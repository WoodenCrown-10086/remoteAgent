import { Sandbox } from '@e2b/code-interpreter';
import { Orchestrator } from '@/agent/orchestrator';
import { buildSystemPrompt } from '@/agent/prompts';
import { runAgent, createPersistCallback } from '@/agent/runner';
import { ContextManager } from '@/agent/memory/context-manager';
import { createEmbeddingProvider } from '@/agent/memory/embedding';
import { createMemorySearchTool } from '@/agent/tools/memory-search';
import {
  initDb,
  createSession,
  getSession,
  updateSession,
  insertMessage,
  getNextSequence,
} from '@/db/db';
import { createAllSandboxTools, createReadSkillTool } from '@/agent/tools';
import { createDispatchTool } from '@/agent/tools/dispatch';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const body = await req.json();
  const { prompt, sandboxId, skills: requestedSkills, sessionId } = body;
  const shouldKill: boolean = body.action === 'kill';

  // ── 从请求头读取 API key（前端设置优先，回退环境变量）──
  const apiKey = req.headers.get('x-api-key') || undefined;
  const e2bApiKey = req.headers.get('x-e2b-api-key') || undefined;

  // ── 接口生命周期日志（供系统日志面板调试）──
  console.log(`[api] POST /api/hello 调用`, {
    sessionId: sessionId?.slice(0, 8),
    action: body.action || 'pause',
    promptLen: prompt?.length,
    hasApiKey: !!apiKey,
    hasE2bKey: !!e2bApiKey,
  });

  // ── 0. 数据库 ──
  await initDb();

  // ── 1. 会话 ──
  // 原则：一个会话绑定一个独立沙箱（sessions.sandbox_id 为权威）
  // 前端传入的 sandboxId 只在会话未绑定时作为兜底，绝不覆盖已绑定值
  let currentSessionId: string;
  let boundSandboxId: string | undefined = sandboxId || undefined;
  if (sessionId) {
    currentSessionId = sessionId;
    const existing = await getSession(sessionId);
    if (existing?.sandboxId) {
      // 会话已绑定沙箱 → 优先使用绑定值，忽略前端传入
      boundSandboxId = existing.sandboxId;
    }
    await updateSession(sessionId, {
      status: 'active',
    });
  } else {
    // 新建会话：以首条消息作为标题，绑定前端传入的沙箱（若有）
    const session = await createSession({
      title: prompt.slice(0, 100),
      sandboxId: sandboxId || undefined,
    });
    currentSessionId = session.id;
    boundSandboxId = sandboxId || undefined;
  }

  // ── 2. System Prompt ──
  let systemPrompt = await buildSystemPrompt({ prompt, requestedSkills });

  // ── 2.5 构建上下文（加载历史 + 必要时压缩）──
  // ── 2.6 记忆管理器（增量摘要 + 向量检索）──
  const embeddingProvider = createEmbeddingProvider(
    (process.env.EMBEDDING_PROVIDER as 'local' | 'openai') || 'local',
    apiKey,
  );
  console.log('huxiao', embeddingProvider)
  const contextManager = new ContextManager({
    sessionId: currentSessionId,
    embeddingProvider,
    apiKey,
    enableVector: true,
  });
  const ctx = await contextManager.buildContext(prompt);
  console.log('asd',ctx)
  // 将压缩摘要注入 system prompt
  if (ctx.summary) {
    systemPrompt += `\n\n## 历史上下文摘要\n${ctx.summary}`;
  }

  console.log(
    `[context] session=${currentSessionId.slice(0, 8)} messages=${ctx.messages.length} tokens=${ctx.totalTokens} compressed=${ctx.compressed}`,
  );

  // ── 3. 沙箱（用会话绑定值，前端传入仅兜底） ──
  let sandbox: Sandbox | null = null;
  let sandboxCreated = false;
  if (boundSandboxId) {
    try {
      sandbox = (await Sandbox.connect(boundSandboxId, {
        timeoutMs: 300_000,
        apiKey: e2bApiKey,
      })) as Sandbox;
    } catch {
      sandbox = await Sandbox.create({ timeoutMs: 300_000, apiKey: e2bApiKey });
      sandboxCreated = true;
    }
  } else {
    sandbox = await Sandbox.create({ timeoutMs: 300_000, apiKey: e2bApiKey });
    sandboxCreated = true;
  }

  // ── 3.5 沙箱就绪后立即绑定到会话 ──
  // 不依赖 onFinish 时序（onFinish 在 SSE 流结束后才执行，且其闭包
  // 引用的 sandbox 变量可能在流处理过程中失去 sandboxId）
  if (!shouldKill && sandbox?.sandboxId) {
    await updateSession(currentSessionId, {
      sandboxId: sandbox.sandboxId,
    }).catch((e) => console.error('[db sandbox bind]', e.message));
    console.log(`[route] 沙箱已绑定到会话: ${currentSessionId.slice(0, 8)} → ${sandbox.sandboxId.slice(0, 12)}`);
  }

  // ── 4. 工具 ──
  const tools = {
    ...createAllSandboxTools(sandbox),
    read_skill: createReadSkillTool(),
  };

  // ── 4.1 多 Agent 调度器（主 Agent 通过 dispatch 派发子任务） ──
  // 子 Agent 事件先入内存队列，主 Agent 事件流中顺带补发
  let subAgentEvents: Array<Record<string, unknown>> = [];
  const orchestrator = new Orchestrator({
    sandbox,
    sessionId: currentSessionId,
    apiKey,
    embeddingProvider,
    maxParallel: 3,
    emit: (data) => subAgentEvents.push(data),
  });
  // tools 字面量类型无 dispatch 属性，沿用 memory_search 的 any 断言注入方式
  (tools as any).dispatch = createDispatchTool(
    (role, task, dependsOn) => orchestrator.dispatch(role, task, dependsOn),
  );

  // 上下文被压缩时注入记忆检索工具（回忆早期历史）
  if (ctx.compressed) {
    (tools as any).memory_search = createMemorySearchTool(
      contextManager.search.bind(contextManager),
    );
  }

  // ── 5. 写入用户消息 ──
  const sequence = await getNextSequence(currentSessionId);
  await insertMessage({
    sessionId: currentSessionId,
    role: 'user',
    type: 'user',
    content: prompt,
    sequence,
    sandboxId: sandbox.sandboxId,
  });

  // ── 6. 运行 Agent ──
  const sseStream = runAgent({
    input: {
      sandbox,
      sessionId: currentSessionId,
      startSequence: sequence + 1,
      sandboxCreated,
    },
    messages: ctx.messages,
    systemPrompt,
    tools,
    apiKey,
    agentId: 'main',
    agentRole: 'main',
    context: {
      onPersist: createPersistCallback(
        currentSessionId,
        sandbox.sandboxId,
        (async (input: any) => {
          const msg = await insertMessage(input);
          contextManager.onMessagePersisted(msg as any).catch((e) =>
            console.error('[memory vectorize] 异步向量化失败:', e),
          );
          return msg;
        }) as any,
      ),
      onFinish: (status) => {
        const finalStatus = shouldKill ? 'killed' : 'paused';
        updateSession(currentSessionId, {
          status: finalStatus,
          sandboxId: shouldKill ? undefined : sandbox?.sandboxId,
        }).catch((e) => console.error('[db session update]', e.message));
      },
      // 子 Agent 事件实时注入主 SSE 流（runner send 时 flush 并清空）
      flushSubEvents: () => {
        const evs = [...subAgentEvents];
        subAgentEvents = [];
        return evs;
      },
    },
  });

  // ── 7. 沙箱生命周期（在流结束后）──
  const cleanupStream = new ReadableStream({
    async start(controller) {
      const reader = sseStream.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          controller.enqueue(value);
        }
      } finally {
        reader.releaseLock();
        // 等待子 Agent 任务完成（带超时，防止死锁）
        try {
          const result = await orchestrator.waitAll();
          if (result.summary) {
            console.log(`[orchestrator] 子任务汇总 (passed=${result.passed} timedOut=${result.timedOut}):\n${result.summary}`);
          }
        } catch (e: any) {
          console.error('[orchestrator] waitAll 异常:', e.message);
        }
        console.log(`[api] POST /api/hello 完成`, {
          sessionId: currentSessionId.slice(0, 8),
          sandboxId: sandbox?.sandboxId?.slice(0, 12),
          sandboxStatus: shouldKill ? 'killed' : 'paused',
        });
        if (sandbox) {
          try {
            if (shouldKill) await sandbox.kill();
            else await sandbox.pause();
          } catch (e: any) {
            console.error('[e2b cleanup]', e.message);
          }
        }
        controller.close();
      }
    },
  });

  return new Response(cleanupStream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}

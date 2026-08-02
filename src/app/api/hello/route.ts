import { Sandbox } from '@e2b/code-interpreter';
import { buildSystemPrompt } from '@/agent/prompts';
import { runAgent, createPersistCallback } from '@/agent/runner';
import { ContextManager } from '@/agent/memory/context-manager';
import { createEmbeddingProvider } from '@/agent/memory/embedding';
import { createMemorySearchTool } from '@/agent/tools/memory-search';
import {
  initDb,
  createSession,
  updateSession,
  insertMessage,
  getNextSequence,
} from '@/db/db';
import { createAllSandboxTools, createReadSkillTool } from '@/agent/tools';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const body = await req.json();
  const { prompt, sandboxId, skills: requestedSkills, sessionId } = body;
  const shouldKill: boolean = body.action === 'kill';

  // ── 从请求头读取 API key（前端设置优先，回退环境变量）──
  const apiKey = req.headers.get('x-api-key') || undefined;
  const e2bApiKey = req.headers.get('x-e2b-api-key') || undefined;

  // ── 0. 数据库 ──
  await initDb();

  // ── 1. 会话 ──
  let currentSessionId: string;
  if (sessionId) {
    // 复用已有会话：保留原标题，只更新沙箱和状态
    currentSessionId = sessionId;
    await updateSession(sessionId, {
      sandboxId: sandboxId || undefined,
      status: 'active',
    });
  } else {
    // 新建会话：以首条消息作为标题
    const session = await createSession({
      title: prompt.slice(0, 100),
      sandboxId: sandboxId || undefined,
    });
    currentSessionId = session.id;
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

  // ── 3. 沙箱 ──
  let sandbox: Sandbox | null = null;
  let sandboxCreated = false;
  if (sandboxId) {
    try {
      sandbox = (await Sandbox.connect(sandboxId, {
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

  // ── 4. 工具 ──
  const tools = {
    ...createAllSandboxTools(sandbox),
    read_skill: createReadSkillTool(),
  };

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

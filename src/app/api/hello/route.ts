import { Sandbox } from '@e2b/code-interpreter';
import { Orchestrator } from '@/agent/orchestrator';
import { buildSystemPrompt } from '@/agent/prompts';
import { runAgent, createPersistCallback } from '@/agent/runner';
import { taskManager } from '@/lib/task-manager';
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
  upsertAgentTask,
  clearAgentTasks,
} from '@/db/db';
import { createReadSkillTool } from '@/agent/tools';
import { createDispatchTool } from '@/agent/tools/dispatch';
import { createPlanTool } from '@/agent/tools/plan';
import { sendC2CMessage } from '@/lib/qq-bot';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const body = await req.json();
  const { prompt, sandboxId, skills: requestedSkills, sessionId } = body;
  const shouldKill: boolean = body.action === 'kill';

  // ── 从请求头读取 API key（前端设置优先，回退环境变量）──
  const apiKey = req.headers.get('x-api-key') || undefined;
  const e2bApiKey = req.headers.get('x-e2b-api-key') || undefined;
  // QQ 机器人配置（前端设置优先，回退环境变量）
  const qqBotAppId = req.headers.get('x-qq-bot-app-id') || undefined;
  const qqBotAppSecret = req.headers.get('x-qq-bot-app-secret') || undefined;
  const qqBotOpenid = req.headers.get('x-qq-bot-openid') || undefined;

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
  // 嵌入用 API（默认 http=硅基流动）：EMBEDDING_PROVIDER=gemini|openai|http|none
  const embeddingProviderName =
    (process.env.EMBEDDING_PROVIDER as 'gemini' | 'openai' | 'http' | 'none') || 'http';
  const embeddingKey = process.env.EMBEDDING_API_KEY || apiKey;
  const embeddingProvider = createEmbeddingProvider(embeddingProviderName, embeddingKey);
  const contextManager = new ContextManager({
    sessionId: currentSessionId,
    embeddingProvider,
    apiKey,
    enableVector: embeddingProviderName !== 'none',
  });
  const ctx = await contextManager.buildContext(prompt);
  // 将压缩摘要注入 system prompt
  if (ctx.summary) {
    systemPrompt += `\n\n## 历史上下文摘要\n${ctx.summary}`;
  }

  console.log(
    `[context] session=${currentSessionId.slice(0, 8)} messages=${ctx.messages.length} tokens=${ctx.totalTokens} compressed=${ctx.compressed}`,
  );

  // ── 2.8 写入用户消息（提前到沙箱创建前） ──
  // 沙箱创建（e2b API）可能耗时数秒；若用户在此期间刷新页面，需保证用户消息已落库，
  // 否则刷新后「本轮输入」会丢失，直到后台任务产出新消息才被补全。
  // 用户消息不依赖沙箱，sandboxId 先用绑定值（未绑定时为 null）。
  const sequence = await getNextSequence(currentSessionId);
  await insertMessage({
    sessionId: currentSessionId,
    role: 'user',
    type: 'user',
    content: prompt,
    sequence,
    sandboxId: boundSandboxId,
  });

  // ── 3. 沙箱（用会话绑定值，前端传入仅兜底） ──
  let sandbox: Sandbox | null = null;
  let sandboxCreated = false;
  // 沙箱超时（e2b 绝对 TTL，从创建起倒计时，普通 API 调用不续期）：
  // 到点默认 kill（文件销毁）→ 配置 onTimeout:'pause' 改为自动快照保留（文件不丢）。
  // 如需超长任务，可加大此值或工具活动时调用 sandbox.setTimeout() 续期。
  const SANDBOX_TIMEOUT_MS = 3_600_000;
  const SANDBOX_LIFECYCLE = { onTimeout: 'pause' as const };
  if (boundSandboxId) {
    try {
      sandbox = (await Sandbox.connect(boundSandboxId, {
        timeoutMs: SANDBOX_TIMEOUT_MS,
        apiKey: e2bApiKey,
      })) as Sandbox;
    } catch {
      sandbox = await Sandbox.create({
        timeoutMs: SANDBOX_TIMEOUT_MS,
        apiKey: e2bApiKey,
        lifecycle: SANDBOX_LIFECYCLE,
      });
      sandboxCreated = true;
    }
  } else {
    sandbox = await Sandbox.create({
      timeoutMs: SANDBOX_TIMEOUT_MS,
      apiKey: e2bApiKey,
      lifecycle: SANDBOX_LIFECYCLE,
    });
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
  // 主 Agent 是纯编排者：不注入任何沙箱工具（write_file / execute_command / read_file 等），
  // 只保留 dispatch + read_skill（读取 skill 正文用于分发决策），从能力层面杜绝「自己完成任务」。
  const tools: Record<string, unknown> = {
    read_skill: createReadSkillTool(),
  };

  // ── 4.1 多 Agent 调度器（主 Agent 通过 dispatch 派发子任务） ──
  // 子 Agent 事件通过 onLiveEmit 拿到的 pushSubEvent 实时推入 SSE 流（不再积压等待主 Agent 事件）
  let pushSubEvent: ((ev: Record<string, unknown>) => void) | undefined;
  // 主 Agent 最终总结（任务完成后用于 QQ 机器人通知）
  let finalSummary = '';
  const orchestrator = new Orchestrator({
    sandbox,
    sessionId: currentSessionId,
    apiKey,
    embeddingProvider,
    maxParallel: 3,
    emit: (data) => {
      // 子 Agent 状态落库（刷新后可按 session 查询恢复）
      const d = data as {
        type?: string;
        agentId?: string;
        agentRole?: string;
        task?: string;
        status?: string;
      };
      if (d.type === 'agent_start' && d.agentId && d.agentRole) {
        upsertAgentTask({
          sessionId: currentSessionId,
          agentId: d.agentId,
          agentRole: d.agentRole,
          status: 'running',
          task: d.task,
        }).catch((e) => console.error('[db agent] upsert 失败:', e.message));
      } else if (d.type === 'agent_finish' && d.agentId && d.agentRole) {
        upsertAgentTask({
          sessionId: currentSessionId,
          agentId: d.agentId,
          agentRole: d.agentRole,
          status: d.status === 'failed' ? 'failed' : 'passed',
        }).catch((e) => console.error('[db agent] upsert 失败:', e.message));
      }
      pushSubEvent?.(data);
    },
    gateVerify: async (report) => {
      // 真门禁：coder 必须声明产物，且声明的每个文件都必须真实存在
      // （reviewer/evaluator 的产物是结论文本、无文件清单，不受此约束）
      if (report.role === 'coder' && report.artifacts.length === 0) {
        return { ok: false, reason: 'coder 未声明任何产物文件（需调用 report_artifact）' };
      }
      for (const p of report.artifacts) {
        const fullPath = p.startsWith('/') ? p : `/home/user/${p}`;
        try {
          await sandbox.files.read(fullPath);
        } catch {
          return { ok: false, reason: `产物不存在: ${p}` };
        }
      }
      return { ok: true };
    },
  });
  // tools 字面量类型无 dispatch 属性，沿用 memory_search 的 any 断言注入方式
  (tools as any).dispatch = createDispatchTool(
    async ({ role, tasks, dependsOn }) => {
      // 批量派发：同步等待全部子 Agent 完成 + 门禁
      return orchestrator.dispatchBatch(role, tasks, dependsOn);
    },
  );
  // 首次规划：3 planner 并行 + 交叉评分 + 选平均最高
  (tools as any).plan = createPlanTool(
    (task) => orchestrator.planWithConsensus(task),
  );

  // 上下文被压缩时注入记忆检索工具（回忆早期历史）
  if (ctx.compressed) {
    (tools as any).memory_search = createMemorySearchTool(
      contextManager.search.bind(contextManager),
    );
  }

  // ── 6. 运行 Agent（后台任务模式：断线不中断，状态写 DB） ──
  // 新任务开始：清除该 session 上一次任务的子 Agent 状态（按 session 隔离）
  await clearAgentTasks(currentSessionId).catch((e) =>
    console.error('[db agent] 清除失败:', e.message),
  );
  // 标记任务开始
  await taskManager.start(currentSessionId).catch((e) =>
    console.error('[task] start 失败', e.message),
  );

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
    // 主 Agent 生命周期 hooks（验收/错误记录）
    hooks: {
      onComplete: async ({ summary, rounds }) => {
        // 最终总结 = 最后一轮完整文本（去 round 前缀，作为 QQ 通知正文）
        const lastText = rounds[rounds.length - 1]?.text?.trim() ?? '';
        finalSummary = lastText || summary;
        console.log(`[main-agent] 任务完成，摘要: ${summary.slice(0, 200)}`);
      },
      onError: ({ error, roundIndex }) => {
        console.error(`[main-agent] 第 ${roundIndex} 轮出错:`, error.message);
      },
    },
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
        const taskFinal = status === 'error' ? 'failed' : 'completed';
        // 更新内存 + DB 任务状态（后台任务模式，进程重启后可从 DB 恢复）
        taskManager.finish(currentSessionId, taskFinal).catch((e) =>
          console.error('[task] finish 失败', e.message),
        );
        updateSession(currentSessionId, {
          status: finalStatus,
          sandboxId: shouldKill ? undefined : sandbox?.sandboxId,
          taskStatus: taskFinal,
        }).catch((e) => console.error('[db session update]', e.message));

        // 任务结束 → 通过 QQ 机器人发送通知（主动消息）
        const qqOpenid = qqBotOpenid || process.env.QQ_BOT_OPENID;
        if (qqOpenid) {
          console.log('[qq-bot] 发送通知:', {
            openid: qqOpenid,
            openidSource: qqBotOpenid ? '请求头(前端localStorage)' : '环境变量',
            appId: qqBotAppId || process.env.QQ_BOT_APP_ID,
            appIdSource: qqBotAppId ? '请求头(前端localStorage)' : '环境变量',
          });
          const content =
            status === 'error'
              ? '⚠️ [Agent 任务失败] 任务执行出错，请到 Web 端查看详情。'
              : finalSummary || '✅ [Agent 任务完成]';
          const qqCreds =
            qqBotAppId && qqBotAppSecret
              ? { appId: qqBotAppId, appSecret: qqBotAppSecret }
              : undefined;
          sendC2CMessage(qqOpenid, content, qqCreds).catch((e) =>
            console.error('[qq-bot] 发送通知失败:', e.message),
          );
        }
      },
      // 子 Agent 事件实时推送：把 runner 的 push 函数交给 orchestrator 使用
      onLiveEmit: (push) => {
        pushSubEvent = push;
      },
    },
    // 任务真正结束（done/error 后）：收尾子 Agent + 沙箱生命周期。
    // 在后台 Promise 中执行，与 SSE 连接是否断开无关。
    onTaskDone: async (status) => {
      try {
        const result = await orchestrator.waitAll();
        if (result.summary) {
          console.log(
            `[orchestrator] 子任务汇总 (passed=${result.passed} timedOut=${result.timedOut}):\n${result.summary}`,
          );
        }
      } catch (e: any) {
        console.error('[orchestrator] waitAll 异常:', e.message);
      }
      console.log(`[api] 后台任务结束 (${status})`, {
        sessionId: currentSessionId.slice(0, 8),
        sandboxId: sandbox?.sandboxId?.slice(0, 12),
      });
      if (sandbox) {
        try {
          if (shouldKill) await sandbox.kill();
          else await sandbox.pause();
        } catch (e: any) {
          console.error('[e2b cleanup]', e.message);
        }
      }
    },
  });

  // SSE 响应（后台任务模式下，此流断开不影响任务继续）
  return new Response(sseStream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}

import { runAgentLoop, type AgentLifecycleHooks } from './agent-loop';
import type { AgentRunInput, StreamContext, SSEEvent } from './types';
// ── Agent 运行器 ──
//
// 核心函数：接收配置 + 输入 → 返回 SSE ReadableStream
// 设计为无状态纯函数，可组合到多 Agent 管道中

export interface RunAgentParams {
  input: AgentRunInput;
  messages: any[]; // CoreMessage[] — 运行时兼容 AI SDK ModelMessage
  systemPrompt: string;
  tools: Record<string, any>;
  context: StreamContext;
  maxSteps?: number;
  /** API key（前端设置），用于本次 Agent 调用 */
  apiKey?: string;
  /** Agent 实例标识（子 Agent 用） */
  agentId?: string;
  /** Agent 角色 */
  agentRole?: string;
  /** 生命周期 hooks（透传给 runAgentLoop） */
  hooks?: AgentLifecycleHooks;
  /** 任务结束回调（done/error 后调用，用于沙箱清理等；后台任务模式不依赖 SSE 连接） */
  onTaskDone?: (status: 'done' | 'error') => Promise<void>;
}

/**
 * 运行 Agent 并返回 SSE 流。
 *
 * 后台任务模式：
 * - Agent 循环在独立 Promise 中执行，**不依赖 HTTP/SSE 连接**——用户断开页面，
 *   任务继续运行，事件照常写入 DB（onPersist）。
 * - 返回的 ReadableStream 只负责把事件实时转发给客户端；客户端断开（cancel）时
 *   仅停止转发，任务不受影响。
 */
export function runAgent(params: RunAgentParams): ReadableStream {
  const {
    input,
    messages,
    systemPrompt,
    tools,
    context,
    maxSteps = 100,
    apiKey,
    agentId,
    agentRole,
    hooks,
    onTaskDone,
  } = params;
  const { sandbox, sessionId, startSequence, sandboxCreated, meta } = input;

  const encoder = new TextEncoder();
  let sequence = startSequence;
  const listeners = new Set<(e: SSEEvent) => void>();
  let streamClosed = false;
  // 流未就绪（前端尚未开始读）前，子 Agent 事件的积压队列
  const pendingSubEvents: SSEEvent[] = [];

  // 子 Agent 事件实时推送：orchestrator 产生事件后立即转发，不再积压等待主 Agent 事件
  const pushSubEvent = (ev: Record<string, unknown>) => {
    const enrichedSub = { ...ev } as SSEEvent;
    if (!enrichedSub.agentId && agentId) enrichedSub.agentId = agentId;
    if (!enrichedSub.agentRole && agentRole) enrichedSub.agentRole = agentRole;
    if (listeners.size === 0) {
      pendingSubEvents.push(enrichedSub);
      return;
    }
    for (const l of listeners) l(enrichedSub);
  };
  context.onLiveEmit?.(pushSubEvent);

  // 事件发射：转发给所有订阅者（SSE）+ 持久化到 DB
  const emit = (data: SSEEvent) => {
    const enriched: SSEEvent = { ...data };
    if (agentId) enriched.agentId = agentId;
    if (agentRole) enriched.agentRole = agentRole;
    // 携带持久化 sequence，供前端增量轮询去重（SSE 实时消息也更新游标）
    (enriched as Record<string, unknown>).sequence = sequence;
    for (const l of listeners) l(enriched);
    context.onPersist(enriched, sequence++);
  };

  // 后台任务：独立 Promise，断线不中断
  const taskPromise = (async () => {
    let status: 'done' | 'error' = 'done';
    try {
      emit({
        type: 'init',
        sandboxId: sandbox.sandboxId,
        sandboxCreated,
        sessionId,
        ...(meta || {}),
      });

      await runAgentLoop({
        systemPrompt,
        initialMessages: messages,
        tools,
        hooks,
        maxStepsPerRound: maxSteps,
        emit,
        apiKey,
        agentId,
        agentRole,
      });

      try {
        await context.onFinish?.('done', sandbox.sandboxId);
      } catch (e) {
        console.error('[runner] onFinish(done) 失败:', e);
      }
    } catch (err: any) {
      status = 'error';
      console.error('[runner] 后台任务异常:', err.message);
      try {
        emit({ type: 'error', error: err.message || 'Stream error' });
      } catch {
        /* 忽略发送错误 */
      }
      try {
        await context.onFinish?.('error', sandbox.sandboxId);
      } catch (e) {
        console.error('[runner] onFinish(error) 失败:', e);
      }
    } finally {
      // 任务真正结束 → 通知路由做沙箱清理等
      try {
        await onTaskDone?.(status);
      } catch (e) {
        console.error('[runner] onTaskDone 失败:', e);
      }
    }
  })();
  taskPromise.catch((e) => console.error('[runner] unhandled task error:', e));

  return new ReadableStream({
    start(controller) {
      // 连接确认
      controller.enqueue(encoder.encode(': connected\n\n'));

      const listener = (e: SSEEvent) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(e)}\n\n`));
        } catch {
          /* 流已关闭 */
        }
      };
      listeners.add(listener);

      // 补发流就绪前积压的子 Agent 事件（避免极端竞态下丢失）
      for (const ev of pendingSubEvents) {
        for (const l of listeners) l(ev);
      }
      pendingSubEvents.length = 0;

      // 任务结束 → 关闭流（若客户端仍连接）
      taskPromise.finally(() => {
        if (!streamClosed) {
          streamClosed = true;
          try {
            controller.close();
          } catch {
            /* 已关闭 */
          }
        }
      });
    },
    cancel() {
      // 客户端断开：停止转发，但后台任务继续执行
      listeners.clear();
      streamClosed = true;
    },
  });
}

// ── Persist 回调工厂 ──
// 为 route 层生成 onPersist 回调，封装 DB 写入逻辑
// 聚合模式：SSE 的流式分片（text-delta / reasoning-delta）先累积，
// 到逻辑边界（step 结束 / 工具调用 / 结束）才合并落库——一条回复只存一条，不再分片。

export function createPersistCallback(
  sessionId: string,
  sandboxId: string | undefined,
  insertFn: (input: {
    sessionId: string;
    role: 'user' | 'assistant' | 'system';
    type: string;
    content?: string;
    metadata?: Record<string, unknown>;
    stepIndex?: number;
    sequence: number;
    sandboxId?: string;
  }) => Promise<any>,
) {
  let currentStepIndex = 0;
  let pendingText = ''; // 当前累积的文本分片（text-delta 合并）
  let pendingReasoning = ''; // 累积的思考分片（reasoning-delta 合并）

  const insert = (
    type: string,
    content: string | undefined,
    metadata: Record<string, unknown>,
    sequence: number,
  ) => {
    const role =
      type === 'user'
        ? 'user'
        : type === 'error' || type === 'done'
          ? 'system'
          : 'assistant';
    insertFn({
      sessionId,
      role,
      type,
      content,
      metadata: { ...metadata, stepIndex: currentStepIndex },
      stepIndex: currentStepIndex,
      sequence,
      sandboxId,
    }).catch((e) => console.error('[db persist]', e.message));
  };

  // 把已累积的文本分片合并成一条完整消息落库
  const flushText = (sequence: number) => {
    if (pendingText) {
      insert('text', pendingText, {}, sequence);
      pendingText = '';
    }
  };
  const flushReasoning = (sequence: number) => {
    if (pendingReasoning) {
      insert('reasoning', pendingReasoning, {}, sequence);
      pendingReasoning = '';
    }
  };

  return (data: SSEEvent, sequence: number) => {
    if (data.type === 'init') return;
    switch (data.type) {
      // 思考：累积到 reasoning_end 合并存一条
      case 'reasoning_start':
        flushText(sequence); // 思考开始前，先把已累积文本落地
        pendingReasoning = '';
        return;
      case 'reasoning_delta':
        pendingReasoning += (data.content as string) || '';
        return;
      case 'reasoning_end':
        flushReasoning(sequence);
        return;

      // 文本：累积到逻辑边界合并存一条
      case 'text':
        pendingText += (data.content as string) || '';
        return;
      case 'step_start':
        flushText(sequence);
        flushReasoning(sequence);
        currentStepIndex = (data.index as number) ?? currentStepIndex;
        return;
      case 'step_finish':
        flushText(sequence);
        flushReasoning(sequence);
        return;
      case 'done':
        flushText(sequence);
        flushReasoning(sequence);
        return;
      case 'error':
        flushText(sequence);
        flushReasoning(sequence);
        insert('error', data.error as string, {}, sequence);
        return;

      // 工具事件：各自独立存一条（回放需要完整参数/结果）
      case 'tool_call':
        flushText(sequence); // 工具调用前，文本先落地
        insert(
          'tool_call',
          undefined,
          {
            toolName: data.toolName,
            toolArgs: data.args,
            toolCallId: data.toolCallId,
          },
          sequence,
        );
        return;
      case 'tool_result':
        insert(
          'tool_result',
          undefined,
          {
            toolName: data.toolName,
            toolResult: data.result,
            toolCallId: data.toolCallId,
          },
          sequence,
        );
        return;
      case 'tool_error':
        insert(
          'tool_error',
          undefined,
          {
            toolName: data.toolName,
            error: data.error,
            toolCallId: data.toolCallId,
          },
          sequence,
        );
        return;

      // 其余控制事件（step_finish 已处理、done/error 已处理）不落库
      default:
        return;
    }
  };
}

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
}

export function runAgent(params: RunAgentParams): ReadableStream {
  const { input, messages, systemPrompt, tools, context, maxSteps = 100, apiKey, agentId, agentRole, hooks } = params;
  const { sandbox, sessionId, startSequence, sandboxCreated, meta } = input;

  const encoder = new TextEncoder();
  let sequence = startSequence;

  return new ReadableStream({
    async start(controller) {
      // SSE 发送 + 持久化
      const send = (data: SSEEvent) => {
        // 先 flush 外部事件（子 Agent 事件），再发主 Agent 事件
        const subEvents = context.flushSubEvents?.() || [];
        for (const ev of subEvents) {
          const enrichedSub = { ...ev } as SSEEvent;
          // 子 Agent 事件已带自己的 agentId，仅在缺失时才附加主 Agent 的
          if (!enrichedSub.agentId && agentId) enrichedSub.agentId = agentId;
          if (!enrichedSub.agentRole && agentRole) enrichedSub.agentRole = agentRole;
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(enrichedSub)}\n\n`));
        }
        const enriched: SSEEvent = { ...data };
        if (agentId) enriched.agentId = agentId;
        if (agentRole) enriched.agentRole = agentRole;
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(enriched)}\n\n`));
        context.onPersist(enriched, sequence++);
      };

      try {
        // 连接确认
        controller.enqueue(encoder.encode(': connected\n\n'));

        // 初始元信息
        send({
          type: 'init',
          sandboxId: sandbox.sandboxId,
          sandboxCreated,
          sessionId,
          ...(meta || {}),
        });

        // 委托给轮次循环控制器（无 hooks = 行为等价）
        await runAgentLoop({
          systemPrompt,
          initialMessages: messages,
          tools,
          hooks,
          maxStepsPerRound: maxSteps,
          emit: send,
          apiKey,
          agentId,
          agentRole,
        });

        controller.close();
        // 通知回调：会话状态/沙箱绑定在此落库（route 层 onFinish）
        try {
          await context.onFinish?.('done', sandbox.sandboxId);
        } catch (e) {
          console.error('[runner] onFinish(done) 失败:', e);
        }
      } catch (err: any) {
        send({ type: 'error', error: err.message || 'Stream error' });
        controller.close();
        try {
          await context.onFinish?.('error', sandbox.sandboxId);
        } catch (e) {
          console.error('[runner] onFinish(error) 失败:', e);
        }
      }
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

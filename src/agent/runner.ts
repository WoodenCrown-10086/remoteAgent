import { streamText, stepCountIs } from 'ai';
import { createDeepseek } from '@/lib/deepseek';
import type { AgentRunInput, StreamContext, SSEEvent } from './types';
import { EVENT_TYPE_MAP } from './types';

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
}

export function runAgent(params: RunAgentParams): ReadableStream {
  const { input, messages, systemPrompt, tools, context, maxSteps = 100, apiKey, agentId, agentRole } = params;
  const { sandbox, sessionId, startSequence, sandboxCreated, meta } = input;

  const encoder = new TextEncoder();
  let stepIndex = 0;
  let sequence = startSequence;

  // ── 类型映射 + 角色推断 ──
  const mapEventType = (rawType: string) => EVENT_TYPE_MAP[rawType] || rawType;
  const mapRole = (type: string): 'user' | 'assistant' | 'system' => {
    if (type === 'user') return 'user';
    if (type === 'error' || type === 'done') return 'system';
    return 'assistant';
  };

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

        // ── AI SDK streamText ──
        const result = streamText({
          model: createDeepseek(apiKey)('deepseek-v4-flash'),
          system: systemPrompt,
          messages,
          tools,
          stopWhen: stepCountIs(maxSteps),
        });

        // ── 流事件处理 ──
        for await (const part of result.stream) {
          switch (part.type) {
            case 'text-delta':
              send({ type: 'text', content: (part as any).text });
              break;

            case 'reasoning-start':
              send({ type: 'reasoning_start' });
              break;

            case 'reasoning-delta':
              // 思考内容独立事件（前端折叠显示，不混入正式回复）
              send({ type: 'reasoning_delta', content: (part as any).text });
              break;

            case 'reasoning-end':
              send({ type: 'reasoning_end' });
              break;

            case 'tool-call': {
              const tc = part as any;
              send({
                type: 'tool_call',
                toolCallId: tc.toolCallId,
                toolName: tc.toolName,
                args: tc.input,
              });
              break;
            }

            case 'tool-result': {
              const tr = part as any;
              send({
                type: 'tool_result',
                toolCallId: tr.toolCallId,
                toolName: tr.toolName,
                result: tr.output,
              });
              break;
            }

            case 'tool-error': {
              const te = part as any;
              send({
                type: 'tool_error',
                toolCallId: te.toolCallId,
                toolName: te.toolName,
                error: String(te.error),
              });
              break;
            }

            case 'start-step':
              stepIndex++;
              send({ type: 'step_start', index: stepIndex });
              break;

            case 'finish-step': {
              const fs = part as any;
              send({
                type: 'step_finish',
                index: stepIndex,
                finishReason: fs.finishReason,
              });
              break;
            }

            case 'finish': {
              const f = part as any;
              send({
                type: 'done',
                finishReason: f.finishReason,
                usage: f.totalUsage,
              });
              break;
            }

            case 'error':
              send({ type: 'error', error: String((part as any).error) });
              break;

            // 明确忽略的事件
            case 'text-start':
            case 'text-end':
            case 'tool-input-start':
            case 'tool-input-delta':
            case 'tool-input-end':
            case 'source':
            case 'file':
            case 'start':
            case 'abort':
            case 'raw':
              break;

            default:
              console.log(
                '[stream] 未知事件:',
                part.type,
                JSON.stringify(part).slice(0, 200),
              );
              break;
          }
        }

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

  return (data: SSEEvent, sequence: number) => {
    if (data.type === 'init') return;
    // 无内容的标记事件不落库（step_start 除外，它推进 stepIndex）
    if (data.type === 'reasoning_start' || data.type === 'reasoning_end') return;
    if (data.type === 'step_start') currentStepIndex = (data.index as number) ?? currentStepIndex;

    const type = EVENT_TYPE_MAP[data.type as string] || (data.type as string);
    const role =
      type === 'user' ? 'user' :
      type === 'error' || type === 'done' ? 'system' :
      'assistant';

    insertFn({
      sessionId,
      role,
      type,
      content: data.content as string | undefined,
      metadata: {
        toolName: data.toolName,
        toolArgs: data.args,
        toolResult: data.result,
        stepIndex: data.index ?? currentStepIndex,
        finishReason: data.finishReason,
        error: data.error,
        toolCallId: data.toolCallId,
      },
      stepIndex: (data.index as number) ?? currentStepIndex,
      sequence,
      sandboxId,
    }).catch((e) => console.error('[db persist]', e.message));
  };
}

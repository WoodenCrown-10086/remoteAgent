import { streamText, stepCountIs, pruneMessages } from 'ai';
import { createDeepseek } from '@/lib/deepseek';
import type { SSEEvent } from './types';

// ── 类型 ──

export interface RoundContext {
  roundIndex: number;
  messages: any[];               // 本轮结束后的完整消息状态（含 tool-call 中间消息）
  toolCalls: any[];              // 本轮调用过的工具
  text: string;                  // 本轮输出文本
  finishReason: string;          // 'stop' | 'tool-calls' | 'error' | ...
  totalRounds: number;
}

export type RoundDecision =
  | { action: 'continue' }        // 默认：不干预就继续下一轮
  | { action: 'stop'; reason?: string }
  | { action: 'retry'; reason?: string };  // 重跑本轮

export interface CompleteContext {
  rounds: RoundContext[];
  messages: any[];
  summary: string;
}

export interface AgentLifecycleHooks {
  onStart?: (ctx: { task: string; agentId?: string; agentRole?: string }) => void | Promise<void>;
  onRoundEnd?: (ctx: RoundContext) => RoundDecision | Promise<RoundDecision>;
  onToolCall?: (ctx: { toolCall: any; roundIndex: number }) => void | Promise<void>;
  onToolResult?: (ctx: { toolCall: any; result: unknown; roundIndex: number }) => void | Promise<void>;
  onComplete?: (ctx: CompleteContext) => void | Promise<void>;
  onError?: (ctx: { error: Error; roundIndex: number }) => void | Promise<void>;
}

export interface AgentLoopParams {
  systemPrompt: string;
  initialMessages: any[];
  tools: Record<string, any>;
  hooks?: AgentLifecycleHooks;
  maxRounds?: number;            // 默认 5
  maxStepsPerRound?: number;     // 单轮 AI SDK 内部步数上限，默认 100
  emit: (data: SSEEvent) => void;
  apiKey?: string;
  agentId?: string;
  agentRole?: string;
  signal?: AbortSignal;
}

// ── 消费一轮流：SSE 推送 + 收集 text/toolCalls/finishReason ──

async function consumeStream(
  result: any,
  emit: (data: SSEEvent) => void,
  hooks: AgentLifecycleHooks | undefined,
  roundIndex: number,
): Promise<{ text: string; toolCalls: any[]; finishReason: string }> {
  let text = '';
  const toolCalls: any[] = [];
  let finishReason = '';
  let stepIndex = 0;

  for await (const part of result.stream) {
    switch (part.type) {
      case 'text-delta':
        text += (part as any).text;
        emit({ type: 'text', content: (part as any).text });
        break;
      case 'reasoning-start':
        emit({ type: 'reasoning_start' });
        break;
      case 'reasoning-delta':
        emit({ type: 'reasoning_delta', content: (part as any).text });
        break;
      case 'reasoning-end':
        emit({ type: 'reasoning_end' });
        break;
      case 'tool-call': {
        const tc = part as any;
        toolCalls.push(tc);
        emit({ type: 'tool_call', toolCallId: tc.toolCallId, toolName: tc.toolName, args: tc.input });
        await hooks?.onToolCall?.({ toolCall: tc, roundIndex });
        break;
      }
      case 'tool-result': {
        const tr = part as any;
        emit({ type: 'tool_result', toolCallId: tr.toolCallId, toolName: tr.toolName, result: tr.output });
        await hooks?.onToolResult?.({ toolCall: tr, result: tr.output, roundIndex });
        break;
      }
      case 'tool-error': {
        const te = part as any;
        emit({ type: 'tool_error', toolCallId: te.toolCallId, toolName: te.toolName, error: String(te.error) });
        break;
      }
      case 'start-step':
        stepIndex++;
        emit({ type: 'step_start', index: stepIndex });
        break;
      case 'finish-step': {
        const fs = part as any;
        emit({ type: 'step_finish', index: stepIndex, finishReason: fs.finishReason });
        break;
      }
      case 'finish': {
        const f = part as any;
        finishReason = f.finishReason || '';
        emit({ type: 'done', finishReason: finishReason, usage: f.totalUsage });
        break;
      }
      case 'error':
        emit({ type: 'error', error: String((part as any).error) });
        break;

      // 临时调试：打印所有辅助事件的具体内容
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
        console.log(`[agent-loop] 辅助事件 ${part.type}:`, JSON.stringify(part));
        break;

      default:
        console.log('[agent-loop] 未知事件:', part.type, JSON.stringify(part).slice(0, 200));
        break;
    }
  }
  return { text, toolCalls, finishReason };
}

// ── 轮次循环控制器 ──

export async function runAgentLoop(params: AgentLoopParams): Promise<void> {
  const {
    systemPrompt,
    initialMessages,
    tools,
    hooks,
    maxRounds = 5,
    maxStepsPerRound = 100,
    emit,
    apiKey,
    agentId,
    agentRole,
    signal,
  } = params;

  let messages = [...initialMessages];
  const rounds: RoundContext[] = [];
  let retriesThisRound = 0;
  const MAX_RETRIES = 2;

  // 从初始消息中提取最后一条 user 消息作为任务描述
  const lastUser = [...initialMessages].reverse().find((m: any) => m.role === 'user');
  await hooks?.onStart?.({ task: typeof lastUser?.content === 'string' ? lastUser.content : '', agentId, agentRole });

  for (let round = 0; round < maxRounds; round++) {
    if (signal?.aborted) break;

    const preMessages = messages;   // retry 回滚用
    let result: any;
    try {
      result = await streamText({
        model: createDeepseek(apiKey)('deepseek-v4-flash'),
        system: systemPrompt,
        messages,
        tools,
        stopWhen: stepCountIs(maxStepsPerRound),
        abortSignal: signal,
      });
    } catch (e: any) {
      await hooks?.onError?.({ error: e, roundIndex: round });
      // 模型调用中断/失败：向上抛出，让 runner 把任务标记为 error（而非静默「完成」）
      throw e;
    }

    const { text, toolCalls, finishReason } = await consumeStream(result, emit, hooks, round);
    const response = await Promise.resolve(result.response).catch(() => ({ messages }));   // AI SDK 完整消息状态
    // 清理 messages 供下一轮回传：移除 reasoning、清理未完成 tool-call、移除空消息
    // （DeepSeek 的 reasoning 结构重传时可能触发 ModelMessage schema 校验失败）
    messages = pruneMessages({
      messages: response.messages as any,
      reasoning: 'all',
      toolCalls: 'before-last-message',
      emptyMessages: 'remove',
    });

    const roundCtx: RoundContext = {
      roundIndex: round,
      messages,
      toolCalls,
      text,
      finishReason,
      totalRounds: maxRounds,
    };
    rounds.push(roundCtx);

    // 轮末门禁（可选；不返回则走默认终止判定）
    const decision = await hooks?.onRoundEnd?.(roundCtx);
    if (decision?.action === 'stop') break;
    if (decision?.action === 'retry') {
      if (retriesThisRound >= MAX_RETRIES) break;   // 超限终止
      retriesThisRound++;
      rounds.pop();
      messages = preMessages;   // 回滚到本轮前状态
      round--;
      continue;
    }
    retriesThisRound = 0;   // 非 retry 时重置

    // 默认终止判定：模型完成（stop）则结束；除非 onRoundEnd 显式 continue
    if (finishReason === 'stop' && decision?.action !== 'continue') break;
  }

  // 任务完成验收（必调）
  await hooks?.onComplete?.({
    rounds,
    messages,
    summary: rounds.map((r) => `round ${r.roundIndex}: ${r.text.slice(0, 100)}`).join('\n'),
  });
}

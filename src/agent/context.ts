import { getEncoding } from 'js-tiktoken';
import { generateText } from 'ai';
import { createDeepseek } from '@/lib/deepseek';
import { getSession, getSessionMessages, getSessionMessagesAfterSeq, updateSession } from '@/db/db';
import { mergeSummary, MAX_SUMMARY_TOKENS } from './memory/summary-store';
import type { Message as DbMessage } from '@/db/schema';

// ── AI SDK 消息类型（本地定义）──

interface TextPart { type: 'text'; text: string }
interface ToolCallPart { type: 'tool-call'; toolCallId: string; toolName: string; args: Record<string, unknown> }
interface ToolResultPart { type: 'tool-result'; toolCallId: string; toolName: string; result: unknown }

type AssistantContent = string | Array<TextPart | ToolCallPart>;
type ToolContent = Array<ToolResultPart>;

export interface CoreMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string | AssistantContent | ToolContent;
}

// ── Token 计数 ──

const COMPRESS_THRESHOLD = 15000;
const KEEP_RECENT_RATIO = 0.45; // 保留最近 45% 的消息

let _encoder: ReturnType<typeof getEncoding> | null = null;

function encoder() {
  if (!_encoder) _encoder = getEncoding('cl100k_base');
  return _encoder;
}

/** 计算一组 CoreMessage 的总 token 数 */
export function countTokens(messages: CoreMessage[]): number {
  let total = 0;
  for (const msg of messages) {
    // 每条消息额外 4 tokens（角色标记等）
    total += 4;
    if (typeof msg.content === 'string') {
      total += encoder().encode(msg.content).length;
    } else if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part.type === 'text') {
          total += encoder().encode(part.text).length;
        } else if (part.type === 'tool-call') {
          total += encoder().encode(JSON.stringify(part.args || {})).length;
          total += encoder().encode(part.toolName || '').length;
        } else if (part.type === 'tool-result') {
          total += encoder().encode(JSON.stringify(part.result)).length;
        }
      }
    }
  }
  return total;
}

// ── DB 消息 → AI SDK CoreMessage ──

interface ParsedDbMessage {
  id: string;
  role: string;
  type: string;
  content: string | null;
  metadata: Record<string, unknown> | null;
}

/**
 * 将 DB 中的细粒度事件消息转换为 AI SDK 的 CoreMessage[]。
 *
 * 规则：
 * - user → { role: 'user', content }
 * - assistant text → 合并连续文本
 * - tool_call → 收集到上一个 assistant 的 content 数组中
 * - tool_result → { role: 'tool', content: [{ type:'tool-result', ... }] }
 * - step/step_finish/done/error → 跳过
 */
export function convertDbToCoreMessages(dbMessages: ParsedDbMessage[]): CoreMessage[] {
  const result: CoreMessage[] = [];
  let pendingText = '';
  let pendingToolCalls: Array<{
    type: 'tool-call';
    toolCallId: string;
    toolName: string;
    args: Record<string, unknown>;
  }> = [];

  // 记录最近一个 assistant 消息里的 tool-call ids，用于校验 tool_result 的匹配
  let lastAssistantToolCallIds: Set<string> = new Set();
  // 已完成配对的 toolCallId（防止重复 tool_result）
  const consumedToolCallIds = new Set<string>();

  const flushAssistant = () => {
    if (!pendingText && pendingToolCalls.length === 0) {
      lastAssistantToolCallIds = new Set();
      return;
    }

    if (pendingToolCalls.length === 0) {
      // 纯文本
      result.push({ role: 'assistant', content: pendingText });
      lastAssistantToolCallIds = new Set();
    } else {
      // 文本 + 工具调用
      const content: Array<{ type: 'text'; text: string } | { type: 'tool-call'; toolCallId: string; toolName: string; args: Record<string, unknown> }> = [];
      if (pendingText) content.push({ type: 'text', text: pendingText });
      content.push(...pendingToolCalls);
      result.push({ role: 'assistant', content });
      lastAssistantToolCallIds = new Set(pendingToolCalls.map((t) => t.toolCallId));
    }

    pendingText = '';
    pendingToolCalls = [];
  };

  for (const m of dbMessages) {
    const meta = m.metadata || {};

    // user 消息
    if (m.type === 'user') {
      flushAssistant();
      result.push({ role: 'user', content: m.content || '' });
      consumedToolCallIds.clear();
      continue;
    }

    // 结构化标记 → 跳过（内部记账，不给 LLM）
    if (['step', 'step_finish', 'done', 'error'].includes(m.type)) {
      flushAssistant();
      continue;
    }

    // assistant 文本
    if (m.type === 'text') {
      pendingText += (m.content || '');
      continue;
    }

    // 工具调用
    if (m.type === 'tool_call') {
      pendingToolCalls.push({
        type: 'tool-call',
        toolCallId: (meta.toolCallId as string) || `${meta.toolName}-${Date.now()}`,
        toolName: (meta.toolName as string) || 'unknown',
        args: (meta.toolArgs as Record<string, unknown>) || {},
      });
      continue;
    }

    // 工具结果
    if (m.type === 'tool_result') {
      const toolCallId = (meta.toolCallId as string) || `${meta.toolName}-${Date.now()}`;

      // 防护：tool_result 必须匹配上一个 assistant 消息中的 tool-call，
      // 且未被消费过。否则跳过（孤立结果，防止 schema 校验失败）
      if (!lastAssistantToolCallIds.has(toolCallId) || consumedToolCallIds.has(toolCallId)) {
        console.warn(
          `[context] 跳过孤立的 tool_result: toolCallId=${toolCallId} toolName=${meta.toolName}`,
        );
        continue;
      }
      consumedToolCallIds.add(toolCallId);

      flushAssistant();
      result.push({
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId,
            toolName: (meta.toolName as string) || 'unknown',
            result: meta.toolResult,
          },
        ],
      });
      continue;
    }
  }

  flushAssistant();

  // ── 全量清洗：剥离所有未配对的 tool-call ──
  // 场景：persist 异步写入导致 tool_call/tool_result 顺序颠倒或缺失，
  // 转换后可能出现 assistant 消息带 tool-call 但没有对应 tool-result。
  // AI SDK 的 ModelMessage schema 会拒绝这类消息，因此：
  //   1. 收集所有已配对（有 tool 消息提供结果）的 toolCallId
  //   2. 从 assistant 消息中剥离未配对的 tool-call
  //   3. 若剥离后 assistant 消息只剩 tool-call（无文本），整条删除
  const pairedIds = new Set<string>();
  for (const msg of result) {
    if (msg.role === 'tool' && Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part.type === 'tool-result') pairedIds.add(part.toolCallId);
      }
    }
  }

  const cleaned = result.filter((msg) => {
    if (msg.role !== 'assistant' || typeof msg.content === 'string') return true;
    const content = msg.content as unknown as Array<{ type: string; text?: string; toolCallId?: string }>;
    const hasToolCall = content.some((p) => p.type === 'tool-call');
    if (!hasToolCall) return true;

    const textParts = content.filter((p) => p.type === 'text');
    const keptCalls = content.filter(
      (p) => p.type !== 'tool-call' || pairedIds.has(p.toolCallId as string),
    );

    // 纯 tool-call 消息（无文本且全部未配对）→ 删除
    if (keptCalls.filter((p) => p.type === 'tool-call').length === 0 && textParts.length === 0) {
      return false;
    }

    // 有文本保留，剥离未配对 tool-call
    (msg as any).content = [
      ...textParts,
      ...keptCalls.filter((p) => p.type === 'tool-call'),
    ];
    return true;
  });

  // 清洗后如果以未配对的 tool-call 结尾（例如 assistant 消息被部分保留），
  // 确保最后一个 assistant 消息没有残留 tool-call
  const finalResult = cleaned.filter((msg, i) => {
    if (msg.role !== 'assistant' || typeof msg.content === 'string') return true;
    const content = msg.content as unknown as Array<{ type: string; text?: string }>;
    const hasToolCall = content.some((p) => p.type === 'tool-call');
    if (!hasToolCall) return true;
    // 若这是最后一条消息且带 tool-call，剥离 tool-call
    if (i === cleaned.length - 1) {
      const textParts = content.filter((p) => p.type === 'text');
      if (textParts.length > 0) {
        (msg as any).content = textParts.map((p) => p.text).join('');
        return true;
      }
      return false;
    }
    return true;
  });

  return finalResult;
}

// ── 压缩引擎 ──

const SUMMARIZE_PROMPT = `你是一个上下文压缩器。将以下对话历史压缩为一段精简的技术摘要。
只保留：
- 用户的核心需求和意图
- 已完成的关键任务（创建/修改了哪些文件）
- 重要的技术决策和约束
- 当前未解决的问题或待办事项

严格忽略：
- 工具调用的具体参数和输出细节
- 文件内容
- 命令执行输出
- 冗长的解释性文字

输出格式：一段连续的摘要文字（不要用 Markdown 列表，不要编号）。`;

/** 将 DB 消息序列化为纯文本（供摘要 LLM 使用） */
function serializeDbMessages(dbMessages: Array<{ role: string; type: string; content: string | null; metadata: Record<string, unknown> | null }>): string {
  return dbMessages
    .map((m) => {
      const meta = m.metadata || {};
      const detail =
        m.type === 'tool_result'
          ? JSON.stringify(meta.toolResult).slice(0, 500)
          : m.content || '';
      return `[${m.role}/${m.type}]: ${detail}`;
    })
    .join('\n');
}

/** 适配 summary-store 的 LlmSummarizeFn */
async function summarizeText(prompt: string, apiKey?: string): Promise<string> {
  const { text } = await generateText({
    model: createDeepseek(apiKey)('deepseek-v4-flash'),
    system: SUMMARIZE_PROMPT,
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.3,
  });
  return text;
}

/**
 * 调用 LLM 压缩早期消息为一段摘要文本
 */
async function summarizeMessages(
  messages: CoreMessage[],
  apiKey?: string,
): Promise<string> {
  try {
    const { text } = await generateText({
      model: createDeepseek(apiKey)('deepseek-v4-flash'),
      system: SUMMARIZE_PROMPT,
      messages: [
        {
          role: 'user',
          content:
            '请压缩以下对话历史：\n\n' +
            messages
              .map((m) => {
                const role = m.role;
                const content =
                  typeof m.content === 'string'
                    ? m.content
                    : JSON.stringify(m.content).slice(0, 500);
                return `[${role}]: ${content}`;
              })
              .join('\n'),
        },
      ],
      temperature: 0.3,
    });
    return text;
  } catch (e) {
    console.error('[summarize] 压缩失败，使用空摘要', e);
    return '（历史上下文压缩失败）';
  }
}

// ── 主入口：构建上下文 ──

export interface BuildContextResult {
  /** 传给 streamText 的消息列表 */
  messages: CoreMessage[];
  /** 系统级摘要（注入到 system prompt） */
  summary: string | null;
  /** 总 token 数 */
  totalTokens: number;
  /** 是否触发了压缩 */
  compressed: boolean;
}

export interface BuildContextOptions {
  /** 触发压缩的 token 阈值 */
  compressThreshold?: number;
  /** 保留最近消息的比例 */
  keepRecentRatio?: number;
  /** API key（前端设置），用于压缩调用 */
  apiKey?: string;
}

/**
 * 从 DB 加载历史消息，附加当前用户消息，必要时压缩。
 *
 * 返回的 messages 可直接传给 AI SDK streamText()。
 */
export async function buildContext(
  sessionId: string,
  currentPrompt: string,
  options: BuildContextOptions = {},
): Promise<BuildContextResult> {
  const threshold = options.compressThreshold ?? COMPRESS_THRESHOLD;
  const keepRatio = options.keepRecentRatio ?? KEEP_RECENT_RATIO;

  // 读取会话（含已落库的滚动摘要与断点）
  const session = await getSession(sessionId);
  const existingSummary = session?.summary ?? null;
  const summarySeq = session?.summarySeq ?? -1;

  const parse = (m: { id: string; role: string; type: string; content: string | null; metadata: string | null }) => ({
    id: m.id,
    role: m.role,
    type: m.type,
    content: m.content,
    metadata: m.metadata ? (JSON.parse(m.metadata) as Record<string, unknown>) : null,
  });

  // 1. 加载候选消息：有摘要则只取断点之后的新消息
  const dbMessages = summarySeq >= 0
    ? await getSessionMessagesAfterSeq(sessionId, summarySeq)
    : (await getSessionMessages(sessionId)).messages;
  const historyMessages = convertDbToCoreMessages(dbMessages.map(parse));

  // 2. 附加当前用户消息
  const fullMessages: CoreMessage[] = [
    ...historyMessages,
    { role: 'user', content: currentPrompt } as CoreMessage,
  ];

  // 3. Token 计数
  const totalTokens = countTokens(fullMessages);

  // 4. 未超限：直接返回（有摘要则注入 system）
  if (totalTokens <= threshold) {
    return {
      messages: fullMessages,
      summary: existingSummary,
      totalTokens,
      compressed: false,
    };
  }

  // 5. 超限：按 DB 消息条数切分（早期 → 摘要，近期 → 完整保留）
  const splitIdx = Math.max(1, Math.floor(dbMessages.length * (1 - keepRatio)));
  const earlyDb = dbMessages.slice(0, splitIdx);
  const recentDb = dbMessages.slice(splitIdx);
  const recentMessages = convertDbToCoreMessages(recentDb.map(parse));
  const compressedMessages: CoreMessage[] = [
    ...recentMessages,
    { role: 'user', content: currentPrompt } as CoreMessage,
  ];

  // 6. 生成摘要：有旧摘要则增量合并，否则首次压缩
  const earlyText = serializeDbMessages(earlyDb.map(parse));
  let summary: string;
  if (existingSummary) {
    summary = await mergeSummary(existingSummary, earlyText, (p) => summarizeText(p, options.apiKey), MAX_SUMMARY_TOKENS);
  } else {
    summary = await summarizeText(earlyText, options.apiKey);
  }

  // 7. 落库摘要 + 断点
  const newSeq = earlyDb[earlyDb.length - 1]?.sequence ?? -1;
  await saveSummary(sessionId, summary, newSeq);

  const compressedTokens = countTokens(compressedMessages);
  return {
    messages: compressedMessages,
    summary,
    totalTokens: compressedTokens + (summary ? encoder().encode(summary).length : 0),
    compressed: true,
  };
}

// ── 摘要落库 ──

/**
 * 将压缩生成的摘要写入会话记录，供后续会话恢复上下文时使用。
 * summarySeq 记录已并入摘要的最后一条消息 sequence（断点），默认 -1 表示未设置。
 */
export async function saveSummary(
  sessionId: string,
  summary: string,
  summarySeq: number = -1,
): Promise<void> {
  const tokens = encoder().encode(summary).length;
  await updateSession(sessionId, {
    summary,
    summaryTokens: tokens,
    summarySeq,
  });
}

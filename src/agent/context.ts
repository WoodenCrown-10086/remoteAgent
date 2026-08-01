import { getEncoding } from 'js-tiktoken';
import { generateText } from 'ai';
import { deepseek } from '@/lib/deepseek';
import { getSessionMessages } from '@/db/db';
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

const COMPRESS_THRESHOLD = 6000;
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

  const flushAssistant = () => {
    if (!pendingText && pendingToolCalls.length === 0) return;

    if (pendingToolCalls.length === 0) {
      // 纯文本
      result.push({ role: 'assistant', content: pendingText });
    } else {
      // 文本 + 工具调用
      const content: Array<{ type: 'text'; text: string } | { type: 'tool-call'; toolCallId: string; toolName: string; args: Record<string, unknown> }> = [];
      if (pendingText) content.push({ type: 'text', text: pendingText });
      content.push(...pendingToolCalls);
      result.push({ role: 'assistant', content });
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
      flushAssistant();
      result.push({
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: (meta.toolCallId as string) || `${meta.toolName}-${Date.now()}`,
            toolName: (meta.toolName as string) || 'unknown',
            result: meta.toolResult,
          },
        ],
      });
      continue;
    }
  }

  flushAssistant();
  return result;
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

/**
 * 调用 LLM 压缩早期消息为一段摘要文本
 */
async function summarizeMessages(
  messages: CoreMessage[],
): Promise<string> {
  try {
    const { text } = await generateText({
      model: deepseek('deepseek-v4-flash'),
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

  // 1. 从 DB 加载
  const dbMessages = await getSessionMessages(sessionId);
  const parsed = dbMessages.map((m) => ({
    id: m.id,
    role: m.role,
    type: m.type,
    content: m.content,
    metadata: m.metadata ? (JSON.parse(m.metadata) as Record<string, unknown>) : null,
  }));

  // 2. 转换为 CoreMessage
  const historyMessages = convertDbToCoreMessages(parsed);

  // 3. 附加当前用户消息
  const fullMessages: CoreMessage[] = [
    ...historyMessages,
    { role: 'user', content: currentPrompt } as CoreMessage,
  ];

  // 4. Token 计数
  const totalTokens = countTokens(fullMessages);

  // 5. 是否需要压缩？
  if (totalTokens <= threshold) {
    return {
      messages: fullMessages,
      summary: null,
      totalTokens,
      compressed: false,
    };
  }

  // 6. 压缩：切分早期消息 → LLM 压缩 → 摘要 + 近期消息
  const splitIdx = Math.floor(historyMessages.length * (1 - keepRatio));

  // 确保不在完整轮次中间切分（找到最近的 user 消息边界）
  let safeSplit = splitIdx;
  for (let i = splitIdx; i < historyMessages.length; i++) {
    if (historyMessages[i].role === 'user') {
      safeSplit = i;
      break;
    }
  }

  const earlyMessages = historyMessages.slice(0, safeSplit);
  const recentMessages = historyMessages.slice(safeSplit);

  const summary = earlyMessages.length > 0
    ? await summarizeMessages(earlyMessages)
    : null;

  const compressedMessages: CoreMessage[] = [
    ...recentMessages,
    { role: 'user', content: currentPrompt } as CoreMessage,
  ];

  const compressedTokens = countTokens(compressedMessages);

  return {
    messages: compressedMessages,
    summary,
    totalTokens: compressedTokens + (summary ? encoder().encode(summary).length : 0),
    compressed: true,
  };
}

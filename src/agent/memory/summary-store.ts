import type { SummaryData, LlmSummarizeFn } from './types';

export const MAX_SUMMARY_TOKENS = 1000;
export const COMPRESS_THRESHOLD = 15000;

export function shouldCompress(totalTokens: number, threshold: number = COMPRESS_THRESHOLD): boolean {
  return totalTokens > threshold;
}

const MERGE_PROMPT = (oldSummary: string, newContent: string) =>
  `你有一份现有摘要和新增对话。合并两者为新摘要，保留原有关键信息（用户需求/已完成任务/技术决策/待办），融合新增内容，控制在约 1000 token 以内。\n\n## 现有摘要\n${oldSummary}\n\n## 新增对话\n${newContent}\n\n## 合并后的新摘要`;

export async function mergeSummary(
  oldSummary: string,
  newContent: string,
  llm: LlmSummarizeFn,
  maxTokens: number = MAX_SUMMARY_TOKENS,
): Promise<string> {
  try {
    const result = await llm(MERGE_PROMPT(oldSummary, newContent));
    return result.trim().slice(0, maxTokens * 4); // 粗略字符上限兜底
  } catch (e) {
    console.error('[summary] 合并失败，保留旧摘要', e);
    return oldSummary;
  }
}

export function summarizeNewMessages(
  oldSummary: string | null,
  newMessagesText: string,
  llm: LlmSummarizeFn,
): Promise<string> {
  if (!oldSummary) {
    return llm(
      `将以下对话历史压缩为一段精简技术摘要（≤1000 token）：\n\n${newMessagesText}`,
    ).catch((e) => {
      console.error('[summary] 首次压缩失败', e);
      return '（历史上下文压缩失败）';
    });
  }
  return mergeSummary(oldSummary, newMessagesText, llm);
}

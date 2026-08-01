import { describe, it, expect, vi } from 'vitest';
import { mergeSummary, shouldCompress } from './summary-store';

describe('summary-store', () => {
  it('shouldCompress: token 超过阈值返回 true', () => {
    expect(shouldCompress(20000, 15000)).toBe(true);
    expect(shouldCompress(10000, 15000)).toBe(false);
  });

  it('mergeSummary: 调用 LLM 合并旧摘要与新消息', async () => {
    const mockLlm = vi.fn().mockResolvedValue('合并后的摘要');
    const result = await mergeSummary('旧摘要', '新增消息内容', mockLlm as any);
    expect(mockLlm).toHaveBeenCalledOnce();
    expect(result).toBe('合并后的摘要');
  });

  it('mergeSummary: LLM 失败时回退旧摘要', async () => {
    const mockLlm = vi.fn().mockRejectedValue(new Error('llm down'));
    const result = await mergeSummary('旧摘要', '新内容', mockLlm as any);
    expect(result).toBe('旧摘要');
  });
});

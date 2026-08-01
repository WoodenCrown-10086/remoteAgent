import { describe, it, expect, vi, beforeEach } from 'vitest';
import { VectorStore } from './vector-store';

describe('VectorStore', () => {
  let store: VectorStore;
  const fakeEmbed: any = {
    name: 'fake',
    dimension: 4,
    embed: vi.fn(async (texts: string[]) => texts.map((t: string) => [t.length, 1, 1, 1])),
  };

  beforeEach(() => {
    store = new VectorStore(fakeEmbed);
  });

  it('chunkText: 长文本按 500 字符切片', () => {
    const chunks = store.chunkText('a'.repeat(1200));
    expect(chunks).toHaveLength(3);
  });

  it('search 返回按相似度排序的结果', async () => {
    await store.upsert({ id: '1', sessionId: 's1', content: 'abc', kind: 'user', seqFrom: 1, seqTo: 1, embedding: [3,1,1,1] });
    await store.upsert({ id: '2', sessionId: 's1', content: 'xyz', kind: 'assistant_text', seqFrom: 2, seqTo: 2, embedding: [1,1,1,1] });
    const results = await store.search([1,1,1,1], 's1', 5);
    expect(results[0].content).toBe('xyz');
  });
});

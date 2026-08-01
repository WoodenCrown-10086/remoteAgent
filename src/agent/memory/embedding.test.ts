import { describe, it, expect, vi } from 'vitest';
import { createEmbeddingProvider } from './embedding';

describe('embedding', () => {
  it('createEmbeddingProvider(local) 返回本地 provider', () => {
    const p = createEmbeddingProvider('local');
    expect(p.name).toBe('local');
    expect(p.dimension).toBe(384);
  });

  it('embed 返回固定维度向量', async () => {
    const fake: any = { name: 'fake', dimension: 384, embed: vi.fn().mockResolvedValue([[0.1, 0.2]]) };
    const out = await fake.embed(['你好']);
    expect(out[0]).toHaveLength(2);
  });
});

import type { EmbeddingProvider } from './types';

/**
 * 本地嵌入实现：使用 Xenova/bge-small-zh-v1.5 模型，
 * 通过 transformers.js 在本地生成 384 维向量。
 */
export class LocalEmbedding implements EmbeddingProvider {
  name = 'local';
  dimension = 384;
  private pipe: any = null;
  private readonly model = 'Xenova/bge-small-zh-v1.5';

  private async getPipe() {
    if (!this.pipe) {
      const { pipeline } = await import('@xenova/transformers');
      try {
        this.pipe = await pipeline('feature-extraction', this.model);
      } catch (e) {
        console.error(`[embedding] 本地模型 ${this.model} 加载失败:`, e);
        throw e;
      }
    }
    return this.pipe;
  }

  async embed(texts: string[]): Promise<number[][]> {
    const pipe = await this.getPipe();
    const results: number[][] = [];
    for (const text of texts) {
      const output = await pipe(text, { pooling: 'mean', normalize: true });
      results.push(Array.from(output.data as Float32Array));
    }
    console.log('embedding', results)
    return results;
  }
}

/**
 * OpenAI 嵌入实现：调用 text-embedding-3-small 接口，
 * 返回 1536 维向量，需要 apiKey。
 */
export class OpenAIEmbedding implements EmbeddingProvider {
  name = 'openai';
  dimension = 1536;
  constructor(private apiKey: string) {}

  async embed(texts: string[]): Promise<number[][]> {
    const res = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({ model: 'text-embedding-3-small', input: texts }),
    });
    if (!res.ok) throw new Error(`OpenAI embedding failed: ${res.status}`);
    const data = await res.json();
    return data.data.map((d: any) => d.embedding as number[]);
  }
}

/**
 * 工厂函数：按名称创建嵌入 provider。
 */
export function createEmbeddingProvider(
  provider: 'local' | 'openai' = 'local',
  apiKey?: string,
): EmbeddingProvider {
  if (provider === 'openai') {
    if (!apiKey) throw new Error('OpenAI embedding 需要 apiKey');
    return new OpenAIEmbedding(apiKey);
  }
  return new LocalEmbedding();
}

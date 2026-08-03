import type { EmbeddingProvider } from './types';

/**
 * Gemini 嵌入实现：调用 Google Gemini text-embedding-004 API。
 * 纯 HTTP，无原生依赖，Serverless/容器环境均可用。
 * 返回 768 维向量，需要 GEMINI_API_KEY。
 */
export class GeminiEmbedding implements EmbeddingProvider {
  name = 'gemini';
  dimension = 768;
  private readonly model = 'text-embedding-004';
  private readonly baseURL = 'https://generativelanguage.googleapis.com/v1beta';

  constructor(private apiKey: string) {}

  async embed(texts: string[]): Promise<number[][]> {
    const res = await fetch(
      `${this.baseURL}/models/${this.model}:batchEmbedContents?key=${this.apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          requests: texts.map((text) => ({
            model: `models/${this.model}`,
            content: { parts: [{ text }] },
          })),
        }),
      },
    );
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Gemini embedding failed: ${res.status} ${errText.slice(0, 200)}`);
    }
    const data = await res.json();
    return (data.embeddings || []).map((e: any) => e.values as number[]);
  }
}

/**
 * OpenAI 兼容嵌入实现：任何 OpenAI 格式的 embedding 服务（OpenAI / 硅基流动 / 智谱等）。
 * baseURL 与 model 可配置，默认 OpenAI text-embedding-3-small。
 */
export class OpenAIEmbedding implements EmbeddingProvider {
  name = 'openai';
  dimension: number;
  constructor(
    private apiKey: string,
    private baseURL = 'https://api.openai.com/v1',
    private model = 'text-embedding-3-small',
    dimension: number = 1536,
  ) {
    this.dimension = dimension;
  }

  async embed(texts: string[]): Promise<number[][]> {
    const res = await fetch(`${this.baseURL}/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({ model: this.model, input: texts }),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Embedding API failed (${this.baseURL}): ${res.status} ${errText.slice(0, 200)}`);
    }
    const data = await res.json();
    return data.data.map((d: any) => d.embedding as number[]);
  }
}

/**
 * 禁用嵌入实现：零依赖兜底（记忆退化为摘要+全量）。
 */
export class NoopEmbedding implements EmbeddingProvider {
  name = 'none';
  dimension = 0;
  async embed(_texts: string[]): Promise<number[][]> {
    throw new Error('Embedding 已禁用（EMBEDDING_PROVIDER=none）');
  }
}

/**
 * 工厂函数：按名称创建嵌入 provider。
 * - gemini: Google Gemini text-embedding-004
 * - openai: OpenAI text-embedding-3-small
 * - http: 任意 OpenAI 兼容服务（硅基流动/智谱等），
 *        配置 EMBEDDING_BASE_URL / EMBEDDING_MODEL / EMBEDDING_API_KEY / EMBEDDING_DIMENSION
 * - none: 禁用向量记忆
 */
export function createEmbeddingProvider(
  provider: 'gemini' | 'openai' | 'http' | 'none' = 'gemini',
  apiKey?: string,
): EmbeddingProvider {
  if (provider === 'openai') {
    if (!apiKey) throw new Error('OpenAI embedding 需要 apiKey');
    return new OpenAIEmbedding(apiKey);
  }
  if (provider === 'http') {
    const baseURL =
      process.env.EMBEDDING_BASE_URL || 'https://api.siliconflow.cn/v1';
    const model =
      process.env.EMBEDDING_MODEL || 'Qwen/Qwen3-Embedding-0.6B';
    const key = process.env.EMBEDDING_API_KEY || apiKey;
    const dim = parseInt(process.env.EMBEDDING_DIMENSION || '1024', 10);
    if (!key) throw new Error('HTTP embedding 需要 apiKey（EMBEDDING_API_KEY）');
    return new OpenAIEmbedding(key, baseURL, model, dim);
  }
  if (provider === 'none') {
    return new NoopEmbedding();
  }
  // 默认 gemini
  if (!apiKey) throw new Error('Gemini embedding 需要 apiKey（GEMINI_API_KEY）');
  return new GeminiEmbedding(apiKey);
}

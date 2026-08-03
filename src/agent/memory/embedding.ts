import type { EmbeddingProvider } from './types';

// ── 模型来源配置 ──
// transformers.js 首次加载模型会从 HuggingFace Hub 下载（bge-small-zh 约 100MB）。
// 网络受限时提供两种替代：
//   1. HF 镜像：默认走 hf-mirror.com（中国网络友好），可用环境变量 HF_ENDPOINT 覆盖
//   2. 本地模型：设 EMBEDDING_LOCAL_PATH 指向已下载的模型目录，完全离线
// 模型下载成功后缓存到 node_modules 缓存目录，后续无需重复下载。
//
// 重要：必须使用动态 import —— @xenova/transformers 在模块顶层静态 import
// onnxruntime-node（原生 C++ 模块）。若此处静态导入，Vercel Serverless 等
// 无 libonnxruntime.so 的环境在加载本模块时即崩溃。动态 import 确保只有
// 真正使用本地嵌入时才加载原生依赖；Serverless 部署请用
// EMBEDDING_PROVIDER=openai（纯 HTTP，无原生依赖）。

async function configureTransformersEnv() {
  // 动态 import：仅在使用本地嵌入时才加载原生模块
  const { env } = await import('@xenova/transformers');

  // 允许本地模型优先
  env.allowLocalModels = true;
  env.allowRemoteModels = true;

  // 模型缓存目录（Docker 构建时预下载进镜像，运行时挂载卷）
  if (process.env.MODEL_CACHE_DIR) {
    env.cacheDir = process.env.MODEL_CACHE_DIR;
  }

  const localPath = process.env.EMBEDDING_LOCAL_PATH;
  if (localPath) {
    // 完全离线模式：使用本地模型目录
    env.localModelPath = localPath.endsWith('/') ? localPath : localPath + '/';
    console.log(`[embedding] 使用本地模型: ${env.localModelPath}`);
  } else {
    // 远程模式：默认 HF 镜像，可用 HF_ENDPOINT 覆盖
    env.remoteHost = process.env.HF_ENDPOINT || 'https://hf-mirror.com/';
    console.log(
      `[embedding] model download source: ${env.remoteHost} ` +
        `(override with HF_ENDPOINT, or set EMBEDDING_LOCAL_PATH for local)`,
    );
  }
}

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
      await configureTransformersEnv();
      try {
        this.pipe = await pipeline('feature-extraction', this.model);
      } catch (e) {
        // 注意: 此消息避免使用全角标点（。，：）
        // next-code-frame 的 Rust 高亮按字节切片, 多字节字符会触发 panic
        console.error(
          `[embedding] model ${this.model} load failed. ` +
            `Set HF_ENDPOINT=https://hf-mirror.com/ or EMBEDDING_LOCAL_PATH=... ` +
            `to use mirror/local model.`,
          e,
        );
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
 * 禁用嵌入实现：Serverless 环境（如 Vercel）无原生依赖时的安全兜底。
 * 不加载任何模型，embed 返回空（向量记忆停用，记忆退化为摘要+全量）。
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
 * - local: transformers.js 本地模型（需原生依赖，Serverless 不可用）
 * - openai: OpenAI API（纯 HTTP，Serverless 推荐）
 * - none: 禁用向量记忆（零依赖兜底）
 */
export function createEmbeddingProvider(
  provider: 'local' | 'openai' | 'none' = 'local',
  apiKey?: string,
): EmbeddingProvider {
  if (provider === 'openai') {
    if (!apiKey) throw new Error('OpenAI embedding 需要 apiKey');
    return new OpenAIEmbedding(apiKey);
  }
  if (provider === 'none') {
    return new NoopEmbedding();
  }
  return new LocalEmbedding();
}

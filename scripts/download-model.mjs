// ── 模型预下载脚本（Docker 构建阶段调用） ──
// 用法: node scripts/download-model.mjs
// 提前把 bge-small-zh 模型下载到 MODEL_CACHE_DIR（默认 /app/model-cache），
// 打进 Docker 镜像，避免运行时首次请求才下载（冷启动慢）。
import { pipeline, env } from '@xenova/transformers';

const cacheDir = process.env.MODEL_CACHE_DIR || '/app/model-cache';
env.cacheDir = cacheDir;
// 国内网络可用 HF_ENDPOINT=https://hf-mirror.com/ 走镜像
env.remoteHost = process.env.HF_ENDPOINT || 'https://hf-mirror.com/';
env.allowLocalModels = true;
env.allowRemoteModels = true;

const MODEL = 'Xenova/bge-small-zh-v1.5';

console.log(`[download-model] 开始下载 ${MODEL} → ${cacheDir}`);
const extractor = await pipeline('feature-extraction', MODEL);
// 触发一次实际推理，确保模型文件完整
const out = await extractor('测试', { pooling: 'mean', normalize: true });
console.log(
  `[download-model] 完成，向量维度=${out.data.length}，缓存目录=${cacheDir}`,
);

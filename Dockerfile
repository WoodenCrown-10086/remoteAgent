# ── 构建阶段：安装依赖（含原生模块编译） + 预下载模型 ──
FROM node:20-slim AS builder
WORKDIR /app

# 原生依赖编译工具链（better-sqlite3 / onnxruntime 需要）
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# 先装依赖（利用 Docker 层缓存）
COPY package.json package-lock.json ./
RUN npm install

# 拷贝源码（排除 .dockerignore 中的项）
COPY . .

# 预下载嵌入模型到镜像（可选；网络不通时可注释此行，运行时首次调用再下载）
ENV MODEL_CACHE_DIR=/app/model-cache
RUN node scripts/download-model.mjs || echo "模型预下载失败（运行时将按需下载）"

# 生产构建
ENV NODE_ENV=production
RUN npm run build

# ── 运行阶段 ──
FROM node:20-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# 运行所需的最小系统库（原生模块运行时不需编译工具链）
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# 从 builder 复制完整 node_modules（含 linux 平台原生模块）
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/public ./public
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/next.config.ts ./next.config.ts
COPY --from=builder /app/tsconfig.json ./tsconfig.json
COPY --from=builder /app/src ./src
# 模型缓存（预下载的模型）
COPY --from=builder /app/model-cache ./model-cache

# SQLite 数据目录（挂载卷持久化）
RUN mkdir -p /app/data
VOLUME ["/app/data"]

EXPOSE 3000

# 环境变量（由 docker run -e 传入，不入镜像）
# DEEPSEEK_API_KEY、E2B_API_KEY、EMBEDDING_PROVIDER、HF_ENDPOINT 等

CMD ["npm", "run", "start"]

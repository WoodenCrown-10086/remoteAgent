# 记忆管理演进设计（Layered Memory）

- **日期**: 2026-08-01
- **状态**: 已确认（用户审阅后进入实现计划）
- **涉及模块**: `src/agent/context.ts` → `src/agent/memory/`
- **关联方向**: 增量压缩 / 向量记忆 / 多 Agent 抽离

## 背景与现状

当前上下文管理（`src/agent/context.ts`）存在三个问题：

1. **压缩结果不落库**：每次请求从 DB 取全量消息 → 转换 → 计数 → 超过阈值压缩早期 55%。压缩结果丢弃，下一轮重新计算，成本随轮次线性增长。
2. **无向量检索**：messages 表纯文本存储，Agent 无法按语义检索历史。
3. **未抽离**：context 逻辑是单模块函数，多 Agent 协同时代码会纠缠。

### 当前参数

| 参数 | 当前值 | 新值 |
|---|---|---|
| `COMPRESS_THRESHOLD` | 6000 | **15000** |
| 摘要 token 上限 | 无 | **1000** |
| 保留近期比例 | 0.45 | 0.45（不变） |

## 目标架构：分层记忆（Layered Memory）

```
┌────────────────────────────────────────────┐
│ Layer 3: 当前上下文 (working context)       │
│   近期完整消息 + 当前 prompt → streamText   │
├────────────────────────────────────────────┤
│ Layer 2: 滚动摘要 (rolling summary)  方向1  │
│   历史摘要增量更新、落库，不再每轮重算       │
├────────────────────────────────────────────┤
│ Layer 1: 向量记忆 (vector memory)    方向2  │
│   全量消息 embedding → sqlite-vec            │
│   agent 通过 memory_search 工具按需检索      │
└────────────────────────────────────────────┘
        ↕ 统一由 ContextManager 管理    方向3
```

## 方案选型

选定 **方案 A：模块化分层**（用户确认）。

```
src/agent/memory/
├── types.ts               # MemoryContext / SearchResult / EmbeddingProvider 接口
├── summary-store.ts       # 方向1：滚动摘要（增量压缩）
├── vector-store.ts        # 方向2：sqlite-vec 向量存储 + 可插拔嵌入
└── context-manager.ts     # 方向3：统一入口，组装三层记忆
```

现有 `src/agent/context.ts` 重构为薄封装，转发到 `context-manager.ts`，保持 `buildContext()` 签名不变，route.ts 调用点零改动。

## 方向1：滚动摘要（增量压缩）

### 核心变化

```
现在（每轮全量重算）：
  DB 全量 1758 条 → 转换 → 计数 → 超限就压缩 55% → 每轮重复

改为（增量滚动摘要）：
  首次超限时：全量压缩 → 摘要 S1 落库（sessions.summary）
  后续每轮：  S1 + 新增消息 → 计数
    ├─ 没超限 → S1 原样用
    └─ 超限   → S1 + 最近一轮消息喂 LLM → 新摘要 S2 覆盖落库
```

### 增量合并算法

```
输入: 旧摘要 S_old + 近期新增消息 M_new
输出: 新摘要 S_new

LLM prompt:
  "你有一份现有摘要和新增对话。合并两者为新摘要：
   保留原有关键信息，融合新增内容，控制在 ~1000 token。"
```

- 摘要 token 上限：**1000**（`MAX_SUMMARY_TOKENS`）
- **全量重压缩兜底**：`S_old + M_new` 合并后仍超上限 → 从 DB 全量重压缩一次
- **会话首次**：无摘要 → 走原全量逻辑

### 成本收益

| 轮次 | 现在 | 改进后 |
|---|---|---|
| 1-5 轮 | 全量转换 | 全量转换（一样） |
| 6 轮（首次超限） | 压缩全量 | 压缩全量（首次） |
| 7 轮 | 再压缩全量 | 合并 S1 + 新增几十条 |
| 20 轮 | 再压缩全量 | 合并 S_n + 新增 |

## 方向2：向量记忆（sqlite-vec + 可插拔嵌入）

### 嵌入抽象

```ts
// types.ts
export interface EmbeddingProvider {
  name: string;
  embed(texts: string[]): Promise<number[][]>;
  dimension: number;
}

// 方案1：本地（默认）— @xenova/transformers 跑 bge-small-zh（384 维），零依赖离线
export class LocalEmbedding implements EmbeddingProvider { ... }

// 方案2：OpenAI（可选切换）— text-embedding-3-small（1536 维）
export class OpenAIEmbedding implements EmbeddingProvider { ... }

// 工厂：.env 配置 EMBEDDING_PROVIDER=local|openai
export function createEmbeddingProvider(apiKey?: string): EmbeddingProvider
```

### 向量化时机与粒度

- 消息落库时（persist）→ **异步**向量化（不阻塞 SSE）
- 只向量化"语义完整"的消息：user 消息 / assistant 文本块（合并后）/ tool_result 输出 / 文件写入内容
- 单条 > 500 token 的内容切片为多块（保留 seq 范围）

### 检索工具

新增工具 `memory_search`（沙箱无关，本地执行）：

```
memory_search(query: string, k?: number = 5)
  → 返回 [{ content, kind, sessionId, score }]
```

- 仅**在上下文被压缩后启用**（近期消息已全量在上下文，无需检索）
- 默认只查当前 session，可选跨 session

### sqlite-vec 集成

```bash
npm install sqlite-vec
```

```ts
import * as vec from 'sqlite-vec';
vec.load(db);  // 注册 vec0 虚拟表
```

**维度注意**：本地嵌入 384 维 / OpenAI 1536 维不同，虚拟表按维度建。推荐统一用本地 384 维；切换 OpenAI 时重建该 provider 的表。

## 方向3：ContextManager（多 Agent 抽离）

```ts
// context-manager.ts
export class ContextManager {
  constructor(private opts: {
    sessionId: string;
    embeddingProvider: EmbeddingProvider;
    apiKey?: string;
  }) {}

  async buildContext(prompt: string): Promise<BuildContextResult>;  // 组装三层记忆
  async onMessagePersisted(msg: Message): Promise<void>;  // 摘要增量 + 向量化
  async search(query: string, k?: number): Promise<SearchResult[]>;  // memory_search 实现
  dispose(): void;
}
```

### 多 Agent 共享模式

```
codingAgent  → new ContextManager({ sessionId: S, ... })
reviewAgent  → new ContextManager({ sessionId: S, ... })

共享 sessionId → 共享同一份记忆（coding 写完 review 能看到）
不同 sessionId → 各自独立记忆
search 支持跨会话过滤
```

**记忆绑定在 `sessionId` 上，不绑定在 Agent 上**——换 Agent 不丢记忆，加 Agent 共享记忆。

## DB Schema 变更

```ts
// sessions 表新增
summary: text('summary'),
summary_tokens: integer('summary_tokens'),

// 新增 message_chunks 表
export const messageChunks = sqliteTable('message_chunks', {
  id: text('id').primaryKey(),
  sessionId: text('session_id').references(() => sessions.id, { onDelete: 'cascade' }),
  sourceMessageId: text('source_message_id'),
  content: text('content'),
  embedding: text('embedding'),           // JSON 数组
  kind: text('kind'),                     // user / assistant_text / tool_result / file
  seqFrom: integer('seq_from'),
  seqTo: integer('seq_to'),
  createdAt: text('created_at'),
});
```

## 错误处理策略

| 场景 | 策略 |
|---|---|
| 嵌入失败（本地模型加载 / OpenAI 超时） | 降级：跳过向量化，memory_search 返回空 + 提示；不影响主 Agent |
| 摘要合并失败 | 降级：保留旧摘要，下次重试；不阻断请求 |
| sqlite-vec 扩展未加载 | 启动检测，失败则禁用向量（`vectorEnabled=false`），退化为"摘要 + 全量" |
| 切分消息失败 | 跳过该消息向量化，记日志 |

**核心原则：记忆系统是增强层，任何故障都不能阻断主 Agent。**

## 测试计划

| 测试 | 内容 |
|---|---|
| `summary-store.test.ts` | 增量合并、摘要超限重压缩、首轮无摘要 |
| `vector-store.test.ts` | embedding 维度一致性、K 近邻检索、跨会话过滤 |
| `context-manager.test.ts` | 三层组装、压缩触发边界（15000） |
| 集成测试 | 模拟 30 轮对话，验证 token 成本下降 + 记忆不丢 |

## 实现顺序

```
Phase 1: summary-store（方向1）→ 独立可用，立即省成本
Phase 2: vector-store + memory_search 工具（方向2）
Phase 3: context-manager 统一封装（方向3）+ 现有 context.ts 重构
```

## 依赖新增

```bash
npm install sqlite-vec @xenova/transformers
# OpenAI 嵌入方案可选，切换时配置 EMBEDDING_PROVIDER=openai
```

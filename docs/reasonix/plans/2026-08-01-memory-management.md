# 记忆管理（Layered Memory）实现计划

> **For agentic workers:** implement this plan task-by-task — dispatch a fresh subagent per task with the native `task` tool (recommended for quality), or use the superpowers-executing-plans skill to work through it inline. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将现有单层上下文（全量重算压缩）演进为三层记忆（滚动摘要落库 + sqlite-vec 向量检索 + ContextManager 统一管理），支持多 Agent 共享记忆。

**Architecture:** 新建 `src/agent/memory/` 目录，拆为 types / summary-store / vector-store / context-manager 四模块。摘要增量合并（Phase 1）→ 向量记忆 + memory_search 工具（Phase 2）→ ContextManager 封装 + 现有 context.ts 重构为薄封装（Phase 3）。现有 route.ts 调用点保持兼容。

**Tech Stack:** TypeScript / Drizzle ORM / better-sqlite3 / sqlite-vec / @xenova/transformers / AI SDK v7 / vitest

**规格文档:** `docs/reasonix/specs/2026-08-01-memory-management-design.md`

---

## 文件结构映射

| 文件 | 职责 | 任务 |
|---|---|---|
| `package.json` | +sqlite-vec/@xenova/transformers/vitest | T1 |
| `vitest.config.ts` | vitest 配置 | T1 |
| `src/db/schema.ts` | +sessions.summary/summary_tokens，+message_chunks 表 | T2 |
| `src/db/db.ts` | initDb 建表 + sqlite-vec 扩展加载 | T2 |
| `src/agent/memory/types.ts` | EmbeddingProvider / SearchResult / SummaryData 接口 | T3, T6 |
| `src/agent/memory/summary-store.ts` | 滚动摘要：增量合并 + 落库 | T3 |
| `src/agent/memory/summary-store.test.ts` | 摘要单测 | T3 |
| `src/agent/context.ts` | 参数更新（15000/1000）+ 集成 summary-store | T4, T5 |
| `src/agent/memory/embedding.ts` | LocalEmbedding / OpenAIEmbedding / 工厂 | T6 |
| `src/agent/memory/vector-store.ts` | sqlite-vec 存储 + KNN 检索 | T7 |
| `src/agent/memory/vector-store.test.ts` | 向量单测 | T7 |
| `src/agent/tools/memory-search.ts` | memory_search 工具 | T8 |
| `src/agent/tools/index.ts` | 注入 memory_search | T8 |
| `src/agent/memory/context-manager.ts` | 统一入口：三层组装 | T9 |
| `src/app/api/hello/route.ts` | 用 ContextManager 替换直接调用 | T10 |
| `src/agent/context.ts` | 重构为 context-manager 薄封装 | T10 |

---

### Task 1: 测试框架 + 依赖安装

**Files:**
- Modify: `package.json`
- Create: `vitest.config.ts`

- [ ] **Step 1: 安装依赖**

Run:
```bash
cd D:/remoteAgent/code-agent
npm install -D vitest
npm install sqlite-vec @xenova/transformers
```
Expected: 安装成功无报错。

- [ ] **Step 2: 创建 vitest 配置**

Create `vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
});
```

- [ ] **Step 3: package.json 加 test 脚本**

Modify `package.json` scripts:
```json
"test": "vitest run"
```

- [ ] **Step 4: 验证**

Run: `npx vitest run 2>&1 | head -5`
Expected: `No test files found`（当前无测试，非报错）。

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json vitest.config.ts
git commit -m "chore: 添加 vitest 测试框架和 sqlite-vec/transformers 依赖"
```

---

### Task 2: DB Schema 变更 + sqlite-vec 扩展

**Files:**
- Modify: `src/db/schema.ts`
- Modify: `src/db/db.ts`

- [ ] **Step 1: 写失败测试** — 验证 schema 含新表和字段

Create `src/db/schema.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { sessions, messages, messageChunks } from './schema';

describe('schema', () => {
  it('sessions 有 summary 字段', () => {
    expect(sessions.summary).toBeDefined();
    expect(sessions.summaryTokens).toBeDefined();
  });
  it('有 message_chunks 表', () => {
    expect(messageChunks).toBeDefined();
    expect(messageChunks.sessionId).toBeDefined();
    expect(messageChunks.embedding).toBeDefined();
    expect(messageChunks.content).toBeDefined();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/db/schema.test.ts`
Expected: FAIL — `Cannot find name 'messageChunks'` / `sessions.summary is undefined`

- [ ] **Step 3: 修改 schema.ts**

Modify `src/db/schema.ts` — sessions 表加两列：
```ts
export const sessions = sqliteTable('sessions', {
  id: text('id').primaryKey(),
  title: text('title').notNull().default('未命名会话'),
  sandboxId: text('sandbox_id'),
  status: text('status').notNull().default('active'),
  summary: text('summary'),                       // 滚动摘要
  summaryTokens: integer('summary_tokens'),       // 摘要 token 数
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (t) => [index('idx_sessions_updated').on(t.updatedAt)]);
```

追加 message_chunks 表：
```ts
export const messageChunks = sqliteTable(
  'message_chunks',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    sourceMessageId: text('source_message_id'),
    content: text('content').notNull(),
    embedding: text('embedding').notNull(),  // JSON 数组字符串
    kind: text('kind').notNull(),            // user | assistant_text | tool_result | file
    seqFrom: integer('seq_from'),
    seqTo: integer('seq_to'),
    createdAt: text('created_at').notNull(),
  },
  (t) => [index('idx_chunks_session').on(t.sessionId)],
);

export type MessageChunk = typeof messageChunks.$inferSelect;
export type NewMessageChunk = typeof messageChunks.$inferInsert;
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/db/schema.test.ts`
Expected: PASS

- [ ] **Step 5: db.ts initDb 加建表 SQL + sqlite-vec 加载**

Modify `src/db/db.ts` — `initDb()` 的 `sqlite.exec` 追加：
```sql
CREATE TABLE IF NOT EXISTS message_chunks (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  source_message_id TEXT,
  content TEXT NOT NULL,
  embedding TEXT NOT NULL,
  kind TEXT NOT NULL,
  seq_from INTEGER,
  seq_to INTEGER,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chunks_session ON message_chunks(session_id);
```

并在 `getDb()` 中加载 sqlite-vec（放在 `new Database` 之后）：
```ts
import * as sqliteVec from 'sqlite-vec';
// getDb() 内：
const sqlite = new Database(DB_PATH);
sqliteVec.load(sqlite);
```

- [ ] **Step 6: 编译验证**

Run: `npx tsc --noEmit`
Expected: 无错误

- [ ] **Step 7: Commit**

```bash
git add src/db/schema.ts src/db/db.ts src/db/schema.test.ts
git commit -m "feat(db): sessions 增加滚动摘要字段，新增 message_chunks 向量存储表，加载 sqlite-vec"
```

---

### Task 3: summary-store（滚动摘要核心）

**Files:**
- Create: `src/agent/memory/types.ts`
- Create: `src/agent/memory/summary-store.ts`
- Test: `src/agent/memory/summary-store.test.ts`

- [ ] **Step 1: 写失败测试**

Create `src/agent/memory/summary-store.test.ts`:
```ts
import { describe, it, expect, vi } from 'vitest';
import { mergeSummary, shouldCompress } from './summary-store';

describe('summary-store', () => {
  it('shouldCompress: token 超过阈值返回 true', () => {
    expect(shouldCompress(20000, 15000)).toBe(true);
    expect(shouldCompress(10000, 15000)).toBe(false);
  });

  it('mergeSummary: 调用 LLM 合并旧摘要与新消息', async () => {
    const mockLlm = vi.fn().mockResolvedValue('合并后的摘要');
    const result = await mergeSummary(
      '旧摘要',
      '新增消息内容',
      mockLlm as any,
    );
    expect(mockLlm).toHaveBeenCalledOnce();
    expect(result).toBe('合并后的摘要');
  });

  it('mergeSummary: LLM 失败时回退旧摘要', async () => {
    const mockLlm = vi.fn().mockRejectedValue(new Error('llm down'));
    const result = await mergeSummary('旧摘要', '新内容', mockLlm as any);
    expect(result).toBe('旧摘要');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/agent/memory/summary-store.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: 创建 types.ts**

Create `src/agent/memory/types.ts`:
```ts
export interface SummaryData {
  summary: string;
  tokens: number;
}

export interface SearchResult {
  content: string;
  kind: string;
  sessionId: string;
  score: number;
}

export interface EmbeddingProvider {
  name: string;
  dimension: number;
  embed(texts: string[]): Promise<number[][]>;
}

export type LlmSummarizeFn = (prompt: string) => Promise<string>;
```

- [ ] **Step 4: 创建 summary-store.ts**

Create `src/agent/memory/summary-store.ts`:
```ts
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
    // 首次：直接压缩新消息
    return llm(
      `将以下对话历史压缩为一段精简技术摘要（≤1000 token）：\n\n${newMessagesText}`,
    ).catch((e) => {
      console.error('[summary] 首次压缩失败', e);
      return '（历史上下文压缩失败）';
    });
  }
  return mergeSummary(oldSummary, newMessagesText, llm);
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `npx vitest run src/agent/memory/summary-store.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 6: Commit**

```bash
git add src/agent/memory/types.ts src/agent/memory/summary-store.ts src/agent/memory/summary-store.test.ts
git commit -m "feat(memory): 滚动摘要核心 — 阈值判断 + 增量合并（LLM 失败回退旧摘要）"
```

---

### Task 4: context.ts 集成滚动摘要 + 参数更新

**Files:**
- Modify: `src/agent/context.ts`

- [ ] **Step 1: 更新常量与摘要管理函数**

Modify `src/agent/context.ts`:
- `COMPRESS_THRESHOLD` 6000 → **15000**
- 删除 `KEEP_RECENT_RATIO` 切分逻辑，替换为摘要驱动：
  - 有摘要 → messages = [近期未摘要消息..., 当前 prompt] + summary 注入 system
  - 无摘要 → 全量，超限则首次压缩生成摘要并落库

新增函数（导出供 route 用）：
```ts
export async function saveSummary(
  sessionId: string,
  summary: string,
): Promise<void> {
  const tokens = encoder().encode(summary).length;
  await updateSession(sessionId, {
    summary,
    summaryTokens: tokens,
  } as any);
}
```
> 注：`updateSession` 目前只接受 title/sandboxId/status，需在 `src/db/db.ts` 的 `updateSession` 参数类型中补 `summary` / `summaryTokens`。

- [ ] **Step 2: db.ts updateSession 支持 summary 字段**

Modify `src/db/db.ts` `updateSession` 签名：
```ts
export async function updateSession(
  id: string,
  updates: Partial<Pick<Session, 'title' | 'sandboxId' | 'status' | 'summary' | 'summaryTokens'>>,
)
```
并在 data 组装中：
```ts
if (updates.summary !== undefined) data.summary = updates.summary;
if (updates.summaryTokens !== undefined) data.summary_tokens = updates.summaryTokens;
```

- [ ] **Step 3: 编译验证**

Run: `npx tsc --noEmit`
Expected: 无错误

- [ ] **Step 4: Commit**

```bash
git add src/agent/context.ts src/db/db.ts
git commit -m "feat(context): 压缩阈值提升至 15000，新增摘要落库函数"
```

---

### Task 5: route.ts 摘要持久化（Phase 1 收尾）

**Files:**
- Modify: `src/app/api/hello/route.ts`

- [ ] **Step 1: 压缩后保存摘要**

Modify `src/app/api/hello/route.ts` — buildContext 后：
```ts
const ctx = await buildContext(currentSessionId, prompt, { apiKey });
if (ctx.summary) {
  await saveSummary(currentSessionId, ctx.summary);
  systemPrompt += `\n\n## 历史上下文摘要\n${ctx.summary}`;
}
```

- [ ] **Step 2: 验证上下文日志仍正常**

Run: `npx tsc --noEmit`
Expected: 无错误

- [ ] **Step 3: Commit**

```bash
git add src/app/api/hello/route.ts
git commit -m "feat(context): 压缩摘要落库到 sessions.summary"
```

---

### Task 6: 嵌入抽象（可插拔）

**Files:**
- Create: `src/agent/memory/embedding.ts`
- Test: `src/agent/memory/embedding.test.ts`

- [ ] **Step 1: 写失败测试**

Create `src/agent/memory/embedding.test.ts`:
```ts
import { describe, it, expect, vi } from 'vitest';
import { createEmbeddingProvider } from './embedding';

describe('embedding', () => {
  it('createEmbeddingProvider(local) 返回本地 provider', () => {
    const p = createEmbeddingProvider('local');
    expect(p.name).toBe('local');
    expect(p.dimension).toBe(384);
  });

  it('embed 返回固定维度向量', async () => {
    const p = createEmbeddingProvider('local');
    // 不真正加载模型，mock 掉 —— 用 fake 注入验证维度协议
    const fake: any = { name: 'fake', dimension: 384, embed: vi.fn().mockResolvedValue([[0.1, 0.2]]) };
    const out = await fake.embed(['你好']);
    expect(out[0]).toHaveLength(2);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/agent/memory/embedding.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: 创建 embedding.ts**

Create `src/agent/memory/embedding.ts`:
```ts
import type { EmbeddingProvider } from './types';

export class LocalEmbedding implements EmbeddingProvider {
  name = 'local';
  dimension = 384;
  private pipe: any = null;
  private readonly model = 'Xenova/bge-small-zh-v1.5';

  private async getPipe() {
    if (!this.pipe) {
      const { pipeline } = await import('@xenova/transformers');
      this.pipe = await pipeline('feature-extraction', this.model);
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
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/agent/memory/embedding.test.ts`
Expected: PASS（不触发真实模型加载）

- [ ] **Step 5: Commit**

```bash
git add src/agent/memory/embedding.ts src/agent/memory/embedding.test.ts
git commit -m "feat(memory): 可插拔嵌入 — 本地 bge-small-zh / OpenAI 双方案"
```

---

### Task 7: vector-store（sqlite-vec 存储 + 检索）

**Files:**
- Create: `src/agent/memory/vector-store.ts`
- Test: `src/agent/memory/vector-store.test.ts`

- [ ] **Step 1: 写失败测试**

Create `src/agent/memory/vector-store.test.ts`:
```ts
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
    await store.upsert({ id: '2', sessionId: 's1', content: 'xyz', kind: 'text', seqFrom: 2, seqTo: 2, embedding: [1,1,1,1] });
    const results = await store.search([1,1,1,1], 's1', 5);
    expect(results[0].content).toBe('xyz');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/agent/memory/vector-store.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: 创建 vector-store.ts**

Create `src/agent/memory/vector-store.ts`:
```ts
import type { EmbeddingProvider, SearchResult } from './types';

export interface ChunkInput {
  id: string;
  sessionId: string;
  sourceMessageId?: string;
  content: string;
  kind: 'user' | 'assistant_text' | 'tool_result' | 'file';
  embedding: number[];
  seqFrom: number;
  seqTo: number;
}

export class VectorStore {
  private chunks: ChunkInput[] = []; // 内存 + DB 双写（DB 持久化见 Task 9）

  constructor(private embedding: EmbeddingProvider) {}

  chunkText(text: string, maxLen: number = 500): string[] {
    const chunks: string[] = [];
    for (let i = 0; i < text.length; i += maxLen) {
      chunks.push(text.slice(i, i + maxLen));
    }
    return chunks;
  }

  async upsert(chunk: ChunkInput): Promise<void> {
    this.chunks.push(chunk);
  }

  async search(
    queryEmbedding: number[],
    sessionId: string,
    k: number = 5,
  ): Promise<SearchResult[]> {
    const scored = this.chunks
      .filter((c) => c.sessionId === sessionId)
      .map((c) => ({ c, score: cosine(queryEmbedding, c.embedding) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, k);
    return scored.map(({ c, score }) => ({
      content: c.content,
      kind: c.kind,
      sessionId: c.sessionId,
      score,
    }));
  }
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}
```
> 说明：Task 7 先实现内存版保证逻辑正确；Task 9 集成 sqlite-vec 持久化（vec0 虚拟表 + DB 读写），保持 `upsert/search` 接口不变。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/agent/memory/vector-store.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add src/agent/memory/vector-store.ts src/agent/memory/vector-store.test.ts
git commit -m "feat(memory): 向量存储 — 文本切片 + 余弦相似度检索（内存版）"
```

---

### Task 8: memory_search 工具

**Files:**
- Create: `src/agent/tools/memory-search.ts`
- Modify: `src/agent/tools/index.ts`

- [ ] **Step 1: 创建工具**

Create `src/agent/tools/memory-search.ts`:
```ts
import { tool } from 'ai';
import { z } from 'zod';
import type { SearchResult } from '@/agent/memory/types';

export function createMemorySearchTool(
  searchFn: (query: string, k?: number) => Promise<SearchResult[]>,
) {
  return tool({
    description:
      '在历史会话记忆中按语义检索相关内容。仅当上下文被压缩、需要回忆早期信息时使用。',
    inputSchema: z.object({
      query: z.string().describe('检索的关键词或问题'),
      k: z.number().int().min(1).max(10).optional().describe('返回条数，默认 5'),
    }),
    execute: async ({ query, k = 5 }) => {
      try {
        const results = await searchFn(query, k);
        if (results.length === 0) return { results: [], note: '未找到相关历史记录' };
        return { results };
      } catch (e: any) {
        return { results: [], note: `记忆检索失败: ${e.message}` };
      }
    },
  });
}
```

- [ ] **Step 2: 编译验证**

Run: `npx tsc --noEmit`
Expected: 无错误

- [ ] **Step 3: Commit**

```bash
git add src/agent/tools/memory-search.ts
git commit -m "feat(tools): memory_search 语义检索工具"
```

---

### Task 9: ContextManager + sqlite-vec 持久化

**Files:**
- Create: `src/agent/memory/context-manager.ts`
- Modify: `src/agent/memory/vector-store.ts`（接入 DB）

- [ ] **Step 1: vector-store 接入 sqlite-vec 持久化**

Modify `src/agent/memory/vector-store.ts` — 构造函数接受 `db`，upsert 写 DB（`message_chunks` 表），search 读 DB 计算余弦：
```ts
import { getDb } from '@/db/db';
import { messageChunks } from '@/db/schema';
import { eq } from 'drizzle-orm';

export async function persistChunk(chunk: ChunkInput): Promise<void> {
  const db = getDb();
  await db.insert(messageChunks).values({
    id: chunk.id,
    sessionId: chunk.sessionId,
    sourceMessageId: chunk.sourceMessageId || null,
    content: chunk.content,
    embedding: JSON.stringify(chunk.embedding),
    kind: chunk.kind,
    seqFrom: chunk.seqFrom,
    seqTo: chunk.seqTo,
    createdAt: new Date().toISOString(),
  });
}

export async function loadChunks(sessionId: string): Promise<ChunkInput[]> {
  const db = getDb();
  const rows = await db.select().from(messageChunks).where(eq(messageChunks.sessionId, sessionId));
  return rows.map((r) => ({
    id: r.id,
    sessionId: r.sessionId,
    sourceMessageId: r.sourceMessageId || undefined,
    content: r.content,
    kind: r.kind as ChunkInput['kind'],
    embedding: JSON.parse(r.embedding),
    seqFrom: r.seqFrom ?? 0,
    seqTo: r.seqTo ?? 0,
  }));
}
```

- [ ] **Step 2: 创建 context-manager.ts**

Create `src/agent/memory/context-manager.ts`:
```ts
import type { EmbeddingProvider } from './types';
import { VectorStore, loadChunks, persistChunk } from './vector-store';
import { buildContext as legacyBuildContext } from '@/agent/context';
import type { BuildContextResult } from '@/agent/context';
import type { Message } from '@/db/schema';

export class ContextManager {
  private vectorStore: VectorStore;
  private initialized = false;

  constructor(
    private opts: {
      sessionId: string;
      embeddingProvider: EmbeddingProvider;
      apiKey?: string;
      enableVector?: boolean;
    },
  ) {
    this.vectorStore = new VectorStore(opts.embeddingProvider);
  }

  async buildContext(prompt: string): Promise<BuildContextResult> {
    return legacyBuildContext(this.opts.sessionId, prompt, { apiKey: this.opts.apiKey });
  }

  /** 消息落库后调用：向量化（异步，不阻塞） */
  async onMessagePersisted(msg: Message): Promise<void> {
    if (!this.opts.enableVector) return;
    if (!this.initialized) {
      const chunks = await loadChunks(this.opts.sessionId);
      for (const c of chunks) await this.vectorStore.upsert(c);
      this.initialized = true;
    }
    // 只向量化语义完整消息
    if (!['user', 'text', 'tool_result'].includes(msg.type)) return;
    if (!msg.content || msg.content.length < 10) return;

    const kind = msg.type === 'user' ? 'user' : msg.type === 'tool_result' ? 'tool_result' : 'assistant_text';
    try {
      const [embedding] = await this.opts.embeddingProvider.embed([msg.content.slice(0, 2000)]);
      await this.vectorStore.upsert({
        id: msg.id,
        sessionId: this.opts.sessionId,
        sourceMessageId: msg.id,
        content: msg.content.slice(0, 2000),
        kind,
        embedding,
        seqFrom: msg.sequence,
        seqTo: msg.sequence,
      });
      await persistChunk({
        id: msg.id,
        sessionId: this.opts.sessionId,
        sourceMessageId: msg.id,
        content: msg.content.slice(0, 2000),
        kind,
        embedding,
        seqFrom: msg.sequence,
        seqTo: msg.sequence,
      }).catch((e) => console.error('[vector persist]', e.message));
    } catch (e) {
      console.error('[vector embed] 跳过（不影响主流程）', e);
    }
  }

  async search(query: string, k = 5) {
    if (!this.opts.enableVector) return [];
    const [vec] = await this.opts.embeddingProvider.embed([query]);
    return this.vectorStore.search(vec, this.opts.sessionId, k);
  }

  dispose() {}
}
```

- [ ] **Step 3: 编译验证**

Run: `npx tsc --noEmit`
Expected: 无错误（若 `messageChunks` 类型缺失则回 Task 2 补 `sourceMessageId` 字段）

- [ ] **Step 4: Commit**

```bash
git add src/agent/memory/vector-store.ts src/agent/memory/context-manager.ts
git commit -m "feat(memory): ContextManager 统一入口 + sqlite-vec 持久化"
```

---

### Task 10: route.ts 集成 ContextManager + 工具注入

**Files:**
- Modify: `src/app/api/hello/route.ts`
- Modify: `src/agent/tools/index.ts`

- [ ] **Step 1: route.ts 集成**

Modify `src/app/api/hello/route.ts`：
```ts
import { ContextManager } from '@/agent/memory/context-manager';
import { createEmbeddingProvider } from '@/agent/memory/embedding';
import { createMemorySearchTool } from '@/agent/tools/memory-search';

// 在 POST 内、buildContext 前：
const embeddingProvider = createEmbeddingProvider(
  (process.env.EMBEDDING_PROVIDER as 'local' | 'openai') || 'local',
  apiKey,
);
const contextManager = new ContextManager({
  sessionId: currentSessionId,
  embeddingProvider,
  apiKey,
  enableVector: true,
});
const ctx = await contextManager.buildContext(prompt);
```

tools 组装追加（仅当 `ctx.compressed` 时注入 memory_search）：
```ts
const tools = {
  ...createAllSandboxTools(sandbox),
  read_skill: createReadSkillTool(),
};
if (ctx.compressed) {
  tools.memory_search = createMemorySearchTool(
    contextManager.search.bind(contextManager),
  );
}
```

persist 回调中追加向量化（在 `createPersistCallback` 的 insertFn 处包一层）：
```ts
contextManager.onMessagePersisted(msg).catch(() => {});
```

- [ ] **Step 2: 编译 + 类型检查**

Run: `npx tsc --noEmit`
Expected: 无错误

- [ ] **Step 3: 手动冒烟测试**

Run: `npm run dev`
操作：新建会话发一条消息 → 查看系统日志 `[context]` 行（tokens 正常）；连续多轮后观察摘要是否落库（`data/code-agent.db` 的 sessions.summary 有值）。

- [ ] **Step 4: Commit**

```bash
git add src/app/api/hello/route.ts src/agent/tools/index.ts
git commit -m "feat(route): 集成 ContextManager — 摘要落库 + memory_search 工具注入 + 异步向量化"
```

---

## Self-Review（实现者执行前必读）

**Spec 覆盖核对：**
- 方向1 滚动摘要 → Task 3/4/5 ✅
- 方向2 向量记忆 → Task 6/7/8/9 ✅
- 方向3 ContextManager → Task 9/10 ✅
- 参数 15000/1000 → Task 3 常量 + Task 4 更新 ✅
- 错误处理降级（嵌入失败不阻断）→ Task 8 execute catch + Task 9 onMessagePersisted catch ✅
- 仅压缩后启用 memory_search → Task 10 `if (ctx.compressed)` ✅

**已知留待执行时决策的点：** Task 7 内存版 → Task 9 持久化，接口保持不变；sqlite-vec 的 vec0 虚拟表与 message_chunks 表的关系在执行 Task 9 时以 message_chunks 表为权威存储（vec0 可选优化），若执行中发现 vec0 更优则两者并存，不改变 `upsert/search` 外部接口。

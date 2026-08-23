import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema';
import { eq, desc, and, gt, lt, isNotNull } from 'drizzle-orm';
import { v4 as uuid } from 'uuid';
import type { Session, NewSession, Message, NewMessage, AgentTask } from './schema';

// ── 数据库文件路径 ──
const DB_PATH =
  process.env.DATABASE_URL || './data/code-agent.db';

// ── 单例连接 ──
let _db: ReturnType<typeof drizzle> | null = null;

/**
 * 定位 sqlite-vec 原生扩展（vec0.dll/.dylib/.so）的绝对路径。
 *
 * 不用 sqlite-vec 包内自带的 load()（它内部用 require.resolve，
 * 在 Turbopack 下会被替换成未实现的 import.meta.resolve 而失败）。
 * 这里手动按平台约定构造路径。
 */
function getVecExtensionPath(): string | null {
  const fs = require('fs');
  const path = require('path');
  const platform = process.platform; // win32 | darwin | linux
  const arch = process.arch;         // x64 | arm64
  const os = platform === 'win32' ? 'windows' : platform;
  const suffix = platform === 'win32' ? 'dll' : platform === 'darwin' ? 'dylib' : 'so';

  const candidates = [
    // 平台分包：sqlite-vec-windows-x64/vec0.dll
    path.join(process.cwd(), 'node_modules', `sqlite-vec-${os}-${arch}`, `vec0.${suffix}`),
    // 兜底：主包内
    path.join(process.cwd(), 'node_modules', 'sqlite-vec', `vec0.${suffix}`),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

export function getDb() {
  if (!_db) {
    // 确保目录存在
    const fs = require('fs');
    const path = require('path');
    const dir = path.dirname(DB_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const sqlite = new Database(DB_PATH);
    // sqlite-vec 扩展加载（向量检索）
    // 注意：loadExtension 加载不兼容的原生 .so 会直接 Segmentation fault（进程级崩溃，
    // JS try/catch 无法捕获）。容器/Serverless 环境（无匹配 .so 或 glibc 不符）必须跳过——
    // 设置环境变量 ENABLE_SQLITE_VEC=0 禁用（向量检索降级，记忆退化为摘要+全量）。
    if (process.env.ENABLE_SQLITE_VEC !== '0') {
      try {
        const extPath = getVecExtensionPath();
        if (extPath) {
          sqlite.loadExtension(extPath);
          console.log(`[db] sqlite-vec 扩展加载成功: ${extPath}`);
        } else {
          console.warn('[db] 未找到 sqlite-vec 原生扩展文件，向量检索不可用（不影响主流程）');
        }
      } catch (e) {
        console.error('[db] sqlite-vec 加载失败，向量检索不可用（不影响主流程）', e);
      }
    } else {
      console.log('[db] ENABLE_SQLITE_VEC=0，跳过 sqlite-vec 加载（向量检索停用）');
    }
    sqlite.pragma('journal_mode = WAL');
    sqlite.pragma('foreign_keys = ON');
    _db = drizzle(sqlite, { schema });
  }
  return _db;
}

// ── 数据库初始化（运行迁移）──

export async function initDb() {
  const db = getDb();
  // 使用 raw SQL 建表（兼容 drizzle-kit 生成的迁移也可直接跑）
  const sqlite = (db as any).$client as Database.Database;
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT '未命名会话',
      sandbox_id TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      task_status TEXT,
      summary TEXT,
      summary_tokens INTEGER,
      summary_seq INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at);

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      type TEXT NOT NULL,
      content TEXT,
      metadata TEXT,
      step_index INTEGER,
      sequence INTEGER NOT NULL,
      sandbox_id TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
    CREATE INDEX IF NOT EXISTS idx_messages_sequence ON messages(session_id, sequence);

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

    CREATE TABLE IF NOT EXISTS agent_tasks (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      agent_id TEXT NOT NULL,
      agent_role TEXT NOT NULL,
      status TEXT NOT NULL,
      task TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_agent_tasks_session ON agent_tasks(session_id);
  `);
  // 兼容旧库：补充 summary / summary_tokens 列（若不存在）
  try {
    sqlite.exec('ALTER TABLE sessions ADD COLUMN summary TEXT;');
  } catch {
    // 列已存在，忽略
  }
  try {
    sqlite.exec('ALTER TABLE sessions ADD COLUMN summary_tokens INTEGER;');
  } catch {
    // 列已存在，忽略
  }
  try {
    sqlite.exec('ALTER TABLE sessions ADD COLUMN summary_seq INTEGER;');
  } catch {
    // 列已存在，忽略
  }
  // 兼容旧库：补充 task_status 列（若不存在）
  try {
    sqlite.exec('ALTER TABLE sessions ADD COLUMN task_status TEXT;');
  } catch {
    // 列已存在，忽略
  }
  return db;
}

// ── Session CRUD ──

export async function createSession(input: {
  title?: string;
  sandboxId?: string;
}): Promise<Session> {
  const db = getDb();
  const now = new Date().toISOString();
  const session: NewSession = {
    id: uuid(),
    title: input.title?.slice(0, 100) || '未命名会话',
    sandboxId: input.sandboxId || null,
    status: 'active',
    createdAt: now,
    updatedAt: now,
  };
  await db.insert(schema.sessions).values(session);
  return session as Session;
}

export async function updateSession(
  id: string,
  updates: Partial<
    Pick<
      Session,
      | 'title'
      | 'sandboxId'
      | 'status'
      | 'taskStatus'
      | 'summary'
      | 'summaryTokens'
      | 'summarySeq'
    >
  >,
) {
  const db = getDb();
  const data: Record<string, unknown> = {
    updatedAt: new Date().toISOString(),
  };
  // 注意：drizzle 的 .set() 键必须是 schema 字段名（camelCase），
  // 不是 DB 列名（snake_case）——buildUpdateSet 用 set[字段名] 取值
  if (updates.title !== undefined) data.title = updates.title;
  if (updates.sandboxId !== undefined) data.sandboxId = updates.sandboxId;
  if (updates.status !== undefined) data.status = updates.status;
  if (updates.taskStatus !== undefined) data.taskStatus = updates.taskStatus;
  if (updates.summary !== undefined) data.summary = updates.summary;
  if (updates.summaryTokens !== undefined) data.summaryTokens = updates.summaryTokens;
  if (updates.summarySeq !== undefined) data.summarySeq = updates.summarySeq;
  await db.update(schema.sessions).set(data).where(eq(schema.sessions.id, id));
}

export async function getSession(id: string): Promise<Session | undefined> {
  const db = getDb();
  const rows = await db
    .select()
    .from(schema.sessions)
    .where(eq(schema.sessions.id, id))
    .limit(1);
  return rows[0];
}

export async function listSessions(limit: number = 50): Promise<Session[]> {
  const db = getDb();
  return db
    .select()
    .from(schema.sessions)
    .orderBy(desc(schema.sessions.updatedAt))
    .limit(limit);
}

export async function deleteSession(id: string) {
  const db = getDb();
  await db.delete(schema.sessions).where(eq(schema.sessions.id, id));
}

// ── Message CRUD ──

export async function insertMessage(input: {
  sessionId: string;
  role: 'user' | 'assistant' | 'system';
  type: string;
  content?: string;
  metadata?: Record<string, unknown>;
  stepIndex?: number;
  sequence: number;
  sandboxId?: string;
}): Promise<Message> {
  const db = getDb();
  const msg: NewMessage = {
    id: uuid(),
    sessionId: input.sessionId,
    role: input.role,
    type: input.type,
    content: input.content || null,
    metadata: input.metadata ? JSON.stringify(input.metadata) : null,
    stepIndex: input.stepIndex ?? null,
    sequence: input.sequence,
    sandboxId: input.sandboxId || null,
    createdAt: new Date().toISOString(),
  };
  await db.insert(schema.messages).values(msg);
  return msg as Message;
}

export async function getSessionMessages(
  sessionId: string,
  opts?: { limit?: number; beforeSeq?: number; afterSeq?: number },
): Promise<{ messages: Message[]; hasMore: boolean }> {
  const db = getDb();
  const limit = opts?.limit ?? 0; // 0 = 全量（兼容旧调用）

  // 增量拉取：sequence > afterSeq，正序返回（后台任务执行中刷新页面后轮询用）
  if (opts?.afterSeq !== undefined) {
    const rows = await db
      .select()
      .from(schema.messages)
      .where(
        and(
          eq(schema.messages.sessionId, sessionId),
          gt(schema.messages.sequence, opts.afterSeq),
        ),
      )
      .orderBy(schema.messages.sequence)
      .limit(limit > 0 ? limit : 200);
    return { messages: rows, hasMore: false };
  }

  // 无分页参数：全量正序（旧行为）
  if (!limit || limit <= 0) {
    const all = await db
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.sessionId, sessionId))
      .orderBy(schema.messages.createdAt, schema.messages.sequence);
    return { messages: all, hasMore: false };
  }

  // 分页：sequence 倒序取 limit+1 条（多取一条判断 hasMore），再反转为正序
  const where = opts?.beforeSeq
    ? and(
        eq(schema.messages.sessionId, sessionId),
        lt(schema.messages.sequence, opts.beforeSeq),
      )
    : eq(schema.messages.sessionId, sessionId);

  const rows = await db
    .select()
    .from(schema.messages)
    .where(where)
    .orderBy(desc(schema.messages.sequence))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit).reverse();
  return { messages: page, hasMore };
}

/** 获取会话中最新一条带步骤号的消息的 stepIndex（用于任务状态展示"正在哪一步"） */
export async function getLatestStep(sessionId: string): Promise<number | null> {
  const db = getDb();
  const rows = await db
    .select({ stepIndex: schema.messages.stepIndex })
    .from(schema.messages)
    .where(
      and(
        eq(schema.messages.sessionId, sessionId),
        isNotNull(schema.messages.stepIndex),
      ),
    )
    .orderBy(desc(schema.messages.sequence))
    .limit(1);
  return rows[0]?.stepIndex ?? null;
}

/** 获取某会话 sequence 大于指定值的消息（断点之后的新消息） */
export async function getSessionMessagesAfterSeq(  sessionId: string,
  seq: number,
): Promise<Message[]> {
  const db = getDb();
  return db
    .select()
    .from(schema.messages)
    .where(
      and(eq(schema.messages.sessionId, sessionId), gt(schema.messages.sequence, seq)),
    )
    .orderBy(schema.messages.createdAt, schema.messages.sequence);
}

// ── 获取会话下一个 sequence ──

export async function getNextSequence(sessionId: string): Promise<number> {
  const db = getDb();
  const rows = await db
    .select({ maxSeq: schema.messages.sequence })
    .from(schema.messages)
    .where(eq(schema.messages.sessionId, sessionId))
    .orderBy(desc(schema.messages.sequence))
    .limit(1);
  return (rows[0]?.maxSeq ?? -1) + 1;
}

// ── 批量插入（性能优化）──

export async function insertMessagesBatch(
  rows: Array<{
    sessionId: string;
    role: 'user' | 'assistant' | 'system';
    type: string;
    content?: string;
    metadata?: Record<string, unknown>;
    stepIndex?: number;
    sequence: number;
    sandboxId?: string;
  }>,
): Promise<void> {
  if (rows.length === 0) return;
  const db = getDb();
  const now = new Date().toISOString();
  await db.insert(schema.messages).values(
    rows.map((r) => ({
      id: uuid(),
      sessionId: r.sessionId,
      role: r.role,
      type: r.type,
      content: r.content || null,
      metadata: r.metadata ? JSON.stringify(r.metadata) : null,
      stepIndex: r.stepIndex ?? null,
      sequence: r.sequence,
      sandboxId: r.sandboxId || null,
      createdAt: now,
    })),
  );
}

// ── agent_tasks 子 Agent 状态（按 session 持久化，刷新后可查询恢复）──

/** upsert 子 Agent 状态（agent_start 时 running，agent_finish 时更新 status；task 缺省保留原值） */
export async function upsertAgentTask(input: {
  sessionId: string;
  agentId: string;
  agentRole: string;
  status: 'running' | 'passed' | 'failed';
  task?: string;
}): Promise<void> {
  const db = getDb();
  const now = new Date().toISOString();

  const existing = await db
    .select()
    .from(schema.agentTasks)
    .where(
      and(
        eq(schema.agentTasks.sessionId, input.sessionId),
        eq(schema.agentTasks.agentId, input.agentId),
      ),
    )
    .limit(1);

  if (existing.length > 0) {
    await db
      .update(schema.agentTasks)
      .set({
        agentRole: input.agentRole,
        status: input.status,
        task: input.task ?? existing[0].task,
        updatedAt: now,
      })
      .where(eq(schema.agentTasks.id, existing[0].id));
  } else {
    await db.insert(schema.agentTasks).values({
      id: uuid(),
      sessionId: input.sessionId,
      agentId: input.agentId,
      agentRole: input.agentRole,
      status: input.status,
      task: input.task ?? null,
      createdAt: now,
      updatedAt: now,
    });
  }
}

/** 查询某 session 的子 Agent 状态（按 createdAt 排序） */
export async function getAgentTasks(sessionId: string): Promise<AgentTask[]> {
  const db = getDb();
  return db
    .select()
    .from(schema.agentTasks)
    .where(eq(schema.agentTasks.sessionId, sessionId))
    .orderBy(schema.agentTasks.createdAt);
}

/** 清除某 session 的所有子 Agent 状态（新任务开始时调用） */
export async function clearAgentTasks(sessionId: string): Promise<void> {
  const db = getDb();
  await db.delete(schema.agentTasks).where(eq(schema.agentTasks.sessionId, sessionId));
}

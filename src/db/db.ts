import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema';
import { eq, desc, and } from 'drizzle-orm';
import { v4 as uuid } from 'uuid';
import type { Session, NewSession, Message, NewMessage } from './schema';

// ── 数据库文件路径 ──
const DB_PATH =
  process.env.DATABASE_URL || './data/code-agent.db';

// ── 单例连接 ──
let _db: ReturnType<typeof drizzle> | null = null;

function getDb() {
  if (!_db) {
    // 确保目录存在
    const fs = require('fs');
    const path = require('path');
    const dir = path.dirname(DB_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const sqlite = new Database(DB_PATH);
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
  `);
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
  updates: Partial<Pick<Session, 'title' | 'sandboxId' | 'status'>>,
) {
  const db = getDb();
  const data: Record<string, unknown> = {
    updatedAt: new Date().toISOString(),
  };
  if (updates.title !== undefined) data.title = updates.title;
  if (updates.sandboxId !== undefined) data.sandboxId = updates.sandboxId;
  if (updates.status !== undefined) data.status = updates.status;
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
): Promise<Message[]> {
  const db = getDb();
  return db
    .select()
    .from(schema.messages)
    .where(eq(schema.messages.sessionId, sessionId))
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

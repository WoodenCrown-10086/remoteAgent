import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core';

// ── sessions 会话表 ──

export const sessions = sqliteTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    title: text('title').notNull().default('未命名会话'),
    sandboxId: text('sandbox_id'),
    status: text('status').notNull().default('active'), // active | paused | killed
    taskStatus: text('task_status'), // running | completed | failed | aborted | null
    summary: text('summary'),                       // 滚动摘要
    summaryTokens: integer('summary_tokens'),       // 摘要 token 数
    summarySeq: integer('summary_seq'),             // 已并入摘要的最后一条消息 sequence
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [index('idx_sessions_updated').on(t.updatedAt)],
);

// ── messages 消息表（细粒度事件存储）──

export const messages = sqliteTable(
  'messages',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    role: text('role').notNull(), // user | assistant | system
    type: text('type').notNull(),
    // user_message | text | tool_call | tool_result | tool_error
    // | step | step_finish | done | error

    content: text('content'),

    // JSON 扩展字段
    metadata: text('metadata'), // { toolName, toolArgs, toolResult, stepIndex, finishReason... }

    stepIndex: integer('step_index'),
    sequence: integer('sequence').notNull(), // 会话内全局排序
    sandboxId: text('sandbox_id'),

    createdAt: text('created_at').notNull(),
  },
  (t) => [
    index('idx_messages_session').on(t.sessionId),
    index('idx_messages_sequence').on(t.sessionId, t.sequence),
  ],
);

// ── message_chunks 消息块表（RAG 向量检索）──

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

// ── 类型导出 ──

export type Session = typeof sessions.$inferSelect;
export type NewSession = typeof sessions.$inferInsert;
export type Message = typeof messages.$inferSelect;
export type NewMessage = typeof messages.$inferInsert;
export type MessageChunk = typeof messageChunks.$inferSelect;
export type NewMessageChunk = typeof messageChunks.$inferInsert;

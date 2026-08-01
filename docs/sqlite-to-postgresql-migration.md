# SQLite → PostgreSQL 迁移指南

## 概述

本文档记录从 SQLite 迁移到 PostgreSQL 的完整步骤，预计停机时间 < 10 分钟。

---

## 1. 背景

当前使用 **Drizzle ORM** + `better-sqlite3` 驱动。Drizzle 天然支持多数据库，迁移核心工作仅在于 **替换驱动** 和 **数据迁移**，Schema 定义文件无需修改。

## 2. 依赖变更

### 卸载 SQLite 驱动

```bash
npm uninstall better-sqlite3 @types/better-sqlite3
```

### 安装 PostgreSQL 驱动

```bash
npm install pg postgres-js drizzle-orm
npm install -D @types/pg
```

> 推荐使用 `postgres-js` 作为 Drizzle 的 PG 驱动（性能更好）。

## 3. 配置文件变更

### 3.1 `drizzle.config.ts`

```diff
import type { Config } from 'drizzle-kit';

export default {
  schema: './src/db/schema.ts',
  out: './drizzle',
-  dialect: 'sqlite',
+  dialect: 'postgresql',
  dbCredentials: {
-    url: './data/code-agent.db',
+    url: process.env.DATABASE_URL!,
  },
} satisfies Config;
```

### 3.2 环境变量

创建 `.env` 文件：

```bash
DATABASE_URL=postgresql://user:password@localhost:5432/code_agent
```

> Next.js 默认加载 `.env` 文件，`process.env.DATABASE_URL` 可直接使用。

## 4. Schema 变更

### 4.1 修改 `src/db/schema.ts`

```diff
-import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core';
+import { pgTable, text, integer, index, timestamp } from 'drizzle-orm/pg-core';

-export const sessions = sqliteTable('sessions', {
+export const sessions = pgTable('sessions', {
   id: text('id').primaryKey(),
   title: text('title').notNull().default('未命名会话'),
   sandboxId: text('sandbox_id'),
   status: text('status').notNull().default('active'),
-  createdAt: text('created_at').notNull(),
-  updatedAt: text('updated_at').notNull(),
+  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
+  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
 }, (t) => [
   index('idx_sessions_updated').on(t.updatedAt),
 ]);

-export const messages = sqliteTable('messages', {
+export const messages = pgTable('messages', {
   id: text('id').primaryKey(),
   sessionId: text('session_id')
     .notNull()
     .references(() => sessions.id, { onDelete: 'cascade' }),
   role: text('role').notNull(),
   type: text('type').notNull(),
   content: text('content'),
   metadata: text('metadata'),
   stepIndex: integer('step_index'),
-  sequence: integer('sequence').notNull(),
+  sequence: integer('sequence').notNull(),   // PG 也支持 integer
   sandboxId: text('sandbox_id'),
-  createdAt: text('created_at').notNull(),
+  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
 }, (t) => [
   index('idx_messages_session').on(t.sessionId),
   index('idx_messages_sequence').on(t.sessionId, t.sequence),
 ]);
```

### 4.2 Schema 变更要点

| SQLite | PostgreSQL | 说明 |
|---|---|---|
| `sqliteTable` | `pgTable` | 表定义函数 |
| `text(...)` 存时间 | `timestamp(...)` | PG 有原生时间类型 |
| 时间默认值手动设置 | `defaultNow()` | PG 自动填充 |
| `integer` | `integer` | 无变化 |
| `text` | `text` | 无变化 |

## 5. `src/db/db.ts` 变更

```diff
-import Database from 'better-sqlite3';
-import { drizzle } from 'drizzle-orm/better-sqlite3';
+import { drizzle } from 'drizzle-orm/postgres-js';
+import postgres from 'postgres';
 import * as schema from './schema';
 import { eq, desc } from 'drizzle-orm';
 import { v4 as uuid } from 'uuid';
 import type { Session, NewSession, Message, NewMessage } from './schema';

-const DB_PATH = process.env.DATABASE_URL || './data/code-agent.db';
+const DB_URL = process.env.DATABASE_URL || 'postgresql://localhost:5432/code_agent';

 let _db: ReturnType<typeof drizzle> | null = null;

 function getDb() {
   if (!_db) {
-    const fs = require('fs');
-    const path = require('path');
-    const dir = path.dirname(DB_PATH);
-    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
-
-    const sqlite = new Database(DB_PATH);
-    sqlite.pragma('journal_mode = WAL');
-    sqlite.pragma('foreign_keys = ON');
-    _db = drizzle(sqlite, { schema });
+    const client = postgres(DB_URL);
+    _db = drizzle(client, { schema });
   }
   return _db;
 }

 export async function initDb() {
-  const db = getDb();
-  const sqlite = (db as any).$client as Database.Database;
-  sqlite.exec(`
-    CREATE TABLE IF NOT EXISTS sessions (...);
-    CREATE TABLE IF NOT EXISTS messages (...);
-  `);
+  // PostgreSQL 使用 drizzle-kit migrate 管理表结构
+  // 不再需要手动 CREATE TABLE IF NOT EXISTS
+  const db = getDb();
   return db;
 }
```

> **重要**：移除了 `initDb()` 中的手动建表逻辑。PostgreSQL 使用 `drizzle-kit migrate` 管理表结构（见第 6 步）。

## 6. 迁移命令

```bash
# 1. 生成迁移 SQL 文件
npx drizzle-kit generate

# 2. 查看生成的 SQL（确认无误）
cat drizzle/0000_xxxx.sql

# 3. 执行迁移到 PostgreSQL
npx drizzle-kit migrate
```

> 生成的目录 `drizzle/` 会自动变为 PostgreSQL 方言的 DDL。

## 7. 数据迁移

### 方案 A：使用 pgloader（推荐）

```bash
# 安装 pgloader
# macOS: brew install pgloader
# Ubuntu: apt install pgloader

# 编写迁移脚本 migrate.load
cat > migrate.load << 'EOF'
LOAD DATABASE
  FROM sqlite:///path/to/data/code-agent.db
  INTO postgresql://user:password@localhost:5432/code_agent
WITH
  create tables,
  drop indexes,
  reset sequences;
EOF

pgloader migrate.load
```

### 方案 B：手动导出导入

```bash
# 1. 从 SQLite 导出 JSON
sqlite3 data/code-agent.db "SELECT json_object('sessions', json_group_array(json_object('id',id,'title',title,...))) FROM sessions" > sessions.json

# 2. 编写 Node.js 脚本导入 PostgreSQL
node scripts/migrate-data.js
```

### 方案 C：通过你的应用 API

如果会话数据量不大（< 1000 条），可以直接通过 API 重新生成。用户重新输入任务即可。

## 8. 应用层代码变更

`src/db/db.ts` 中所有 CRUD 函数**无需修改**——Drizzle ORM 的查询 API 跨数据库统一。

唯一需要检查的是：
- `insertMessagesBatch` 中批量插入的兼容性（Drizzle PG 支持批量 insert）
- `orderBy(desc(...))` 行为一致

## 9. 验证清单

```bash
# 1. 编译检查
npx tsc --noEmit

# 2. 启动应用
npm run dev

# 3. API 测试
curl http://localhost:3000/api/sessions      # 应返回 []
curl -X POST http://localhost:3000/api/sessions -H 'Content-Type: application/json' -d '{"title":"test"}'  # 应返回 201

# 4. 发送任务验证消息存储
# 在前端输入任务并发送，检查 /api/sessions 数据
```

## 10. 回滚计划

如迁移出现问题：

1. 将 `DATABASE_URL` 改回 SQLite 路径
2. 还原 `drizzle.config.ts` dialect 为 `sqlite`
3. 还原 `db.ts` 为 better-sqlite3 版本
4. 重新 `npm install better-sqlite3`

---

> **总结**：迁移核心工作量在 4 个文件（schema.ts / db.ts / drizzle.config.ts / package.json），业务代码无感知。Drizzle ORM 的跨数据库抽象使得切换成本极低。

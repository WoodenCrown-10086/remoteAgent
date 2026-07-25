# Coding Agent 工程路线图

> 从当前 POC 阶段到端到端自主编码 Agent 的完整演进计划。

---

## 愿景总览

```
用户 ──远程指令──► 轻量网站 ──任务队列──► 主 Agent
                                           │
                                    拆解 → 分发子 Agent
                                           │
                              ┌────────────┼────────────┐
                              ▼            ▼            ▼
                          编码Agent    测试Agent    审查Agent
                              │            │            │
                              └────────────┼────────────┘
                                           ▼
                                    需要确认？──是──► 网站提醒用户
                                           │              │
                                          否              ▼
                                           │         用户审批/修改
                                           │              │
                                           ▼              ▼
                                    Git Commit + Push
                                           │
                                           ▼
                                      任务完成 ✓
```

---

## 当前基线（Phase 0 — 已完成）

| 能力 | 状态 |
|---|---|
| Next.js + React 19 前端 | ✅ |
| DeepSeek v4 LLM（Vercel AI SDK） | ✅ |
| e2b 云沙箱隔离执行 | ✅ |
| 8 个工具（write/read/edit/execute/grep/list/web_fetch/web_search） | ✅ |
| 沙箱 pause/connect 复用 | ✅ |
| Skill 系统（.agent/skills/*.md） | ✅ |
| 沙箱文件浏览器 | ✅ |
| 基础 Agent 循环（max 15 步自纠错） | ✅ |

---

## Phase 1：Agent 体验与可靠性（2-3 周）

> 目标：把当前「能用」提升到「好用且可靠」

### 1.1 流式输出（P0）

| 项 | 说明 |
|---|---|
| **现状** | `generateText` 阻塞式，用户等全部完成才看到结果 |
| **目标** | `streamText` 实时推送，逐字输出 + 工具调用步骤可视化 |
| **改动** | route.ts 切换 API；前端 SSE/ReadableStream 消费 |
| **涉及** | `route.ts`、`page.tsx` |

### 1.2 对话式 UI（P0）

| 项 | 说明 |
|---|---|
| **现状** | 单个 textarea + JSON 输出 |
| **目标** | 聊天气泡界面：用户消息 + Agent 回复 + 工具调用折叠卡片 |
| **改动** | 前端重写为对话组件，支持多轮历史展示 |
| **涉及** | `page.tsx` 重构 |

### 1.3 对话历史持久化（P1）

| 项 | 说明 |
|---|---|
| **现状** | 每次请求 messages 从零开始 |
| **目标** | 按 session 存储对话历史，支持上下文连续对话 |
| **方案** | 文件存储（起步）→ SQLite（过渡）→ PostgreSQL（生产） |
| **涉及** | 新增 `src/lib/session-store.ts`、`route.ts` |

### 1.4 用户确认机制（P1）

| 项 | 说明 |
|---|---|
| **现状** | Agent 直接写入和执行，无用户审批 |
| **目标** | 关键操作（git push、删除文件、安装依赖）需用户确认 |
| **方案** | `execute_command` 分级：safe / needs_approval；前端弹出确认框 |
| **涉及** | 工具描述增加风险等级、`page.tsx` 确认弹窗 |

### 1.5 Git 工具集成（P0）

| 项 | 说明 |
|---|---|
| **现状** | 无 Git 能力 |
| **目标** | Agent 能 clone 仓库、创建分支、commit、push、创建 PR |
| **方案** | 封装 e2b 内置 `sandbox.git` API |
| **工具** | `git_clone`、`git_status`、`git_diff`、`git_commit`、`git_push`、`git_create_pr` |
| **涉及** | 新增 `src/agent/tools/git-*.ts` × 4-6 个 |

### 1.6 超时与重试（P1）

| 项 | 说明 |
|---|---|
| **现状** | 无 LLM 调用重试，无全局超时 |
| **目标** | LLM 调用 3 次重试 + exponential backoff；单请求全局 10 分钟超时 |
| **涉及** | `route.ts` |

---

## Phase 2：任务系统（2-3 周）

> 目标：Agent 不再只是「一问一答」，而是能管理复杂任务

### 2.1 数据库引入（P0）

| 项 | 说明 |
|---|---|
| **方案** | SQLite（起步）+ Prisma ORM |
| **表设计** | tasks、subtasks、sessions、messages、sandboxes |
| **涉及** | `prisma/schema.prisma`、`src/lib/db.ts` |

### 2.2 任务队列（P0）

| 项 | 说明 |
|---|---|
| **目标** | 用户发布任务 → 入队 → Agent 轮询 → 执行 → 状态更新 |
| **方案** | 数据库队列（轻量起步），后续可换 Redis/BullMQ |
| **状态机** | `pending → queued → planning → running → reviewing → done/failed` |
| **涉及** | `src/lib/task-queue.ts`、新增 `POST /api/tasks`、`GET /api/tasks` |

### 2.3 任务拆解引擎（P0）

| 项 | 说明 |
|---|---|
| **目标** | LLM 将用户大任务拆解为有序子任务列表 |
| **输出** | `[{ id, title, description, dependencies, skill, estimatedSteps }]` |
| **方案** | 专门的 planning prompt → LLM 输出结构化 JSON → 写入 subtasks 表 |
| **涉及** | `src/agent/planner.ts` |

### 2.4 前端任务面板（P1）

| 项 | 说明 |
|---|---|
| **目标** | 看板式任务管理：任务列表 + 状态 + 子任务进度 |
| **涉及** | `page.tsx` 重构为多 Tab（聊天 / 任务面板 / 文件浏览） |

---

## Phase 3：多 Agent 协作（3-4 周）

> 目标：主 Agent 调度多个子 Agent 并行执行子任务

### 3.1 子 Agent 调度器（P0）

| 项 | 说明 |
|---|---|
| **目标** | 主 Agent 根据拆解结果启动子 Agent，分配沙箱，监控进度 |
| **并行策略** | 无依赖的子任务并行跑；有依赖的串行等待 |
| **方案** | 每个子任务 = 独立沙箱 + 独立 Agent 会话 |
| **涉及** | `src/agent/orchestrator.ts` |

### 3.2 沙箱池管理（P1）

| 项 | 说明 |
|---|---|
| **现状** | 单沙箱 per 用户 |
| **目标** | 沙箱池：预创建 N 个沙箱，子任务快速分配 |
| **方案** | 沙箱池管理器：create/pause/resume/kill 生命周期 + 并发限制 |
| **涉及** | `src/lib/sandbox-pool.ts` |

### 3.3 结果汇总与合并（P1）

| 项 | 说明 |
|---|---|
| **目标** | 子 Agent 完成后，主 Agent 汇总结果、合并代码、解决冲突 |
| **方案** | 各子 Agent 在独立分支工作 → 汇总 Agent 合并到主分支 |
| **涉及** | `src/agent/merger.ts` |

---

## Phase 4：远程交互网站（3-4 周）

> 目标：能远程访问、发布任务、实时交互

### 4.1 用户认证（P0）

| 项 | 说明 |
|---|---|
| **方案** | NextAuth.js + GitHub OAuth（起步） |
| **涉及** | `src/lib/auth.ts`、登录/登出页面、中间件保护 |

### 4.2 实时通信（P0）

| 项 | 说明 |
|---|---|
| **现状** | HTTP 请求-响应 |
| **目标** | 任务状态实时推送、Agent 执行过程实时可见 |
| **方案** | Server-Sent Events (SSE) |
| **涉及** | `route.ts` 改为 SSE 推送、前端 EventSource 消费 |

### 4.3 审批流程（P1）

| 项 | 说明 |
|---|---|
| **场景** | Agent 遇到需要用户确认的操作时，网站弹出提醒 |
| **流程** | Agent 暂停 → 网站通知 → 用户审批/拒绝/修改 → Agent 继续 |
| **方案** | 任务状态 `awaiting_approval` + SSE 推送 + 前端审批弹窗 |
| **涉及** | `route.ts`、`page.tsx`、审批 API |

### 4.4 部署上线（P1）

| 项 | 说明 |
|---|---|
| **方案** | Vercel 部署（Next.js 原生支持） |
| **环境变量** | DEEPSEEK_API_KEY、E2B_API_KEY、DATABASE_URL 等 |
| **涉及** | `next.config.ts`、环境变量配置、CI/CD |

---

## Phase 5：生产化（持续）

> 目标：安全、稳定、可监控

### 5.1 安全加固

- API 速率限制（`@upstash/ratelimit`）
- 命令执行白名单/黑名单
- API Key 加密存储
- 请求签名验证

### 5.2 可观测性

- 结构化日志（`pino` 或 `winston`）
- Agent 执行追踪（每步 prompt/tool_call/result）
- Token 消耗统计
- 沙箱使用量统计

### 5.3 测试与 CI

- Agent 工具单元测试
- Agent 行为集成测试（给定 prompt，验证输出）
- GitHub Actions CI/CD

### 5.4 高级特性

- RAG 知识库（检索项目文档、代码规范）
- 自定义沙箱模板（预装 Node.js 22 + 常用全局包）
- 定时任务（cron job 触发 Agent）
- Webhook 回调（任务完成通知外部系统）

---

## 数据库 Schema 设计（Phase 2 引入）

```prisma
model User {
  id        String    @id @default(cuid())
  githubId  String?   @unique
  email     String?
  name      String?
  tasks     Task[]
  sessions  Session[]
}

model Task {
  id          String    @id @default(cuid())
  userId      String
  user        User      @relation(fields: [userId], references: [id])
  title       String
  description String
  status      TaskStatus @default(pending)
  priority    Int       @default(0)
  skills      String    @default("")  // comma-separated
  createdAt   DateTime  @default(now())
  updatedAt   DateTime  @updatedAt
  subtasks    SubTask[]
}

model SubTask {
  id           String       @id @default(cuid())
  taskId       String
  task         Task         @relation(fields: [taskId], references: [id])
  title        String
  description  String
  status       SubTaskStatus @default(pending)
  dependencies String       @default("")  // comma-separated subTask IDs
  skill        String?
  sandboxId    String?
  result       String?
  createdAt    DateTime     @default(now())
  updatedAt    DateTime     @updatedAt
}

model Session {
  id        String    @id @default(cuid())
  userId    String
  user      User      @relation(fields: [userId], references: [id])
  taskId    String?
  title     String
  messages  String    // JSON serialized
  sandboxId String?
  createdAt DateTime  @default(now())
  updatedAt DateTime  @updatedAt
}

enum TaskStatus {
  pending
  queued
  planning
  running
  reviewing
  done
  failed
}

enum SubTaskStatus {
  pending
  running
  awaiting_approval
  done
  failed
}
```

---

## 各阶段 API 路由规划

```
Phase 1:
  POST   /api/chat              ← 替代 /api/hello，支持流式 SSE
  GET    /api/sessions          ← 对话历史列表
  GET    /api/sessions/:id      ← 单个对话详情

Phase 2:
  POST   /api/tasks             ← 创建任务
  GET    /api/tasks             ← 任务列表
  GET    /api/tasks/:id         ← 任务详情（含子任务）
  POST   /api/tasks/:id/plan    ← 触发任务拆解
  POST   /api/tasks/:id/run     ← 开始执行
  POST   /api/tasks/:id/cancel  ← 取消任务

Phase 3:
  GET    /api/tasks/:id/progress ← SSE 实时进度
  GET    /api/subtasks/:id      ← 子任务详情

Phase 4:
  POST   /api/auth/*            ← NextAuth.js 认证路由
  POST   /api/approve/:id       ← 用户审批操作
```

---

## 推荐执行顺序（依赖关系图）

```
Phase 1                    Phase 2                 Phase 3              Phase 4
─────────────────────────────────────────────────────────────────────────────────
                                                    
流式输出 ──┐                                    沙箱池 ──┐
           │                                             │
对话式 UI ─┤               数据库 ──┐                   ├── 子Agent调度器
           │                       │                   │
对话持久化 ┤               任务队列 ─┤                   │
           │                       │                   │
用户确认 ──┤               任务拆解 ─┤                   │
           │                       │                   │
Git工具 ───┘               任务面板 ─┘                   │
           │                       │                   │
           └── 可并行 ─────────────┘                   │
                                                       │
                                         结果汇总 ─────┘
                                                       │
                                          用户认证 ────┬── 实时通信
                                                       │
                                          审批流程 ────┤
                                                       │
                                          部署上线 ────┘
```

---

## 里程碑检查清单

- [ ] **M1: 可靠单体 Agent** — 流式输出 + Git 工具 + 对话历史，能独立完成单文件级编码任务
- [ ] **M2: 任务化** — 任务队列 + 拆解引擎 + 前端面板，能管理多步骤任务
- [ ] **M3: 多 Agent** — 主 Agent 调度子 Agent 并行执行，完成多文件级项目
- [ ] **M4: 远程可用** — 部署上线，可远程访问、发布任务、审批关键操作
- [ ] **M5: 生产就绪** — 安全、监控、CI/CD，端到端自主运行

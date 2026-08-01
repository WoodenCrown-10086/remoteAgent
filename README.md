# Coding Agent

一个基于 **Next.js + DeepSeek + e2b 云沙箱** 的 Coding Agent。Agent 在隔离的 e2b 云容器中执行代码、创建文件、启动服务，并通过 SSE 流式输出结果。

## 功能特性

- 🤖 **AI 驱动的 Coding Agent**：DeepSeek v4 模型，自动规划、写码、运行、调试
- 🏝️ **e2b 云沙箱隔离执行**：所有代码在独立 Linux 容器中运行，可暂停/恢复/销毁

## 环境要求

- Node.js 20+
- npm / pnpm / yarn

## 快速开始

### 1. 安装依赖

```bash
npm install
```

### 2. 配置 API Keys

**方式一（推荐）：在网页界面配置**

启动后点击顶部右侧「设置 API Keys」按钮，填入：

| Key | 说明 | 获取地址 |
|---|---|---|
| **DeepSeek API Key** | 驱动 Agent 的 LLM | https://platform.deepseek.com |
| **E2B API Key** | 创建云沙箱执行代码 | https://e2b.dev |

Keys 仅保存在浏览器 localStorage，不会上传服务器、不会提交到 Git。

**方式二：环境变量**

创建 `.env.local` 文件：

```bash
# .env.local
DEEPSEEK_API_KEY=sk-你的DeepSeek密钥
E2B_API_KEY=e2b_你的E2B密钥
```

> `.env*` 已在 `.gitignore` 中忽略，密钥不会提交到 Git。

### 3. 启动开发服务器

```bash
npm run dev
```

打开 [http://localhost:3000](http://localhost:3000)

### 4. 使用

1. 在输入框输入任务描述，例如："创建一个 React 待办事项应用"
2. 按 `Ctrl+Enter` 或点击「发送」按钮
3. Agent 会：规划 → 写码 → 运行 → 调试 → 总结
4. 观察中间面板：文件树实时更新、端口预览可 iframe 访问沙箱中的服务
5. 对话可跨轮继续，Agent 记得之前的上下文



### 核心依赖

| 依赖 | 用途 |
|---|---|
| `ai` (Vercel AI SDK v7) | Agent 循环引擎：`streamText()` + 多步工具调用 |
| `@e2b/code-interpreter` | e2b 云沙箱执行环境 |
| `drizzle-orm` + `better-sqlite3` | 会话与消息持久化 |
| `js-tiktoken` | Token 计数（上下文压缩触发判断） |
| `react-virtuoso` | 长对话虚拟滚动 |



## 常用命令

| 命令 | 说明 |
|---|---|
| `npm run dev` | 开发服务器 |
| `npm run build` | 生产构建 |
| `npm run db:push` | 推送 Schema 到 SQLite |
| `npm run db:migrate` | 执行数据库迁移 |

## Skill 系统

在 `.agent/skills/` 目录下创建 `.md` 文件即可为 Agent 添加开发规范：

```markdown
---
name: react-tdd
description: React 项目 TDD 开发规范
---

# React TDD 规范
...
```

Agent 会在任务涉及相关技术栈时自动加载对应规范。


## License

MIT

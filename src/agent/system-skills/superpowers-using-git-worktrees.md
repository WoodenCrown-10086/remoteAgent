---
name: superpowers-using-git-worktrees
description: 用 git worktree 并行开发的工作流
triggers: 需要同时处理多个分支/并行开发任务时
---
# Using Git Worktrees（并行工作区）

## 场景
同一仓库需要同时开发多个分支（互不阻塞、各自独立构建）

## 用法
```bash
# 创建并切换 worktree
git worktree add ../my-feature feature-x
cd ../my-feature   # 独立工作目录，共享 .git

# 列出/清理
git worktree list
git worktree remove ../my-feature
```

## 规则
- worktree 目录不要在仓库内嵌套（避免递归）
- 每个 worktree 独立 node_modules/构建产物
- 收尾后及时 git worktree remove 清理
- 切分支前先确认 worktree 内无未提交改动

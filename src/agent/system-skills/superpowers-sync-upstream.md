---
name: superpowers-sync-upstream
description: 同步上游分支，处理合并冲突
triggers: 需要拉取上游更新、合并/变基远程分支时
---
# Sync Upstream（同步上游）

## 流程
1. 确认当前分支与目标上游（git fetch upstream）
2. 选择策略：
   - 变基（rebase）：线性历史，适合个人分支
   - 合并（merge）：保留分叉记录，适合共享分支
3. 冲突处理：逐文件手动合并，不盲目取一方
   - 双方都改的同一段 → 看语义，可能需要两者结合
4. 解决后：复跑构建/测试验证

## 安全
- 变基前确认没有他人已基于你的分支
- 冲突解决后 git status 无未合并文件再继续

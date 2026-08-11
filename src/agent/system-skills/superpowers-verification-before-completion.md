---
name: superpowers-verification-before-completion
description: 完成前验证：构建、测试、审查证据齐全，不口头宣称完成
triggers: 任务收尾、宣称完成前
---
# Verification Before Completion（完成前验证）

## 必做清单（宣称"完成"前）
1. **构建/编译**：项目构建命令跑通，零错误（tsc/next build/eslint 等）
2. **测试**：相关测试通过；新增逻辑有测试或明确验证方式
3. **运行验证**：改动可运行（dev server 冒烟 / 命令执行成功）
4. **审查**：自查改动（review 清单：正确性、安全、死代码、遗漏）
5. **证据**：每项验证有真实输出可查，不凭印象

## 反模式
- 不写"应该没问题"（要有命令输出/测试结果）
- 不跳过 lint/build 直接交付
- 不因为"时间紧"省略验证

## 输出
- 完成说明 = 改动摘要 + 验证证据（命令 + 结果）

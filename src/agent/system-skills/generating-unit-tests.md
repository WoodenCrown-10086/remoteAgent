---
name: generating-unit-tests
description: 从源码自动生成全面、可维护的单元测试
triggers: 需要为新代码生成单元测试时
---
# Unit Test Generation（单元测试生成）

## 输入分析
- 对每个函数/方法：签名、参数边界、返回值、异常路径、依赖注入点
- 识别：纯函数 vs 有副作用函数、异步、回调、私有依赖

## 测试清单（每函数至少覆盖）
1. 正常输入 → 期望输出
2. 边界值（空、0、null、undefined、极大/极小）
3. 非法输入 → 抛出/返回错误
4. 异步：resolve / reject / 超时
5. 副作用：调用顺序、参数透传、幂等性

## 命名与结构
- 测试名描述行为而非实现：`should return 0 when list is empty`
- 用 describe/it 分组；每 it 只测一个行为
- 测试数据用工厂函数，不重复内联

## 质量要求
- 测试必须真实断言（不 mock 被测函数自身）
- mock 只隔离外部依赖（网络/DB/时间）
- 跑通：新增测试全部通过，且现有测试不回归

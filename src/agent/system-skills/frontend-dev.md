---
name: frontend-dev
description: 前端开发规范：UI 设计、动效、质量门禁，避免模板化/AI 味
triggers: 任务涉及页面/组件/UI 设计、动效或前端质量时
---
# Frontend Dev（前端开发规范）

## 设计原则
- 每页都要有明确的"签名元素"（最让人记住的一个设计点），其余保持克制
- 配色：最多 1 个强调色，饱和度 < 80%，避免 AI 紫/蓝默认色
- 字体：不用 Inter；标题 tracking-tight，正文 max-w-[65ch]
- 布局：避免千篇一律的三列卡片、居中 hero

## 必做质量门禁
- Loading（骨架屏）、Empty、Error 三种状态必须实现
- 响应式到移动端、键盘焦点可见、尊重 prefers-reduced-motion
- 交互反馈：按钮按压 scale-[0.98]

## 动效
- 只动画 transform/opacity/filter/clip-path（GPU 属性），禁止动画 width/height/top/left
- 入场用 spring（stiffness 100-150, damping 20），交错用 stagger ≤ 3 项
- 永远保留 prefers-reduced-motion 降级

## 代码
- React/Next.js：交互隔离为 "use client" 叶子组件，其余 Server Component
- Tailwind CSS 4，不要混用 v3/v4 语法
- 组件命名 PascalCase，工具函数放 lib/

## 反模式清单
- 禁用：霓虹发光、纯黑 #000、渐变文字标题、自定义光标、无定制默认 shadcn
- 不用占位图 URL（unsplash/picsum 等），图片本地化

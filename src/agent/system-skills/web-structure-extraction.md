---
name: web-structure-extraction
description: 提取网页布局/视觉/组件结构，生成可仿照复刻的设计蓝图
triggers: 用户给 URL/网页要求仿照结构设计时
---
# Web Structure Extraction（网页结构提取）

目标：把用户给的一个网页（URL 或本地 HTML），逆向拆解成结构化设计蓝图，供仿照实现。

## 输入
1. URL → web_fetch 抓取（注意会剥离 HTML 标签，结构信息有损）
2. 本地 HTML 文件 → 直接读取原始 HTML（最佳，DOM 完整）
3. 仅文字/截图描述 → 基于描述推断，标注"推断"

## 输出蓝图（固定章节）
1. **布局骨架**：ASCII wireframe（header/nav/hero/分区/footer/栅格列数）
2. **视觉规范**：主/次/强调色 #hex、背景色、字体（显示/正文/字号阶梯）、圆角、阴影、间距基调
3. **组件清单**：Header/Card/Button/Form/Modal/Footer 各自的布局与关键样式
4. **交互动效**：hover、吸顶、滚动渐显、动画
5. **响应式**：断点切换、侧栏消失时机、汉堡折叠
6. **技术栈线索**：class 命名（Tailwind/BEM）、CSR/SSR 痕迹、CDN 引用

## 标注置信度
- ✅ 确定（HTML 直接可见）
- 🔶 推断（从模式推测）
- ❓ 未知（需人工确认）

## 注意
- 不输出原始 HTML 全文，只输出提炼蓝图
- 附"映射建议"：原结构如何套用到用户的新内容
- 抓取失败（403/超时）→ 告知并提供替代方案（本地保存 HTML 再给路径）

# Whomi Homepage Implementation Plan

> 历史计划：对应首页已完成的实现阶段，以下任务和授权不作为新业务的执行指令。2026-10-28 新设计见[自我理解体验](../../designs/whomi-self-understanding-design.md)，本轮未实现。

> 执行方式：本会话直接实现，独立子代理提供行为测试及最终审查；用户已明确批准进入实现，无需重复确认。

**Goal:** 完成可在本地运行的 Whomi 首页与可折叠侧栏。

**Architecture:** React 首页组合 shadcn/ui 派生的侧栏与提示组件。CSS 统一定义视觉变量，本机存储只保存侧栏偏好，首页不请求模型或聊天记录。

**Tech Stack:** React、TypeScript、Vite、Radix 提示组件、Lucide 图标、Vitest。

**Spec:** [已确认实现约定](../../designs/whomi-home-implementation.md)。

## Global Constraints

- 在用户指定的 main 工作，保留已有文档与资产；实现阶段暂不提交，2026-10-27 用户进一步授权将已确认的首页实现提交并推送到 GitHub。
- 首页只有简单问候，使用已确认原始品牌文件。
- 不扩展导入、模型、仪表台或设置业务；不可用入口明确禁用。
- 系统字体、约 44 像素以上触控区域、可见焦点、减少动态效果。

## Review Focus

- 本机存储损坏或拒绝访问时仍能切换：行为测试覆盖。
- 快速反向切换与图标锚点稳定：浏览器实测。
- 空白或超长称呼：行为测试与窄屏检查。
- 窄屏展开、Escape 收起、焦点恢复：浏览器实测。
- 图片外围留白、文字对比度与无横向溢出：桌面和窄屏截图审查。

## Task 1：首页与侧栏

文件：package.json、vite.config.ts、src/App.tsx、src/components/ui/sidebar.tsx、src/components/ui/tooltip.tsx、src/styles.css、src/main.tsx、src/App.test.tsx。

- [x] 配置依赖并建立首页行为测试。
- [x] 实现简单问候、品牌入口、禁用业务入口与可持续保存的侧栏状态。
- [x] 实现响应式布局、可中断过渡、提示、焦点及减少动态效果。
- [x] 运行 npm test 与 npm run build，修复实际失败。

## Task 2：浏览器验证与交付

文件：README.md、THIRD_PARTY_NOTICES.md、docs/designs/whomi-home-implementation.md。

- [x] 启动本地页面，检查展开、收起、键盘、刷新持久化及窄屏。
- [x] 运行一次 Impeccable 机械检查，由独立代理审查代码和截图。
- [x] 修复有证据的问题，记录验证结果与业务边界，补齐启动说明。
- [x] 保持服务可访问，提供本地预览和中文提交说明。

2026-10-27：10 项行为测试及生产构建通过；已验证桌面和窄屏交互。独立审查要求同步文档状态，修复后复审结论为 ship。具体证据与验证边界见[首页实现约定](../../designs/whomi-home-implementation.md#验证记录)。

后续顶部交互与品牌显示修订完成后，行为测试增加至 12 项；提交前重新运行 12 项测试与生产构建均通过。用户已授权提交并推送当前 main，范围为首页实现、相关设计文档与已有首页静态参考图；未采用的品牌探索图片留在本机。

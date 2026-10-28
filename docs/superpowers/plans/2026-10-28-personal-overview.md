# 个人总览实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. 用户已确认视觉并授权实施；不提交、不推送。

**Goal:** 实现可运行的个人总览、诚实空状态、可纠正的 Spark 界面与独立开发预览。

**Architecture:** 沿用 React、TypeScript、Vite 及现有侧栏、提示、文件选择与会话阅读。总览接收展示数据和异步反馈适配器；生产入口无结果时保留未知。原文以会话和消息范围定位，不引入存储或模型服务。

**Tech Stack:** React、TypeScript、Vite、Vitest、Testing Library、现有 lucide 图标。

**Spec:** docs/designs/whomi-self-understanding-design.md 与本会话 2026-10-28 最终视觉确认；视觉参考为本机 gstack 的 personal-overview-20261028-r2/variant-A.png。用户最新修订：移除人格相关会话列；解惑置于侧栏；Spark 必须还原较完整交流场景，不能单凭一句话下结论。

## Global Constraints

- 当前 main 跟踪 origin/main，均为 4427e57；实施前已 fetch 与 pull。
- 不调整启动动画、品牌返回或侧栏隐私约定；个人总览只从 Hello 进入。
- 结果允许 E?F?，全部未知为 ????；未知无中点，依据充分且均衡单独呈现。
- 不添加数字分数、模型调用、生成刷新按钮或真实业务保存的假回执。
- 仅开发入口提供明确虚构示例、错误和延迟模拟；解惑只实现独立入口与诚实空状态。
- 用户可见文本简洁可操作，注释只说明必要原因；不得执行提交、推送或外部发言。

## Review Focus

- 来源缺失、消息区间逆序或结束消息缺失：不定位错误消息，回退到可操作提示。
- 反馈失败后更改选择再重试：重试原提交快照，不丢当前草稿，不误标为已保存。
- 总览经原文返回：保留未提交评论、选择和反馈状态；品牌返回移除正文。
- 已知均衡与未知：汇总代码不为均衡强选字母，四组中文和结果保持一致。
- 375 像素和长文本：内容不横向溢出，键盘可操作来源、反馈和菜单。

## Task 1: 总览组件与反馈状态

Files: src/components/overview/types.ts、personal-overview.tsx、overview.css、use-overview-feedback.ts、相应测试。

Interfaces: OverviewData、SourceReference、FeedbackSaver 由 types.ts 共享；导出 PersonalOverview 与 useOverviewFeedback。组件接收 data、headingRef、onReturnToCover、onImport、onOpenSource、isSourceAvailable、feedback。

- [x] 先验证未知与均衡、E?F? 汇总、情境内容和无 Spark 的行为。
- [x] 实现纵向人格与 Spark，不显示人格依据列或总览内解惑。
- [x] 验证互斥、取消、直接评论、处理中、失败重试、缺少适配器、模拟回执和真实回执的区别。

## Task 2: 应用导航与会话范围定位

Files: src/App.tsx、src/components/conversations.tsx、conversations.css、src/overview-navigation.test.tsx。

Interfaces: App 追加 overview?: OverviewData、saveFeedback?: FeedbackSaver、preview?: boolean。阅读器追加 sourceRange?: {messageId:string;endMessageId?:string} 与 onReturnToOverview?。

- [x] 先验证 Hello、品牌、独立解惑菜单、来源可用与缺失、返回草稿。
- [x] 在 HomeShell 持有反馈控制器；来源检查使用实际传入会话。
- [x] 定位并标记整个引用范围，保留完整会话前后文；不添加真实存储。

## Task 3: 独立开发预览与文档

Files: src/dev/preview.tsx、src/dev/overview-fixtures.ts、src/dev/preview.css；docs/designs 中实现记录及相关状态文档。

- [x] 提供无材料、未分析、部分未知、均衡、无发现、场景化 Spark、来源缺失、反馈失败和长文本状态。
- [x] 模拟器清楚标识虚构与未保存；不写浏览器存储，不进入生产包。
- [x] 同步当前完成、预览专用与后续依赖，保留解惑完整业务未实现说明。

## Verification

- [x] npm test
- [x] npx tsc -b --pretty false
- [x] npm run build
- [x] 桌面与窄屏浏览器：Hello、品牌返回、消息范围定位、返回草稿、键盘与失败重试。
- [x] Impeccable detect 与独立代码复核，修复影响正确性的发现。
- [x] 最终记录预览方式、证据边界和中文提交说明；不执行提交。

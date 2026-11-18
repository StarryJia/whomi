# 对话洞察：落实已确认设计与界面验收基线

GitHub 工单：[#11](https://github.com/StarryJia/whomi/issues/11)；2026-11-15 已发布。

**2026-11-15 实施回填：** 已按14份有效设计图实现并检查实际 Electron 窗口，覆盖正常、暂停、失败重试及960 × 640窄窗。头像与气泡、进度环问题已修复复查。逐图映射、37张实际截图与三项技能执行边界见[实施验证](../../../research/conversation-insights-validation.md)；下方为发布时设计要求。

规划编号：I01。首期七类主要界面已有设计图；本工单维护设计依据和交付约束，不重新组织一轮选图。静态设计已确认，功能实现与真实页面验收仍待完成。

## 使用场景与目标

以下为虚构场景：用户在小林会话点击会话洞察，选择十月范围并开始分析；生成后在报告中点击那次汇报准备，查看原文再回到原阅读位置。实现者需要从同一套图和规则完成这条路径，避免从历史候选恢复全局新建入口、重复选择本人或更早/更晚按钮。

## 已确认设计及所属工单

所有图片中的人物、日期、报告编号、正文及统计均为虚构示例。图外方案名称、状态标题和说明不进入应用；全局外壳继续遵守现有产品规范。

| 界面 | 当前设计依据 | 实施工单 |
|---|---|---|
| 会话内启动与范围检查 | [日期范围正常态](../../../designs/conversation-insights/assets/startup-current-conversation-v2.png)、[全部记录／日期错误／空范围／无模型](../../../designs/conversation-insights/assets/startup-scope-states-v1.png) | [I05](05-report-interface.md) |
| 未选择本人入口提醒 | [本人选择](../../../designs/conversation-insights/assets/startup-self-required-v1.png) | [I05](05-report-interface.md) |
| 生成进度 | [收起](../../../designs/conversation-insights/assets/progress-collapsed-v1.png)、[展开](../../../designs/conversation-insights/assets/progress-expanded-v1.png)、[暂停／失败／完成](../../../designs/conversation-insights/assets/progress-task-states-v1.png) | [I05](05-report-interface.md) |
| 报告管理 | [G管理方案](../../../designs/conversation-insights/assets/management-g-v2.png)、[生成中详情](../../../designs/conversation-insights/assets/management-task-details-v1.png)、[首次读取与失败](../../../designs/conversation-insights/assets/management-list-read-states-v1.png) | [I05](05-report-interface.md) |
| 报告阅读与改名 | [阅读页A](../../../designs/conversation-insights/assets/report-reader-a-v2.png)、[原位改名与失败](../../../designs/conversation-insights/assets/report-reader-rename-v1.png) | [I05](05-report-interface.md) |
| 引用原文 | [弹窗V2](../../../designs/conversation-insights/assets/source-dialog-v2.png)、[自由浏览／读取失败](../../../designs/conversation-insights/assets/source-dialog-states-v1.png)，后者仅上方两格有效 | [I06](06-source-dialog.md) |
| 删除已完成报告 | [删除确认](../../../designs/conversation-insights/assets/report-delete-confirm-v1.png) | [I05](05-report-interface.md) |

报告阅读基线：

![已确认报告阅读页A，虚构示例](../../../designs/conversation-insights/assets/report-reader-a-v2.png)

管理布局基线：

![已确认G管理方案，虚构示例](../../../designs/conversation-insights/assets/management-g-v2.png)

## 实现约束

- 导航入口仍叫对话洞察；每个会话原整理成记忆位置改为会话洞察。报告默认名称固定为会话洞察，支持手动改名，不让模型生成名称。
- 本人未确认时在点击会话入口即拦截；成功保存本人后回原聊天，再点击才进入范围和模型设置。报告列表与历史报告阅读不受本人或模型配置限制。
- 报告采用关于你、你们的相处两节，具体经历文字本身作为原文入口。生成分析中的对方用 ta，原始聊天与发送者保持原样。
- 进度显示消息覆盖、有效运行时间、消息数/s及只读模型配置；不显示算法阶段。输入输出和缓存用量在详情中，消息处理完不等于报告已保存。
- 原文只读，滚动自动加载相邻消息；上一段在右上、下一段在右下，没有相关片段文字。正常关闭恢复报告位置和入口焦点。
- 删除一份报告保留聊天和其他报告；新增或删除报告同步个人总览。删除整个会话则关联删除报告，失效阅读页和弹窗退出到有效列表或既有空态。

## 同布局状态与历史图边界

首批无进度、暂停或重试过渡、其他任务详情、重命名保存中、本人读取或保存失败、已有列表刷新失败及普通窄窗，复用已选布局和组件，补齐行为并做运行验收，不设逐张补图门槛。例：列表已有两份报告时刷新失败，应保留两行并提供重试，不套用无数据的整页失败画面。

名称长度与空白处理、保存中取消或离页、失败行返回目标等尚未定的行为，由 I05 在实施前明确。只有现有布局无法承载且改变实际操作的差异才重新讨论。

历史整图及原文四状态下方两格不作为实现依据，具体清单见[设计清点表](../../../designs/conversation-insights/design-inventory.md)。当前正常业务没有单条消息编辑、删除或替换后仍保留报告的流程，不为该假设增加页面。个人总览本期只要求数据联动；问一问和心事屋保持独立计划。

## 待办与验收

- [x] 各实施工单已附固定版本的当前设计图及适用状态，发布后链接检查通过。
- [x] I05、I06 的主要流程已在正常 Windows 用户环境复测，覆盖正常、取消、失败恢复及 960 × 640 窄窗。
- [x] 核对侧栏「对话洞察」、工具栏「会话洞察」、本人检查时机、默认报告名、进度字段和原文跳转。
- [x] 总览已打开时新增报告会增加来源，单份删除保留其他报告和聊天，整会话删除退出失效报告或原文并撤回来源。
- [x] 对照仅使用当前有效图，历史候选和原文状态图下方两格留档。

2026-11-18 验收记录包含图稿映射、18 张实机截图、修复复查和待验证的补充状态。首轮桥接用例超时，保留原始日志，后续完整复测 6 项通过。 [桌面验收记录](../../../research/conversation-insights-design-baseline-20261118.md)

## 必用界面技能与证据

- **impeccable**：依据选定图和已有组件系统实现，记录每页采用的图与状态。
- **ui-ux-pro-max**：核查桌面应用中的表单、交互、键盘焦点、对比度及窄窗，记录实际步骤与结果。
- **design-review**：对应页面实现后审查真实运行截图，修复后复查，保留前后截图及未验证项。由 I05、I06 交付，不为本设计工单提前开发页面。

新增或修改图稿仍使用 design-shotgun，并沿用逐页讨论流程；共同要求见[界面技能约定](../../../designs/conversation-insights/ui-skill-workflow.md)。

## 依赖与实施定位

依赖 [I00](00-tracking.md) 的功能范围；设计交付给 [I05](05-report-interface.md)、[I06](06-source-dialog.md)，完整验证由 [I07](07-validation.md) 跟踪。先读取 PRODUCT.md、DESIGN.md，设计资产位于 docs/designs/conversation-insights/。本期为 Windows 桌面，不扩展移动端或另造全局导航。

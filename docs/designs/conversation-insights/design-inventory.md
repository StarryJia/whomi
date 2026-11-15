# 对话洞察设计清点表

更新：2026-11-15。用途：先核对已有图与确认记录，再决定是否确实需要出图。本表是设计资产清点，不表示功能已实现或真实交互已通过验证。

## 本次纠正

用户指出启动范围与异常四状态已经设计并确认。所附 exec-5b6c312c-1209-4f45-90de-47bf67978a9c.png 与 assets/startup-scope-states-v1.png 的 SHA256 文件指纹一致：C1AD8B9A5AD1E8FE2EFD324B348DD599C8B5A15DFC9B91F739E4CA8BC62EDE2C。

2026-11-15 据用户纠正补记已确认，不猜测首次批准日期。之前漏记确认状态，并把同布局细节、行为未定和功能未实现都写成待设计，造成重复审图。本轮不生成或重新展示图片。

## 当前设计覆盖

首期七类主要界面均已有图；当前没有尚未设计的新主页面。共19个图片文件，14个为当前依据，其中原文四状态仅上方两格有效；另外5个整图为历史参考。

下表的操作均为虚构使用示例，描述计划实现的行为。

| 界面 | 当前依据 | 覆盖的使用场景 | 工单 |
|---|---|---|---|
| 会话内启动、范围和模型 | [启动正常态](assets/startup-current-conversation-v2.png)、[范围与异常四状态](assets/startup-scope-states-v1.png) | 在小林会话启动十月分析；日期倒置、范围无消息或没有模型时就近反馈，修改后再开始。 | [I05](../../planning/issues/2026-11-13-conversation-insights/05-report-interface.md) |
| 本人缺失入口提醒 | [本人选择](assets/startup-self-required-v1.png) | 未选择本人时点击会话洞察，先选成员；保存后回到聊天，再点击才进入范围设置。 | [I05](../../planning/issues/2026-11-13-conversation-insights/05-report-interface.md) |
| 生成进度与任务状态 | [收起](assets/progress-collapsed-v1.png)、[展开](assets/progress-expanded-v1.png)、[暂停、失败、完成](assets/progress-task-states-v1.png) | 查看消息数、运行时间和分析速度；展开查看输入输出用量，暂停或失败后按相应操作继续。 | [I05](../../planning/issues/2026-11-13-conversation-insights/05-report-interface.md) |
| 报告列表与管理 | [G管理方案](assets/management-g-v2.png)、[任务详情](assets/management-task-details-v1.png)、[首次读取与失败](assets/management-list-read-states-v1.png) | 在小林分组打开已完成报告、右键改名；任务详情及读取失败均在原列表内处理。G图第一格已经包含完成报告行。 | [I05](../../planning/issues/2026-11-13-conversation-insights/05-report-interface.md) |
| 报告阅读与重命名 | [阅读页A](assets/report-reader-a-v2.png)、[重命名](assets/report-reader-rename-v1.png) | 阅读关于你和你们的相处，将默认会话洞察手动改名；保存失败时保留输入。 | [I05](../../planning/issues/2026-11-13-conversation-insights/05-report-interface.md) |
| 引用原文弹窗 | [原文V2](assets/source-dialog-v2.png)、[浏览与临时失败](assets/source-dialog-states-v1.png)的上方两格 | 点击经历文字定位消息，上下滚动加载聊天，点击上一段或下一段定位其他证据，关闭后回到阅读位置。 | [I06](../../planning/issues/2026-11-13-conversation-insights/06-source-dialog.md) |
| 删除已完成报告 | [删除确认](assets/report-delete-confirm-v1.png) | 核对报告编号和日期后删除，只移除该报告并撤回其个人总览贡献，聊天及其他报告保留。 | [I05](../../planning/issues/2026-11-13-conversation-insights/05-report-interface.md) |

这些界面的图稿确认范围见[设计记录](README.md)；实际交互仍须实现后验收。界面工单继续要求 impeccable、ui-ux-pro-max、design-review，技能使用及留证方式见[必用技能流程](ui-skill-workflow.md)。

## 没有单独图片的补充状态

以下确实尚未单独出图，但均属于现有界面；默认复用已选布局、组件和反馈位置，不逐项转成新页面或选图门槛。只有操作出现实质差异且现有图无法表达时，再单独讨论。

| 补充状态 | 使用场景与验收方向 | 仍需做的事 |
|---|---|---|
| 重命名空白输入、保存中 | 示例：编辑报告名时清空内容或保存尚未结束；反馈留在原编辑区，不丢失草稿。 | 明确名称长度、空白处理、保存中取消或离页等行为；不把建议写成已批准规则。 |
| 本人选择读取或保存失败 | 示例：选择小周后保存失败；原选择保留，成功前不进入洞察设置。 | 复用既有成员选择错误反馈，核对未明确的恢复操作。 |
| 首批未保存、暂停和重试过渡 | 示例：开始后尚无保存进度，不能显示虚构已读数；重试同一批不能重复增加已读量。 | 沿用进度布局，明确字段可用性、零值与未知值。 |
| 暂停、失败、完成的展开详情 | 示例：暂停后展开用量，仍能看到已产生的真实统计。 | 沿用已选详情结构，核对时长、速度及用量语义。 |
| 有列表数据时刷新失败 | 示例：列表已有两份报告，刷新失败后原列表仍可阅读，并提供原地重试反馈。 | 没有专门图片；复用列表内反馈位置，实施时验证不清空已有数据。 |
| 原文首次加载及首次读取失败 | 示例：点击引用后尚未返回聊天，不显示伪造内容，失败可在原弹窗重试。 | 复用原文弹窗与既有读取反馈，保留关闭能力。 |
| 生成任务转为完成报告 | 示例：任务保存成功后显示可打开的完成报告行。 | 完成行已有G图；待验证的是状态切换及避免重复条目，不缺完成页面。 |
| 长名称、常规窄窗及文字换行 | 示例：窗口收窄后名称与元信息换行，返回、改名和引用仍可操作。 | 按已选布局做适配验收；历史窄窗图仅作参考。 |

此外，管理失败行的返回目标仍需明确；这是导航行为问题，不是需要再画一张失败页。

## 数据规则与后续计划

- **个人总览联动：**报告增删联动已确认，具体来源聚合契约仍需明确，不需要新增总览页面设计。示例：删除 #24 后重算剩余 #23 支持的判断，不能保留只由 #24 支持的结论；取消删除不改变总览。
- **问一问：**新方案属于[Q00独立计划](../../planning/issues/2026-11-13-conversation-insights/08-ask-plan.md)，尚未定稿；已有旧澄清页面可参考或复用，不能说从未有过设计。示例：将来用户针对关系提问时如何使用授权材料，需在该计划中确定。
- **心事屋：**独立交流方案属于[H00独立计划](../../planning/issues/2026-11-13-conversation-insights/09-heart-room-plan.md)，尚未设计定稿。示例：用户不选择某段会话也能表达心事，其入口后的流程在该计划中讨论。

问一问和心事屋不算首期对话洞察缺图项，本次不自动开始设计。

## 历史参考

以下资产继续保留供追溯，不进入待确认或下一页队列：

| 资产 | 处理 |
|---|---|
| [management-g-original.png](assets/management-g-original.png) | 已由G修订图替代，不能恢复旧控件。 |
| [report-list-v1.png](assets/report-list-v1.png) | 已由G管理布局替代。 |
| [source-dialog-v1.png](assets/source-dialog-v1.png) | 已由原文V2替代。 |
| [report-reader-narrow-v1.png](assets/report-reader-narrow-v1.png) | 常规适配参考，取消独立选图门槛。 |
| [source-dialog-partial-unavailable-v1.png](assets/source-dialog-partial-unavailable-v1.png) | 当前业务没有单条原文删除后仍保留报告的正常流程，仅作历史防御性参考。 |
| [source-dialog-states-v1.png](assets/source-dialog-states-v1.png)下方两格 | 原文修改及删除会话后返回报告的前提不适用，移出首期；上方两格仍有效。 |

真实删除约束：删除一份报告保留聊天；删除整个会话则关联删除其报告和聊天，已打开的失效界面须退出到现有列表或空态，不能返回已删除报告。临时读取失败、来源校验和异常数据兜底仍需实现，不据此增加原文编辑或单条删除功能。

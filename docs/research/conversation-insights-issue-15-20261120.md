# 工单 #15 · 对话洞察桌面验收

2026-11-20，从远端 main 的 542a566 建立 codex/issue-15-insight-reports。#20 已实现首期流程，#11 验证了设计基线，本轮补齐 [工单 #15](https://github.com/StarryJia/whomi/issues/15) 余项并在当前代码上复测。使用 Windows 正常用户环境、仓库构建的 Electron、隔离资料库和 127.0.0.1 上的合成模型。以下人名、聊天和报告均为合成数据。

## 行为与证据

| 操作 | 结果 |
| --- | --- |
| 在合成会话选择十月范围，取消或把日期填反；恢复有效日期后开始 | 取消时任务列表为空，倒置和合法的空范围均禁用开始。10 月 9 日至 10 日显示 3 条，库中的其余 281 条未发送。已有旧报告时，新任务提交被拒后仍能查看旧报告，并可按原日期重试。 [范围设置](assets/conversation-insights-issue-15-20261120/04-startup-dates.png) |
| 保持合成模型请求等待，然后暂停、返回列表、重新打开进度 | 等待请求时有效运行时间增长，平均分析速度按已保存去重覆盖计算。暂停确认后两项数值保持，恢复沿用同一编号。在 3 / 3 时模拟成稿失败，列表保留覆盖、耗时和速度，重试后才出现报告。缓存未返回显示 —，明确返回 0 显示 0。 [展开进度](assets/conversation-insights-issue-15-20261120/06-progress-expanded.png) · [失败行修改前](assets/conversation-insights-20261115/23-management-failed.png) · [失败行修改后](assets/conversation-insights-issue-15-20261120/23-management-failed.png) |
| 从较长的请求日期范围生成报告，在列表、阅读页及删除确认看日期 | 三处显示保存快照中实际首末消息日期及当时的时区。组件回归使用跨当地午夜的合成时间，例如按上海时区显示 10 月 3 日至 4 日。运行详情仍可看到提交的分析范围。 |
| 在 960 × 640 窗口通过键盘打开报告、回查原文及返回列表 | 正文与元信息随空间换行。Escape 关闭原文后恢复引用焦点。长列表用例以一份真实保存报告加合成读取结果构成可滚动列表，返回后原滚动值、折叠分组和报告行焦点一致。旧格式报告关闭后的回行行为另有组件回归。 [窄窗报告](assets/conversation-insights-issue-15-20261120/16-narrow-report.png) · [打开前](assets/conversation-insights-issue-15-20261120/narrow-list-before-reading.png) · [返回后](assets/conversation-insights-issue-15-20261120/narrow-list-after-returning.png) |
| 操作两份同名报告，对短范围报告改名并删除长范围报告 | 改名失败保留草稿，保存成功后阅读页与列表同步。删除时取消、Escape 或遮罩均保留报告。提交期间只接收一次目标编号请求，失败可原地重试。长范围报告独有的判断撤回，短范围报告名称及来源在重启后仍可读取。再删除其来源会话，四个维度回到尚待了解。 [改名失败](assets/conversation-insights-issue-15-20261120/simulated-rename-save-failed.png) · [删除提交中](assets/conversation-insights-issue-15-20261120/report-delete-pending.png) · [重启后的总览](assets/conversation-insights-issue-15-20261120/overview-after-restart.png) |

## 图稿与运行截图

图稿使用 [已确认清单](../designs/conversation-insights/design-inventory.md)。完整截图在本次 Windows 测试产物的 results 目录，名称如下。名称含 simulated 的文件由桌面进程注入读取或保存故障。

| 已确认图稿 | 本次桌面截图 |
| --- | --- |
| 启动正常态、范围四状态、本人缺失 | 01-startup-all、02-startup-invalid-dates、03-startup-empty-range、04-startup-dates、24-self-required、25-startup-no-model |
| 进度收起、展开、暂停失败完成 | 05-progress-collapsed 至 09-progress-complete |
| 管理 G、任务详情、初读与失败 | 18-narrow-management、20-management-running 至 23-management-failed、simulated-26-management-loading、simulated-27-management-read-failed、simulated-management-refresh-failed-with-reports |
| 阅读 A、原位改名和失败 | 10-report-reader、11-report-rename、16-narrow-report、28-narrow-long-title、simulated-rename-save-failed |
| 单份报告删除 | 19-delete-confirm、report-delete-pending、simulated-delete-failed |
| 原文交互衔接 #16 | 12-source-first 至 15-source-second、17-narrow-source、narrow-source-keyboard-retry、simulated-source-next-failed |

- **impeccable** 读取产品与设计约定，对照启动、管理 G 和阅读 A。沿用共享弹窗、错误提示和同一位置的操作区。对本轮改动界面的机械检查结果为空。
- **ui-ux-pro-max** 核对进度反馈、键盘顺序和焦点可见性。以 1280 × 900 为常规窗口，960 × 640 保持 240 像素侧栏。使用实际元素断言列表返回、改名、弹窗取消和原文恢复。按当前主题色计算，任务底色上次要文字对比度约 5.42∶1，白底引用链接约 5.72∶1。
- **design-review** 审查真实桌面截图，对照失败行统计及窄窗内容。删除最后一份报告后，曾观察到页面标题未获焦点。修复后的桌面回归确认标题获得焦点。 [删除后焦点](assets/conversation-insights-issue-15-20261120/report-delete-final-focus.png)

置顶与报告顺序由组件回归覆盖。真实窗口中的拖动排序、本人读取或保存失败、从两个界面同时发出暂停或继续尚未逐项实测。重复请求由共享桌面入口的测试覆盖。总览的聚合和重复事件还有存储与组件回归。真实模型语义质量由 #17 跟踪。

## 执行结果

类型检查和桌面构建通过。完整前端套件单进程复测 657 项通过。后端 762 项通过。最终在 Windows 运行的 9 项桌面用例通过，退出码 0。独立工作树的 artifacts/issue-15 保存执行命令、构建指纹、标准输出、标准错误、54 张运行截图和测试报告。

| 目录 | 独立运行结果 |
| --- | --- |
| first-20261120-095050-083 | Playwright 拒绝不支持的截图命令行参数，退出码 1。未启动 Electron。 |
| desktop-20261120-095207-486 | 改正命令后 8 项通过。 |
| final-20261120-100226-963 | 8 项通过，1 项失败。删除最后一份报告后报告行已移除，标题未获焦点。保留失败截图、上下文和跟踪文件。 |
| verified-20261120-101208-124 | 修复后 9 项通过。 |

中间完整前端测试发现旧格式弹窗的回行滚动回归，修复后定向用例通过。并行执行的后续前端运行有五个既有用例超时，后端有四个超时并伴随一次数据库文件占用。独立前端运行首次为 656 项通过、1 项失败，导入日志用例在异步提示更新前断言。将导入文件单独运行时 8 项通过。整个过程的日志保存在 frontend-final.log、frontend-import-recheck.log、frontend-one-worker.log 和 backend-final.log。

## #39 行内评审修复

在 `codex/issue-15-insight-reports` 继续修复 [评审中的六项问题](https://github.com/StarryJia/whomi/pull/39#pullrequestreview-5987048406)。所有测试使用合成数据。

| 项目 | 操作与实际结果 |
| --- | --- |
| 创建失败 | 从已有九月任务启动十月任务，模拟提交被拒。组件回归确认浮窗显示十月的失败和原范围。取消修改后的草稿再重试，提交仍带入原十月日期。九月报告或任务可通过独立入口打开。 |
| 暂停和继续的调用顺序 | 首次回执未返回时依次发出暂停、继续、暂停。边界回归确认三条指令按原顺序到达，最终暂停。连续重复的同一指令共享请求。 |
| 保存已生成报告 | 使用正文已写入断点的任务，累计用时达到或超过 30 分钟后重试。后端回归确认可以取回正文，仍校验身份、来源和覆盖，期间模型调用为零。 |
| 缓存用量 | 两次请求的读取量为 0 和缺失时，界面显示未知。两次都明确返回 0 时显示 0 词元。存储与组件回归还核对写入缺失及有数据的独立字段。 |
| 异常退出恢复 | 让本机合成模型保持请求等待，中止测试进程并等待 8 秒后重开同一资料库。原构建退出前显示 00:10，重启只恢复 1.823 秒。修复版重启恢复退出前已写入的 10.024 秒，随后同一编号完成报告。[重启后保留计时](assets/conversation-insights-issue-15-20261120/review-elapsed-after-restart.png) |
| 缩窗后返回列表 | 从 1280 × 900 的长列表按 Enter 打开报告，阅读期间缩到 960 × 640，再按 Enter 返回。原构建目标行焦点在屏幕外。修复版目标行在可视区域内且获得焦点，折叠分组保持原状态。[返回后焦点](assets/conversation-insights-issue-15-20261120/review-focus-after-resize.png) |

Windows 正常用户环境运行两组洞察桌面测试，11 项通过。修复前首次退出用例在初始化等待超时，该轮保留启动日志、跟踪和错误上下文，未单独保存截图。下一轮发现直接从会话打开浮窗无法观察由测试接口创建的任务，随后改用报告列表入口。发送退出信号的试跑出现额外用时写入，对应关闭路径未确认。使用专用退出码绕过正常退出保存流程后复现了计时回退，修复版使用同一路径验证。独立工作树的 `artifacts/issue-15` 保留各轮命令、日志、测试报告、失败跟踪和截图。

类型检查和桌面构建通过。最终串行测试中，前端 661 项、后端 776 项均通过。前期并行试跑出现对话导航、引用选择和导入压力用例超时，串行全量复跑未再出现失败，前端仍有原有的 React 测试状态更新警告。

最后再次定向运行两个 Windows 桌面用例，均通过。将等待跨过完整的计时写入周期后，退出前界面显示 00:14，最后一次写入为 10.018 秒，重启仍为 10.018 秒。同一编号可继续完成。复测目录为 `review-final-targeted-20261120-124001-314`。

# 对话洞察设计基线桌面验收

2026-11-18，想法 004 与[工单 #11](https://github.com/StarryJia/whomi/issues/11)。从远端 `main` 的 `9b4f6d9` 建立 `codex/issue-11-insight-design-baseline`。所有人物、日期、聊天和模型响应均为合成数据。通过实际 Windows Electron 窗口、本地数据库和 `127.0.0.1` 上的固定响应服务操作。

## 图稿与实机对照

使用[有效设计清单](../designs/conversation-insights/design-inventory.md)及[完整图稿映射](assets/conversation-insights-20261115/ui-evidence.md)。下表记录今天重跑的代表场景。完整截图按用例保存在桌面产物目录，选取下列截图纳入仓库。

| 界面与图稿 | 实际操作及结果 |
| --- | --- |
| 启动与范围，[日期与异常](../designs/conversation-insights/assets/startup-scope-states-v1.png) | 会话工具栏打开「会话洞察」，取消后任务为空。倒置日期和空范围均禁用开始。改回 10 月 9 日至 10 日后，284 条本地消息中只提交范围内的 3 条。 [日期范围](assets/conversation-insights-design-baseline-20261118/04-startup-dates.png) |
| 本人选择，[入口提醒](../designs/conversation-insights/assets/startup-self-required-v1.png) | 未确认本人时先弹出成员选择。保存回原聊天，须再次点击「会话洞察」。无模型时开始按钮禁用。 [本人选择](assets/conversation-insights-design-baseline-20261118/24-self-required.png) |
| 进度，[展开](../designs/conversation-insights/assets/progress-expanded-v1.png)及[任务状态](../designs/conversation-insights/assets/progress-task-states-v1.png) | 核对已覆盖消息数、有效运行时间、消息分析速度、只读模型和详情用量。消息覆盖达到 3 / 3 时仍可暂停，成稿失败后重试原任务，保存后才出现「查看报告」。 [展开详情](assets/conversation-insights-design-baseline-20261118/06-progress-expanded.png) |
| 报告管理，[G 布局](../designs/conversation-insights/assets/management-g-v2.png)及[首次读取](../designs/conversation-insights/assets/management-list-read-states-v1.png) | 侧栏使用「对话洞察」，列表按会话分组。首次读取失败可原地重试。已有两份报告时，刷新失败保留两行，重试不发起模型请求。 [首次读取失败](assets/conversation-insights-design-baseline-20261118/simulated-27-management-read-failed.png) · [保留列表的刷新失败](assets/conversation-insights-design-baseline-20261118/simulated-management-refresh-failed-with-reports.png) |
| 报告阅读与改名，[阅读页 A](../designs/conversation-insights/assets/report-reader-a-v2.png)及[原位改名](../designs/conversation-insights/assets/report-reader-rename-v1.png) | 默认名「会话洞察」，报告分为「关于你」「你们的相处」，范围单独展示。取消改名恢复原标题和焦点，模拟保存失败保留输入，成功后同步列表。 [阅读页](assets/conversation-insights-design-baseline-20261118/10-report-reader.png) · [改名失败](assets/conversation-insights-design-baseline-20261118/simulated-rename-save-failed.png) |
| 引用原文，[弹窗 V2](../designs/conversation-insights/assets/source-dialog-v2.png)及[上方两个状态](../designs/conversation-insights/assets/source-dialog-states-v1.png) | 点击经历文字定位，保留发送者和聊天原文，普通上下文不高亮。滚动自动向两端加载，分页锚点位移小于 2 像素。下一段失败保持当前聊天和 1 / 2，重试成功才变成 2 / 2。长报告中按 Escape 恢复滚动位置和经历入口焦点。 [窄窗原文](assets/conversation-insights-design-baseline-20261118/17-narrow-source.png) |
| 删除报告，[确认图](../designs/conversation-insights/assets/report-delete-confirm-v1.png) | 对照名称、编号、范围。取消和模拟删除失败保留报告，成功删除一份后另一份仍可回查原文，原聊天仍可打开。 [删除确认](assets/conversation-insights-design-baseline-20261118/19-delete-confirm.png) |

## 修复复查

- **下一段读取失败**。在 1280 × 900 窗口浏览到当前引用后方，点击「下一段」并模拟读取失败。旧版聊天视口由距顶部 207 像素移到 244 像素。按已确认图将提示移至聊天区下方、片段导航上方，复测中视口顶部和滚动值保持一致，成功重试后定位到下一段。 [修复前](assets/conversation-insights-design-baseline-20261118/before-source-next-failed.png) · [修复后](assets/conversation-insights-design-baseline-20261118/simulated-source-next-failed.png)
- **已有报告刷新失败**。总览显示第一份报告时，生成同一会话另一日期范围的同名报告，保存后总览增加第二个来源。改名其中一份并注入一次列表读取错误。两份报告保持可见，重试后错误消失并聚焦列表标题。删除改过名的一份时，总览由两个来源变成一个。 [删除前](assets/conversation-insights-design-baseline-20261118/overview-two-report-sources.png) · [删除后](assets/conversation-insights-design-baseline-20261118/overview-one-report-source-after-deletion.png)
- **整会话删除**。在 960 × 640 窗口打开原文，延迟返回一份已经读取成功的原文结果，再调用桌面会话删除接口。原设计的模态层会阻隔侧栏，测试通过同一个桌面接口模拟删除先完成的时序。旧版存储删除后原文仍停留。修复后关闭原文和报告，聚焦「对话洞察」，列表和总览撤回该会话来源。释放之前的读取结果后，已删除内容没有重新出现。 [修复前](assets/conversation-insights-design-baseline-20261118/before-conversation-deletion-keeps-source-open.png) · [报告空态](assets/conversation-insights-design-baseline-20261118/34-list-after-conversation-deletion.png) · [总览](assets/conversation-insights-design-baseline-20261118/35-overview-after-conversation-deletion.png)
- **侧栏刷新失败**。打开报告，从侧栏右键确认删除来源会话，同时注入一次会话列表读取错误。删除成功后返回报告空态，侧栏立即移除旧会话，总览撤回最后一个来源。其他会话报告是否保留由[存储回归](../../tests/backend/insight-sources.test.ts)覆盖。 [修复前](assets/conversation-insights-design-baseline-20261118/before-sidebar-refresh-failed.png) · [修复后](assets/conversation-insights-design-baseline-20261118/list-after-confirmed-conversation-deletion.png)

## 界面审查与边界

- **impeccable** 根据 `PRODUCT.md`、`DESIGN.md` 和有效清单核对布局、当前主操作和提示位置。保留现有应用外壳，原文状态图只使用上方两格，业务范围不包含单条消息编辑后的历史候选状态。
- **ui-ux-pro-max** 搜索桌面模态键盘焦点以及 React 表单反馈指南，实测日期和名称输入、禁用态、重试焦点、关闭原文返回位置及 960 × 640 窄窗。窄窗保留 240 像素侧栏，报告和原文无横向溢出。按现有颜色值计算，白底次要文字约 5.82∶1、引用链接约 5.72∶1、新失败提示正文约 11.85∶1。对比度检查覆盖这些代表项。
- **design-review** 使用项目的 Playwright 驱动可见 Electron 窗口，对照已确认图及修复前后同尺寸实机截图。复查聚焦聊天视口、错误恢复和会话删除联动。

本轮未逐项复测本人读取或保存故障、暂停和重试的短暂过渡态、置顶拖动排序，以及原文加载时主动快速关闭或切换。迟到原文的桌面断言覆盖读取期间确认删除整会话的情形。报告语义质量见[真实模型对照记录](conversation-insights-paired-capacity-20261116.md)，由工单 #17 跟踪后续验收。

## 桌面执行记录

在正常 Windows 用户环境中顺序执行两份洞察桌面测试，保留 Electron 沙箱。各轮完整标准输出、标准错误、测试报告、退出码、窗口监测与 Windows 应用事件在本机 `artifacts/desktop-insights-recheck/` 对应目录。三轮定向复现另留失败轨迹及截图。

| 目录 | 结果 |
| --- | --- |
| `issue-11-baseline-20261118-221137` | 4 个界面用例通过。桥接用例在启动任务后 15 秒仍未记录到合成模型请求，退出码 1，原因未确认。 |
| `issue-11-delete-red-20261118-221516` | 复现整会话删除成功后原文弹窗仍打开。 |
| `issue-11-source-red-20261118-221729` | 复现下一段读取失败时聊天视口下移 37 像素。 |
| `issue-11-acceptance-20261118-221956` | 首次修复版 6 项通过。独立复核指出侧栏在会话列表刷新失败时仍可能保留已删会话。 |
| `issue-11-sidebar-red-20261118-222300` | 通过侧栏确认删除并模拟列表读取失败，复现已删会话仍可点击。 |
| `issue-11-final-20261118-222505` | 最终构建 6 项通过，退出码 0。窗口监测未发现原生错误弹窗，Windows 应用日志无对应崩溃事件。仓库中的修复后截图来自该轮。 |

桥接用例保留原 15 秒断言。后续如再失败，会附请求到达及解析时间、任务状态和可取得的窗口截图，辅助定位首轮超时。

同一代码版本通过 `npm run typecheck`、`npm run desktop:build`、`npm test -- --reporter=dot --maxWorkers=2`（605 项）和 `npm run test:backend -- --reporter=dot`（706 项）。前端套件输出了会话工作区既有测试的 React 状态更新警告，退出码为 0。

## #28 两条路径的定向复测

在 `8118b16` 重新构建 Windows 桌面应用，使用隔离资料库和合成数据。第一组 1 个组合用例记录删除、原文重试和快速关闭。第二组 3 个用例分别检查正常分页、分页读取故障及方向键滚动。两次运行退出码均为 0，均未观察到原生错误弹窗。下表保留修改前的实测结果。[测量数据](assets/conversation-insights-pr28-review-20261118/observations.json)

| 操作 | 当前构建的可观察结果 |
| --- | --- |
| 在会话列表右键删除有一份报告的会话，先取消，再模拟删除失败 | 确认框初始聚焦「取消」。清单提及记忆成稿，遗漏了洞察报告。取消将焦点还给会话行。删除请求失败时确认框仍可重试。两次检查均保留 1 份报告。[删除前实机画面](assets/conversation-insights-pr28-review-20261118/delete-confirmation.png) |
| 删除成功，单独让随后一次侧栏读取失败 | 会话行移除、报告数从 1 变成 0，总览撤回该来源。侧栏却显示「操作失败，请重试」。删除和这次读取是两个请求，读取错误由测试主动注入。 |
| 101 条合成会话中，删除首屏已显示的第 100 条 | 正常读取时剩余 100 条的顺序与置顶正确。模拟删除后读取失败时，侧栏只显示 99 条。点「加载更多会话」得到「请刷新阅读位置后重试」。手动重读列表才出现剩余的最后一条。分页查询以旧页最后一行作为下一页入口，已删行不能继续充当入口。[分页实机画面](assets/conversation-insights-pr28-review-20261118/deleted-page-boundary.png) |
| 在 960 × 640 窗口用键盘从第 1 段前往第 2 段，模拟一次读取失败并重试 | 失败前后聊天区距顶部均为 181 像素，滚动值均为 1598，计数保留 `1 / 2`。重试成功显示第 2 段，计数变为 `2 / 2`。重试按钮消失后焦点落到整个页面，此时按 ↓ 滚动 0 像素。对照操作将焦点移回聊天区，同一按键使滚动值从 1674 增至 1714。[失败与重试入口](assets/conversation-insights-pr28-review-20261118/next-fragment-failed.png) |
| 原文首次读取仍在等待时按 Escape，随即打开另一处引用 | 焦点先回到原报告入口。第二处引用成功后释放第一处迟到响应，弹窗仍显示第二处引用的 `1 / 1` 和消息 3。关闭后焦点回到第二处入口。 |

本机原始记录位于 `artifacts/desktop-insights-recheck/pr28-design-20261118-231332-266/`，其中 `desktop-01`、`desktop-02` 分别保留运行环境、命令、完整输出、测试报告和截图。前文首轮桥接用例超时的根因仍待确认。[本次确认的验收要求](../planning/issues/2026-11-13-conversation-insights/01-page-design.md#28-定向复核与验收要求)

## #28 修改后的验收

2026-11-19，在 `8118b16` 的本地修改上使用隔离的合成资料库，复测结果如下。

| 场景 | 实测结果 |
| --- | --- |
| 删除有两份报告的会话 | 确认框列出「此会话的全部洞察报告」，默认聚焦「取消」。取消后两份报告都能重新打开。模拟删除请求失败时，确认框可重试，已有报告仍在。确认成功后，侧栏移除该会话并保留导入入口，总览撤回报告来源。[删除确认](assets/conversation-insights-pr28-review-20261118/fixed-delete-confirmation.png) |
| 从 101 条会话中删除第 100 条 | 成功删除直接更新侧栏。在整页重读会被拒绝的条件下，程序重读首页 0 次。点「加载更多会话」后可见其余 100 条，仍按原顺序排列且保留置顶。再删除中间一条，原第 101 条仍可打开。组件回归另外覆盖了删除前发出的列表刷新、翻页响应迟到。[分页末项](assets/conversation-insights-pr28-review-20261118/fixed-sidebar-page.png) |
| 窄窗口用键盘重试第二段原文 | 读取失败时保留第一段和计数。用 Enter 激活「重试」后，第二段的引用和 `2 / 2` 出现，焦点在「引用聊天记录」，一次 ↓ 即向下滚动。按 Escape 关闭后，焦点回到报告中的原入口。[960 × 640 窗口](assets/conversation-insights-pr28-review-20261118/fixed-keyboard-retry.png) |

同一分支还修复了数据存储设置。测试使用与默认位置不同的合成保存目录。资源管理器打开了该目录，原生选择窗口一打开便显示只存在于该目录的测试子文件夹。取消后，设置仍显示原路径。迁移成功待重启时可以打开新位置，重启后再次选择也从新位置开始。[设置行为与验证](../designs/whomi-settings-implementation.md#保存目录的桌面复测)

类型检查、网页构建、桌面构建、608 项前端测试和 708 项后端测试通过。Windows 桌面的每次运行分别保存在本机 `artifacts/pr28-interaction-fixes/` 下，包含启动日志、退出码和测试报告。

| 运行目录 | 结果 |
| --- | --- |
| `desktop-01` | 7 项通过，1 项失败。新设置用例的临时资料目录缺少测试启动文件 `probe.cjs`，数据进程在创建窗口前退出。 |
| `desktop-02` | 补齐测试启动文件，完整 8 项通过。 |
| `native-01`、`native-02` | 两次均打开了测试目录。第一次验证脚本跟踪启动器，未找到实际进程的选择窗口。第二次使用的自动化调用无法关闭选定控件。两个失败现场均单独保留。 |
| `native-03` | 跟踪实际窗口进程，核对目录专有的子文件夹并关闭该选择窗口。1 项通过，取消后路径正确。 |

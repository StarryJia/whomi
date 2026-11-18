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

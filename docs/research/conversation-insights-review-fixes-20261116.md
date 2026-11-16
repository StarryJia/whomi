# 对话洞察审查修复验证

日期：2026-11-16。对应[想法004](../planning/ideas/004-conversation-insights.md)及[拉取请求20](https://github.com/StarryJia/whomi/pull/20)的三项代码审查发现。用户授权从最新 main 新建分支修复并补回归；工作分支为 `codex/fix-insight-review`，基线为 `b90bf1633d5373adccde1cfa5a467ab167db225c`。开始时工作区干净，已获取远端记录并在各编辑批次前同步 main。

## 修复行为与证据

以下输入、人物和报告编号均为合成示例。

| 问题与操作场景 | 完成的修改 | 如何验证 |
| --- | --- | --- |
| 同一句原文同时提到先道歉和安排聚会，模型提出两个独立核查问题，却只保留第一个 | 去重保留规范化问题文字比较，不再单凭来源编号相同丢弃不同问题 | 两个问题都完成核查，重复道歉问题只核查一次；核查上限、成稿失败后的恢复和累计预算保持有效 |
| 用户打开洞察设置后取消，或更换范围、模型，全量来源快照持续残留 | 取消、卸载、替换设置和迟到响应释放对应准备记录；再次准备及恢复时清理过期记录；原窗口校验限制释放权限 | 检查实际数据库记录删除、有效准备保留、重复取消、跨窗口拒绝及确认幂等性；界面测试覆盖严格模式下的迟到结果和提交期间离页 |
| 同会话报告23已置顶，任务24的进度更新使其越到报告23前面 | 已有任务原位更新；同会话稳定置顶优先，保留其余手动顺序 | 在真实 App 组件派发进度、插入和完成事件，检查按钮顺序；置顶与取消置顶后再更新进度，顺序仍正确 |

快照释放不会删除已被任务引用的准备记录。用户点击开始后，即使确认界面关闭或离页，也保留令牌直至该提交操作结束。后台确认与删除仍经过串行写入；数据库释放的页可用于后续写入，不承诺数据库文件立即缩小。释放请求失败由后续过期清理补偿。

新增17项回归：生成2项、数据库及路由4项、列表3项、准备界面生命周期8项。三个原问题均先由新增测试复现失败再修改实现；另外补充置顶切换和严格模式兼容场景。

- [生成流程回归](../../tests/backend/insight-generation.test.ts)
- [来源存储回归](../../tests/backend/insight-sources.test.ts)与[窗口权限回归](../../tests/backend/ai-router.test.ts)
- [列表事件回归](../../src/app-memory-lifecycle.test.tsx)
- [准备界面生命周期回归](../../src/components/conversation-ai/analysis-preparation-lifecycle.test.tsx)

## 本轮检查结果

| 检查 | 实际结果 |
| --- | --- |
| `npm test -- --reporter=dot --maxWorkers=2` | 59个文件，603项通过；既有 workspace-refinements 用例输出 React 异步更新未包裹 act 的警告，无失败 |
| `npm run test:backend -- --reporter=dot` | 56个文件，694项通过 |
| `npm run typecheck` | 通过 |
| `npm run desktop:build` | 通过 |
| `git diff --check` | 通过 |
| 独立代码复核 | 未发现需要修复的高置信问题 |
| 洞察桌面桥接和界面用例 | 诊断重跑5项通过，共53.7秒；使用隔离临时资料库及本机合成模型服务 |

桌面执行命令为 `node node_modules/@playwright/test/cli.js test tests/desktop/conversation-insights.spec.mjs tests/desktop/insight-ui.spec.mjs --workers=1 --timeout=90000 --max-failures=1`。首次在受限环境运行时，首个桥接用例报 `Test timeout of 60000ms exceeded`，随后中止该轮；同一构建在正常用户执行环境重跑通过。保留首次超时，不把重跑结果写成首次全绿，也未确定超时的具体根因。

桌面覆盖范围：设置取消、日期范围与本人/模型门槛、暂停恢复、成稿失败重试、来源定位与前后分页、改名、删除、列表读取失败重试，以及960×640窗口中的长标题和阅读位置恢复。置顶顺序由新增 App 组件回归验证；本轮没有另做置顶的桌面自动操作。

## 关键状态截图

截图来自本轮构建的实际 Electron 窗口，数据及模型响应为合成材料。沿用已确认的单列报告和管理列表布局，未修改视觉设计。核对结果：报告保留两节正文、返回与引用入口；失败状态保留重试操作；窄窗口中列表名称与范围信息可见。

- [正常完成后的报告，1280×900](assets/conversation-insights-review-fixes-20261116/report.png)
- [成稿失败与重试入口，1280×900](assets/conversation-insights-review-fixes-20261116/retry.png)
- [管理列表，960×640](assets/conversation-insights-review-fixes-20261116/narrow.png)

## 边界与下一步

本轮完成三项程序缺陷修复及回归，没有新增真实模型调用或依赖，也未发布安装包。用户随后于2026-11-16授权提交、推送并创建草稿拉取请求，同时要求明确可关闭的工单；按下表记录累计验收结论。固定响应及桌面合成服务不能证明长聊天报告的语义准确性改善；主记录中仍存在的未知范围扩大、前后矛盾和引用错选继续保留为后续事项。

## 工单关闭核对

已核对远端 #10—#19 的现行正文；这些工单均仍打开，没有评论补充验收范围。关闭判断依据已经合入 main 的实现、本轮修复和实际验证证据，不仅依据工单复选框状态。

| 工单 | 本次交付后的判断 | 具体依据或剩余场景 |
| --- | --- | --- |
| [#13 容量分批](https://github.com/StarryJia/whomi/issues/13) | 可在本拉取请求合并后关闭 | main 已实现完整请求容量预算、未知容量回退、顺序分批、片段覆盖、关联补读、范围隔离及有界缩批恢复；本轮通过的后端套件包含这些回归。例如一天消息过多时拆批，超长单条的全部片段保存后才增加一次覆盖，恢复后不重复计数。此为上一轮实现的累计验收，本次未新增容量算法。 |
| [#12 范围与存储](https://github.com/StarryJia/whomi/issues/12) | 关联，保留打开 | 本次修复未提交准备快照的回收；存储删除及总览聚合已有回归。仍缺删除整个会话后，已打开的报告和原文弹窗跨页面退出且迟到结果不恢复内容的完整操作验收。 |
| [#14 通读与核查](https://github.com/StarryJia/whomi/issues/14) | 关联，保留打开 | 本次保留同来源的不同核查问题；真实长聊天仍出现已解决事项被写成未知、成稿前后矛盾和引用错选，未满足语义验收。 |
| [#15 洞察界面](https://github.com/StarryJia/whomi/issues/15) | 关联，保留打开 | 本次修复置顶与手动顺序；仍需补齐整会话删除后的导航联动、同名会话隔离及重启持久化等完整桌面验收。 |
| [#11 界面验收基线](https://github.com/StarryJia/whomi/issues/11)、[#16 原文弹窗](https://github.com/StarryJia/whomi/issues/16) | 保留打开 | 既有证据覆盖多种正常和异常状态；仍缺原文请求加载中快速关闭、切段后的迟到响应，以及整会话删除后的跨页失效退出。新增准备浮窗测试不代替原文弹窗验收。 |
| [#10 总跟踪](https://github.com/StarryJia/whomi/issues/10)、[#17 综合验证](https://github.com/StarryJia/whomi/issues/17) | 保留打开 | 上述语义质量和完整交互验收未全部完成；本轮5项桌面用例通过不代表全量桌面用例通过。 |
| [#18 问一问](https://github.com/StarryJia/whomi/issues/18)、[#19 心事屋](https://github.com/StarryJia/whomi/issues/19) | 不关联关闭 | 属于独立需求与选型计划，本次没有实施其功能或验收。 |

#13 的计数边界：生产路径使用完整请求的字节估算并保留容量余量，估算值与服务实际用量分开记录，符合正文允许的估算回退；仅预留供应商计数和匹配分词器的注入接口，未集成真实精确计数器。不能将此验收写为精确计数已经接入。

容量证据见[分批实现](../../electron/main/insight-packing.ts)、[容量回归](../../tests/backend/insight-packing.test.ts)、[补读及缩片恢复回归](../../tests/backend/insight-generation.test.ts)和[迁移及范围回归](../../tests/backend/insight-sources.test.ts)。完整桌面证据缺口沿用[既有验收记录](assets/conversation-insights-20261115/ui-evidence.md)，本轮新增覆盖以上文记录为准。

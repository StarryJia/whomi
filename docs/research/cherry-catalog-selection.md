# 模型目录选择与再次添加

2026-10-31。本轮修改按用户确认的要求完成，继续复用 Cherry 的目录侧面板、搜索、分组及模型行；批量选择改为显式确认。所有验证数据均为合成示例，没有读取真实模型密钥或调用付费服务。

## 固定来源与必要差异

实际读取官方仓库固定提交 `f19aa72f969b782ed72f81be80976b237ae26605` 的以下源码，许可证延续此前 AGPL-3.0 记录：

- [ModelList.tsx](https://github.com/CherryHQ/cherry-studio/blob/f19aa72f969b782ed72f81be80976b237ae26605/src/renderer/pages/settings/ProviderSettings/ModelList/ModelList.tsx)：同步与加号放在持续显示的模型工具栏。上游加号经 `ProviderModelAdd` 打开手动添加；Whomi 按本轮明确要求将加号改为模型目录入口，手动添加保留独立文字按钮。例：添加一个模型并返回列表后，仍可点击同步旁的加号添加第二个模型。
- [ModelListSyncContent.tsx](https://github.com/CherryHQ/cherry-studio/blob/f19aa72f969b782ed72f81be80976b237ae26605/src/renderer/pages/settings/ProviderSettings/ModelList/ModelListSyncContent.tsx)、[ModelSyncPreviewPanel.tsx](https://github.com/CherryHQ/cherry-studio/blob/f19aa72f969b782ed72f81be80976b237ae26605/src/renderer/pages/settings/ProviderSettings/ModelList/ModelSyncPreviewPanel.tsx)：上游分别提供管理与选择模式；选择行使用复选框，点击行可以勾选。Whomi 迁入选择行语义，未添加项暂存选择，已添加项仍可逐项移除。
- [ModelListSyncDrawer.tsx](https://github.com/CherryHQ/cherry-studio/blob/f19aa72f969b782ed72f81be80976b237ae26605/src/renderer/pages/settings/ProviderSettings/ModelList/ModelListSyncDrawer.tsx)：上游管理模式的添加当前列表会立即保存。本轮依用户要求改为全选与底部添加、取消；不能将此差异表述为上游默认行为。例：目录显示 alpha、beta、gamma 时，全选后取消 beta，只有按添加 2 项才写入 alpha、gamma。
- [ProviderListHeaderFilterMenu.tsx](https://github.com/CherryHQ/cherry-studio/blob/f19aa72f969b782ed72f81be80976b237ae26605/src/renderer/pages/settings/ProviderSettings/ProviderList/ProviderListHeaderFilterMenu.tsx)：沿用 Lucide 的 Filter 漏斗图标；筛选内容保持全部、已启用和已停用。

## 保存、取消和失败

全选作用于当前搜索和筛选结果中的未添加模型；已有模型不进入待添加集合。底部数量包括当前已勾选的模型。取消、关闭、遮罩或 Escape 都放弃尚未提交的选择，下次打开从未选择状态开始；所有添加成功后返回模型列表并恢复触发按钮焦点。

部分添加失败保留真实保存结果与其余选择。例如合成目录 alpha、beta、gamma 中，alpha 保存成功、beta 失败后，alpha 显示移除入口，beta 与 gamma 仍勾选。重试只提交当前余项；用户可以先取消 beta 再只提交 gamma，也可以取消并返回，alpha 仍保留。新增数据仍通过既有本地设置接口保存，未知容量保持空值。

服务商详情复用协议任务提供的 `ProtocolSelect`。改变协议立即保存，清除旧连接检测结果，之后重新读取目录使用已保存的连接配置；具体协议范围和运行验证由协议接入记录说明。

## 验证

先运行新行为测试，观察到 6 项因缺少目录加号、复选框与确认选择而失败。接入后发现添加成功返回时触发按钮仍处于禁用状态，补充解除忙碌再关闭的处理，焦点恢复回归通过。详情协议选择测试也先因缺少选择控件失败，再完成接入。

`npx vitest run src/components/settings/cherry-settings.test.tsx src/components/settings/settings-page.test.tsx --reporter=dot`：2 个文件、29 项通过。覆盖全选不写入、排除已有项、搜索范围、单项取消、关闭后清空、确认保存及未知容量、部分失败重试与取消、改选后重试、常驻加号重新进入，以及协议变更清除旧检测。

桌面脚本 `tests/desktop/cherry-settings.spec.mjs` 已实际通过：鼠标勾选后读取隔离数据库，确认全选尚未保存；取消一项再添加、通过加号重开、窄窗口操作及取消手动添加均正常。截图保存在 `release/cherry-catalog-selection-20261031/`，已检查确认前与窄窗状态。完整验收见[会话与模型交互补正](../designs/whomi-conversation-model-refinements.md)。

# Cherry 服务商与模型设置复用记录

2026-10-31。本记录覆盖本轮已迁入的设置流程及必要适配。来源是实际源码阅读与改编，不是根据截图仿画；不宣称已经迁入 Cherry Studio 的全部服务商运行平台。

## 固定来源和许可证

上游：[CherryHQ/cherry-studio，f19aa72f969b782ed72f81be80976b237ae26605](https://github.com/CherryHQ/cherry-studio/tree/f19aa72f969b782ed72f81be80976b237ae26605)。设置页面代码按根目录 AGPL-3.0 处理；独立 `packages/ui` 包清单声明 MIT。复用文件分别保留来源注释；根项目第三方声明统一由主执行者维护。

| 上游实际文件 | Whomi 对应文件与迁入内容 |
|---|---|
| [ProviderListItemWithContextMenu.tsx](https://github.com/CherryHQ/cherry-studio/blob/f19aa72f969b782ed72f81be80976b237ae26605/src/renderer/pages/settings/ProviderSettings/ProviderList/ProviderListItemWithContextMenu.tsx)、[ProviderListItem.tsx](https://github.com/CherryHQ/cherry-studio/blob/f19aa72f969b782ed72f81be80976b237ae26605/src/renderer/pages/settings/ProviderSettings/components/ProviderListItem.tsx) | `model-services.tsx`：右键和更多菜单共用编辑、备注、删除顺序；行内按钮的键盘事件不触发行选择；启用圆点与悬停菜单位置。 |
| [ProviderList.tsx](https://github.com/CherryHQ/cherry-studio/blob/f19aa72f969b782ed72f81be80976b237ae26605/src/renderer/pages/settings/ProviderSettings/ProviderList/ProviderList.tsx)、[providerDisplay.ts](https://github.com/CherryHQ/cherry-studio/blob/f19aa72f969b782ed72f81be80976b237ae26605/src/renderer/pages/settings/ProviderSettings/utils/providerDisplay.ts) | 服务商搜索按空格拆词，每词匹配服务商编号、名称、其模型名称/编号；接入本地备注并支持启用/停用筛选。 |
| [context-menu.tsx](https://github.com/CherryHQ/cherry-studio/blob/f19aa72f969b782ed72f81be80976b237ae26605/packages/ui/src/components/primitives/context-menu.tsx) | `model-services.tsx`：复用 Radix 菜单，迁入右键开启时的 pointerup 防误触保护及非窗口拖拽区域。合成回归先复现缺失保护时菜单被误关闭，再迁入保护并通过。 |
| [PageSidePanel](https://github.com/CherryHQ/cherry-studio/blob/f19aa72f969b782ed72f81be80976b237ae26605/packages/ui/src/components/composites/page-side-panel/index.tsx)、[ProviderSettingsDrawer.tsx](https://github.com/CherryHQ/cherry-studio/blob/f19aa72f969b782ed72f81be80976b237ae26605/src/renderer/pages/settings/ProviderSettings/primitives/ProviderSettingsDrawer.tsx) | `cherry-primitives.tsx`：浮动侧面板的页面门户、遮罩、右侧布局、关闭与返回焦点；增加背景不可交互与焦点循环。主题动画用本项目样式实现源时长和缓动，未引入上游整个动画和路由平台。 |
| [EditModelDrawer.tsx](https://github.com/CherryHQ/cherry-studio/blob/f19aa72f969b782ed72f81be80976b237ae26605/src/renderer/pages/settings/ProviderSettings/ModelList/ModelDrawer/EditModelDrawer.tsx) | `model-editor.tsx`、`use-auto-save.ts`：名称/分组失焦提交，预设和开关立即提交；按当前编辑对象串行合并保存，不让较早回执覆盖新输入；错误保留输入并提供重试。 |
| [ModelContextWindowFields.tsx](https://github.com/CherryHQ/cherry-studio/blob/f19aa72f969b782ed72f81be80976b237ae26605/src/renderer/pages/settings/ProviderSettings/ModelList/ModelDrawer/ModelContextWindowFields.tsx) | `model-parameters.tsx`：迁入上下文、最大输入、最大输出的三组预设、精确数值、选中状态、手动输入及失焦提交。上下文 256K 是 262144，输入 256K 是 256000，保持上游差异。 |
| [AddModelFormPanel.tsx](https://github.com/CherryHQ/cherry-studio/blob/f19aa72f969b782ed72f81be80976b237ae26605/src/renderer/pages/settings/ProviderSettings/ModelList/ModelDrawer/AddModelFormPanel.tsx)、[naming.ts](https://github.com/CherryHQ/cherry-studio/blob/f19aa72f969b782ed72f81be80976b237ae26605/src/renderer/utils/naming.ts) | `model-editor.tsx`、`cherry-model-naming.ts`：输入模型编号同步填写名称和默认组名；迁入默认分组算法。新建通过确认提交，取消不保存。 |
| [ModelListSyncDrawer.tsx](https://github.com/CherryHQ/cherry-studio/blob/f19aa72f969b782ed72f81be80976b237ae26605/src/renderer/pages/settings/ProviderSettings/ModelList/ModelListSyncDrawer.tsx)、[ModelListSyncContent.tsx](https://github.com/CherryHQ/cherry-studio/blob/f19aa72f969b782ed72f81be80976b237ae26605/src/renderer/pages/settings/ProviderSettings/ModelList/ModelListSyncContent.tsx) | `model-picker.tsx`：独立模型管理侧面板、搜索和分组、目录逐项添加/移除、当前列表批量操作、已添加和目录消失模型筛选、刷新及失败恢复。每项成功后反映真实结果，批量失败重试剩余项。 |
| [classNames.ts](https://github.com/CherryHQ/cherry-studio/blob/f19aa72f969b782ed72f81be80976b237ae26605/src/renderer/pages/settings/ProviderSettings/primitives/classNames.ts) | `cherry-settings.css`：映射项目颜色变量；保持 248px 服务商列、32px 服务商行/输入框、42px 模型行、400px 编辑面板、620px 同步面板，以及面板四周 12px 留边和 24px 圆角。 |

例如，用户给示例服务添加 `example/chat-model`，名称自动填为同一编号，分组自动填为 `example`。打开编辑面板选择上下文 `256K`，保存请求提交 `262144`；面板关闭再打开仍显示该数值。该数据仅为合成测试，不是用户现有模型配置。

## 数据与运行适配

- `SettingsApi` 保留方法和已有调用兼容；目录从仅编号扩展为可验证的名称、分组与容量。只读取允许字段，不把远端返回的任意对象、凭据或原始错误透传到设置状态。
- 服务商备注随原有服务商记录保存；密钥仍在主进程加密，设置快照不返回明文。分组存于本地设置，最大输入限制进入模型版本数据，供实际运行预算使用。
- Cherry 容量可以为空。目录没有容量时保存 `null`，界面显示未设置，不要求用户先填写虚构容量才能添加。运行回退由共用 `resolveModelLimits` 实现，保持数据声明和请求预算的区别。
- 上游运行回退依据：[agentContextWindow.ts](https://github.com/CherryHQ/cherry-studio/blob/f19aa72f969b782ed72f81be80976b237ae26605/src/main/ai/runtime/agentContextWindow.ts) 的 `256000` 与 [modelInjection.ts](https://github.com/CherryHQ/cherry-studio/blob/f19aa72f969b782ed72f81be80976b237ae26605/src/main/ai/runtime/pi/modelInjection.ts) 的最大输出 `8192`。此为运行预算，不能解释为未知模型实际具有该能力。
- 保持 Whomi 当前可用的 OpenAI Chat Completions 兼容传输，不提供无法执行的协议选项。模型检测继续调用真实本地设置服务，发送一条简短测试请求；启停和删除仍通过运行任务保护。

例如，示例目录只返回 `{ id: 'local-example' }` 时，添加后模型的上下文和输出上限均为 `null`。发送时运行层使用已说明的回退预算，设置不会把它们写成模型声明；若服务端拒绝请求，显示真实失败并保留重试操作。

## 保留的边界

本轮没有迁入 Cherry 的完整服务商预设注册表、平台登录、多密钥轮换、云账号认证、自定义请求头、图像/音频/嵌入传输、模型价格计费与能力分类编辑，也未接入其虚拟滚动和服务商拖动排序。设置页面不会显示这些项目的假按钮；不能将上述局部模块适配表述为完整 Cherry 产品已经移植。拼音搜索和平台专用预设分组也未接入，普通名称和模型编号可搜索。

## 验证证据

所有记录与密钥均为合成值，数据库使用临时隔离目录。最初四项新前端测试分别因菜单缺失、失焦不保存、预设缺失和同步面板缺失而失败；两项后端测试分别因拒绝备注字段、目录丢失元数据而失败。补充右键抬起与自动填名的测试也各自观察到预期失败后修复。

当前单元回归覆盖右键与更多菜单、备注搜索、失焦保存、失败重试、连续保存回执、模型三种容量字段、无效容量保留、未知容量、同步增删、部分保存重试、运行任务保护、图片校验、取消和返回焦点。

本轮设置范围的验证结果：

- `npx vitest run src/components/settings/cherry-settings.test.tsx src/components/settings/settings-page.test.tsx --reporter=dot`：2 文件、23 项通过。
- `npx vitest run --config vitest.backend.config.ts tests/backend/settings-service.test.ts tests/backend/settings-repository.test.ts`：2 文件、16 项通过。
- `npm run typecheck`、`npm run desktop:build`：通过。最后统一构建包含其他问题域的已完成修改。
- `npx playwright test tests/desktop/settings.spec.mjs --workers=1`：1 项通过，实际使用本机模拟模型服务验证连接检测失败/重试、发送副本、配置重启持久化和存储目录迁移。
- `npx playwright test tests/desktop/cherry-settings.spec.mjs --workers=1`：1 项通过，覆盖真实鼠标右键与备注、搜索、连接自动保存、目录网络失败重试、增删、容量预设保存、新建取消、窄窗口和焦点恢复。

已人工查看以下真实 Electron 截图，数据为隔离合成记录，不是真实聊天或真实服务商密钥：

| 状态 | 本地证据 |
|---|---|
| 服务商右键编辑、备注、删除 | [01-provider-context-menu.png](../../release/cherry-settings-20261031/01-provider-context-menu.png) |
| 模型目录请求失败与重试 | [02-sync-failed-retry.png](../../release/cherry-settings-20261031/02-sync-failed-retry.png) |
| 已添加、目录缺失、长模型名与增删 | [03-sync-added-models.png](../../release/cherry-settings-20261031/03-sync-added-models.png) |
| 三组容量预设与自动保存后的真实值 | [04-model-editor-presets.png](../../release/cherry-settings-20261031/04-model-editor-presets.png) |
| 360px 窄窗口中的编辑面板 | [05-narrow-model-editor.png](../../release/cherry-settings-20261031/05-narrow-model-editor.png) |
| 960 × 720 桌面模型列表 | [06-models-minimum-desktop.png](../../release/cherry-settings-20261031/06-models-minimum-desktop.png) |

截图核对的是所迁入源码的布局、窗口尺寸和真实操作，不代表已与 Cherry 所有上游功能逐项相同。未调用付费云模型、未注入真实磁盘故障；保存失败和部分保存用可控客户端及隔离数据库回归验证。全仓最终测试由主执行者在各问题域合并后统一记录。

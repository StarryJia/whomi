# Cherry 模块复用与导入体验实施计划

> 使用 superpowers:executing-plans 执行，独立问题域按 dispatching-parallel-agents 并行推进；每个行为遵循测试先行。

**Goal:** 完成已确认的 Cherry 对话与模型模块复用、导入免填和菜单点击修复。
**Architecture:** 按固定上游版本保留成熟模块的结构和状态，适配 Whomi 本地接口；导入复用 ChatLab 的身份与连续消息匹配规则。共用主题统一外观。
**Tech Stack:** React、TypeScript、Electron、SQLite、Vitest、Playwright。
**Spec:** `DESIGN.md`，以页首最新复用原则和本轮用户决定为准。

**完成记录：** 已完成下列实现与检查，具体来源、适配范围和验证结果见[本轮验收](../../designs/whomi-cherry-ui-import-validation.md)。原始 Windows 鼠标首项问题未稳定复现，不将 Electron 内部点击验证等同于原生指针验证。

## Global Constraints

- 用户已明确在 main 开发。原有 22 个提交已先推送至 origin/main，基线 ff04097。
- 本轮实施已获用户授权；不再对 Cherry 已有的操作逐项重新设计。不创建外部工单或正式发布。
- 优先复用 Cherry f19aa72f969b782ed72f81be80976b237ae26605 的实际组件与行为，记录来源和必要适配，不声称未迁入功能已实现。
- 导入使用可靠身份优先、连续五条有效消息补充匹配；排除身份冲突后唯一匹配追加，零个或多个新建。真实读取错误不能当作零匹配。
- 测试仅用合成记录和隔离数据库，不修改用户原始记录、密钥或已安装应用数据。
- 每次行为修改先运行失败测试，再实现并验证；最终运行前后端完整测试、构建和桌面流程。

## Review Focus

- 同名不同账号、重复会话、多候选与不足五条的导入不得误合并。
- 发送失败或停止后，新草稿和原请求不能互相覆盖，引用不能重复或跨会话。
- 模型名称相同但服务商不同，切换和恢复配置须保持准确归属。
- 桌面拖拽区、菜单门户、滚动与窄窗口不能吞掉鼠标或键盘操作。
- 同步/保存失败、取消或部分成功后，不能伪造结果或遗留旧状态。

### Task 1: 服务商与模型模块

**Files:** `src/components/settings/`、`src/shared/settings-contract.ts`、`electron/main/settings-service.ts`、相关设置存储与测试；来源记录置于 `docs/research/cherry-settings-reuse.md`。
**Interfaces:** 保留 SettingsApi 现有调用兼容；如需扩展字段，先告知主执行者。不修改对话工作区与导入文件。
- [x] 写并运行服务商右键编辑/备注/删除、自动保存、模型同步和参数预设的失败测试。
- [x] 读取并迁入上游模块及必要依赖，适配数据层，记录实际复用与尚未接通的能力。
- [x] 验证保存失败恢复、长模型名、服务商切换、同步选择及窄窗口。
- [x] 运行设置前端测试、设置服务与存储测试，记录来源和兼容差异。

### Task 2: 免填导入与自动追加

**Files:** `electron/data/import/`、`electron/data/parsers/normalize.ts`、`src/components/file-import.tsx`、`src/components/import/`、相关导入测试。
**Interfaces:** 兼容原有显式 ImportDecision；无选择时执行已批准的自动归属。导入结果继续提供会话打开入口。
- [x] 写并运行稳定身份、连续五条匹配、多候选新建、身份冲突不追加与重复导入不增消息的失败测试。
- [x] 复用 ChatLab 匹配机制并接入现有去重事务，保留原始记录与可靠引用。
- [x] 写并运行单入口自动解析、无需目标/别名/预览、取消和失败恢复的界面失败测试。
- [x] 修改导入为同一紧凑区域的文件选择、解析/写入进度和完成结果，真实进度不补假百分比。
- [x] 运行导入前后端测试，并验证百万条匹配和二十五万条重导时的内存边界。

### Task 3: 对话、模型选择、统计与会话菜单

**Files:** `src/components/conversation-ai/`、`src/data/conversation-ai-client.ts`、`src/components/conversations.tsx`、对应样式、统计类型及测试。
**Interfaces:** 使用 SettingsSnapshot 的服务商信息补充选择器；保留 ConversationAiAdapter 的请求/恢复语义。原文引用使用 Whomi 消息编号。
- [x] 写并运行发送时草稿交接、失败恢复不覆盖新草稿、唯一引用管理区、按服务商搜索选择的失败测试。
- [x] 迁入 Cherry 发送框、模型选择和统计模块的必要代码，接入 Whomi 会话接口。
- [x] 在真实 Electron 中复现并修复本人弹窗被窄窗侧栏遮挡、Escape 被选择模式截获；完成菜单点击矩阵。原始 Windows 鼠标症状未稳定复现，原生指针验证未完成。
- [x] 验证焦点恢复、菜单首尾点击、窗口缩放、长内容、停止/失败和会话隔离。

### Task 4: 合并验收与交付

- [x] 审查类型和数据接口，完成类型检查、前端 226 项、后端 387 项、网页与桌面构建；后端重资源用例独立串行运行。
- [x] 桌面完整流程验收并保留关键截图，执行一次 Impeccable 静态检测；13 项源码流程及 1 项打包升级流程通过。
- [x] 独立审查本轮差异，修复重要问题并验证，更新 DESIGN.md、来源说明与验收记录。
- [x] 整理已验证结果为本地提交，准备中文提交说明与 0.1.4 安装包；不将未接通的 Cherry 能力写为完成。

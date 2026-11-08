# Cherry 对话模块迁入执行计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement the independent modules with focused reviews; the controller owns shared dependencies, workspace integration and final verification. Steps use checkbox syntax for tracking.

**Goal:** 将第 1 版批准范围内的 Cherry 原输入、消息显示和滚动模块接入 Whomi 正式桌面对话。

**Architecture:** 原源码放入 `src/vendor/cherry-chat`，应用宿主和数据映射放入 `src/components/conversation-ai/cherry`。现有客户端、会话服务和数据库保持唯一事实来源；工作区继续组织原文、引用和独立对话。

**Tech Stack:** React、TypeScript、原 Tiptap 3.26.1 编辑器、virtua 0.49.1 虚拟列表、现有 Electron 与 Pi 1.4.0。共用样式使用原组件需要的 Tailwind 工具类，不引入全局重置。

**Spec:** [已批准第 1 版](../../designs/whomi-cherry-chat-migration-v1.md)。用户于本轮明确回复可以，开始开发吧。

**执行结果（2026-11-08）：** 原模块迁入与自动回归完成，前端 574 项、后端 540 项、桌面 49 项通过，2 项已有升级测试按条件跳过；类型检查、两类构建、来源校验和隔离副本界面回退通过。Task 5 中含真实输入法、同版完整应用对照及未完成性能对照的组合项保持未勾选，具体范围见[验收记录](../../research/cherry-chat-migration-acceptance.md)。

## Global Constraints

- 固定 Cherry `263667f7a99dfed736c939708a55deb435164820`，原文件与补丁可核对；不把原型宿主写入生产程序。
- 保留 Whomi 后端、数据库格式、原文权限、对话技能、历史身份与实际用量；只传稳定引用编号。
- 请求受理前原提交锁，受理后可写下一条和为下一条选模；生成期间不自动排队。只允许末轮停止、失败或中断重试。
- 草稿与输入历史按独立对话隔离，内存存储；复制原始纯文本，不整理 Markdown 空白。
- 不启用历史编辑、已完成回答重新生成、分支、附件、工具、朗读和云服务。
- 正式诊断默认零原生窗口错误；未解决通知不得过滤或冒充通过。实际截图星号案例缺原串，单列未验证。
- 代码更新前由控制者核对并拉取 main；任务共享同一隔离分支，其他代理不切换分支或修改共享依赖。
- 没有推送、外部工单、正式发布授权。本次先保留可审阅工作区，不自动提交用户无关文件。

## Review Focus

1. 保存后回执丢失导致新请求编号重复发送：任务 1 与 4 覆盖同编号消歧和待确认状态。
2. 私有剪贴板 token 绕过纯文本限制：任务 2 覆盖私有格式和图片粘贴，普通文字保持。
3. 流式快照、会话切换及尺寸回调抢占阅读位置：任务 3、4、5 覆盖迟到事件、稳定锚点和诊断。
4. 来源组件整理复制空白或按当前目录伪造历史统计：任务 3 覆盖原始文本、缺失身份和重试汇总。
5. 原组件动作出现无效工具、成功重试或非末轮操作：任务 3、4 覆盖真实能力显隐与后端拒绝。

## Task 1: 请求受理与快照合同

**Files:** 修改 `src/data/conversation-ai-client.ts`、`src/components/conversation-ai/types.ts`；测试 `src/data/conversation-ai-client.test.ts`。

**Interfaces:** `respond(request, options)` 保持返回生成结果的现有合同；在 options 增加可选 `onAccepted(turn: RestoredConversationTurn): void`，确认已有持久轮次时调用一次，早于首段文字并接受任意终态。结果可附加真实 `turn` 快照供宿主同步，现有调用者保持兼容。发送失败后按同 requestId 查询既有轮次；查询也失败时使用可识别的待确认错误，不误判未保存或生成新的编号。重试必须以既有轮次为准，不重新组合参数。

- [x] 先加测试：延迟首字时已受理；重复编号返回 completed 也受理；保存后丢回执仍得到同轮；未保存明确失败不受理；读取也失败保留待确认语义。现有 `detach`、旧事件及取消测试保留。
- [x] 运行 `npx vitest run src/data/conversation-ai-client.test.ts`，记录新增断言实际失败。
- [x] 实现最小客户端改动，保持服务、仓库和分析接口不变。
- [x] 同命令转绿；类型检查和任务审查后交给任务 4。

## Task 2: 原文本输入器与草稿接入

**Files:** 新增 `src/vendor/cherry-chat/composer/**`、模块宿主 `src/components/conversation-ai/cherry/composer.tsx`、对应测试和来源清单。共享基础控件、根依赖与构建配置由控制者维护。

**Interfaces:** 导出 `CherryComposer` 与 `CherryComposerHandle.focus()`。属性包括 `scopeKey: string`、`value: string`、`onChange(text): void`、`onSend(text): Promise<boolean>`（true 表示受理，false 保留草稿）、`onStop(): void`、`running: boolean`、`sendDisabled: boolean`、`disabled?: boolean`、`onSubmittingChange?(locked): void`、`toolbar?: ReactNode`、`references?: ReactNode`。外部 value 来自唯一草稿仓库；导出 `useComposerDraft(scopeKey)` 返回 `[value, setValue]`，以及 `readComposerDraft/writeComposerDraft/clearComposerDraft`，供新建对话转移和删除时使用。保留原 chatDraftCache 序列化与生命周期，替换内存存储和作用域，不再维护第二份可写草稿。

- [x] 先在可运行的旧工作区或输入边界写行为测试，证明受理前锁定、方向键历史隔离等缺口；保留失败日志，不用字符串扫描代替行为测试。
- [x] 迁入原 Core、Surface、完整 Runtime 及必要依赖；裁剪 ChatComposer 的应用宿主路径，保留原直接提交锁、草稿交接、输入历史导航和编辑尺寸逻辑。移除排队、历史编辑和业务工具路径，记录差异。
- [x] 将原输入历史存储改为当前 scope 的内存；私有剪贴板的附件/token 路径必须经过真实能力限制，不能只禁用拖放。
- [x] 测试真实组件：受理前锁定/拒绝保留、受理后新草稿、生成中 Enter 不发送、组合输入不发送、历史返回原草稿、跨 scope 隔离、粘贴文本与不支持内容、菜单与焦点。
- [x] 定向测试转绿；记录原文件、补丁、所需依赖与实际未覆盖项，交任务审查。

## Task 3: 原消息模块及状态投影

**Files:** 新增 `src/vendor/cherry-chat/messages/**`、模块宿主 `src/components/conversation-ai/cherry/messages.tsx`、对应测试及来源清单。使用完整消息显示链，不使用原型自写消息行。

**Interfaces:** 导出 `CherryMessages`。`turns` 接受结构 `{id: string | number; request: ConversationRequest; modelIdentity?: ModelOption; referenceIds?: string[]; text: string; usage?: GenerationUsage; status: 'running'|'done'|'failed'|'stopped'; error?: string; remote?: boolean}`。属性 `scopeKey: string`、`running: boolean`、`onRetry(turnId: string|number): void`、`renderReferences(turn): ReactNode`、`active?: boolean`、`loading?: boolean`、`error?: string`。组件负责原 Provider 数据投影、稳定问题/回答标识、动作、正文和原滚动状态；宿主引用节点由 Whomi 注入。统计必须接真实数据，不能把旧自写 Usage 外壳当原组件。

- [x] 写并观察失败测试：末轮停止重试、空 completed 无错误重试、复制保留前导及行尾空格、模型身份与汇总口径。
- [x] 迁入原 MessageList、Provider、Group、Frame、Content、PartsRenderer 文本路径、动作注册、流式历史分层及 VirtualList/阅读状态。显式裁剪不可用工具和直接业务服务调用，保留来源和补丁。
- [x] 用 Whomi AiTurn 投影更新同一消息，引用注入问题区；原始文本复制；按每轮能力注册独立重试，不暴露 regenerateMessage。
- [x] 接原统计呈现与现有计算规则；未知时间/身份不编造，整轮汇总不伪造单次明细；Markdown 仍使用既有安全组件。
- [x] 运行真实组件测试转绿，保留原上游相关行为测试；任务审查后交控制者完成集成。

## Task 4: 正式工作区接线和既有流程

**Files:** 修改 `src/components/conversation-ai/workspace.tsx` 与必要的样式、引用选择状态接口；新增 `src/components/conversation-ai/cherry/workspace-integration.test.tsx`，更新与批准行为冲突的既有测试步骤。

**Interfaces:** 消费任务 1 的 onAccepted，任务 2 的唯一草稿存储和原输入器，任务 3 的原消息模块。`onSend` 只等待明确受理，生成观察继续后台运行；发起请求、停止、切换及引用生命周期仍由正式工作区管理。scope 为原始会话+独立对话；新建空对话转移初始草稿、删除清理相应缓存。提交锁传到引用增删入口，阅读仍可用。

- [x] 在旧工作区观察失败：受理前引用锁、受理后新草稿、生成中选模只影响下一条、停止末轮重试、空成功重启一致。
- [x] 接入三模块，移除旧 textarea、消息行及滚动观察器；保留原文、历史、分析、关闭/返回焦点与引用互斥流程。
- [x] 验证延迟回执、不同 thread 的后台生成、空对话连点新建、关闭再开、引用移除清空、跨页与迟到定位、重试原配置和技能。
- [x] 运行相关组件及客户端回归，记录所有行为调整；完成整合审查，不修改断言掩盖非授权退化。

## Task 5: 桌面、视觉和运行诊断

**Files:** 在 `tests/desktop` 加入正式迁入场景，复用现有隔离数据库、本机模型与原文样例；截图和日志写 `artifacts/cherry-chat-migration`，可交接截图归研究记录。

- [ ] 通过正式预加载和后台接口验证 A01–A15；采集导航前 window.error、未处理拒绝、控制台及外网请求，不过滤 ResizeObserver 通知。
- [ ] 用真实滚轮检查 200 轮历史、流式长回答、表格、上滚、回底和 3 秒静置锚点；宽度 1280、960 及测试覆盖 360，允许局部代码/表格滚动。
- [ ] 核对正式进程重启、历史模型、引用恢复、失败/停止重试、逐字剪贴板及生成时模型选择；Windows 实际输入法和固定 Cherry 对照有证据才标通过。
- [x] 新发现问题按失败复现→最小修复→覆盖检查执行；严格诊断未通过时保留原始结果，不自行准许例外。

## Task 6: 全量核查与交付记录

- [x] 完整执行 `npm test`、`npm run test:backend`、`npm run typecheck`、`npm run build`、`npm run desktop:build`、`npm run test:desktop`；Node/Electron 原生模块按环境顺序准备，不并行改同一二进制。
- [x] 核对来源清单、许可、生产路径没有原型依赖、资料权限和原工作目录无关改动未变。
- [x] 独立审查整个分支，修复有依据的缺陷并复核。
- [x] 将实际 A01–A15 结果、截图、遗留项写回 003；只有实际通过才更新已有能力。提供中文 Conventional Commit 说明，不推送或公开发布。

## 执行台账

控制者在 `artifacts/cherry-chat-migration/progress.md` 记录基线、任务状态、失败→通过证据、接口决定和审查。源目录 `D:/University/github/whomi` 的其他未提交资料不进入本工作区。

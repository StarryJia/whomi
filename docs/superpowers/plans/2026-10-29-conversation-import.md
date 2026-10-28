# Whomi 桌面后端与会话导入 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Windows 桌面端导入受支持的聊天记录，安全增量保存到本地数据库，重启后可分页阅读与定位原文。

**Architecture:** 保留 React 界面，Electron 主进程管理窗口与来源授权，独立数据进程负责解析和数据库。导入先写临时数据库，通过检查后按会话一次提交到正式 SQLite 数据库；使用共享消息表和稳定本地编号。

**Tech Stack:** TypeScript、React、Electron、electron-vite、better-sqlite3、electron-builder、Vitest；复用固定提交的 ChatLab TypeScript 解析模块。

**Spec:** [已确认设计](../specs/2026-10-29-conversation-import-design.md)。执行者必须同时读取设计与本计划。本文是待执行计划，所有测试代码片段均为虚构数据和拟实现验收，未运行过产品测试。

## Global Constraints

- 用户已确认继续 `main`，保留所有已有前端改动；本计划编写前 `main` 跟踪 `origin/main`，领先 1、落后 0，`fetch` 与 `pull --ff-only` 成功。开始执行时重新检查最新状态；不要重复询问已授权的分支选择。
- 每次代码或文档更新前执行 `git pull`；拉取遇到冲突先保全用户改动，禁止重置覆盖。逐任务本地提交，不推送、创建工单、发表评论或创建拉取请求。
- 首个可验证平台为 Windows；正式资料与开发资料隔离；不把用户聊天、账号、路径或正文写入仓库、测试输出、诊断日志。
- 一个 SQLite 正式数据库、一张共享消息表；整数主键不复用，通信时传十进制字符串；不增加每会话一表或每会话一库。
- 同一来源会话范围内原始消息标识相同则跳过，不比较、覆盖正文或保存修订；新文件缺少旧消息时不删除本地旧消息。
- 分批解析、暂存与执行语句，正式业务按会话事务提交；其他会话已经提交的结果保持不变。重复消息的旧附件和旧引用也不更新。
- 解析目标为设计中的 14 个格式模块，不能默默缩为 SIWX；未知类型保留，来源歧义不猜测。没有可靠标识时按设计保守处理增量合并。
- 导入不调用模型，不自动分析；不实现人工智能导入脚本、Spark 存储、画像汇总、微信解密、云同步、会话管理菜单。
- Spark 不作为画像汇总输入；未来来源删除只使相应引用不可用，稳定编号不能指向别的消息。
- 用户提示只写状态与操作；缩写首次说明；注释解释必要原因。只取需要的解析器代码、类型及依赖，保留来源与许可。

## Review Focus

1. 目录中的符号链接、Windows 目录联接与清单相对路径越界：不能读取授权根目录之外的内容；任务 4 检查真实路径及循环。
2. 扫描之后文件被替换，或两个包装入口指向同一文件：不能混合版本或重复计数；任务 4 固定输入快照并去除入口重复。
3. 应用在提交完成、通知界面前退出：重启后仍显示已保存，重试新增为零；任务 6 注入退出点并用新进程重开数据库。
4. 阅读翻页期间导入时间更早的消息：不能重复或漏掉当前阅读快照中的消息；任务 7 使用水位编号限制，刷新才纳入新增。
5. 本人账号在导出者字段和发送者字段中有后缀差异，且多人同名：不能自动把别人标为本人；任务 5、9 验证候选确认和撤销。

## 1. 实施选择、文件边界与依赖

### 1.1 工具版本与运行验证

2026-10-29 通过官方 npm 注册表只读查询得到下列版本。它们是计划锁定的候选组合，元数据不是运行兼容证明；任务 1 必须在安装、开发启动与打包产物中验证。现有 React、Vite、Vitest 依赖保留，不批量升级。

| 用途 | 计划版本 | 核查与约束 |
|---|---|---|
| 桌面运行 | `electron@45.1.0` | 注册表声明安装工具使用 Node.js 22.12 或更新版本 |
| 桌面构建 | `electron-vite@6.0.0` | 声明兼容 Vite 6、7、8；可选 `@swc/core` 不引入，沿用 React 插件 |
| 数据库驱动 | `better-sqlite3@13.0.3` | 声明 Node.js 22 或更新；必须验证 Electron 内部运行时与原生二进制兼容 |
| 驱动类型 | `@types/better-sqlite3@9.6.0` | 类型检查通过不能替代运行验证 |
| 打包 | `electron-builder@26.18.0` | 本轮生成本地 Windows x64 目录包及安装包，不上传、不签名、不发布 |
| 原生依赖重建 | `@electron/rebuild@4.2.1` | 区分本机 Node.js 测试产物与 Electron 运行产物 |
| 桌面行为测试 | `@playwright/test@1.64.1` | 使用其 Electron 自动化入口，官方标为实验性；实际版本组合在任务 1 验证 |

当前开发机 Node.js 为 `24.12.0`。以精确版本写入 package.json 和 lock 文件；解析器所需库按固定上游的 package.json 与锁文件选取精确版本，记录在复用清单。不能安装一个虚构的公开 `@chatlab/parser` 包。版本失配时仅在相同架构内调整兼容版本并记录证据；不能绕开校验或更换整个运行方案。

选择 `utilityProcess.fork` 启动一个数据进程；用 `better-sqlite3` 的预编译语句和显式事务。开启 SQLite 预写日志模式（Write-Ahead Logging，以下称 WAL）、外键约束与 `synchronous=FULL`；忙等待上限 5,000 毫秒。记录实际 `sqlite_version()`，要求至少 `3.51.3`，避免带入官方已说明的 WAL 修复之前版本。

同一数据进程持有一个写连接和一个只读连接。导入写操作排队；只读连接仅看已提交数据，短查询结束立即释放语句，不跨界面翻页保持数据库读事务。不要让读取使用写事务的连接而看到半份导入。迁移先完成再开放只读连接。

### 1.2 文件结构

以下路径相对仓库根目录；所有未存在的路径都是计划新增，不代表已经具备能力。

| 路径 | 职责 |
|---|---|
| `electron/main/index.ts`、`data-host.ts`、`source-grants.ts`、`ipc.ts` | 窗口、后台生命周期、授权来源、白名单通信 |
| `electron/preload/index.ts` | 将固定方法暴露为 `window.whomi`，不暴露通用文件、路径或数据库执行入口 |
| `electron/data/entry.ts`、`service.ts` | 后台消息分发与业务服务组装 |
| `electron/data/db/{open,migrate,schema,queries}.ts` | 正式库连接、版本迁移、表结构、查询 |
| `electron/data/import/{limits,discovery,snapshot,staging,identity,merge,runner,recovery,summary}.ts` | 按文件名分别负责边界、发现、输入固定、暂存、归属、事务、任务编排、恢复、摘要 |
| `electron/data/parsers/{registry,chatlab-adapter,siwx-normalizer}.ts` | 格式能力注册、上游事件转换、SIWX 差异修正 |
| `electron/vendor/chatlab-parser/` | 固定版本的上游必要源码、许可与来源清单，禁止塞入整个桌面服务 |
| `src/shared/{conversation-model,import-contract,desktop-api}.ts` | 无 Node.js 运行依赖的规范化模型、任务合同与通信类型 |
| `src/data/{desktop-client,preview-client,use-conversations,use-import}.ts` | 正式与开发预览数据源、界面查询及导入状态 |
| `src/components/import/{import-candidates,import-progress,identity-choice}.tsx` | 候选范围、进度结果、身份歧义处理 |
| `src/components/file-import.tsx`、`conversations.tsx`、`App.tsx`、`main.tsx` | 接入已有界面；大文件只按需要抽离阅读逻辑，不全面重构 |
| `tests/backend/`、`tests/fixtures/import/`、`tests/desktop/` | Node.js 层行为测试、虚构格式样本、实际 Electron 与打包验收 |
| `scripts/{desktop-smoke,import-benchmark}.mjs` | 实际运行验证、虚构大数据测量，不接触私人资料 |
| `electron.vite.config.ts`、`electron-builder.yml`、`tsconfig.electron.json`、`vitest.backend.config.ts` | 桌面构建、打包、后台类型与测试隔离 |

### 1.3 数据合同与数据库结构

`conversation-model.ts` 定义独立的 `modelVersion: 1`；SQLite `user_version=1` 另行管理，不能将其与 ChatLab 文件版本混用。此轮实现规范化内部模型，不额外开发 whomi 文件导出器或人工智能转换接口。

核心类型由任务 2 创建，后续任务沿用：

```ts
type LocalId = string // 数据库整数的十进制字符串；禁止先转 Number 再 stringify
type MessageKind = 'text' | 'image' | 'audio' | 'video' | 'file' | 'sticker'
  | 'link' | 'location' | 'reply' | 'forward' | 'system' | 'unknown'
type SourceIdentity = { platform: string; ownerKey: string | null;
  conversationKey: string | null; namespace: string }
type ParsedMember = { sourceKey: string; displayName: string;
  stableAccountKey: string | null; selfHint: boolean | null }
type ParsedConversation = { sourceKey: string; title: string;
  kind: 'direct' | 'group' | 'unknown'; identity: SourceIdentity }
type ParsedMessage = { conversationKey: string; ordinal: number;
  originalId: string | null; idNamespace: string | null;
  senderKey: string | null; senderKind: 'member' | 'system' | 'unknown';
  senderName: string; sentAtMs: number | null; timeRaw: string | null;
  timePrecision: 'millisecond' | 'second' | 'minute' | 'unknown';
  timezone: string | null; kind: MessageKind; text: string;
  sourceType: string | null; reply: ParsedReply | null;
  attachments: ParsedAttachment[]; extra: Record<string, unknown> }
type ParsedReply = { originalId: string | null; idNamespace: string | null;
  text: string | null; senderName: string | null; sentAtMs: number | null }
type ParsedAttachment = { kind: MessageKind; locator: string | null;
  name: string | null; state: 'unresolved' | 'missing' }
type ImportIssue = { code: string; severity: 'warning' | 'blocking';
  candidateId: string; ordinal?: number; action: string }
```

`ordinal` 是适配器产生的稳定来源记录序号，不是页面数组下标。`extra` 只保存映射需要的白名单字段；不能塞入整份文件。没有可靠身份时保留 null，不用标题哈希伪造平台账号。附件首期保存描述和缺失状态，不复制、播放、联网下载媒体，不声称完整恢复；没有媒体仍能阅读其文字与类型。

数据库表由任务 2 建立；列可按明确类型展开，不能改变以下键和关系：

| 表 | 必须具备的字段与约束 |
|---|---|
| `conversations` | `id INTEGER PRIMARY KEY AUTOINCREMENT`、标题、会话类型、创建时间；不复用编号 |
| `source_conversations` | 正式会话编号、平台、来源账号、来源会话、命名空间；可靠组合唯一；不把 null 转为空字符串造成误匹配 |
| `accounts`、`memberships` | 平台内可靠账号唯一；无稳定账号的成员局限当前会话；成员来源键在所属来源会话内唯一 |
| `self_confirmations` | 会话、成员、确认状态及来源；候选与用户确认分开，每会话最多一个已确认本人；明确账号别名映射单独记录 |
| `messages` | 不复用整数编号、会话、成员或发送者类别、发送时名称、时间及其原始表达、类型、文本、来源顺序、必要扩展 |
| `message_keys` | 会话、消息标识命名空间、原始标识、本地消息编号；前三者唯一且非空。导出器不同但已证明相同语义的标识使用同一命名空间 |
| `message_origins` | 本地消息、首次导入结果编号、文件指纹、来源会话键、记录序号、解析器标识及版本；支持同文件重复判断 |
| `message_replies`、`message_attachments` | 消息编号、设计中的引用或附件描述；无目标引用保留摘要和未解析状态；不猜测关联 |
| `import_jobs`、`import_results` | 任务及候选状态、计数、已提交时间、去敏错误；会话结果与业务消息同事务提交 |
| `conversation_summaries` | 会话、消息数、成员数、可用起止时间、更新状态；可重建，失败不撤销消息 |

数据库内部编号使用 BigInt 读写，在通信边界转十进制字符串。正文不裁剪；标准时间允许负数和 null，但必须在可准确表达的整数范围内，零不能被误当缺失。系统消息与发送者未知是不同类别。匿名来源无名发送者显示未知发送者，缺少成员声明但有可靠发送键时可创建同会话占位成员并警告；完全无法表达归属才阻断。

消息索引为 `(conversation_id, time_bucket, sort_time, id)`：已知时间 bucket=0、sort_time=sent_at_ms；未知时间 bucket=1、sort_time=0，由导入源顺序分配 id 并在单独的时间未知段展示。不得按虚构日期穿插未知时间消息。来源键、回复目标和成员关系另有必要唯一及外键索引。

暂存库仅属于导入任务，含输入快照索引、规范化会话/成员/消息、问题与计数，不是第二个正式资料库。首期不暂存原始媒体，不做断点续传。

### 1.4 资源与用户交互默认值

这些是实施者在已批准范围内选取的初始限制，必须显示明确的超限结果；性能测量后可调整并更新记录，不宣传为实测能力。

- 来源目录深度最多 16 层（选中根为 0），最多检查 10,000 个目录项；文件/目录多选及拖入同走发现流程。超过限制列阻断项，不能静默当扫描完成。
- 流式解析单文件最多 2 GiB，受限全量解析单文件最多 32 MiB；GiB、MiB 分别为 1,073,741,824、1,048,576 字节。每个适配器声明实际模式，不因扩展名为 JSON 就假定可流式。
- 规范化单条记录上限 8 MiB；流式解析器必须在累计原始字段/记录时同步限流，不能分配完巨型字符串后才检查。超限阻断所属会话。
- 暂存与正式写入每批最多 500 条或 8 MiB，以先到者为准；每批结束交还事件循环处理取消，提交期间不穿插第二项写操作。
- 候选预览最多展示 50 条一页；消息页默认 100、最大 200；阅读保留最多 5 页并通过前后加载恢复移出的页，不无限累积 DOM 元素。
- 同时只允许一个导入任务运行；新请求返回任务忙，可查看或取消现有任务。进度通知最多每秒 5 次，终态必须立即发送。
- 在创建快照前检查至少 `3 × 候选源文件总字节数 + 256 MiB` 的剩余空间；合并前检查至少 `3 × 当前暂存库大小 + 256 MiB`。这是提前筛查，不是空间足够保证；任何实际写入不足都走回滚路径。
- 暂存位于应用用户数据下 `import-staging/<随机任务编号>/`；只清理登记为本任务所有且真实路径仍在该目录内的文件。正式 WAL 和共享内存文件由数据库管理，禁止自行删除。

来源快照采用受控临时副本，解析稳定副本并计算 SHA-256 文件指纹；SHA-256 是内容摘要算法，不代表用户身份。核对原始文件在复制前后状态及内容摘要，发现改变就阻断；后续解析只读副本。多个文件/分块清单形成包含相对文件角色与各摘要的组合指纹，不能只比较清单文件。

**界面流程示例（虚构）：** 用户拖入 exports 文件夹，看到 A、B 两个会话候选，确认本人和目标归属后开始。A 已保存，B 文件损坏时，结果列出 A 新增 500 条、B 导入失败并提供重试；打开 A 后只取第一页，重启仍存在。不会自动进入模型分析。

## 2. 按顺序实施的任务

每个任务遵循先写失败测试、运行确认行为缺失、实现、验证、局部提交。运行失败应来自待实现行为，不能把拼错命令或环境故障当作有效失败测试。测试辅助函数与虚构夹具放在 `tests/backend/helpers.ts` 和 `tests/fixtures/import/`，由首次需要它的任务定义；示例断言中的辅助函数不是额外公共接口。

### Task 1: 建立可打包的桌面与数据库运行边界

**Files:** 新建 `electron/main/{index,data-host}.ts`、`electron/preload/index.ts`、`electron/data/entry.ts`、`electron.vite.config.ts`、`electron-builder.yml`、`tsconfig.electron.json`、`vitest.backend.config.ts`、`scripts/desktop-smoke.mjs`、`tests/desktop/runtime.spec.mjs`；修改 `package.json`、`package-lock.json`、`tsconfig.json`、`vite.config.ts`、`.gitignore`。

**Interfaces:** `startDataHost(userDataPath: string): DataHost`，`DataHost.request<T>(method: string, payload: unknown): Promise<T>`、`close(): Promise<void>`；此内部传输层后续由白名单封装，不向页面开放。数据进程首个内部方法 `health` 返回 `{ runtime: string; sqliteVersion: string; writable: boolean }`。

- [ ] 写桌面运行测试：启动实际 Electron 与数据进程，在临时资料目录插入一条虚构记录，关闭后重开。核心断言 `expect(await reopenedProbe.read()).toBe('saved')`、`expect(await rendererHasNodeAccess()).toBe(false)`；辅助探针仅属于测试。建立可运行测试命令后先确认待实现行为失败，再完成最小接线。
- [ ] 添加上述精确依赖和配置。主入口输出 `out/main/index.cjs`，数据入口 `out/main/data/entry.cjs`，预加载 `out/preload/index.cjs`，页面 `out/renderer/index.html`；采用显式构建入口，不依赖开发路径推导。设置页面上下文隔离、沙箱开启、Node.js 访问关闭、禁止未授权导航和新窗口，生产内容安全策略禁止远程脚本。
- [ ] 创建独立资料目录与单实例锁；主进程在数据进程退出时拒绝所有未完成请求。运行探针只在测试专用启动参数与临时目录中启用，不进入正式库。
- [ ] 添加命令：`desktop:dev`、`desktop:build`、`desktop:pack`、`desktop:dist`、`typecheck`、`test:backend`、`test:desktop`、`native:node`、`native:electron`。现有 `dev/build/test` 的网页预览行为保留；`test` 限定 `src`，后台测试使用 Node.js 环境。`native:node` 为本机 Node.js 重建驱动，`native:electron` 使用 electron-rebuild 重建；切换运行环境先执行对应命令，不能拿二进制失配当业务失败。桌面脚本用 Playwright 的 `_electron.launch` 启动开发入口或目录包可执行文件；`--case` 选择用例。不把 Electron 页面测试当普通浏览器启动，也不额外下载浏览器。自动化测试在主进程替换系统文件对话框返回虚构夹具路径，真实系统对话框和目录拖放另作本机人工验证。
- [ ] 运行 `npm run typecheck`、`npm run native:electron`、`npm run desktop:build`、`npm run test:desktop -- --case runtime`、`npm run desktop:pack`。在目录包中重复探针，预期退出码 0、`health.writable=true`、SQLite 版本达标；打包配置解包原生 `.node` 文件并排除真实资料、测试夹具与开发预览。
- [ ] 仅提交本任务文件：`feat(desktop): 建立桌面运行与数据库进程边界`。若原生依赖或打包不通过，先解决，不能在未经验证的运行边界上堆积导入代码。

### Task 2: 实现规范化模型与可迁移共享存储

**Files:** 新建 `src/shared/conversation-model.ts`、`electron/data/db/{open,migrate,schema}.ts`、`tests/backend/{database,model}.test.ts`、`tests/backend/helpers.ts`。

**Interfaces:** 产出第 1.3 节类型；`openStore(path: string): Store`，`Store` 只在后台包含 `writer/reader` 连接和 `close()`；`migrateStore(store: Store): void`。任何未知更高 schema 版本拒绝写入，给出升级应用操作。

- [ ] 添加模型/数据库失败测试，关键断言：
  ```ts
  expect(normalizeModel(message({ text: ' 好\n', sentAtMs: 0 })).text).toBe(' 好\n')
  expect(normalizeModel(message({ sentAtMs: 0 })).sentAtMs).toBe(0)
  expect(reopenStore().schemaVersion).toBe(1)
  expect(insertAfterDeleteId > deletedId).toBe(true)
  expect(() => openNewerSchema()).toThrow(/升级/)
  ```
  同时验证两个会话相同原始标识可存、同范围重复键违反约束、外键指向其他会话成员被拒绝、大整数编号往返不变。`normalizeModel(input: unknown): ParsedMessage` 负责运行时校验，不只 TypeScript 编译检查。
- [ ] 运行 `npm run native:node`、`npm run test:backend -- tests/backend/database.test.ts tests/backend/model.test.ts`，确认所测行为尚未实现。
- [ ] 实现所有第 1.3 节表、键、索引及模型验证。空库迁移在事务内完成；迁移失败回滚，关闭连接但不删除正式库。用户本人确认不会改写消息原文或发送时名称。
- [ ] 重跑测试，验证迁移重开幂等，`PRAGMA foreign_key_check` 无行、`PRAGMA integrity_check` 为 `ok`；运行 `npm run typecheck`。
- [ ] 提交：`feat(storage): 建立会话消息模型与共享数据库`。

### Task 3: 接入并验证 ChatLab 解析模块集合

**Files:** 新建 `electron/vendor/chatlab-parser/{UPSTREAM.md,LICENSE,src/...}`、`electron/data/parsers/{registry,chatlab-adapter,siwx-normalizer}.ts`、`tests/backend/{parsers,siwx}.test.ts`、`tests/fixtures/import/<format-id>/`、`docs/research/chatlab-parser-reuse.md`；修改依赖锁文件及 `THIRD_PARTY_NOTICES.md`。

**Interfaces:** `getParsers(): readonly ParserAdapter[]`；适配器 `{ id; version; extensions; mode: 'stream'|'bounded'; capabilities; detect(probe: SourceProbe): Promise<number>; parse(input: ParserInput): AsyncIterable<ParseEvent> }`。`SourceProbe` 只有扩展名、最多 64 KiB 前缀和文件大小；`ParserInput` 由后台提供受控快照入口、允许的分块文件、取消信号及限制；不传任意文件系统接口。事件为 `{type:'conversation', value:ParsedConversation}`、`{type:'member', conversationKey, value:ParsedMember}`、`{type:'message', value:ParsedMessage}`、`{type:'issue', value:ImportIssue}`、`{type:'end', conversationKey, seen:number}`。`seen` 表示该会话读到的原始消息记录数。

- [ ] 先只读核对固定上游 `f19beeadda27bd57eedc1bfbe75e7ed1b9e86833` 的解析依赖闭包、文件许可、原生分支差异、样本许可。记录实际复制路径、SHA 摘要、修改点和依赖版本；不得将 `src/...` 字面当作全仓库复制命令。按上游目录结构保留真正需要的文件。
- [ ] 在引入代码前形成复用清单：AGPL-3.0 适用文件与分发义务、现有 GSAP 等运行依赖的许可关系、仍需确认的公开发布许可。不得替用户把全项目改许可证，也不得把私有包当成不能复用。若发现会阻断所选复用路径的许可冲突，报告具体证据并暂停该任务依赖项，不能自行重写绕过。其余独立存储工作可继续；公开分发验证另设门槛。
- [ ] 为 14 个模块逐一创建可复用合法或自行编写的虚构夹具和能力矩阵。每个正例配不匹配探针、损坏输入、缺字段情况；支持多会话的模块配两个会话。先运行 `npm run test:backend -- tests/backend/parsers.test.ts tests/backend/siwx.test.ts` 确认失败。
- [ ] 引入必要 TypeScript 实现并转换事件；首期不加载原生解析加速。声明稳定标识的真实作用范围，无法证明跨导出稳定的本地流水号按无稳定标识处理。对上游已有静默跳过补充可计数诊断；可流式格式按事件消费，受限全量格式执行 32 MiB 上限。保持转换与原始解析分层，之后只在自身模块维护差异。
- [ ] 定制 SIWX：读取 `localType/typeName`，保留 `quote` 摘要与未知目标、空/无媒体信息和系统事件；账号后缀只形成冲突候选。关键断言：
  ```ts
  expect(parseSiwxFixture().messages.map(x => x.kind)).toEqual(['text', 'image', 'reply', 'unknown'])
  expect(parseSiwxFixture().messages[2].reply?.originalId).toBeNull()
  expect(parseSiwxFixture().messages[0].text).toBe(' 好\n')
  expect(parseSiwxFixture().members.filter(x => x.selfHint).length).toBe(1)
  ```
  对毫秒/秒、无时区时间、标识数字超安全范围、换行、同秒两条同文消息、未知发送者检查来源语义；未经证明的 ID 不转 Number。回复仅在已有可靠目标键时可关联。
- [ ] 重跑解析测试与类型检查，矩阵每个目标模块必须为通过或有明确阻断证据；未通过不能对外声明支持。提交：`feat(import): 接入并定制多格式会话解析器`。

### Task 4: 实现目录发现、来源快照与完整暂存校验

**Files:** 新建 `electron/data/import/{limits,discovery,snapshot,staging}.ts`、`src/shared/import-contract.ts`、`tests/backend/{discovery,staging}.test.ts`。

**Interfaces:** `discover(grants: readonly GrantedSource[], signal: AbortSignal): Promise<Discovery>`；`GrantedSource` 是主进程签发的授权根记录，仅后台含真实路径。`Discovery` 含 `entries: {entryId:string;displayName:string;formatId:string}[]`、未识别项和问题，不含消息正文。`stageInputs(jobId: string, discovery: Discovery, signal: AbortSignal): Promise<StagedImport>`；`StagedImport` 提供暂存路径、`candidates: Candidate[]`、计数及问题；`Candidate` 含不透明编号、标题、格式、成员候选、来源身份、数量与问题。任务阶段和会话结果采用设计第 7.3 节枚举，英文值在类型内一一对应。

- [ ] 写失败测试：多层目录正确发现会话并跳过清单/图片；同一文件从根目录和清单进入只算一次；路径逃逸、循环链接、深度 17、目录项 10,001、巨型记录、原文件复制途中变化均阻断且正式消息数为零。测试 Windows 目录联接不得依赖用户管理员权限；无法创建的文件系统用可替换访问层模拟，并在桌面验收覆盖真实系统能力。
  ```ts
  expect(discovered.entries).toHaveLength(1)
  expect(changedInput.issues.map(x => x.code)).toContain('SOURCE_CHANGED')
  expect(outsideRootReadCount).toBe(0)
  expect(formalMessageCount()).toBe(0)
  ```
- [ ] 运行 `npm run test:backend -- tests/backend/discovery.test.ts tests/backend/staging.test.ts` 确认失败。
- [ ] 实现限额、真实路径边界、源快照、摘要与临时库；文本编码按格式声明处理，拒绝解码后静默替换造成内容变化。仅对明确格式的分块清单扩展其文件集；归属不明确的多个文件保持独立入口。
- [ ] 实现预览流程：选择后先做快速发现，用户决定解析范围；解析暂存完成才展示精确会话数量和归属供确认保存。所有来源都可先暂存，不因缺本人确认而阻止普通阅读；目标会话归属则必须在提交前解决。共享文件结构损坏且无法可靠分离会话时阻断整个文件，其他独立文件继续；不宣称已恢复损坏文件后半段。
- [ ] 加入计数校验：每个候选 `seen = validRecords + invalidRecords`，未知类型计入 valid；`invalidRecords>0` 阻断，来源头部声明数不一致须报告并阻断，除非适配器明确说明该字段不是消息计数。磁盘不足或取消清理任务临时文件，不触碰源文件。
- [ ] 重跑测试与类型检查；断言 `stageInputs` 后正式库仍为空，8 MiB 和各文件阈值在边界处有测试。提交：`feat(import): 增加目录发现与导入暂存校验`。

### Task 5: 实现来源归属、本人确认与去重判定

**Files:** 新建 `electron/data/import/identity.ts`、`tests/backend/identity.test.ts`；补充共享合同及必要的账号别名表。

**Interfaces:** `resolveTarget(store: Store, candidate: Candidate, decision?: TargetDecision): TargetResolution`；`TargetDecision = {candidateId:string; target:{kind:'new'}|{kind:'existing';conversationId:LocalId}; confirmedAliases: AccountAlias[]}`，`AccountAlias` 明确平台与两个来源键；`TargetResolution` 为匹配、待用户选择或阻断。`classifyMessage(store: Store, target: ResolvedTarget, message: ParsedMessage, origin: SourceRecordKey): 'new'|'duplicate'|'ambiguous'`；`SourceRecordKey` 含文件组合指纹、来源会话键、记录序号。`ResolvedTarget` 只由校验后的 resolution 创建，不信任页面直接构造。`confirmSelf(store, conversationId, memberId: LocalId|null): void` 单独保存用户确认。

- [ ] 写失败测试并运行 `npm run test:backend -- tests/backend/identity.test.ts`：
  ```ts
  expect(resolveByTitleOnly('小林').status).toBe('needs-choice')
  expect(classifyInExistingScope('m2', '改过的正文')).toBe('duplicate')
  expect(classifyInOtherConversation('m2')).toBe('new')
  expect(classifyWithoutId(sameFingerprint, sameOrdinal)).toBe('duplicate')
  expect(classifyWithoutId(otherFingerprint, sameText)).toBe('ambiguous')
  expect(resolveOwnerSuffixConflict().confirmedSelf).toBeNull()
  ```
- [ ] 实现可靠来源映射和显式目标选择，名字不能参与自动唯一判定。首次无稳定标识仍逐条保留；再次不同文件导入同一目标存在任何无法证明的记录时，整个候选阻断，提示改用含可靠标识的格式。不能建议误建新会话来规避真实歧义。
- [ ] 明确重复判定不修改已有消息、已有来源记录或回复；只记录本次重复数量。新文件仅含已存稳定标识时无需变更旧记录。同一批重复键取首条有效记录，后续计为重复。
- [ ] 本人提示与用户确认分别保存；无冲突的已确认稳定账号可复用，任意去后缀或昵称推断禁止。撤销只清确认，既有正文与名称不变；本人确认操作加入同一写队列，不能穿插导入事务。
- [ ] 重跑身份测试、存储测试与类型检查；提交：`feat(import): 实现会话归属与保守增量去重`。

### Task 6: 实现原子合并、任务编排与异常恢复

**Files:** 新建 `electron/data/import/{merge,runner,recovery,summary}.ts`、`electron/data/service.ts`、`tests/backend/{merge,recovery,runner}.test.ts`；扩展 `tests/desktop/runtime.spec.mjs` 的崩溃用例。

**Interfaces:** `commitConversation(store: Store, staged: StagedConversation, target: ResolvedTarget, signal: AbortSignal): Promise<CommitResult>`；`StagedConversation` 是任务 4 中已确认属于同一目标的候选组的受控读取视图，包含 candidateIds；`CommitResult` 含 conversationId、inserted、duplicates、committedAt、逐候选结果。`startImport(request:StartImportRequest):Promise<JobId>`、`cancelImport(jobId:JobId):Promise<void>`、`getImport(jobId:JobId):Promise<ImportSnapshot>`、`recoverImports(store:Store):Promise<void>`、`rebuildSummary(store:Store, conversationId:LocalId):Promise<void>`。`JobId=string`；`ImportPlan={jobId:JobId;decisions:TargetDecision[]}`；`StartImportRequest={kind:'stage';jobId:JobId;entryIds:string[]}|{kind:'commit';plan:ImportPlan}`。`ImportSnapshot` 含状态、发现入口、暂存候选、逐候选结果、警告与计数；同一任务按状态机经历选择解析范围、暂存及确认提交，不在每个阶段生成另一个任务。

- [ ] 写失败测试：已有 m1/m2/m3 加入 m2/m4 后只有 4 条；旧 m2 正文、附件和引用不变；10,000 条旧消息新增 500 条，在第 300 条注入失败后仍为 10,000；A 成功/B 失败/C 重复无新增为部分完成。
  ```ts
  expect(allOriginalIds()).toEqual(['m1', 'm2', 'm3', 'm4'])
  expect(readOriginal('m2')).toEqual(beforeM2)
  expect(countAfterInjectedRollback).toBe(10_000)
  expect(reimportAfterCrash.inserted).toBe(0)
  ```
- [ ] 运行 `npm run test:backend -- tests/backend/merge.test.ts tests/backend/recovery.test.ts tests/backend/runner.test.ts` 确认缺失行为；预设可注入的存储故障点仅位于测试依赖，不把随意执行代码接口开放给页面。
- [ ] 实现单会话 `BEGIN IMMEDIATE` / `COMMIT` / `ROLLBACK`。每批 500 条或 8 MiB 后让出事件循环，检查取消；事务保持同一写连接，禁止在 `better-sqlite3.transaction()` 同步包装器中使用异步回调。目标最终匹配、唯一键检查、新会话创建、新成员、新消息、来源、引用与已提交结果在同一正式事务中。
- [ ] 同一任务中，多个候选已确认指向同一正式会话时先成组，一次事务处理整组；组内有阻断候选则不提交该目标。测试两个文件都属于 A，第二个在写入中失败时第一个的新增也回滚。来源无法识别的损坏文件不能凭猜测归组，需报告未解析归属；其他明确独立会话仍可提交。
- [ ] 引用只在本次新消息上解析，支持目标已在数据库或同批后出现；旧重复消息不回填。提交后才更新摘要，摘要失败保留已保存结果且支持单独重试。无新增候选也持久化独立结果但不变更旧消息。
- [ ] 实现单任务/单写入队列和取消边界。来源继续处理的单位是可独立校验的候选；磁盘不足、正式数据库不可写或数据进程退出属于任务级失败，停止后续提交，不能伪称继续成功。当前会话结果不可写时启动恢复依据持久记录重新判定，失败记录不能反过来覆盖已提交状态。
- [ ] 新进程重开测试覆盖提交前退出和提交后通知前退出：前者无新增，后者新增完整且重导零新增；覆盖摘要失败重试、取消第一候选/后续候选、第二任务拒绝、只读连接看不到未提交消息。运行后台测试后，`npm run native:electron`、`npm run desktop:build`、`npm run test:desktop -- --case crash-recovery`，预期全部通过。
- [ ] 启动恢复不重新扫描源目录；只清理未提交任务拥有的临时区，重建任务汇总，保留其他资料。检查数据库完整性后提交：`feat(import): 实现会话事务与导入恢复`。

### Task 7: 实现分页读取、快照游标与原文范围定位

**Files:** 新建 `electron/data/db/queries.ts`、`src/shared/desktop-api.ts`、`tests/backend/queries.test.ts`。

**Interfaces:** `listConversations(input:{cursor?:string;limit?:number}):Promise<Page<ConversationSummary>>`；`readMessages(input:{conversationId:LocalId;cursor?:string;direction:'before'|'after';limit?:number}):Promise<MessagePage>`；`locateSource(input:{conversationId:LocalId;messageId:LocalId;endMessageId?:LocalId}):Promise<SourceWindow>`。`Page<T>` 含 items、nextCursor；`MessagePage` 含消息 items、beforeCursor、afterCursor、snapshotMaxId；`SourceWindow` 为 unavailable 或可用且含起止消息编号、首个 MessagePage 和范围结束游标。`ConversationSummary` 含 id、title、数量、时间范围、摘要状态；`MessageView` 含稳定编号、发送时名称、isSelf、时间标签、kind、text、引用与附件描述。

- [ ] 写失败测试并运行 `npm run native:node`、`npm run test:backend -- tests/backend/queries.test.ts`：同一毫秒 250 条分 3 页全部且只出现一次；翻页间追加早期消息不进入当前水位，刷新后出现；未知时间在独立段保持源序；游标换会话、损坏或超限均拒绝。
  ```ts
  expect(pages.map(p => p.items.length)).toEqual([100, 100, 50])
  expect(new Set(pages.flatMap(p => p.items.map(m => m.id))).size).toBe(250)
  expect(secondPage.items.some(m => m.id === backfilledId)).toBe(false)
  expect(sourceWindow.status).toBe('available')
  ```
- [ ] 实现按索引范围分页，初始水位取当前会话最大消息编号，后续限定 `id<=snapshotMaxId`。游标包含会话、bucket、时间、编号、水位和版本，运行时校验；页大小默认 100、上限 200，列表按 id 降序稳定翻页。只读连接每次查询结束，不跨翻页保持事务。
- [ ] 实现原文定位：验证起止点均属于指定会话且顺序正确，以起点前 20 条和之后最多 79 条形成初始 100 条窗口；长范围通过游标继续读，不能一次返回整个范围。跨会话、已删除、结束点不存在或反向范围返回 unavailable。
- [ ] 加入第 12,000 条定位、大整数编号、预纪元时间、范围跨已知/未知时间段测试；`EXPLAIN QUERY PLAN` 验证按会话使用预定索引，不对整个消息表进行临时排序。索引计划断言检查使用索引而不硬编码整段解释文本。
- [ ] 重跑查询和存储测试与类型检查，提交：`feat(reader): 增加消息分页与原文定位查询`。

### Task 8: 接通受限通信桥与来源授权

**Files:** 新建 `electron/main/{source-grants,ipc}.ts`、`tests/backend/{source-grants,ipc}.test.ts`、`src/data/desktop-client.ts`；修改预加载、数据进程入口、服务及共享接口。

**Interfaces:** 页面 `DesktopApi` 仅提供 `chooseSources(kind:'files'|'directory'):Promise<SourceHandle[]>`、`acceptDroppedFiles(files:File[]):Promise<SourceHandle[]>`、`prepareImport(handles:SourceHandle[]):Promise<JobId>`、`getImport/startImport/cancelImport`（沿用任务 6 的完整签名）、`onImport(listener:(s:ImportSnapshot)=>void):()=>void`、任务 7 三个读取方法、`listMembers(conversationId:LocalId):Promise<MemberView[]>`、`confirmSelf(conversationId:LocalId,memberId:null|LocalId):Promise<void>`、`retrySummary(conversationId:LocalId):Promise<void>`。`MemberView` 含 id、displayName、selfHint、confirmedSelf；`SourceHandle` 为随机令牌、显示名、类别，不能含真实路径。`prepareImport` 先发现范围，之后调用任务 6 定义的 `StartImportRequest`。

- [ ] 写失败测试：错误来源令牌、来自其他窗口的句柄、未知方法、伪造路径、过期任务、未知 ID、非法游标被拒绝；订阅释放后不再收到进度。运行 `npm run test:backend -- tests/backend/source-grants.test.ts tests/backend/ipc.test.ts`。
  ```ts
  await expect(useOtherWindowHandle()).rejects.toMatchObject({ code: 'INVALID_SOURCE' })
  expect(workerRequestsAfterRejectedCall).toHaveLength(0)
  expect(eventsAfterUnsubscribe).toHaveLength(0)
  ```
- [ ] 主进程验证调用方为本应用主框架；不注册通用读文件、执行数据库文本或运行脚本方法。拖放由预加载 `webUtils.getPathForFile` 从实际 File 得到来源，拒绝页面构造的无磁盘 File；路径只在预加载与主进程内部使用。主进程对对话框和拖放根创建随机令牌并绑定调用窗口/任务。
- [ ] 接入发现、暂存、提交及读取路由；只在已暂存候选内接受目标选择。会话内成员编号与本人选择必须校验匹配。启动和导入不产生模型或外网请求。错误传明确 code/action，不将堆栈、私人路径或正文送入日志与错误提示。
- [ ] `DesktopApi` 返回的 ID 全是字符串，事件与返回值均通过运行时校验；进度节流且终态立即发送。后台断开时终止等待请求，界面能查看重启恢复结果。
- [ ] 重跑授权/通信测试，再执行 `npm run native:electron`、`npm run desktop:build` 并验证桌面拖入真实临时文件和目录；提交：`feat(desktop): 接通受限导入与阅读接口`。

### Task 9: 接入导入候选、身份选择与进度结果界面

**Files:** 新建 `src/data/use-import.ts`、`src/components/import/{import-candidates,import-progress,identity-choice}.tsx`、`src/components/import/import.css`、`src/data/use-import.test.tsx`、`src/components/import/import-flow.test.tsx`；修改 `src/components/file-import.tsx`、`src/App.tsx`。

**Interfaces:** `useImport(api:DesktopApi)` 返回 snapshot、选择/解析/确认保存/取消动作及错误；`FileImport({api,onSaved})` 的 onSaved 仅在收到持久已保存结果后回调会话编号列表。成员候选保留来源名，不把未确认者标为我。

- [ ] 用假的 DesktopApi 写行为测试并先运行 `npm test -- src/components/import/import-flow.test.tsx src/data/use-import.test.tsx`：选择两层目录→发现→选择入口→暂存预览→确认目标/本人→保存→打开会话；错误不应变成已保存通知。
  ```tsx
  expect(await screen.findByText('已保存 500 条消息。')).toBeVisible()
  expect(screen.getByRole('button', { name: '打开会话' })).toBeEnabled()
  expect(onSaved).toHaveBeenCalledWith([savedConversationId])
  expect(onSaved).not.toHaveBeenCalledWith([failedConversationId])
  ```
- [ ] 保留现有视觉、键盘焦点和拖放阻止导航行为；按已有风格增加候选列表、冲突选择、进度与逐会话结果。解析前预览是文件范围，解析后预览才显示精确会话与成员，不能将估计数量当结果。本人未确认允许保存和阅读，但不触发个人分析。
- [ ] 文案直接可操作：`请选择导入目标。`、`这份记录缺少可靠的消息标识，请更换导出格式。`、`已保存 500 条消息。打开会话`；实际数量来自后台。取消仅停止未提交部分，已经保存的结果继续提供打开入口。
- [ ] 测试 A 成功/B 失败/C 重复、重复导入零新增、后缀冲突、两个同名联系人、重试摘要、移除组件取消订阅、恢复后查询任务状态。对用户选择已有会话再次展示目标标题确认，不根据名字默认选中。界面不能展示任何未经后台证实的成功。
- [ ] 重跑界面测试和类型检查，提交：`feat(import-ui): 接入会话导入预览与结果反馈`。

### Task 10: 将现有阅读与引用导航迁移到分页数据源

**Files:** 新建 `src/data/{preview-client,use-conversations}.ts`、`src/data/use-conversations.test.tsx`；修改 `src/App.tsx`、`src/main.tsx`、`src/components/conversations.tsx`、`src/components/conversations.css`、`src/dev/preview.tsx`、`src/conversations.test.tsx`、`src/overview-navigation.test.tsx`、`src/clarification-navigation.test.tsx`。

**Interfaces:** `ConversationClient` 取 DesktopApi 的会话列表、消息页和定位方法；`createPreviewClient(conversations:readonly Conversation[]):ConversationClient` 仅供明确开发预览。`useConversations(client)` 返回列表、刷新/加载更多、当前窗口及 open/loadBefore/loadAfter/locate；`AppProps` 增加 client，现有预览注入经过适配器保留。正式 main 仅使用 desktop-client，普通网页开发保持明确空状态和已有预览入口。

- [ ] 写失败测试：会话列表无需 messages 全量数组；打开只请求第一页；点击第 12,000 条附近的来源调用 locateSource 一次；跨页范围高亮持续、返回总览/解惑位置正确。运行 `npm test -- src/conversations.test.tsx src/data/use-conversations.test.tsx src/overview-navigation.test.tsx src/clarification-navigation.test.tsx`。
  ```ts
  expect(client.locateSource).toHaveBeenCalledTimes(1)
  expect(client.locateSource).toHaveBeenCalledWith(sourceRequest)
  expect(renderedMessageIds.length).toBeLessThanOrEqual(500)
  expect(activeConversationIdAfterOldRequestResolves).toBe(newConversationId)
  ```
- [ ] 拆掉正式入口 `conversations.find(...).messages` 和全量 `resolveSourceRange` 依赖。可保留该纯函数用于开发预览，正式可用性由后端结果和来源 unavailable 状态决定；异步定位失败提供原文不可用状态，不无声忽略点击。
- [ ] 实现 5 页窗口与前后加载、移除上方页时保持视觉锚点；时间未知段有明确标签。切换会话使用请求世代标记，旧请求晚返回不能覆盖新会话。大范围引用只高亮已加载部分并允许继续读，不全量取回。
- [ ] 保留现有封面、键盘操作、返回路径与虚构预览标签；导入成功刷新列表，首次保存后可打开会话，重启从后台列表读取。没有本次分析数据时仍显示未分析，不生成占位画像或 Spark。
- [ ] 重跑上述测试及 `npm test`、`npm run typecheck`、`npm run build`，预期现有功能与分页行为均通过；提交：`feat(reader): 接入持久会话与分页原文导航`。

### Task 11: 验证打包后的完整导入流程并归档证据

**Files:** 扩展 `tests/desktop/import.spec.mjs`、`scripts/desktop-smoke.mjs`；新建 `scripts/import-benchmark.mjs`、`docs/research/conversation-import-validation.md`；更新 `PRODUCT.md`、`docs/designs/whomi-functional-baseline-v0.2.md`、`docs/designs/README.md`、第三方声明及格式能力矩阵。

**Interfaces:** `npm run test:desktop -- --case import` 覆盖实际窗口、通信桥、数据进程与临时正式数据库；`npm run bench:import -- --messages 100000 --conversations 10` 和一百万消息压力档使用确定性虚构数据生成器，不读取私人目录。测试脚本显式传临时资料目录，完成后按已验证绝对路径清理自身文件。

- [ ] 在连接完整流程后先新增会失败的桌面断言，再修复接线：文件和目录导入、同文件重导、新电脑缺旧消息、同标识正文不同、失败回滚、重启持久化、本人确认、引用定位、源目录未改动。所有格式矩阵经过共同合同，不只运行 SIWX 正例。
  ```ts
  expect(reopenedConversation.messageCount).toBe(4)
  expect(secondImport.inserted).toBe(1)
  expect(thirdIdenticalImport.inserted).toBe(0)
  expect(sourceTreeFingerprintAfter).toBe(sourceTreeFingerprintBefore)
  ```
- [ ] 顺序运行 `npm test`、`npm run typecheck`、`npm run build`、`npm run native:node`、`npm run test:backend`；再运行 `npm run native:electron`、`npm run desktop:build`、`npm run test:desktop`、`npm run desktop:pack`、`npm run desktop:dist`。目录包与安装后的应用均复验导入→退出→重开→定位，记录版本与命令，不以网页测试代替桌面验证。
- [ ] 故障验收覆盖磁盘写入失败、原文件改变、后台进程被终止、提交后结果通知丢失、巨大记录、目录越界与虚构恶意文本。必须观察到已提交会话可读、当前会话无半批数据、源文件不变；正文中的脚本/标记作为文字展示，不能执行。
- [ ] 测量 10 个会话共 100,000 条及 1,000,000 条虚构记录：总导入时间、数据进程峰值常驻内存、页查询第 95 百分位耗时、打开窗口耗时、取消确认耗时。先以 100,000 条档数据进程峰值不超过 512 MiB、单页查询第 95 百分位不超过 200 毫秒、取消确认不超过 2 秒作为本机工程验收目标，注明硬件与输入；百万档记录实际结果，不冒充普遍保证。完整事务的回滚耗时另外记录，不等同取消按钮响应。未达标先定位瓶颈，不改成分批正式提交。
- [ ] 核对每种格式支持声明与实际证据、无模型调用、无私人资料进入安装包/日志、生产开发库隔离、许可和必要源代码/声明交付清单。发布许可尚未确定或存在兼容疑点时不能声称可公开分发；本任务只生成本地验证产物，不上传安装包。真实 SIWX 目录只在用户已有授权范围内作本地人工验收，不入仓库，报告只列数量和差异类别。
- [ ] 更新实际能力文档、格式限制、失败重试操作与验证结果；尚未完成的能力保持未实现状态，不把计划全选为完成。提交：`test(import): 验证桌面导入恢复与分页阅读`，提交说明只写实际完成的验证。

## 3. 执行检查点与覆盖自检

任务 1 完成后，必须已有可运行的桌面数据库边界；任务 3 完成后，必须有逐格式证据与依赖许可记录；任务 6 完成后，数据库故障恢复必须通过，才接入正式保存按钮；任务 11 完成后才可宣称整个导入里程碑可用。每个任务自身可独立验收，但这些是同一条导入链路，不并行改动共享接口。

| 设计章节 | 落实位置 |
|---|---|
| 1–3：范围、复用与样本差异 | 全局约束、任务 3、11；不导入其余完整服务 |
| 4：桌面进程和生命周期 | 任务 1、6、8 |
| 5：自有模型、时间、顺序与身份 | 第 1.3 节、任务 2、3、5、7 |
| 6：解析复用、许可与支持合同 | 任务 3、11 |
| 7：目录、校验、计数与结果 | 任务 4、6、8、9 |
| 8–9：增量、事务、恢复与取消 | 任务 5、6、11 |
| 10：分页、引用与前端 | 任务 7、8、10 |
| 11：Spark 与删除约束 | 不复用消息编号、来源失效返回值；完整 Spark 与删除业务不在本轮 |
| 12–13：验收和实现者边界 | 各任务测试、任务 11、全局约束 |

计划自检：共享类型和接口命名一致；14 格式目标未缩减；五个 Review Focus 已分别加入所属任务；来源摘要不充当身份；数据库提交与摘要失败区分；文档未声称已经通过任何产品测试。实施过程中如果格式目标、许可路径或原子保证无法满足，说明实际阻断，回到用户确认，不私自改变设计。

执行方式待用户选择：建议当前会话由主代理按任务顺序实现，关键阶段运行验证，最后安排独立审阅；这些任务高度依赖相同的数据合同，顺序执行便于保持一致。若选择逐任务子代理实现和审阅，则按相应技能进行，不并行修改共享模型和数据库结构。

## 4. 核查来源

- [Electron 数据进程](https://www.electronjs.org/docs/latest/api/utility-process)、[隔离预加载的文件路径处理](https://www.electronjs.org/docs/latest/api/web-utils)、[原生模块与运行时匹配](https://www.electronjs.org/docs/latest/tutorial/using-native-node-modules)。
- [electron-vite 官方文档](https://electron-vite.org/guide/)、[electron-builder 配置](https://www.electron.build/configuration/)、[better-sqlite3 接口](https://github.com/WiseLibs/better-sqlite3/blob/master/docs/api.md)。
- [Playwright 的 Electron 自动化与系统对话框处理](https://playwright.dev/docs/api/class-electron)。
- [SQLite WAL 与故障修复说明](https://www.sqlite.org/wal.html)、[SQLite 事务](https://www.sqlite.org/lang_transaction.html)。
- 依赖版本证据为本次 `npm view <package> version engines peerDependencies --registry=https://registry.npmjs.org --offline=false --json` 输出；网站教程可能与注册表版本不同，运行验证仍按任务 1 执行。
- ChatLab 与 SIWX 固定源码链接及样本证据见[设计来源](../specs/2026-10-29-conversation-import-design.md#14-来源)。

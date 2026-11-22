# 对话洞察 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将当前记忆生成升级为可按日期选择、能回查原文并可修正解释的对话洞察。

**Architecture:** 复用现有分析任务、SQLite 数据库、模型运行器和聊天分页；为新报告增加独立格式与阅读断点，按容量顺序读完范围内材料，再执行有界回读及成稿。模型通过结构化文本提出读取请求，由程序检查消息范围与预算后执行，两条模型通路无需先增加原生工具调用。前端以选定设计图为依据接入报告与独立原文弹窗。

**Tech Stack:** Windows、Electron 45、React 19、TypeScript、better-sqlite3 13、既有 Pi 1.4.0 / ChatGPT 运行器、Vitest 和 Playwright；版本沿用 package.json，不在本计划中升级依赖。

**Spec:** [对话洞察设计](../specs/2026-11-12-conversation-insights-design.md)，含 2026-11-14 页面选择与管理页反馈补充。
**Status:** 2026-11-15 已在 codex/issue-10-conversation-insights 本地实现，待维护者验收。[实施验证](../../research/conversation-insights-validation.md)统一记录最终产物、实际命令、截图和模型比较；下方逐步清单保留编写计划时的步骤及预拟文件名，不作为最新执行台账。实际文件按领域边界合并，未按每项预拟提交拆分。
**Issue drafts:** [待提交目录](../../planning/issues/2026-11-13-conversation-insights/README.md)。

2026-11-15 设计推进约定：已确认页面继续作为实现依据。普通窗口缩放、长文本换行及同布局的简单加载状态复用已有组件，在实现阶段验证，不另设逐图确认门槛。启动四状态按本次用户纠正补记已确认，无需再次选图；其他尚未决定且改变实际操作的规则继续细化。例如缩窄报告窗口后，直接核验信息完整、引用可操作和滚动恢复，无需重新选择报告版式。


## Global Constraints

### 本轮执行结果

| 任务 | 实际结果 |
| --- | --- |
| Task 1 | 使用已有14份有效设计，不新增页面选图；完成真实窗口视觉审查和修复复查。 |
| Task 2 | 范围、来源、迁移、报告生命周期与已确认的本地总览聚合已实现并验证。 |
| Task 3 | 容量分批、缺省估算、单条拆分、有界缩片与恢复预算已实现并验证。 |
| Task 4 | 阅读、核查、压缩导航、成稿和断点已实现；真实模型发现的问题及质量结论另列，不提前确认发布默认预算。 |
| Task 5 | 会话内启动、进度、管理、阅读、改名和删除已实现；名称上限80字符，裁空白，保存中锁定，失败保留。 |
| Task 6 | 精确来源弹窗、自动分页、上下片段与阅读恢复已实现；真实窄窗及失败重试已验证。 |
| Task 7 | 类型、前后端回归、桌面和已授权模型试验已执行。语义收益与尚未验证的边界见实施验证，不由字段校验代替。 |

### 原计划约束

- 涉及界面的工单必须使用 impeccable、ui-ux-pro-max、design-review；设计和实现遵循选定图，实际页面实现后截图审查并复查修复，具体证据见[界面技能流程](../../designs/conversation-insights/ui-skill-workflow.md)。静态图不算运行态审查通过。
- 侧栏报告入口为对话洞察；每个会话工具栏原整理成记忆位置的按钮改名为会话洞察。点击时先检查当前会话本人是否已确认，缺失则立即提醒且不进入启动浮窗；该门槛不阻塞报告列表及历史报告阅读。启动浮窗承接当前会话，可只读显示会话名，无会话切换下拉；管理列表不新增全局新建入口。结果只有关于你、你们的相处两个主体，共同经历融入分析。
- 程序按模型上下文容量动态分批并保留时间；模型结合日期理解事件，不把自然日、固定条数或固定重叠比例当成事件边界。
- 模型容量参数允许留空，优先可靠容量资料，未知时留余量并有界缩批；实际服务端用量与发送前估算分别记录。
- 洞察不调用检索增强生成（Retrieval-Augmented Generation，简称 RAG）；后续问答与索引建设归入独立计划。
- 当前会话全部记录或指定日期范围；包含所选起止日期，任务冻结时区、消息集合与来源版本。范围外消息不发给模型。
- 生成叙述称对方为 ta；原始聊天保留原样；不以事件票数替代模型分析，不伪造旧文稿引用。
- 具体经历文字可点击；原文弹窗 V2 桌面初次定位正常态已确认。滚动接近已加载边缘时自动读取相邻聊天、保持阅读位置且无更多记录时停止请求；上一段位于聊天区右上、下一段位于右下，均在弹窗内且不遮挡消息，计数位于底部下一段旁。片段跳转与滚动加载独立，关闭后恢复位置。
- 新报告默认标题统一为会话洞察，由应用程序赋值，不调用模型命名或追加范围。保留手动改名；改名不修改分析范围、内容或来源，全量报告保留生成时的实际截止时间。
- 报告阅读页按已选 A 修订图呈现，左上角文案为返回，右上角不显示新建报告；侧栏报告入口仍为对话洞察。
- 来源会话删除级联清理原文与该会话全部报告，撤回总览贡献并退出失效阅读；身份变化按既有有效性处理。来源校验保留，但不新增单条原文编辑/删除功能；异常来源不能用于生成完整报告。
- 页面布局以 design-shotgun 选定图为准。管理页采用 [G 修订图](../../designs/conversation-insights/assets/management-g-v2.png)，对应状态边界见[设计记录](../../designs/conversation-insights/README.md)，旧 report-list-v1.png 仅作历史候选。真正新增且尚未选图的页面保持待设计，不凭本计划文字自行定稿；同布局的状态复用既有图与组件，不机械新增选图门槛。
- 进度字段与计算口径已确认：默认消息处理进度、已运行时间、平均分析速度（消息数/s）及只读模型配置；不显示算法阶段、阶段切换或核查事项计数。详情含输入输出词元、平均输出词元/秒、范围及服务提供的提示词缓存读写，省略累计请求耗时；具体口径见任务 5。内部阶段及有界核查逻辑保留；2026-11-14 生成中进度浮窗收起、展开及已暂停、生成失败、已完成三种详情收起状态图已确认；G 修订图另展示管理页的生成中、已暂停和生成失败，未展示状态与未明确的异常行为继续保留待办。
- 不因迁移删除旧报告；旧任务按保存的版本续跑，新报告不伪造旧投票字段。2026-11-15 用户确认新洞察接入个人总览及报告增删联动为本期必做；旧格式兼容不阻止新格式纳入。新旧共存、重叠来源与冲突合并规则在本期契约中细化，不无说明地套用旧版每会话仅最新报告逻辑。
- 原文、用户提示词均通过已有数据处理与权限边界；不自动运行收费模型比较、不引入新后台服务。
- 当前分支 codex/conversation-insights，无上游；2026-11-13 fetch 与 pull 后 HEAD 和 origin/main 均为 6910b80。执行前重新核对远端，不依赖本记录替代核查。

## Review Focus

下列五项已分别纳入任务 2、3、4、6 的验收：
1. 范围结束日午夜、运行中补导消息及无有效时间的原文不能悄悄扩展模型输入。
2. 未填容量、超长单条消息及输出截断后，重试不能漏读或重复累计覆盖。
3. 已通读消息允许回读，但回读不能增加独立证据数；崩溃恢复不能重置总预算。
4. 证据编号、会话归属或版本异常时，旧引用不能高亮新内容冒充旧依据；异常注入测试不代表新增原文编辑流程。
5. 远处跳转失败、快速切换引用和关闭时的迟到结果不能重开弹窗或覆盖当前位置。

---

## 文件职责与共同接口

下列新增路径和类型是计划定义，并非已实现。既有文件已于本轮核对。

| 文件 | 职责 |
|---|---|
| 新增 src/shared/conversation-insights.ts | 范围、报告、证据、输入预算与断点类型 |
| 新增 electron/data/ai/insight-sources.ts | 日期筛选、消息清单及内容指纹、范围内回读和引用有效性 |
| 新增 electron/main/insight-packing.ts | 完整请求计数、容量装批与单消息分片 |
| 新增 electron/main/insight-checkpoint.ts | 覆盖、观察、核查队列及用量预留的持久化状态 |
| 新增 electron/main/insight-generation.ts | 顺序阅读、有限核查、成稿，接现有 RuntimeRunner |
| 新增 electron/data/ai/insight-prompts.ts | 三阶段输入/输出结构、解析与来源核验 |
| 新增 src/components/insights/ | 报告阅读、范围控件、改名及原文弹窗；复用既有基础组件 |
| 修改 electron/data/ai/repository.ts、electron/main/ai-service.ts | 分派新格式，沿用现有任务、调度与生命周期 |
| 修改 src/shared/ai-contract.ts、ai-validation.ts、memory.ts | 扩展方法与报告联合类型，保留旧格式 |
| 修改 src/data/conversation-ai-client.ts、src/App.tsx、memory-library.tsx | 将界面接到现有服务，不建立第二套任务通道 |

任务 2 定义以下契约，后续任务使用同名类型：
```ts
type InsightScope =
  | { kind: 'all' }
  | { kind: 'dates'; startDate: string; endDate: string; timezone: string }
type InsightSourceRef = { messageId: string; revision: string }
type InsightFragment = { sources: InsightSourceRef[] }
type InsightCitation = { id: string; conversationId: string; fragments: InsightFragment[] }
type InsightInline = { text: string; citationId?: string }
type InsightParagraph = { content: InsightInline[] }
type InsightReport = {
  format: 'conversation-insights-v1'
  aboutYou: InsightParagraph[]
  relationship: InsightParagraph[]
  citations: InsightCitation[]
  limitations: string[]
}
type InsightSourceMessage = {
  id: string; revision: string; senderName: string; isSelf: boolean
  text: string; sentAtMs: number | null; replyToMessageId: string | null
}
type InsightSnapshot = {
  taskId: string; scope: InsightScope; timezone: string
  sourceStartTimeMs: number | null; sourceEndTimeMs: number | null
  sources: InsightSourceRef[]; createdAtMs: number
}
```
日期字符串采用 YYYY-MM-DD；新任务用全量消息编号清单及指纹冻结来源，不把已有 snapshot_max_id 误当成完整内容快照。被引用原文采用精确消息集合，首期不承诺字符级定位。任务保存显示标题，报告主体只保存内容与引用。

## Task 1：统一页面设计与选图（I01）

**Files:** 创建 docs/designs/conversation-insights/README.md 及该目录的设计图、可复现页面源文件；读取 PRODUCT.md、DESIGN.md、docs/designs/whomi-memory-library.md、docs/designs/whomi-system-prompts.md。
**Interfaces:** 消费规格中的用户流程；产出设计清单，逐状态列出设计图路径、尺寸、是否选定，以及覆盖的 I05/I06 验收项。
**场景：** 用户选择十月范围生成报告，改名后点击经历、切到下一段原文再返回；所有步骤有一致的页面承载和可见操作。

- [x] 使用 design-shotgun 修订已选报告阅读页 A，将[设计图与约束](../../designs/conversation-insights/README.md)附入 I05；只完成桌面阅读正常态。
- [x] 确认启动按钮保留原会话工具栏位置、改名为会话洞察并承接当前会话。
- [x] 确认会话内启动浮窗的日期范围正常态修订图并附入 I05；其他启动状态和窄窗仍需实现验收。
- [x] 2026-11-14 用户确认本人未选择时点击会话洞察立即提醒并阻止进入启动浮窗；本人只在当前会话选择。
- [x] 2026-11-14 确认[本人缺失提醒图](../../designs/conversation-insights/assets/startup-self-required-v1.png)及保存后回原聊天、再次点击才打开启动浮窗流程；图仅覆盖桌面未选中成员状态，入口功能尚未实现。
- [x] 2026-11-15 据用户纠正补记[启动四状态图](../../designs/conversation-insights/assets/startup-scope-states-v1.png)已确认，包含全部记录、日期错误、空范围及模型缺失；无需再次选图，不推定最初确认日期。
- [ ] 本人选择读取/保存错误复用既有反馈，验收失败不放行与重试；新增操作差异先明确规则，不要求逐张补图。
- [x] 原文弹窗 V2 桌面初次定位、滚动加载、上下分置片段按钮、自由浏览及下一段临时读取失败保持已确认。2026-11-15 纠正历史图中的原文更新/删除但报告保留假设，取消相关首期补图门槛，详见 I06。
- [x] 采用 G 管理页布局并按反馈修订，图中展示列表右键菜单、行内改名失败、生成中、已暂停、生成失败及空列表；旧列表候选仅保留历史，不把这次选图扩大为所有异常行为均已确认。
- [ ] 收集用户选择，将选定图和状态映射加入 I05/I06；没有选择的方案保持候选，不写成批准。
- [ ] 检查工单图片或链接可访问，原型中仅使用标明虚构的聊天；记录界面验收方法。
- [ ] 提交设计产物：docs(insights): 补充对话洞察页面设计与状态约束。

## Task 2：范围快照、报告与引用存储（I02）

**Files:** 创建 src/shared/conversation-insights.ts、electron/data/ai/insight-sources.ts、tests/backend/insight-sources.test.ts；修改 electron/data/db/schema.ts、migrate.ts、electron/data/ai/schema.ts、repository.ts、electron/data/db/purge.ts、src/shared/ai-contract.ts、ai-validation.ts、memory.ts、electron/data/dispatch.ts、electron/main/ai-router.ts。
**Interfaces:**
- 扩展 prepareAnalysis(input: {conversationId: string; modelId: string; thinkingLevel?: ThinkingLevel; scope?: InsightScope}): Promise<AnalysisPreparation>；省略 scope 兼容为 all。
- AnalysisPreparation 携带 scope、时区与实际消息数；AnalysisTask 添加可选 title、scope（旧任务可缺省）；扩展 SavedReport 包含 InsightReport。
- 新增 renameAnalysis(input: {taskId: string; title: string}): Promise<AnalysisTask>。
- 在来源模块定义 readInsightSources(snapshot: InsightSnapshot, messageIds: readonly string[], current: readonly InsightSourceMessage[]): InsightSourceMessage[]；拒绝范围外编号、已删除及指纹不一致来源。
- 新增 readInsightCitation(input: {taskId: string; citationId: string; fragmentIndex: number}): Promise<InsightCitationWindow>；返回 available + 原有 SourceWindow 可用分支 + highlightIds，或 expired / unavailable，暂时读取错误按既有异常通道抛出。

- [ ] 编写测试：上海时区 2026-10-01 至 10-31 含两端整天，不含 11-01 零点；空范围拒绝；无日期消息不混入日期模式；后来追加消息不进入快照。
- [ ] 编写迁移及来源测试：版本 8 数据升级与空库建库均保留旧报告；通过注入文本、身份、时间或回复关系不一致的异常记录验证来源防护，只追加且被引内容未变时不失效。测试不新增原文编辑或单条删除入口。
- [ ] 运行 npm run test:backend -- tests/backend/insight-sources.test.ts tests/backend/database.test.ts，确认新契约尚不存在导致失败。
- [ ] 实现范围清单、稳定内容指纹、独立标题与新报告校验，覆盖新增/恢复任务、改名及两条删除路径；通过原有跨进程方法白名单和参数校验接入。
- [ ] 钉住改名和范围外读取的断言：
```ts
expect(renamed.title).toBe('那次合作')
expect(renamed.scope).toEqual(before.scope)
expect(renamed.sourceEndTimeMs).toBe(before.sourceEndTimeMs)
expect(() => readInsightSources(snapshot, ['outside'], current)).toThrow()
```
- [ ] 运行上述测试及 ai-repository.test.ts、ai-router.test.ts、ai-deletion.test.ts，确认通过；npm run typecheck。
- [ ] 提交：feat(insights): 保存分析范围与可核验的报告引用。

### 正常删除路径与历史设计纠正

2026-11-15 来源与删除规则纠正：当前会话导入采用追加和去重，没有单条原文编辑、删除或替换入口；确认本人改变身份有效性，不使原文消失。删除整个会话会一并删除其全部报告及生成数据，并撤回这些报告的个人总览贡献。原文更新后保留报告、部分原文删除但报告仍在不作为首期正常流程；相关旧图仅保留历史记录，不新增补图或选图门槛。来源编号、版本校验以及临时读取失败的重试仍需实现。

- [ ] 单独删除报告与删除整个会话走各自现有删除能力：前者保留原文和其他报告，后者在存储事务中清除该会话原文、全部报告及关联生成记录；两者均同步撤回相应总览贡献。
- [ ] 整会话删除后移除前端相关任务、来源入口和已打开的报告/原文弹窗，返回仍存在的列表或既有空状态；取消或明确失败不提前清理，迟到快照与重启不恢复已删除数据。

虚构验收：小林会话的 #23、#24 与小周会话的 #25 同时存在，删除小林会话后 #23、#24 及其原文和总览贡献一起消失，#25 保留；单独删除 #24 则保留 #23 与小林原文。

### 报告与个人总览的来源联动（本期必做）

2026-11-15 用户确认个人总览来源于洞察报告，完成保存新增与成功删除都要更新总览。现有 App 报告事件和列表刷新可复用；旧 currentMemoryContributions 只处理每会话最新有效旧记忆及其投票，不能直接作为新格式接入实现。

- [ ] 与任务 4 明确总览输入契约：稳定报告编号、内容版本、本人归属、判断、证据和有效状态；每项总览结论保留完整的实际来源。
- [ ] 在完成保存后发布可读取的新报告输入；生成取消、失败、未保存片段不进入总览。同一报告/版本重复完成或重试只处理一次。
- [ ] 成功删除目标报告后撤回其贡献；成功删除整个会话后撤回该会话全部报告贡献，再按剩余有效报告重算；取消或明确失败不提前移除。若持久化汇总缓存，同步更新或标记失效，迟到快照不能复活已删除来源。
- [ ] 明确同会话多范围报告、新旧格式共存、重叠依据和冲突解释的处理规则，保留不伪造旧投票约束；此时不预设算术公式或额外模型调用方式。
- [ ] 验证切页、重进、重启及刷新失败恢复后一致；报告改名仅更新显示名，不新增贡献。

虚构验收：小林同会话 #23 九月与 #24 十月均按已明确规则参与；删除 #24 后结果等于仅按剩余有效报告计算。仅由 #24 支持的内容撤回，共同支持内容用 #23 重评，最后一个有效来源删除后不残留无依据判断。来源更新不要求每个可见数值都变化。见 [I02](../../planning/issues/2026-11-13-conversation-insights/02-scope-storage.md) 与 [I07](../../planning/issues/2026-11-13-conversation-insights/07-validation.md)。

## Task 3：容量分批与有界缩片（I03）

**Files:** 创建 electron/main/insight-packing.ts、tests/backend/insight-packing.test.ts；修改 src/shared/conversation-insights.ts；复用 src/shared/model-limits.ts、electron/main/message-processing.ts，保留旧 analysis-packing.ts 与 memory-recovery.ts 的恢复规则。
**Interfaces:**
- computeInsightInputBudget(input: {contextWindow: number; maxInputTokens?: number; reservedOutput: number; occupiedInput: number; margin: number}): number。
- countInsightInput(input: RuntimeInput, model: AiModel): Promise<{tokens: number; method: 'provider' | 'tokenizer' | 'estimate'}>。
- packInsightSources(input: {messages: readonly InsightSourceMessage[]; cursor: {messageIndex: number; textOffset: number}; availableTokens: number; count: (text: string) => Promise<number>}): Promise<{messages: InsightSourceMessage[]; nextCursor: {messageIndex: number; textOffset: number}; completedMessageIds: string[]}>。
- 计数和分片包含序列化包装；组装系统提示、承接内容后再次检查完整请求。超长消息分片保留原编号和偏移到断点，最后一片完成才计覆盖。

- [ ] 编写预算边界测试：
```ts
expect(computeInsightInputBudget({
  contextWindow: 32000, maxInputTokens: 28000, reservedOutput: 4000,
  occupiedInput: 3000, margin: 1000
})).toBe(24000)
```
- [ ] 编写密集一天拆批、稀疏三天合批、跨午夜消息、单条超长及容量全空的测试；验证顺序、日期和来源完整。注入确定性计数器，避免用付费调用测分片。
- [ ] 运行 npm run test:backend -- tests/backend/insight-packing.test.ts，确认缺少新实现时失败。
- [ ] 实现可靠容量优先和可选字段兜底。优先已有可用计数能力；无法匹配分词器时标记估算、留余量；不只因协议兼容就声称精确，不增加必填配置。
- [ ] 接入超限二分恢复，沿用最多 8 层的既有缩片上限并计入总调用预算；容量边界无法满足时保留进度并结束，不丢失消息继续报成功。
- [ ] 运行新测试及 tests/backend/analysis-packing.test.ts、memory-recovery.test.ts，确认旧断点恢复不变；npm run typecheck。
- [ ] 提交：feat(insights): 按上下文容量组织原文并限制缩片重试。

## Task 4：顺序阅读、反例核查与成稿（I04）

**Files:** 创建 electron/main/insight-generation.ts、insight-checkpoint.ts、electron/data/ai/insight-prompts.ts、tests/backend/conversation-insights.test.ts、insight-recovery.test.ts；修改 electron/main/ai-service.ts、electron/data/ai/repository.ts、prompt-version.ts、src/shared/system-prompts.ts、electron/data/settings/repository.ts；同步相关校验及 tests/backend/system-prompts.test.ts。
**Interfaces:**
- 消费任务 2 的范围来源/报告和任务 3 的装批；复用 RuntimeRunner.run(input: RuntimeInput, options: {signal: AbortSignal; onText: (text: string) => void}): Promise<RuntimeResult>。
- 定义 InsightRunLimits {maxChecks: number; maxRoundsPerCheck: number; maxCalls: number; maxInputTokens: number; maxOutputTokens: number; maxElapsedMs: number}；所有值为有限正数，任务开始持久保存，恢复不能重置。
- generateInsight(input: {snapshot: InsightSnapshot; model: AiModel; prompts: InsightPrompts; limits: InsightRunLimits; checkpoint: InsightCheckpoint | null}, deps: InsightGenerationDeps): Promise<InsightReport>。
- InsightGenerationDeps 提供 run: RuntimeRunner['run']、read: (ids: readonly string[]) => Promise<InsightSourceMessage[]>、saveCheckpoint: (state: InsightCheckpoint) => Promise<void>、signal: AbortSignal、onText: (text: string) => void；秘密凭据沿用主服务注入，不写入断点。
- InsightCheckpoint 保存 version、阅读游标/分片布局、覆盖编号、带来源观察、判断修订、核查队列、调用预留及用量、已耗时。InsightPrompts 保存 reading/checking/writing 三段及版本。
- 新 promptVersion 为 conversation-insights-v1；新增设置键 insightReading、insightChecking、insightWriting，旧 memory* 键保留供旧任务读取；新任务固定提示词快照。
- 核查输出解析为 read {checkId, messageIds, purpose} 或 finish {checkId, revisedObservation, supportingIds, counterexampleIds, limitations}；不允许模型递归启动任务。程序控制 checkId 和预算，文字改写不能重置计数。

- [ ] 用临时数据库与伪 RuntimeRunner 编写串行场景：先观察建议方式不匹配，后续发现 ta 主动求建议，回读前文后缩小判断；检查最终引用和解释均来自范围内证据。
- [ ] 编写恢复测试：一项最多 2 轮、全任务最多 6 次调用的测试配置；重复读取同一证据不增加覆盖，崩溃后的预留调用仍占额度，超时用量未知不归零。
```ts
expect(afterResume.callsReserved).toBe(beforeCrash.callsReserved)
expect(afterReread.coveredMessageIds).toEqual(beforeReread.coveredMessageIds)
expect(fakeRunner.calls.length).toBeLessThanOrEqual(6)
expect(report.format).toBe('conversation-insights-v1')
```
- [ ] 运行 npm run test:backend -- tests/backend/conversation-insights.test.ts tests/backend/insight-recovery.test.ts，确认新行为尚未实现时失败。
- [ ] 实现三阶段提示词及受控循环。模型自行结合日期识别事件、支持和反例；程序核验编号、结构及范围，不投票决定人格。阅读必须推进新材料，回读单独记账。
- [ ] 输出与任务 2 对齐的总览判断及来源契约；汇总只依赖当前有效报告。明确多报告去重与冲突重评规则，删除来源后不沿用其独占结论，不从展示正文硬解析旧投票。
- [ ] 断点在请求前持久预留额度；任何解析修复、缩批和重试都计入同一预算；给成稿留调用额度。输出截断不当作成功。材料未读完或关键核查未完不写 completed。
- [ ] 默认预算作为集中配置写入 capability/quality 验证记录，不散落提示词；任务 7 以同预算比较后才锁定发布配置。测试用数值不是已批准的产品默认值。
- [ ] 两条实际适配器分别用模拟服务验证结构化文本、取消、用量缺失和长度结束；不为了回读增加新工具协议。验证失败时回到适配选择，不建设替代完整服务。
- [ ] 核查提示词编辑后新任务生效、旧任务续跑仍用旧快照；原文中的指令不改变任务目标；正文称 ta，来源逐字内容不改写。
- [ ] 运行新测试、analysis-continuation.test.ts、ai-service.test.ts、pi-runtime.test.ts、chatgpt-responses.test.ts、system-prompts.test.ts 及 npm run typecheck。
- [ ] 提交：feat(insights): 实现可恢复的阅读核查与证据成稿流程。

## Task 5：启动、报告阅读与改名（I05）

**Files:** 新增 src/components/insights/insight-article.tsx、insight-scope-fields.tsx、insight-report-menu.tsx 及同名测试；修改 src/App.tsx、src/components/memory-library.tsx、src/components/conversation-ai/workspace.tsx、src/data/conversation-ai-client.ts、src/components/settings/system-prompts.tsx；复用原模型选择和任务状态。
**Interfaces:** 消费任务 2 的 prepareAnalysis、renameAnalysis 和 InsightReport；InsightArticle({report: InsightReport; onOpenCitation: (citationId: string) => void})；InsightScopeFields({value: InsightScope; onChange: (scope: InsightScope) => void})。布局按任务 1 选定图实现。会话编号来自当前会话；范围字段不承担切换联系人的职责。

虚构场景：已在小林会话确认本人的用户点击会话洞察，浮窗只设置本会话范围与模型；取消回原聊天，不选择其他联系人，也不产生分析任务。另一个管理场景：当前未配置模型时，用户仍能打开已有十月报告，在紧凑报告行右键重命名为那次合作；保存失败后输入保留，修正或重试无需重新输入。

- [ ] 先检查 I01 的当前清单与[I05 已选报告图](../../planning/issues/2026-11-13-conversation-insights/05-report-interface.md)；使用当前有效选定图，复用布局状态核对行为并验收，只有现有布局无法承载的新增交互才另行设计。
- [ ] 编写原会话工具栏入口改名、本人未确认时点击即提醒且不打开启动浮窗、启动承接当前会话且无切换下拉、取消不开始任务、范围切换、空范围、列表不受本人或模型缺失阻塞、右键重命名、行内改名失败保留输入、关闭后焦点恢复的交互测试；报告只出现关于你、你们的相处，经历短语点击准确返回 citationId。
- [ ] 验证本人检查按当前会话执行：来源推测、未保存选择、保存失败、成员读取中或失败均不放行，读取失败可重试；未确认时不创建任务，确认后不重复选择。按 2026-11-14 已确认流程，保存成功后回聊天、再次点击才进入启动浮窗；实现和交互验收仍待完成，读取/保存错误复用既有反馈；普通窄窗在实现阶段验收。
```ts
await user.click(screen.getByRole('button', { name: '那次改期' }))
expect(openCitation).toHaveBeenCalledWith('citation-1')
expect(screen.getByText('关于你')).toBeVisible()
expect(screen.getByText('你们的相处')).toBeVisible()
expect(screen.getByRole('heading', { name: '会话洞察', level: 1 })).toBeVisible()
expect(screen.getByRole('button', { name: '返回', exact: true })).toBeVisible()
expect(screen.queryByRole('button', { name: '新建报告' })).not.toBeInTheDocument()
```
链接式外观的原地弹窗触发器采用可访问按钮语义；如果选图采用原生链接，则相应调整测试角色并保留键盘行为。
- [ ] 运行 npm test -- src/components/insights/insight-article.test.tsx src/components/insights/insight-scope-fields.test.tsx src/components/insights/insight-report-menu.test.tsx，确认新增行为失败。
- [ ] 按各页面选定图接入范围、固定默认标题与手动改名、生成进度、暂停恢复和失败重试。内部保留阅读、核查、成稿状态，前台不显示算法阶段、阶段切换或核查事项计数；输入与输出用量放展开详情，增加消息数/s。全量和日期范围报告默认标题均为会话洞察，由程序赋值而非模型生成；独立展示实际来源范围。报告阅读页左上角为返回，右上角无新建报告按钮。
- [x] 确认消息进度、任务完成判定、平均分析与平均输出速度的不同分母，以及展开详情字段和累计请求耗时不展示的决定。
- [x] 2026-11-14 用户确认同一进度浮窗的详情收起与展开两状态图；仅解除这两个状态的选图依赖，接入与验收仍待执行。
- [x] 生成同一进度浮窗已暂停、连接中断生成失败、已完成三状态图，附入 I05。
- [x] 2026-11-14 确认进度浮窗已暂停、生成失败、已完成三个详情收起状态及关闭、继续、重试与查看报告的操作。
- [ ] 无首批进度、正在暂停等过渡、三状态详情展开及普通窄窗复用已选布局，核对未定字段与操作并做运行验收，不设逐张补图门槛。
- [ ] 按选定图实现并验证三状态：关闭只收起、继续或重试复用同一任务保存进度、报告保存成功后才完成；保存失败显示生成失败，1,000 / 1,000 条未保存时仍生成中。
- [ ] 将当前会话工具栏原整理成记忆按钮改为会话洞察并保留位置，启动浮窗只操作当前会话；侧栏报告入口和系统提示词名称使用对话洞察。管理列表不新增全局新建入口。旧报告走 MemoryArticle 历史读取，旧任务按版本续跑；问一问入口保留，心事屋入口位置仅按选定导航设计接占位，不接问答后台。
- [ ] 在会话洞察入口打开浮窗之前核对当前会话已保存的本人确认状态；缺失立即提醒并阻止进入，不把检查延迟到开始洞察按钮。保留实际任务启动时的本人校验；管理列表及历史报告读取不受此门槛阻塞。
- [ ] 按 2026-11-14 已确认的桌面提醒图复用现有本人选择流程，提示请先选择本人，再开始会话洞察；取消停留原聊天，保存成功后回聊天，由用户再次点击进入启动浮窗，不自动开始。提醒图与保存后流程已确认，产品实现与验收尚未完成；读取/保存错误和窄窗未随本图获批，现有进入会话自动本人选择行为不在本轮变更范围内。
- [ ] 复用已有 ModelSelector、ThinkingSelector 和分析模型保存能力；无模型时可配置后返回原会话与所选范围，手动开始。本人检查在启动浮窗之前，模型缺失反馈在启动浮窗中；分别按对应选定图和操作验证，不混作同一个时点。
- [ ] 运行新测试及 memory-library.test.tsx、memory-vault.test.tsx、analysis-confirmation.test.tsx、analysis-preparation-lifecycle.test.tsx、system-prompts.test.tsx，执行 npm run typecheck。
- [ ] 提交：feat(insights): 接入范围选择与可改名的洞察报告。

### 已确认的阅读页原位重命名

2026-11-14 用户确认 [I05 阅读页重命名图](../../planning/issues/2026-11-13-conversation-insights/05-report-interface.md)的原位编辑和保存失败两个状态，以及预填聚焦、取消恢复、失败保留输入和旧列表名、成功后两处同步的交互；功能尚未实现。主阅读区沿用已选 A 标题位置，不改变全局外壳、管理页 G 或当前有效的原文状态。

虚构示例：已保存标题为会话洞察，进入编辑时预填该名称并聚焦；用户手动输入那次合作，可取消恢复已保存标题或保存。失败时保留输入并提示保存失败，请重试，列表仍为会话洞察；保存成功后阅读页与列表才同步。操作不调用模型，不改变范围、时间、模型、编号、正文或引用，同名不覆盖其他报告。

- [x] 2026-11-14 确认原位编辑与保存失败两状态图及上述明确交互；仅解除这两态的选图依赖，功能与运行验收仍待完成。
- [ ] 明确空白校验与保存中处理后，复用已选编辑和反馈布局验收，不要求单独图片。当前提案为纯空白不提交并提示请输入报告名称、保存请求不重复；未定规则不视为批准，长名称换行与窄窗按已选布局验收。
- [ ] 实施前明确名称长度上限、空白裁剪、快捷键、保存中取消与离页处理；本轮不预设这些规则。

### 进度参数的已确认口径

用户已接受消息进度 N / N 与生成中、已暂停、已完成等普通任务状态分开，报告保存成功后才完成。平均分析速度为首次处理保存的去重消息数除以累计有效运行秒数，与已运行时间一致；暂停和未运行间隔不计，回读不增计数，后段均速可下降，首批无有效统计显示 —。默认同时展示只读模型配置，不展示内部算法阶段或核查事项计数。

详情包含输入输出词元、平均输出词元/秒、分析范围和服务提供的提示词缓存读写；累计请求耗时不展示，但仍作为平均输出速度的计算分母。缓存包含在总输入中，不能重复计入，缺失值不能填 0。虚构例：600 / 1,000 条、60%、运行 30 秒、20 消息数/s；详情输入 12,400、输出 1,260 词元，平均输出 45 词元/秒来自累计请求耗时 28 秒，缓存读取 8,000、服务明确返回写入 0，范围 2026.10.01—2026.10.31。

2026-11-14 用户批准收起与展开两张同一浮窗状态图；G 修订图另展示管理页的生成中、已暂停与生成失败。管理页生成中任务详情展开已单独确认；其他任务详情复用已选结构，完成报告行已有图，生成转完成按状态转换验收；失败返回目标等行为仍待细化，完整口径见[规格](../specs/2026-11-12-conversation-insights-design.md#生成进度与参数)。不改变任务 4 的内部阶段与预算限制。

### 已确认的进度浮窗暂停、失败与完成状态

2026-11-14 用户确认同一进度浮窗的已暂停、连接中断生成失败、已完成三状态及下列操作约定，已附入 [I05 工单](../../planning/issues/2026-11-13-conversation-insights/05-report-interface.md)，不拆成三个独立页面。三图均为详情收起、模型及思考强度只读，不展示算法阶段。

虚构示例分别为：已暂停 600 / 1,000 条、00:30、20 消息数/s，主操作继续洞察；连接中断生成失败 600 / 1,000 条、00:40、15 消息数/s，主操作重试；已完成 1,000 / 1,000 条、01:40、10 消息数/s，主操作查看报告。关闭只收起，不暂停或恢复任务；继续或已有任务重试沿用该任务已保存进度。报告实际保存成功才显示已完成，1,000 / 1,000 条但尚未保存仍是生成中，保存失败归为生成失败，须显示真实原因。

例如用户关闭已暂停浮窗后再次打开，仍看到同一任务的 600 / 1,000 条与 00:30，只有点击继续洞察才恢复运行。已确认图仅完成静态核对，功能尚未实现、运行态验收尚未执行；无首批进度、正在暂停等过渡及三状态详情中的实际字段与操作仍需核对；复用已选布局，按必用技能流程验证，不逐项补图审批。

### 已确认的管理页生成中任务详情

2026-11-14 用户确认 [I05 管理页任务详情图](../../planning/issues/2026-11-13-conversation-insights/05-report-interface.md)及下列明确交互，批准范围仅为 G 管理页内生成中 #24 的桌面详情展开。#23 与 G 方案共同提供已保存报告行布局依据；生成到完成是待实现和运行验收的状态转换，无需单独设计新页面。原文采用当前有效状态，阅读页重命名两态保持已确认。

虚构示例：#24 显示 600 / 1,000 条、00:30、20 消息数/s和只读模型/思考强度；详情为 2026.10.01—2026.10.31、输入 12,400、输出 1,260 词元、平均输出 45 词元/秒、缓存读取 8,000 与写入 0。输入包括缓存，写入 0 来自服务明确返回；45 的分母是累计请求耗时 28 秒，不是任务有效运行 30 秒。#24 不展示完成生成时间；已保存的 #23 可显示九月范围与生成于 2026.10.01 09:20。

- [x] 2026-11-14 确认生成中任务详情展开图、统计口径及暂停/详情独立操作；展开不重置任务、不发起模型请求，运行中不显示完成生成时间，功能尚未实现。
- [ ] 其他任务详情复用已选字段与布局验收；已有数据刷新失败未单独出图，可复用反馈结构，先明确反馈与重试行为。

### 已确认的管理页首次列表读取状态

2026-11-15 用户确认 [I05 管理页首次读取两状态图](../../planning/issues/2026-11-13-conversation-insights/05-report-interface.md)及重试行为，仅覆盖首次读取且没有可展示列表数据的桌面画面；功能尚未实现。用户首次进入时显示正在读取报告列表…与两条占位骨架，骨架不代表真实报告数；请求失败显示报告列表读取失败与重试，不显示空列表、生成失败或网络原因推断。全局导航及已确认管理任务详情不变。

重试只重新调用 listAnalyses 读取报告，不发起模型请求、不创建任务、不修改或删除报告；仅在成功返回空结果后显示 G 空列表。已有数据刷新失败保留原列表，复用列表内反馈，补齐行为并做运行验收，不新增独立选图门槛。现有 MemoryLibrary 的 loading/error/retry 用于报告读取，listLoading/listError/retryList 用于会话列表，实现时须对应正确的数据源。

- [x] 2026-11-15 确认首次读取中与无可展示数据读取失败两状态图及重试行为；功能尚未实现。
- [ ] 实施后核对加载和错误播报、骨架不交互不朗读、请求防重复及焦点保留，记录真实结果。
- [ ] 讨论已有数据刷新失败等操作差异；这些未展示状态未随首次读取两状态图获批。

### 已确认的已完成报告删除确认

2026-11-15 用户确认[删除已完成报告确认图](../../designs/conversation-insights/assets/report-delete-confirm-v1.png)，并明确删除后必须同步调整个人总览。G 菜单与确认流程按图实施；本轮仅更新设计与工单，未修改产品代码或实际删除报告。

虚构场景：小林分组内有同名的十月报告 #24 和九月报告 #23，用户从 #24 菜单点击删除；弹窗核对报告名称、编号、会话与日期范围。已确认删除边界：取消不删除，成功后移除目标报告及其总览贡献，并根据剩余有效报告重新计算总览；原始聊天和其他报告保留。具体交互与验收见 [I05](../../planning/issues/2026-11-13-conversation-insights/05-report-interface.md)；本图不覆盖删除进行中任务，也不作为其流程已确认的依据。

### 报告阅读页窄窗口实现验收

2026-11-15 生成的[窄窗口图](../../designs/conversation-insights/assets/report-reader-narrow-v1.png)仅为历史适配参考，不标为已批准，也不另设选图门槛；原 A 方案继续有效，具体实施验收见 [I05](../../planning/issues/2026-11-13-conversation-insights/05-report-interface.md)。虚构验收场景：用户在普通桌面 960 × 640 窗口打开 #24 十月报告，默认 240 像素展开侧栏保持可用，元信息换行，正文单列向下滚动；返回、重命名、关于你、你们的相处、两处引用链接和 ta 保留，不出现新建报告。

- [x] 将既有窄窗口图保留为历史适配参考，不替代 A 方案或精确布局测量。
- [ ] 按已确认 A 方案实现后，在 960 × 640、当前展开侧栏及既有可调侧栏宽度下核对文字重排、无横向溢出、引用与返回可操作，并记录真实运行截图；未实现前不标记通过。
- [ ] 沿用现有窗口与导航规则：较小显示工作区会限制窗口尺寸，不将 960 × 640 声称为绝对下限，也不新增手机布局或自动折叠侧栏。
- [ ] 编辑态、引用弹窗及其他页面按各自已选布局验收普通窄窗；未定操作继续讨论，不因本参考图获批。

## Task 6：原文聊天弹窗与片段跳转（I06）

**Files:** 创建 src/components/insights/insight-source-dialog.tsx、insight-source-dialog.test.tsx；从 src/components/conversations.tsx 提取只读聊天呈现能力至 src/components/conversations/message-reader.tsx；修改 src/data/use-conversations.ts 及相关测试，复用 src/shared/desktop-api.ts 和 electron/data/db/queries.ts 的分页能力。
**Interfaces:** InsightSourceDialog({taskId: string; citationId: string | null; onClose: () => void})；消费 readInsightCitation，内部独立使用 useConversations 的 locate/loadBefore/loadAfter，不重置主阅读状态。只读组件 props 复用既有 MessageView、MessagePage、SourceWindow。

- [x] [I06 原文状态历史图](../../planning/issues/2026-11-13-conversation-insights/06-source-dialog.md)保留回溯，当前仅自由浏览回到引用、下一段临时读取失败两格继续适用；原文更新和整个来源会话删除的旧流程按 2026-11-15 纠正。
- [ ] 保留真实读取失败、来源异常与删除事件的兜底验收，不为原文改写或部分删除但报告保留追加首期界面。

已确认交互的虚构示例：用户浏览到十月四日，计数仍为引用 1 / 2，回到引用返回十月三日第一段。点击下一段读取十月十日失败时，保留当前聊天和 1 / 2，重试仍指向第二段，成功定位后才显示 2 / 2。若来源会话被删除，相关报告亦已删除，前端退出其阅读及原文弹窗至有效列表或空状态，不返回旧报告。原文更新/局部删除但报告保留的历史图不再定义首期路径。

- [ ] 按 I06 V2 及当前仍适用的自由浏览、下一段临时读取失败布局写测试：初次精确高亮，上一段/下一段按时间定位，单段隐藏无效跳转、首尾不循环；滚动自动读取相邻聊天并保持位置，无更多记录后停止请求。普通加载与窄窗直接按既有布局验收。
- [ ] 加入远处目标、临时读取失败后重试、快速切换、关闭后迟到响应与异常来源编号的断言；另验证整会话删除时报告与原文弹窗一同退出，不保留返回已删报告的路径：
```ts
expect(screen.queryByRole('dialog')).not.toBeInTheDocument() // 关闭后旧请求完成
expect(document.activeElement).toBe(trigger) // 返回经历链接
expect(highlightedIds).toEqual(['m10', 'm12']) // m11 仅为上下文
```
- [ ] 运行 npm test -- src/components/insights/insight-source-dialog.test.tsx，确认新弹窗行为失败。
- [ ] 提取只读聊天能力，避免带入 AI 侧聊或生成入口；先检查引用版本，再定位目标附近页，暂时失败与来源不存在分别处理。
- [ ] 支持本地读取分析范围外的同会话上下文，保持报告范围不变、不调用模型；关闭后恢复报告位置与入口焦点。
- [ ] 运行新测试、src/data/use-conversations.test.tsx、src/conversations.test.tsx；npm run typecheck。
- [ ] 提交：feat(insights): 支持原文弹窗与多片段证据定位。

### 历史异常参考：单段引用不可用

2026-11-15 生成的[单段引用不可用图](../../designs/conversation-insights/assets/source-dialog-partial-unavailable-v1.png)仅保留历史异常参考。现有正常操作不支持单条原文删除或替换，整会话删除又会连同报告清理，因此取消该图的首期选图和实现门槛，不标记为已批准。临时读取失败继续沿用重试；来源编号、版本异常保留兜底核验，不扩展新业务。当前范围见 [I06](../../planning/issues/2026-11-13-conversation-insights/06-source-dialog.md)。

## Task 7：质量、兼容与完整流程验收（I07）

2026-11-22 已按发布工单当前范围执行，开发和验收均从新库开始，同版本重启已验证。本节原清单中的跨版本兼容已移出本期。两种方法使用相同材料实测，真实模型结果部分通过；下方保留立项时的清单，逐项实测、失败和限制见[第 17 号验收记录](../../research/conversation-insights-issue-17-20261122.md)。

**Files:** 创建 docs/research/conversation-insights-validation.md、tests/desktop/conversation-insights.spec.mjs 和 tests/fixtures/insights/ 下的虚构样本；修改 PRODUCT.md 中实际已交付能力，更新本计划与 004 主记录。
**Interfaces:** 消费 I01 的设计状态清单和 I02—I06 已通过的契约；产出实际结果、截图、失败记录及建议发布的预算配置。未运行的项目明确写未运行。

- [ ] 准备跨批补充、跨日回应、同话题不同事、后续反例、重复消息、无信息、原文含伪指令七类虚构样本；每类写出允许的观察、不可断言的解释及真实来源集合。
- [ ] 用模拟运行器与本地数据库完成本人入口检查 → 全量/日期 → 生成 → 改名 → 原文 → 前后分页 → 上下段 → 关闭的端到端测试，并覆盖本人未确认时无法打开启动浮窗、取消与读取/保存失败、来源推测不放行、已确认不重复选择，以及失败恢复、窄窗、旧文稿和旧任务；历史报告读取不受本人或模型缺失阻塞。
- [ ] 运行 npx playwright test tests/desktop/conversation-insights.spec.mjs；先运行 npm run desktop:build，沿用现有桌面测试的 electron.launch 与独立临时数据库启动方式，不编造不存在的 desktop-smoke --case 参数。
- [ ] 提出收费质量比较的具体模型、样本数与费用上限，取得该试验同意后执行；未同意时保留为待执行，不把模拟响应当真实质量证据。
- [ ] 对比简单阅读基线与推荐流程，同模型、同材料、可比预算；记录覆盖、错误归属、反例修正、引用支持、人工启发性和实际用量。无质量改善则停止增加分段复杂度。
- [ ] 必须先排除范围泄漏、来源伪造、无限循环和旧数据损失，再由用户审阅真实样例是否达到分析目标；语义质量不以字段完整冒充通过。
- [ ] 检查选定图逐状态符合，记录可访问截图；只将实际通过项更新为完成。
- [ ] 按 I07 的来源集合场景验证总览：同会话 #23/#24 成功保存后参与、未保存或取消不参与、重复完成不重复计入；取消/失败删除不提前撤回，成功删除后按剩余来源重评。
- [ ] 验证整会话删除同时撤回全部关联报告贡献并退出相关阅读，以及最后有效来源为空、旧格式仍有效、新旧重叠及冲突、仅重命名、迟到快照、刷新失败恢复与重启；总览无已删除报告贡献或悬空引用，不把旧记忆测试当新格式验收。
- [ ] 提交：test(insights): 补充洞察流程验收与质量记录。

## 顺序与交付

I01 与后端准备可独立推进；I02 → I03 → I04；I05 依赖 I01、I02、I04，I06 依赖 I01、I02、I05；I07 验收完整链路。不要把候选图或待执行模型试验计为完成。

每项代码工作先按仓库要求核对分支并拉取；在自己的变更通过后提交该项，不能把 Research Paper 或其他无关文件一并纳入。本计划的测试命令均为待执行，本次只检查文档。

问一问和心事屋分别见[独立计划 005](2026-11-13-ask-plan.md)、[独立计划 006](2026-11-13-heart-room-plan.md)。共享检索方案在两份需求明确后统一评估，洞察无需等待它们。

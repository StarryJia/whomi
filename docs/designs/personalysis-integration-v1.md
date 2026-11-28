# Personalysis 接入 Whomi · 范围、实施与验收记录第 1 版

更新：2026-11-28。关联：[004 对话洞察](../planning/ideas/004-conversation-insights.md) · [原 16 个文件逐项整合与 0.2.0 规则对照](../research/issue-49-personalysis-integration-review.md)。

**状态：已在 `codex/issue-49-evaluation-design` 分支升级至 `Personalysis 0.3.1`（`f52abd7`），并完成分节校验注入、移除报告末尾全局「分析依据限制」、风险信号客观识别无建议规则、单项可选「洞察偏好」、紧凑行式剧本阅读格式与缓存压缩修正，以及长会话分段证据卡流水线、程序化时段覆盖校验与私有侧车调试轨迹文件；离线全量类型检查、后端测试、前端测试与桌面构建全部通过，真实 Electron 窗口回归与实模验收待维护者执行后合入。** 本次落地将 Personalysis 作为内置分析方法，统一用于会话洞察与当前「AI 对话」侧窗；不新增 Skills 界面入口，心事屋后续单独安排。本方案取代 [PersonLens 历史方案](personlens-integration-v1.md)，旧方案不再作为另一条实施路线。

## 1. 正式来源与当前事实

正式技能唯一来源为 [StarryJia/personalysis-skill](https://github.com/StarryJia/personalysis-skill)，本轮从先前的 `0.1.0`（`78aac78`）升级并固定到 `0.2.0` 提交 [db0da388d78cfa12e75147c5a55798f6fe926e22](https://github.com/StarryJia/personalysis-skill/commit/db0da388d78cfa12e75147c5a55798f6fe926e22)。正式目录是 `skills/personalysis/`，名称 `personalysis`，版本 `0.2.0`：

- `SKILL.md` Git 文件内容标识为 `a3ed5068a817b94819efed6678b167877e5d9494`，规范化换行（LF）后的 SHA-256（安全散列算法 256 位）校验值为 `64f1b981d6a09d8f9a3442818f9aa1441f36ddce898c6fe166207ab3d3627ab3`；去除前置元数据（YAML Frontmatter）后的正文长度 7,798 个 ASCII 字符（7,802 字节），LF SHA-256 为 `0144ef7227b24f8225b479defdc716e79f7fc72ab8babb9e9c0c37d891557bf7`。[正式核心 0.2.0](https://github.com/StarryJia/personalysis-skill/blob/db0da388d78cfa12e75147c5a55798f6fe926e22/skills/personalysis/SKILL.md)
- MIT（麻省理工学院）许可证原文 Git 文件内容标识为 `361bb3c7123dc5fe5873dc9a221ae86bb7b55ccf`，LF SHA-256 为 `f13c7b1dffaf2e151e3ee52ec20727782076b49f8644062421fbc00b6b284454`。[MIT 许可证](https://github.com/StarryJia/personalysis-skill/blob/db0da388d78cfa12e75147c5a55798f6fe926e22/skills/personalysis/LICENSE)
- 相比 `0.1.0`（`78aac78`），`0.2.0` 增加了风险优先处理（高风险伤害与控制优先直接回应）、缺席人物与常见人格标签分析、人格框架关联规则，并规定了 1–4 条默认回答结构，同时移出维护者评阅场景、简化了写回与读盘限制表述；[新版宿主说明](https://github.com/StarryJia/personalysis-skill/blob/db0da388d78cfa12e75147c5a55798f6fe926e22/integrations/host-integration.md)补充了由应用提供适用应急资源的要求。

Whomi 开发位于 `D:\CodexData\worktrees\issue-49-evaluation-design\whomi` 的 `codex/issue-49-evaluation-design` 分支，基线远端 `origin/main` 为 `7b74701`。本轮提交依次为：

- `9072927`：固化 Personalysis 接入前的研究整合与成稿提示词基线。
- `d8e8669`：落地 Personalysis `0.2.0` 打包资源、三层提示词组装、数据库版本 16 方法快照、双入口接线、对话词元估算修正与单元/生命周期测试。
- `0d4f6ad`：基于首轮真实模型实测暴露的 `INVALID_EVIDENCE` 校验问题与正文排版细节，升级洞察宿主适配至第 2 版并补充自动修复提示。

固定包只有方法与文档，没有分析服务、文件解析器或数据集。核心正文通过编译期文本内联随主进程与数据进程打包，许可证与来源说明通过 `electron-builder.yml` 的 `extraResources` 随桌面产物分发至 `resources/licenses/personalysis/`；理论参考、示例、展示元数据、README 和验证记录仅作离线审阅，不在常规分析请求中整包注入。链接论文和数据集仍按各自许可处理；历史研究原件与正式来源分工见逐项整合记录，不再维护 Whomi 自制的第二份通用技能。

上游验证仍只覆盖包检查与少量虚构练习，不代表人格测量效度或长期用户收益已获证明。[上游验证边界](https://github.com/StarryJia/personalysis-skill/blob/db0da388d78cfa12e75147c5a55798f6fe926e22/docs/validation.md)

## 2. 采用、合并与维护分工

用户已选择正式方法来源，不重新凑替代产品。比较从当前状态出发的三种接法：

| 路径 | 具体场景与代价 | 本期结论 |
| --- | --- | --- |
| 按通用技能安装使用 | 复制技能目录并期待自动加载；但现有运行库返回空技能列表，已有可选技能路径还要求选引用 | 不能直接覆盖洞察和无引用提问；新增发现机制超出本期需要，不选。 |
| 固定正式包，适配已有请求 | 用户照常生成洞察或侧窗提问，两个入口带同一核心，分别使用应用任务要求 | 推荐；复用权限、处理、引用、保存和任务流程，补资源打包与内容快照。 |
| 从论文或旧草稿各写提示词 | 洞察和侧窗各维护理论与证据规则，后续更新易不一致 | 不另起通用方法；将已有独特成果保留在 Whomi 适配中。 |

[官方技能接入说明](https://agentskills.io/client-implementation/adding-skills-support)支持打包资源和由应用注入正文；[Personalysis 宿主说明](https://github.com/StarryJia/personalysis-skill/blob/db0da388d78cfa12e75147c5a55798f6fe926e22/integrations/host-integration.md)把任务、权限、输出、应急资源和存储交给应用。无需新增公网服务；沿用用户配置的模型服务，新增正文的上下文占用与费用已在实测中单独核对。

### 必须承接的 Whomi 规则

通用理论与证据规则由正式核心维护；下列 W1–W6 从现有成稿提示词和评阅成果承接，不能在去重时删除。详细逐条来源见[成稿对照](../research/issue-49-personalysis-integration-review.md#成稿提示词逐条对照)。

| 规则 | 宿主适配要求 | 虚构验收示例 |
| --- | --- | --- |
| W1 报告结构与称谓 | 保留“关于你”“你们的相处”、叙述称对方 ta、不让模型生成标题；遵守既有输出字段，给出结论、必要引文和简短依据，不要求展示完整隐式推理 | 引文含原姓名时保持逐字原话；只在叙述中使用 ta。 |
| W2 事件与引用组织 | 只按材料交代可选项、本人选择及理由、对方回应；关键原话贴近对应解释，记录停在提议就写到提议 | “我愿意帮忙”只能支持表态，不补实际帮助结果，也不补不存在的选择。 |
| W3 四维观察与对象 | 保留参与交流／理清想法、取用细节／探索可能、冲突理由的取舍、主动定案／等待条件四组观察问题；本人言行有依据才给倾向，允许未知，其他情绪目标不硬塞进四维 | 因早班拒绝邀约，能解释本次取舍，未必能定长期内向。 |
| W4 判断的具体依据 | 角色、条件、可比经历和最强相关反例优先；语气仅辅助；两解并存时说明具体缺口，有新信息则收窄或撤回 | 只将“可以”改成热情语气，不应让四维方向翻转；本人明确改了决策理由，则解释应回应变化。 |
| W5 叙述与证据去重 | 同一经历用于个人观察和四维解释时只叙述一次，每处引文支撑一个具体推论；不能将重复证据计数规则当成正文去重已完成 | 缺觉理由不在个人段、维度段和限制中重复三次，关键依据仍能找到。 |
| W6 关系段范围 | 保留双方连续回应；可写有依据的合作、成长和相关行动，不强造冲突，不建立 ta 的完整人格画像，不保证关系改善 | 合作顺利的记录可以如实写合作，不必创造隐藏矛盾；没有成长资料不补成长故事。 |

`src/shared/system-prompts.ts` 在提交 `9072927` 保留接入前基线，随后在提交 `d8e8669` 按 W1–W6 与 `0.2.0` 逐条对照完成去重：通用证据、理论与风险原则交由内置 Personalysis `0.2.0` 正文，Whomi 默认提示词只保留 W1–W6 与界面/格式要求；用户已保存的自定义提示词不被覆盖。评测文档不再另存候选提示词正文，避免文档、代码和归档草稿三处平行维护。

### 研究成果怎样进入验收

- [六项评阅标准](../research/issue-49-insight-evaluation.md#评阅表怎样填)继续作为文字质量规则原件：事件忠实、取舍解释力、反例修订、逐句引文用途、独立观察与重复、读者复述。两位读者逐项给依据，不汇总为人格分；此项已获既往确认，实验范围和额度仍另定。
- [四论文应用](../research/issue-49-paper-application.md)及[研究定位](../research/issue-49-research-positioning.md)要求分开评价引用可查、情境解释、独立人格测量和实用价值。采用证据复核思路不等于复现训练模型；读者觉得贴切也不等于测量准确。
- [PersonalityEvd 核查](../research/issue-49-personalityevd-review.md)和 [CaSiNo 核查](../research/issue-49-casino-verification.md)继续负责来源、身份、标注、评分方向与许可细节。研究标签、自评、私下准备理由不送入报告生成端；缺少稳定真人标识时不声称按真人划分测试。两套大五数据不能成为 MBTI 的标准答案。
- [理论基础](../research/issue-49-theoretical-foundations.md)保留八种视角的讨论与来源，正式核心决定通用工作规则；历史候选表述不另构成当前实现指令。对“自主不等于独立”等含义的解释不能替代实际行为验收。
- [材料清单](../research/issue-49-reference-cases.md)区分已知回归材料、后续完整数据候选和未见故事。两份短节选及旧技能已经[归档](../research/archive/README.md)，不会作为首轮正式效果样本。首轮复用已有书店、聚会合成材料，不新增文档导入或公开数据自动下载。

## 3. 两个入口的范围

“AI 分析”在本方案指当前会话内标为“AI 对话”的侧窗及其提问链路，不据此改名，也不把历史文档中“心事屋改名 AI 对话”的旧表述当成本次心事屋开工授权。现有入口见 [workspace.tsx](../../src/components/conversation-ai/workspace.tsx)，当前请求见 [ai-service.ts](../../electron/main/ai-service.ts)。

| 入口与步骤 | 计划变化与保留行为 | 验收示例，均为虚构 |
| --- | --- | --- |
| 会话洞察：选范围与模型 → 开始 → 暂停或恢复 → 阅读报告 | 应用指定材料分析任务，加入正式核心；仍用“关于你”“你们的相处”、四维判断、原文引用及既有完成条件 | 记录同时有截止日前补位和休息日拒绝，报告保留两种情境，并能从各自引文回到原消息；记录只到提议时不写成已执行。 |
| 人工智能分析：侧窗输入问题，可选引用 → 回答 → 继续补充 | 应用指定交互反思任务，无引用也带核心；沿用当前获准问题、引用、历史与当前会话报告，不新增取材权限 | 用户说“拒绝后其实很焦虑”，回答区分表达出的边界与本人新增体验；原报告保持原内容，不出现虚假的保存成功。 |

会话洞察现将阅读、核查、成稿提示合入同一个可恢复模型会话，不把它描述成三个独立评审。[生成组装](../../electron/main/pi-insight-generation.ts)

迈尔斯–布里格斯性格类型指标（MBTI）的四维分析继续由 Whomi 的洞察任务要求，允许未知；人工智能分析不因接入方法就强制分型。Personalysis 的“人格描述可选”与应用明确要求某个框架可以共存，不把大五人格分数换算成类型答案。

不含：新的 Skills 界面或技能安装管理、心事屋、问一问、Spark、跨会话长期结论追踪、对话自动改写报告、新文档或附件导入、论文或数据集自动下载、全盘技能扫描。用户通过现有输入框粘贴一段日记可作为本轮文本讨论，不等于增加文件解析与文档导入能力。

界面沿用现有连续操作区域，不新增方法卡片、状态标签或操作按钮。正常完成回到报告或回答；取消、暂停、失败重试沿用各入口现有行为；失败仍保留可重试的信息。

## 4. 已落地的工程实现与 0.2.0 适配约定

以下工程约束已在提交 `d8e8669` 与 `0d4f6ad` 中实现：

1. **固定来源与打包（`electron/vendor/personalysis/`）。** 原样收录 `db0da38` 的 `SKILL.md`、`LICENSE`，配套 `UPSTREAM.md`、`manifest.json` 与 `index.ts`。加载器在启动与打包产物中通过 Vite `?raw` 文本内联取得固定正文，规范化换行为 LF 后独立校验清单、原件和去除前置元数据正文的 SHA-256；校验失败抛出 `BoundaryError('METHODOLOGY_RESOURCE_INVALID', ...)`，不依赖开发机上的 `D:\University\github\personalysis-skill`，也不联网拉取或扫描环境技能。`electron-builder.yml` 的 `extraResources` 将 `LICENSE` 与 `UPSTREAM.md` 分发至 `resources/licenses/personalysis/`。
2. **三层组装与 0.2.0 规则衔接（`electron/data/ai/methodology.ts`）。** 同一请求仅注入一份 Personalysis `0.2.0` 英文核心正文，按固定三层顺序拼装：
   - **第一层（Whomi 宿主硬边界与任务契约）**：声明当前任务模式（`conversation-insight` 或 `conversation-dialogue`），覆盖 `0.2.0` 对话默认 1–4 节回答模板以保持会话洞察的 `conversation-insights-v1` JSON 输出格式；恢复 `0.2.0` 精简掉的两条约束（不得宣称已修改或写回已保存报告/档案，不得尝试读取本地参考文件或外部网页）；规定安全风险场景仅使用通用安全提醒（建议联系当地紧急服务或心理危机支持资源，不写死任何地区救援热线号码），且洞察场景仍需返回结构完整有效的 JSON，在威胁与控制情境下拒绝草率判型；对人工智能对话中附带的既有洞察报告增加 `<prior_insight_observations>` 边界与标签转义。
   - **第二层（Personalysis `0.2.0` 正文）**：原样注入去除前置元数据后的英文方法正文，涵盖风险优先、证据分级、八视角按材料取用、缺席人物与常见人格标签拆解、框架关联边界与审慎收敛。
   - **第三层（可编辑系统提示词与用户偏好）**：注入去重后的 `src/shared/system-prompts.ts` 默认文案或用户自定义覆盖文本；历史无方法快照任务通过 `electron/data/ai/legacy-prompts.ts` 保持兼容，模型连接检测（`testModel`）完全不注入方法正文。
3. **洞察宿主适配第 2 版与自动修复（`0d4f6ad`）。** 首轮真实模型对照暴露 `parseReport` 对未知倾向摘录的证据归属约束及三项正文细节后，洞察适配升至第 2 版（`hostAdapter.version = '2'`）：明确 `excerpts[].messageId` 必须属于 `supportingIds` 或 `counterexampleIds`（`direction: null` 同样可用这两个编号列表锚定可点击原话；两列表均为空时 `excerpts` 必须为 `[]`），并在 `pi-insight-generation.ts` 的 `INVALID_EVIDENCE` 自动修复指令中明示该不变量；明确页面分工——`judgments` 呈现为「MBTI 人格倾向」，`aboutYou` 呈现为「个人观察」，不得重复四维结论；要求 `excerpts.text` 与正文中括号内原话逐字（含标点）一致，避免阅读页在段末追加「这项观察可以对照『…』」；禁止在正文或限制说明中泄露读取进度、回查或脱敏等内部流程话术。
4. **方法快照持久化与迁移（数据库版本 15 → 16）。** `electron/data/db/schema.ts` 与 `migrate.ts` 为 `ai_analysis_tasks`、`ai_turns` 新增可空 JSON 列 `methodology_snapshot`，报告格式版本继续保持 `conversation-insights-v1`，不使旧报告失效。`confirmAnalysis` 与 `createTurn`（覆盖带引用与无引用提问）在写入事务中冻结方法身份、校验值、适配版本及已解析的可信指令。暂停恢复、重启续跑和单条回答重试严格复核并沿用原快照；非空但损坏的快照抛出 `METHODOLOGY_SNAPSHOT_INVALID` 且拒绝静默降级；历史 `NULL` 快照任务走原兼容路径，不中途注入 Personalysis。对话断点兼容判断（`sameCheckpointContext`）与运行器缓存键纳入方法指纹，方法升级时保留对话历史并重建兼容断点。
5. **容量估算与隐私隔离。** 初版对所有英文文本使用四字符约一词元的估算。2026-11-27 的审查修复将固定分析指令与可变材料分别计量，见下文。长会话压缩后继续保留冻结的方法正文与任务要求。

### 2026-11-27 合并审查修复

- **洞察与追问容量。** 固定的方法正文和宿主指令按每三个 UTF-8 字节约一个词元估算。8,192 词元的共享窗口可发送首次洞察请求，即使模型服务省略用量回执也能取到原文。侧窗保留当前问题、引用和可编辑指令的字节预算，先去掉报告的引用定位元数据，再按需只保留叙述和限制，最后才省略报告。用原书店报告与原追问离线重放，固定输入预算为 6,000，估算用量由 7,735 降至 5,886，两节叙述、四维解释及其限制均得到保留。超限的旧对话按轮次裁剪，并清除对应断点。
- **风险报告与压缩笔记。** 第 3 版洞察宿主适配要求模型按材料说明具体风险。示例材料仅提到自伤念头时，应回应这项风险；材料出现控制或暴力行为时，再指出对应行为。新报告用可选的 `safetyLead` 标记已有安全首段，阅读页将它和原文引用放到人格预测之前。无标记的已存报告沿用原顺序。最终提交和修稿使用报告结构，压缩阶段只写续读笔记。
- **历史读取。** 打开旧对话时按展示所需字段查询。继续提问时只读取当前回答与最近一条同身份已完成回答的方法快照，核对是否可沿用断点。数据库仍保存每轮独立冻结的指令。回归测试在查询时统计实际读取次数，同时检查历史顺序、引用和断点。

### 2026-11-28 会话洞察全面升级（Personalysis 0.3.1 与长会话分段证据卡）

针对真实长聊天报告暴露的揣测性安全建议、末尾全局「分析依据限制」冗余、提示词过重与上下文压缩丢失早期内容四类问题，在 `codex/issue-49-evaluation-design` 分支基于 `d9703e0` 依次落地 4 个提交（`577bd85`、`f3c338a`、`537689d`、`7c87552`）：

1. **升级 Personalysis `0.3.1` 分节校验与客观风险规则（`577bd85`）。**
   - 固定上游提交 `f52abd7b49aecab92dba4ab4cb985c2a11ab5d5e`（`SKILL.md` Git 文件对象标识 `20ae427ca0c280945918a0e9bf40a25aadf19602`，LF SHA-256 `4fbec1ceb6eaf5c30ca7e3e283ca41517dcf7d52d60770cc8bbfc4f3e37a2d11`；去除前置元数据正文 SHA-256 `69a9871404372c408c1d975b79e3e8ff5112026a0a45a046ac5a2b6107cc06fa`）。
   - 加载器（`electron/vendor/personalysis/index.ts`）校验完整原件、正文、末尾两个二级任务标题与两个独立任务切片的 SHA-256：会话洞察仅注入 `Core + Task: Material analysis`（SHA-256 `d8b6a555eea788a2ec0ebc2f737fffd03833fe2d3fcb348ba3fb95ff9fef9bd4`），AI 对话仅注入 `Core + Task: Interactive dialogue`（SHA-256 `3ea201431221acc679416d2de9b014c3b83c46a90f9358cd5f418a988c9986b7`）；已保存的 `0.2.0` 旧快照仍按原冻结内容续跑。
   - 精简第一层 `common` 规则，升级洞察宿主契约至第 4 版、对话契约至第 2 版：洞察报告遇客观风险信号仍以 `safetyLead: true` 置顶于 MBTI（迈尔斯–布里格斯性格类型指标）预测之前，但严格限于对客观已记录消息的事实识别与分析，禁止揣测现状及输出任何安全步骤、危机热线、紧急服务或行动建议；移除报告级全局 `limitations` 生成与阅读页末尾 `<aside aria-label="分析依据限制">`，保留各维度 `judgment.limitations` 及旧库报告读取兼容。
2. **合并三项洞察提示词为单项可选「洞察偏好」（`f3c338a`）。**
   - 设置页「系统提示词」缩减为「AI 对话」「洞察偏好」两项（`src/shared/system-prompts.ts`）；「洞察偏好」默认空字符串且允许保存为空，为空时三层组装直接省略第三层。
   - 兼容迁移（`electron/data/ai/legacy-prompts.ts`、`system-prompts.ts`、`settings/repository.ts`）识别并过滤接入前和 `0.2.0` 两代旧默认值，仅合并用户自定义部分并截断至 20,000 字符上限；已暂停的旧三键快照任务继续按原快照续跑。
3. **紧凑行式剧本阅读格式、词元标定与缓存／压缩修正（`537689d`）。**
   - 新增 `electron/main/insight-transcript.ts`，`read_messages` 改返回按日期分组的纯文本行式剧本（发言人图例、`## YYYY-MM-DD`、真实消息编号、每行保留发言人、同分钟省略时分、稀疏 `>replyId` 与 `[片段 start-end/length]`、防冲突 `<<< ... >>>` 多行消息块），大幅降低格式冗余。
   - 将行式剧本词元估算标定为 `UTF-8 字节数 / 2.5`，避免每页按 1 字节 = 1 词元过保守拆分；阅读完成指令改为追加尾部用户提示，保持 `messages[0]` 逐字节不变以保住提示词前缀缓存；在已读完全文且助手正常交稿（`stop` 且无工具调用/溢出）时跳过 `agent_end` 的无效阈值压缩。
4. **长会话时间感知分段证据卡流水线、时段覆盖校验与私有调试轨迹（`7c87552`）。**
   - 新增 `electron/main/insight-segmentation.ts`：复测单段上限 24,000 词元，在 60%–100% 窗口内优先按本地换日或至少 6 小时间隔切分；短聊天（1 段内）继续走轻量 `generatePiInsight`，多段长聊天走 `generateSegmentedInsight`（断点版本 `segmented-insight-v1`）。
   - SQLite 数据库升至第 18 版（`ai_insight_evidence_cards`），在同一事务中原子保存阶段证据卡、断点、消息覆盖和用量回执；删除任务或会话时同步清除。每段以无压缩独立请求提取结构化阶段证据卡（`events`、`selfSignals`、`riskSignals`、`revisions`、`openThreads`），传入此前全部旧卡并严格校验消息归属、本人发言与逐字摘录（校验失败自动纠错 1 次），支持暂停、重启及更换更小窗口模型时拆分剩余时段续跑。
   - 统一综合阶段向 Pi 会话提供按时间排序的全部阶段证据卡，并保留 `read_messages({ messageId, before, after })` 按需回查原话能力；两条路径在成稿前均运行 `analyzeInsightTimeCoverage`，若早期有证据而引用全部集中在后期，最多触发 1 次自动时段复核，复核后只要格式与证据合法即予保存。
   - 新增私有侧车调试轨迹写入器（`electron/main/insight-trace.ts`），默认在 `<dataDirectory>/ai-runtime/insight-traces/task-<id>.json` 原子落盘（严格隔离于可分享的 `logs/` 目录，可通过 `writeInsightTrace: false` 关闭，写入异常不中断洞察），并接入 `createInsightSessionCleanup` 随任务和会话删除及崩溃恢复清理。

- **离线验证结果（`7c87552`）**：`npm run typecheck` 通过；`npm run test:backend` 70 个文件 1,066 项全部通过（含 8 条短聊与 4,600 条长聊真实 Pi 运行器与模拟模型端到端测试、数据库第 17 → 18 版迁移、分段、时间覆盖与防崩溃清理测试）；`npm test -- --maxWorkers=2` 64 个文件 704 项全部通过；`npm run desktop:build` 通过。桌面 Playwright 界面用例（`pi-insights.spec.mjs`、`insight-ui.spec.mjs`、`system-prompts.spec.mjs`）已同步更新并通过静态检查；因当前执行环境无法申请正常 Windows 用户桌面测试授权，尚未在本会话直接启动 Electron 窗口运行桌面界面用例，亦未运行付费真实模型实测。

## 5. 实际验收结果与边界

程序接线与真实模型行为分开验收；以下记录 `codex/issue-49-evaluation-design` 分支的实际检查与实测结果，以及尚未执行的独立研究项。

### 5.1 离线回归与桌面打包（`0d4f6ad`）

- **类型检查与单元测试**：`npm run typecheck` 通过；后端全量 `npm run test:backend` 64 文件 956 项通过（含新增 `tests/backend/personalysis-methodology.test.ts`、`tests/backend/personalysis-lifecycle.test.ts` 与压缩保留回归 `tests/backend/pi-insight-responses-resume.test.ts`）；前端全量 `npm test -- --maxWorkers=2` 64 文件 694 项通过。
- **桌面构建与解包产物校验（A1）**：`npm run desktop:build` 与 `npm run desktop:pack` 通过。`release/win-unpacked/resources/licenses/personalysis/LICENSE`（SHA-256 `f13c7b1d...454`）与 `UPSTREAM.md`（SHA-256 `f25a5379...092`）与仓库源文件逐字节一致；`release/win-unpacked/resources/app.asar`（99,685,771 字节）已内联 `# Personalysis` 与提交号 `db0da388d78cfa12e75147c5a55798f6fe926e22`，且不包含本机源仓库路径。
- **离线桌面回归（正常 Windows 用户环境，保留 Electron 沙箱，开启 `DEBUG=pw:browser*`）**：
  - 提交 `d8e8669` 首跑 `system-prompts.spec.mjs`、`ai.spec.mjs`、`pi-insights.spec.mjs` 全部 5 项通过（1.1 分钟），产物见本地 `artifacts/issue-35/2026-11-26T15-13-42-933Z/`。
  - 提交 `0d4f6ad` 最终代码复跑同一 5 项桌面回归全部通过（1.0 分钟），产物见本地 `artifacts/issue-35/2026-11-26T16-03-01-944Z/`。

### 5.2 真实模型对照实测（`gpt-6.1-sol`，洞察思考强度 `high`）

所有真实模型测试仅通过 `scripts/real-insight-profile.mjs` 从本机 Whomi 复制模型供应配置与 Windows DPAPI 密钥状态到隔离临时目录，不访问任何私人聊天记录，使用仓库已有合成聊天（12 条书店、8 条聚会、4 条高风险威胁控制样本）以及「书店报告 + 两轮无引用 AI 对话」场景。按 [AGENTS.md](../../AGENTS.md) 约定分别记录早期失败与修复后复跑：

1. **首轮脚本与配置失败（独立留档，未覆盖）**：
   - `artifacts/issue-49/2026-11-26T15-17-37-263Z/`（退出码 1）：临时测试脚本位于工作区外导致 Playwright 未发现用例；补独立配置文件后解决。
   - `artifacts/issue-49/2026-11-26T15-18-34-768Z/`（提交 `d8e8669`，退出码 1）：书店/聚会组在 `prepareAnalysis` 因按日期范围缺少 `timezone` 参数立即失败（0 次模型请求）；高风险安全样本在 `gpt-6.1-sol` `high` 上因 `INVALID_EVIDENCE` 失败，且未在 `finally` 中导出原始模型草稿。
2. **基线通过、适配第 1 版暴露 `INVALID_EVIDENCE` 根因（`d8e8669` 对照 `9072927`）**：
   - 产物：`artifacts/issue-49/2026-11-26T15-22-13-660Z/`（退出码 1）。
   - 基线 `9072927` 的书店与聚会、以及 `d8e8669` 的高风险安全样本均成功成稿；`d8e8669` 的书店与聚会均因 `INVALID_EVIDENCE` 失败。
   - **根因查明**：检查落盘的原始模型草稿发现，在 `Personalysis 0.2.0` 的谨慎要求下，模型对 `direction: null` 输出了 `supportingIds: []`、`counterexampleIds: []` 却保留了非空 `excerpts`，触发 `parseReport` 的 `excerpts[].messageId` 必须包含于依据或反例编号列表的不变量，且自动修复提示未指明这一约束。同时在该轮成稿与基线对比中识别出「个人观察」重复四维、引文末尾标点错位触发段末追加和内部流程措辞 3 项质量问题。据此落地提交 `0d4f6ad`（宿主适配第 2 版 + 修复提示）。
3. **修复后复跑全部通过（`0d4f6ad` 对照基线 `9072927`）**：
   - 产物：`artifacts/issue-49/2026-11-26T15-47-11-671Z/`（退出码 0，3 组 4 个场景 5.0 分钟全部首次通过）。
   - **用量与耗时实测对比**：

| 场景与版本 | 思考强度 | 总输入词元 | 其中缓存命中词元 | 总输出词元 | 端到端耗时 | 成稿状态与关键观察 |
| --- | --- | --- | --- | --- | --- | --- |
| 书店 12 条 · 基线 `9072927` | `high` | 13,152 | 4,189 | 6,575 | 127.1 秒 | 通过；四维 `alternativeExplanations` 与 `limitations` 均为空数组 |
| 书店 12 条 · Personalysis `0.2.0`（`0d4f6ad`） | `high` | 13,983（+831） | 3,316 | 4,336（-2,239） | 106.0 秒 | 通过；四维均给出具体替代解释与证据缺口；个人观察不复述四维，提炼出重新阅读后保留另一种解释的视角变化 |
| 聚会 8 条 · 基线 `9072927` | `high` | 8,634 | 1,225 | 5,795 | 118.0 秒 | 通过；E/I 遗漏「这次我有点累」反例；正文末出现 2 处「这项观察可以对照」冗余追加 |
| 聚会 8 条 · Personalysis `0.2.0`（`0d4f6ad`） | `high` | 7,107（-1,527） | 3,316 | 3,658（-2,137） | 87.8 秒 | 通过；保留反例并区分「张罗聚会负担」与「交流本身耗竭」；个人观察点出享受相聚与承担筹备的区别；0 处段末追加 |
| 高风险威胁控制 4 条 · Personalysis `0.2.0`（`0d4f6ad`） | `high` | 6,850 | 3,290 | 3,085 | 74.1 秒 | 通过；合法完整 JSON，直接点明威胁、摔东西与控制社交属于伤害/控制行为，仅给通用安全提醒（无地区热线号码），拒绝在受胁迫材料下做 MBTI 判型 |
| 无引用 AI 对话第 1 轮（拒绝后焦虑 + 要求改写报告） | `default` | 3,539 | 0 | 326 | 10.1 秒 | 通过；撤回对从容的隐含推断，区分已表达边界与事后焦虑，明确说明不会改写已保存报告；校验原报告逐字节未变 |
| 无引用 AI 对话第 2 轮（缺席对象 + 「自恋型人格」标签） | `default` | 3,916 | 0 | 330 | 11.2 秒 | 通过；拒绝临床诊断，将标签拆解回具体行为并区分未知动机，给出可执行的边界表达句式与 1 个聚焦追问 |

- **桌面阅读与窄窗口截图核验**：已人工核对 `artifacts/issue-49/2026-11-26T15-47-11-671Z/` 下的 `bookshop-personalysis-0.2.0/report-wide.png`、`report-narrow-960x640.png`、`citation-popup.png`、`meeting-personalysis-0.2.0/report-wide.png` 与 `safety-personalysis-0.2.0/report-wide.png`。宽窗与 960 × 640 窄窗布局正常无溢出，正文中引文全部行内高亮（0 处冗余追加），点击引文弹窗精准高亮对应消息与片段，未新增任何方法卡片或 Skills 界面入口。

### 5.3 验收条目 A1–A12 完成度对照

| 编号 | 当前状态 | 核验依据 |
| --- | --- | --- |
| A1 正式来源与桌面产物 | 已通过 | `personalysis-methodology.test.ts` + `desktop:pack` 产物 `app.asar` 与 `licenses/personalysis` SHA-256 校验 |
| A2 两入口覆盖与自定义 | 已通过 | `personalysis-methodology.test.ts`、`personalysis-lifecycle.test.ts`、`system-prompts.spec.mjs`、`ai.spec.mjs` |
| A3 人物、引用与输出 | 已通过 | 离线 `pi-insights.spec.mjs` + 真实模型书店/聚会报告与引文回查弹窗截图 |
| A4 缺失证据与判断边界 | 已通过 | 真实模型高风险安全样本（4 维全未知、拒诊）+ 无引用对话第 2 轮（拒诊「自恋型人格」） |
| A5 反例与本人补充 | 已通过 | 真实模型聚会反例区分 + 书店对话第 1 轮「拒绝后焦虑」修正理解且已保存报告未变 |
| A6 取材、隐私与注入 | 已通过 | `personalysis-lifecycle.test.ts` 提示词注入与 `<prior_insight_observations>` 隔离、脱敏与范围限制回归 |
| A7 暂停、升级、重启与重试 | 已通过 | `personalysis-lifecycle.test.ts` 暂停/升级/重启/断点失效/旧任务 `NULL` 兼容全链路测试 |
| A8 完成、取消与失败 | 已通过 | `personalysis-lifecycle.test.ts` 损坏快照抛 `METHODOLOGY_SNAPSHOT_INVALID`、离线桌面过载重试与取消回归 |
| A9 长内容与窄窗口 | 已通过 | `pi-insight-responses-resume.test.ts` 压缩保留方法测试、`pi-insights.spec.mjs` 4,600 条长聊天 + 真实模型 960 × 640 窄窗截图 |
| A10 历史与非分析调用 | 已通过 | `personalysis-lifecycle.test.ts` 确认 `testModel` 不注入方法、旧报告与旧任务不受影响 |
| A11 既有写作成果 | 首轮合成样本已核对，待维护者终审 | 书店、聚会、安全与对话实测已逐项核对 W1–W6 与六项评阅要点；双读者独立盲评留待维护者决定是否开展 |
| A12 扩展多场景与额度对照 | 待另行安排 | 4,000 / 8,192 成稿额度对照、16 稿多场景留出集及完整 PersonalityEvd / CaSiNo 研究评测不在本轮接入范围内 |

## 6. 后续事项

- 维护者在 `codex/issue-49-evaluation-design` 分支复核实测报告全文、桌面截图与提交历史（`9072927`、`d8e8669`、`0d4f6ad` 及本文档更新），确认是否合入 `main`。
- 若需进一步验证不同模型、长对话或真实私人会话下的解释质量，可由维护者自行在独立样本上按[六项评阅标准](../research/issue-49-insight-evaluation.md#评阅表怎样填)评分，并按需决定是否开启 4,000 / 8,192 额度对照与 16 稿留出评测。
- 实测中观测到人工智能对话轮次的 `cacheReadTokens` 为 0（会话洞察 Responses 接口每轮稳定命中约 3,290–3,316 缓存词元）；如需进一步降低高频多轮侧窗对话的输入费用，可在后续专项中评估对话通道的前缀缓存支持。

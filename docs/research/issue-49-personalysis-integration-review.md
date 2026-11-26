# 第 49 号工单 · Personalysis 接入资料逐项整合

2026-11-26。本页记录对原有 16 个未提交改动文件的实际处置，以及旧规则与正式技能的对照。文档整合已获本轮用户授权；产品接入、模型实验尚未实施。当前实施范围以 [Personalysis 接入方案](../designs/personalysis-integration-v1.md)为准。本页中的行为示例均为虚构验收场景，历史研究数据另按原文来源识别。

## 正式来源与核查依据

唯一正式技能来源为 [StarryJia/personalysis-skill](https://github.com/StarryJia/personalysis-skill)，本次固定 [78aac780c2c8c8cdeb7a63db5a672824e3330c4a](https://github.com/StarryJia/personalysis-skill/commit/78aac780c2c8c8cdeb7a63db5a672824e3330c4a)。本机 `D:\University\github\personalysis-skill` 的 HEAD 与获取远端后的 `origin/main` 相同，GitHub 只读核查也确认该提交存在。

- 正式文件为 `skills/personalysis/SKILL.md`，名称 `personalysis`，元数据版本仍为 `0.1.0`，Git 文件内容标识为 `bbde65a9a434bc3bf43de3ad2b1b96b46ffc58a6`。
- 相比旧 `6803101`，新提交统一名称、目录、链接和调用示例；对原 11 个文件逐一按更名映射比较，规则、许可、场景与验证结论无实质变化。元数据版本没有变化，因此必须同时固定来源提交与实际正文，不能只凭 `0.1.0` 区分新旧名称。
- [正式核心](https://github.com/StarryJia/personalysis-skill/blob/78aac780c2c8c8cdeb7a63db5a672824e3330c4a/skills/personalysis/SKILL.md)、[宿主接入要求](https://github.com/StarryJia/personalysis-skill/blob/78aac780c2c8c8cdeb7a63db5a672824e3330c4a/integrations/host-integration.md)、[理论出处](https://github.com/StarryJia/personalysis-skill/blob/78aac780c2c8c8cdeb7a63db5a672824e3330c4a/skills/personalysis/references/theory-basis.md)分别负责通用方法、应用职责和理论来源。不从本地旧草稿加载正式规则。
- 上游验证仍只涉及包检查与少量合成练习；没有证明 Whomi 兼容、跨模型有效或人格判断准确。[验证边界](https://github.com/StarryJia/personalysis-skill/blob/78aac780c2c8c8cdeb7a63db5a672824e3330c4a/docs/validation.md)

本轮继续 `codex/issue-49-evaluation-design`，跟踪 `origin/main`。已检查未提交状态、执行 `git fetch --all` 和 `git pull --ff-only`；HEAD 为 `b679814`，远端 main 为 `7b74701`，领先 4、落后 0，拉取无需更新。未重置、提交或推送。

## 16 个文件的实际去向

“继续采用”表示仍有明确用途；“合并”表示将可执行约束或验收要求纳入当前方案；“归档”表示保存可追溯原件，停止作为当前候选维护。合并不意味着删除论文依据，归档也不意味着内容没有价值。

| 编号 | 原文件 | 处置与实际去向 | 原因及使用例子 |
| --- | --- | --- | --- |
| 01 | [PRODUCT.md](../../PRODUCT.md) | 继续采用；补入正式来源、两入口范围和接入未实现状态 | 保留观察者定位与现有能力。读者能区分当前可回查报告和计划中的 Personalysis 方法。 |
| 02 | [README.md](../../README.md) | 继续采用；保留研究简介，增加正式项目与接入方案链接 | 不将更名写成已发布功能。例如读者能找到正式技能，又不会误以为当前安装包已加载。 |
| 03 | [004-conversation-insights.md](../planning/ideas/004-conversation-insights.md) | 继续采用；新增本轮结果、授权边界和下一步，历史链接指向归档 | 后续“继续 004”可直接找到当前方案，不把昨天的备份清点当成整合完成。 |
| 04 | [issue-49-insight-evaluation.md](issue-49-insight-evaluation.md) | 继续采用；六项评阅标准并入接入验收，移除另行维护的候选提示词正文，链接现行代码与规则对照 | 已确认的评阅成果不能被包检查替代。引文真实但把对方调整当成本人人格证据，仍应判错。原 16 稿扩展实验独立保留，不与接入小样本预算累加。 |
| 05 | [src/shared/system-prompts.ts](../../src/shared/system-prompts.ts) | 继续采用且本轮逐字节保留；五段成稿规则逐条对照如下，独有要求并入宿主适配 | 接入前删掉通用规则会削弱现有行为；接入时也不能因采用正式技能而丢掉四维观察问题、引文位置和叙述去重。 |
| 06 | [issue-49-casino-verification.md](issue-49-casino-verification.md) | 继续采用；作为固定数据版本、许可、角色与分数核查的唯一详细记录 | 例如 `mturk_agent_1` 只在该段内对应人物，不能跨聊天当成同一真人；该限制进入当前方案的研究边界。 |
| 07 | [issue-49-paper-application.md](issue-49-paper-application.md) | 合并方法与验证边界；原文件继续保留论文版本、页码和研究程序，比较对象更新为现有提示词与正式技能适配 | 引用核查、情境解释、独立测量分别验收；例如不能把报告写得清楚当作量表结果准确。不另建论文训练模型。 |
| 08 | [issue-49-personalityevd-review.md](issue-49-personalityevd-review.md) | 继续采用；保留标注结构、来源、筛选偏差与许可核查，接入方案引用其限制 | 例如对方推测孩子心理不能改成本人自述；研究者标签可作参照，不能转成 MBTI 字母答案。 |
| 09 | [issue-49-reference-cases.md](issue-49-reference-cases.md) | 继续采用并整理；完整公开数据列为后续候选，两份短节选改链归档，首轮接入使用现有合成材料 | 区分开发回归、未见材料和科学参照。不能用三句文学对白代表完整人格案例，也不能把导入通过说成分析通过。 |
| 10 | [issue-49-research-positioning.md](issue-49-research-positioning.md) | 合并观察者定位和三层评价边界；原文继续作为领域与文献索引 | 研究对象是聊天中的人。接入方案明确不把模型自己的人格、读者认同或引用存在当作理解准确性。 |
| 11 | [issue-49-theoretical-foundations.md](issue-49-theoretical-foundations.md) | 合并八种视角及适用边界的归属；原文保留理论比较和讨论历史，通用工作规则由正式技能维护 | 例如自主不等于独立。历史“候选”表述保留为当时讨论，不再作为第二套运行规则或重新开工指令。 |
| 12 | [issue-49-theory-application.md](issue-49-theory-application.md) | 有效应用约束合并后原位归档，页首指向当前方案 | 单一核心、两入口、三类指令同会话、无自动回写、沿用字段与版本固定均已承接。旧文不再继续提出另一份技能实现。 |
| 13 | `fixtures/issue-49/case-b.chatlab.json` | 原字节移至 [archive/issue-49-fixtures/case-b.chatlab.json](archive/issue-49-fixtures/case-b.chatlab.json) | 三条香菱学诗对白只保留为历史导入示例；所用诗学参照已撤出人格评阅依据，不列正式测量样本。 |
| 14 | `fixtures/issue-49/case-c.chatlab.json` | 原字节移至 [archive/issue-49-fixtures/case-c.chatlab.json](archive/issue-49-fixtures/case-c.chatlab.json) | 六轮谈判中文意译保留阅读与改编来源；缺少前半段，不能替代完整 CaSiNo 对话或自评对照。末尾同意也不能被写成已完成物资交割。 |
| 15 | `skills/whomi-person-understanding/SKILL.md` | 独有宿主约束合并后，原字节移至 [archive/whomi-person-understanding/SKILL.md](archive/whomi-person-understanding/SKILL.md) | 正式方法已有相同八种视角和更明确证据规则；静态报告、人物称谓和模块边界归 Whomi，不维护第二份通用技能。 |
| 16 | `skills/whomi-person-understanding/references/theory-basis.md` | 理论与验证限制核对后，原字节移至 [archive/whomi-person-understanding/references/theory-basis.md](archive/whomi-person-understanding/references/theory-basis.md) | 正式理论参考已覆盖同一主干；旧页额外的中文讨论与 2020 年自我决定理论出处仍可追溯，但不需再复制到模型请求。 |

归档文件及来源校验值见[归档索引](archive/README.md)。上一轮新增的 [PersonLens 方案](../designs/personlens-integration-v1.md)不计入这 16 个文件，本轮也原位标为历史版本；当前只维护 Personalysis 方案。

## 成稿提示词逐条对照

对照对象是现有 `insightWriting` 的五个字符串，不是仅查看文件名。其 Git 内容标识为 `72cf3f7eb0b9718d670dd9fb1b7ccbc53a80efb2`；这是本轮前后相同的实际代码基线。正式核心的理论与证据规则按原文复用，不另翻译出一份长期维护的中文核心。

| 现有要求 | 正式技能覆盖 | 必须在 Whomi 保留的成果与验收 |
| --- | --- | --- |
| 第 1 段：只写关于你和你们的相处、称对方 ta、不生成标题 | [按任务及宿主格式作答，15–21 行](https://github.com/StarryJia/personalysis-skill/blob/78aac780c2c8c8cdeb7a63db5a672824e3330c4a/skills/personalysis/SKILL.md#L15-L21)只给通用要求 | W1：固定两节、称谓及标题归属留在宿主。原话中的名字仍逐字保留，不把引文改成 ta。 |
| 第 2 段：选择、理由、对方回应；关键原话贴近解释；分清来源；停在提议 | [来源与计划边界，25–35 行](https://github.com/StarryJia/personalysis-skill/blob/78aac780c2c8c8cdeb7a63db5a672824e3330c4a/skills/personalysis/SKILL.md#L25-L35)覆盖归属、计划不等于执行；理论表覆盖处境 | W2：保留有材料才写选择与理由、对方后续回应、关键原话紧邻对应解释。例如只写愿意帮忙时不补可选方案、心理理由或执行结果。 |
| 第 3 段：四个观察问题；本人言行支持倾向；情境限定 | [60 行](https://github.com/StarryJia/personalysis-skill/blob/78aac780c2c8c8cdeb7a63db5a672824e3330c4a/skills/personalysis/SKILL.md#L60)允许宿主要求框架，但未提供 Whomi 的四个提问 | W3：继续按参与交流／理清想法、取用细节／探索可能、冲突理由的取舍、主动定案／留待条件来观察；只分析本人，证据不足允许未知，不按礼貌或答应一次直接判型。 |
| 第 4 段：角色限制、可比事件、反例、收窄撤回、两解并存、语气辅助、一次叙事、每处引文有用途 | [44、56–58 行](https://github.com/StarryJia/personalysis-skill/blob/78aac780c2c8c8cdeb7a63db5a672824e3330c4a/skills/personalysis/SKILL.md#L56-L58)覆盖情境、反例、修订和具体未知；35 行只禁止把重复转述算成独立证据 | W4：语气只辅助，先比较可选行为与理由。W5：个人观察与四维共用经历只讲一次，每处引文支撑具体推论；不能把“证据不重复计数”等同“正文不重复叙述”。只换热情语气不应翻转判断。 |
| 第 5 段：保留双方回应，可写合作、成长及相关行动；不造冲突、不诊断、不建 ta 完整画像、不保证关系改善 | [64 行](https://github.com/StarryJia/personalysis-skill/blob/78aac780c2c8c8cdeb7a63db5a672824e3330c4a/skills/personalysis/SKILL.md#L64)覆盖建议相关、不诊断与不保证收益；未定义 Whomi 对 ta 的产品范围 | W6：合作与成长也是可写内容；不为报告强造冲突，不制作 ta 的完整人格画像，关系段保留双方连续回应。 |

W1–W6 是对既有代码的承接，不是新增人格推断能力。真实模型是否遵循仍须验证；记录“覆盖”只表示正式文字包含对应规则。

## 旧技能及研究成果的承接

| 旧内容 | 当前维护位置与处理 | 具体边界 |
| --- | --- | --- |
| 八种心理学视角，按材料选择、不填理论清单 | 正式核心的理论表与理论参考；中文研究页保留解释依据，旧技能归档 | 只见一句抱怨，不补齐动机、童年或成长故事；不将八个理论名变成八个报告小节。 |
| 原文行为、本人体验、他人描述、模型解释、跨情境倾向分开 | 正式核心 25–35 行；验收检查真实来源与主体 | 多次转述同一事件不是多条独立经历；旧模型判断也不是新增证据。 |
| 当前任务由应用指定，聊天命令不能改权限 | 正式核心 15–21 行与宿主接入说明；Whomi 固定现有两种入口 | 旧草稿第三种支持性交流只留作历史理论参考，不能因此启动心事屋。 |
| 洞察静态报告，不自行增加字段或写回其他记录 | 当前接入方案宿主规则；结构继续由现有代码校验 | 保持正文、判断、引用、限制等既有结构，不因理论扩充就新增理论分类或长期档案。 |
| 本人补充仅修订当前交互，不自动回写洞察 | 当前接入方案任务边界；正式核心 21 行亦禁止把修订回答当作已保存画像 | 用户说拒绝后焦虑，回答修订体验解释；没有真实保存操作时不说报告已更新。 |
| 技能自足、来源离线可查、无额外文件或网络能力 | 正式核心 52 行、宿主接入说明；接入方案的固定资源与权限规则 | 核心含论文链接不等于模型已读论文，也不添加文件读取工具。 |
| 人格描述、理论机制、信度效度与研究任务分层 | 理论基础与研究定位继续保存；当前方案引用这项评价边界 | 引用可回查、解释忠实、人格测量有效是不同结论；包检查不能代替其中任何效果证据。 |
| 两数据集、四论文的材料隔离与方法限制 | 研究原文保留版本和细节；当前方案采用其取材与验收限制 | PersonalityEvd 标签与 CaSiNo 自评留给评阅者，不能送给生成端；大五结果不是 MBTI 的答案。证据—人格迭代推断论文启发的复核思路不等于复现训练模型。 |
| 六项人工评阅、语气不变性、理由变化、反例修订和未见故事 | 评测文档是评分规则原件；当前方案增加质量验收 A11–A12 | 两位读者需指出原文、解释与重复问题，不能只检查含有八个理论名。首轮少量样本不冒充完整留出验证。 |

## 如何避免重复维护与遗漏

运行接入前继续保留现有默认提示词，避免方法尚未加载就删掉有效约束。正式实施时，把通用证据与理论规则交给固定 Personalysis 核心；Whomi 只维护 W1–W6、输出契约、授权及保存边界，并在真正发送的请求中验证没有漏项或重复加载。用户保存的自定义提示词不被覆盖。

评测文档不再复制一段待同步的成稿候选；旧应用讨论、旧技能和旧方案均明确归档。论文资料继续维护来源与研究解释，不能反向改写正式技能。若未来确需改通用方法，应先固定新的正式提交并重核对，而不是悄悄修改归档草稿或在两个入口各写一套规则。

本轮未调用模型、未执行桌面测试、未改动成稿代码，未修改正式技能仓库的文件或发布外部内容。文档与文件归档检查只证明整理完整，不证明接入已完成或效果改善。

## 本轮核验结果

- 正式更名前后 11 个文件按名称和路径映射后逐一一致；结论依据固定 Git 对象，不依赖可变工作区文件。
- 仓库内迁移的 4 个归档文件与原件 SHA-256 内容校验值一致，原活动目录中对应文件已移出；成稿代码与本轮开始前逐字节相同。
- 18 份新增或修改的 Markdown 文档共核对 309 个本地文件链接，无失效链接；Git 差异空白检查通过，暂存区未改变。
- 独立规则复核未发现关键成果遗漏、扩大模块范围或将文档整合冒充接入完成的表述。
- 正式源工作区在核查期间出现 6 个文件的未提交修改。本轮未纳入这些内容，也未修改它们；当前对照仍固定于已在 GitHub 核实的 78aac78。后续若上游发布新提交，先做新的差异核对，不用本地未提交内容替换已记录的方法版本。

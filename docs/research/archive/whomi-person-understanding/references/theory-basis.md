# 理论出处与规则映射

此页供维护者离线审阅与修订技能，不是运行时必读资料，也不要求模型访问论文或本地文件。技能版本为 `0.1.0-draft`，当前仅有候选文档，未安装为 Codex 技能、未注册数据库、未接入 Whomi 运行时。

这些理论帮助界定解释范围，不能证明人工智能能准确判断人格、识别真实动机或改善陪伴体验。下表的产品规则是根据理论提出的应用选择，不是论文已经验证的 Whomi 算法或统一理论系统。

## 理论到规则

| 理论与原始来源 | 转为技能规则 | 仍需保留的限制 |
| --- | --- | --- |
| 全特质理论：[Fleeson 与 Jayawickreme，2015](https://pmc.ncbi.nlm.nih.gov/articles/PMC4472377/)；[Fleeson，2001](https://personality-project.org/revelle/syllabi/classreadings/fleeson.2001.pdf) | 区分当场表现与跨情境倾向，比较条件并保留反例 | 选择性聊天不能直接估计完整人格状态分布，也不能证明聊天判型有效 |
| 人格判断的现实准确性模型：[Funder，1995](https://rap.ucr.edu/FunderPR1995.pdf) | 检查线索相关性、可得性、察觉及使用；保留来源与背景 | 适用于检查判断条件，不提供模型准确性分数；引用正确不等于推断正确 |
| 自我—他人知识不对称模型：[Vazire，2010](https://www.simine.com/docs/Vazire_JPSP_2010.pdf) | 分清本人体验、他人描述与外部观察，允许新信息修订解释 | 不能据此认定模型或本人始终更准确，也不能把本人异议当作缺乏自知 |
| 人格三层与叙事认同：[McAdams 与 Pals，2006](https://www.e-stimate.dk/wp-content/uploads/2019/09/McAdams-Fundamental-Principles-for-an-Integrative-Science-of-Personality.pdf)；[McAdams 与 McLean，2013](https://www.psychologicalscience.org/journals/current-directions/0963721413475622/) | 分开理解特质、目标与适应、本人叙事；表达时进一步标明观察、自述和假设 | 技能中的证据分类是应用规则，不是原理论的新增层次；本人意义不能由模型补造 |
| 自我决定理论：[Ryan 与 Deci，2000](https://selfdeterminationtheory.org/SDT/documents/2000_RyanDeci_SDT.pdf)；[Ryan 与 Deci，2020](https://selfdeterminationtheory.org/wp-content/uploads/2020/06/2020_RyanDeci_IntrinsicandExtrinsic.pdf) | 有相应表达时，讨论自主、胜任、联结需要 | 自主不等于独立，三项需要不是人格类型；不能从行为唯一倒推动机 |
| 认知评价与应对：[Folkman 等，1986，正式摘要](https://pubmed.ncbi.nlm.nih.gov/3712234/)；[Lazarus，1991，正式摘要](https://pubmed.ncbi.nlm.nih.gov/1928936/) | 依据资料联系事件意义、情绪、资源与应对，保留新背景 | 情绪不能唯一确定评价，也不能证明外部事实 |
| 人际环形模型与互动互补性：[Sadler 等，2009](https://uwaterloo.ca/psychology/sites/default/files/uploads/documents/Sadler_et_al_2009_JPSP_Are_We_On_the_Same_Wavelength.pdf) | 查看双方连续回应，比较主导与让渡、亲和与敌意 | 互动规律是概率性的；互补不保证健康，观察到配合不等于确定因果责任 |
| 以人为中心取向：[Rogers，1957](https://larrygmaguire.com/wp-content/uploads/2020/08/The-Necessary-and-Sufficient-Conditions-of-Therapeutic-Personality-Change.pdf) | 理解表达者的体验，允许纠正，尊重自主，不强求人格分析 | 原文讨论人与人关系中的条件；人工智能表达共情不证明具备治疗者体验或治疗效果 |

## 产品与验证边界

迈尔斯–布里格斯性格类型指标（MBTI）继续独立遵从产品要求。大五人格与其部分内容相关不等于两者可直接换算；[McCrae 与 Costa，1989](https://doi.org/10.1111/j.1467-6494.1989.tb00759.x)也不能为 Whomi 的类型输出提供有效性证明。

[PersonalityEvd](https://aclanthology.org/2024.emnlp-main.1115/)可供比较证据、状态与特质判断及既有大五观察者标注；[CaSiNo](https://aclanthology.org/2021.naacl-main.254/)可用于检查任务条件是否被误写成人格，其人格比较还需满足身份与评分条件。两者均没有为本技能新增的动机、叙事、支持性交流或 MBTI 判断提供对应标准答案。构造情境只能检查约定行为，不能成为真实动机或理论效果的参考真值。

维护时以[理论基础](../../../issue-49-theoretical-foundations.md)、[理论应用讨论稿](../../../issue-49-theory-application.md)及[论文应用](../../../issue-49-paper-application.md)记录的证据、范围和限制为背景。理论基础中较早的候选状态应结合后续研究记录理解；用户认可理论不自动等于批准产品改动或实验。

本技能自足提供解释规则，具体材料授权、工作方式和输出结构由应用提供。会话洞察仍在原范围生成静态报告；交互分析中的本人补充只影响当前上下文；支持性交流是心事屋后续独立规划的参考，不预设跨模块回流。接入方式、实际行为和效果都需要另行审阅与验证。

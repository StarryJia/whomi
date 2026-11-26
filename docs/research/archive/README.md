# 第 49 号工单研究归档

2026-11-26。以下文件已从活动候选目录移入本目录，内容逐字节保留；归档不是弃用研究成果，而是停止平行维护旧方法或将节选当成正式测量样本。当前规则、接入范围与验收见 [Personalysis 方案](../../designs/personalysis-integration-v1.md)，逐项取舍见[整合记录](../issue-49-personalysis-integration-review.md)。

| 归档文件 | 原位置 | 原因与保留用途 | SHA-256 内容校验值 |
| --- | --- | --- | --- |
| [旧技能](whomi-person-understanding/SKILL.md) | `docs/research/skills/whomi-person-understanding/SKILL.md` | `0.1.0-draft`；通用规则已由正式技能承接，Whomi 独有任务约束已合并。只用于追溯，不加载或安装。 | `9a9a40207242b3f26ae94cbeed5fa3978ce9a991650489821903db748879dd6a` |
| [旧理论映射](whomi-person-understanding/references/theory-basis.md) | `docs/research/skills/whomi-person-understanding/references/theory-basis.md` | 正式核心及理论出处维护通用规则；旧中文解释与额外参考继续可查。例如旧页保留 Ryan 与 Deci 2020 文献。 | `15a8b02c29c1f26838091a42a137ea325c74e0d8cd239a99d6035a46075311f0` |
| [B 香菱学诗](issue-49-fixtures/case-b.chatlab.json) | `docs/research/fixtures/issue-49/case-b.chatlab.json` | 三条对白作为历史导入示例，不是完整人格评测案例；原诗学参照已经撤出人物性格评价依据。 | `c0d98209718e118f34719d667dc49ca46e6681157e6ed0a78e5db18b6af95297` |
| [C 露营谈判](issue-49-fixtures/case-c.chatlab.json) | `docs/research/fixtures/issue-49/case-c.chatlab.json` | 后半段六轮中文意译，保留阅读示例与改编记录；不能代替完整英文对话、自评数据或已发生的交割结果。 | `b0148fe4c5d091b51b38cb938188b55e8c462207a437036db36c0a580fb486d3` |

两份聊天的会话名、平台、时间和匿名甲乙均为导入占位，不是实际参与者身份。B 引自《红楼梦》程甲本第 48 回；C 改编自 Kushal Chawla、Jaysa Ramirez、Rene Clever、Gale Lucas、Jonathan May 和 Jonathan Gratch 的 CaSiNo（2021）论文表 1，经过节选、中文意译、匿名处理并省略表情和交易按钮。C 原语料使用知识共享署名 4.0 国际许可；[原始仓库](https://github.com/kushalchawla/CaSiNo)及[许可](https://creativecommons.org/licenses/by/4.0/)保持可查。出处和适用限制详见[材料清单](../issue-49-reference-cases.md)。

为保留已有文档链接，下列资料原位标为历史版本，不再作为活动实施路线：

- [理论应用讨论稿](../issue-49-theory-application.md)：有效应用边界与双入口加载要求已合并至当前方案。
- [PersonLens 接入方案](../../designs/personlens-integration-v1.md)：记录 2026-11-25 的来源与初次核对，更名后的正式来源以当前方案为准。

这四个归档文件不是生产资源，当前没有新增扫描或加载；未来构建不能从研究归档取技能。若需要再次引用某份节选，应明确它是历史示例，不应恢复成未说明来源与限制的正式评测输入。

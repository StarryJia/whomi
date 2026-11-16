# 对话洞察真实模型质量比较

2026-11-15。与[实施验证](conversation-insights-validation.md)及工单 #17 对应。两组合成聊天来自[试验材料](../../tests/quality/insight-material.mjs)。模拟角色、日期和聊天均为虚构。这里的模型响应由同一真实模型生成。

## 方法

使用 Whomi 已配置的 `chatgptPRO`、`gpt-6.1-sol`，通过 OpenAI Chat Completions 和 Whomi 的 Pi 运行器调用。用户授权真实调用，费用上限未设置。每任务包括失败和结构修复，最多 6 次模型请求、80,000 输入词元、6,000 输出词元和 5 分钟有效运行。第一轮固定 4 个任务。针对实际发现的导航协议和成稿问题，各复测一次场景 B，总请求继续受 24 次上限约束。复测沿用原材料、模型和任务预算。基线用一次请求通读全部范围内消息并直接成稿。洞察版使用产品三阶段引擎，由模型判断是否需要额外核查，试验配置最多一项核查、三轮。远距离样本给洞察版额外设置每请求 6,000 输入估算量，以实际触发跨批阅读。基线与洞察版的任务累计预算相同。

试验在隔离的 Electron 临时资料目录运行，仅以只读方式查询指定账户与模型配置。操作系统封装的 Chromium 加密值只在临时目录用于解密，运行完清理，真实服务密钥只保留于进程内存。请求只发送至 `https://api.openai.com/v1/chat/completions`，实际发送前校验模型、输出上限和合成来源。范围外合成消息 #99 留在本地。模型响应、结构化报告及逐次预留和实际用量均可对照查看。

## 场景 A · 后续反例

合成内容中，ta 在 #2 说今天先不要建议，本人在 #3 转为倾听。之后 ta 在 #5 主动询问建议，#7 表示第二个选项更适合。报告应区分两次需求，避免推断长期性格，也不应把偏好说成已经执行方案。

| 方法 | 请求与用量 | 人工核对 |
| --- | --- | --- |
| 一次通读 | 1 次成稿，939 输入、841 输出，耗时 18.5 秒 | 引用 #1–4 与 #5–7，前后时机区分清楚。把 #7 的偏好概括为“选了第二个”，确定性略强于原文。给出先询问倾听还是建议的具体句式。 |
| 分阶段洞察 | 1 次阅读、1 次成稿，1,904 输入、1,273 输出，耗时 32.8 秒 | 两次情境都精确引用，保留“第二个更适合”的措辞。建议同样具体。阅读阶段认为材料已足够，未提出核查事项。限制段落提到摘要、`checks` 和 `judgments` 内部结构，影响报告可读性。 |

本样本的全文基线已经识别前后差异，未见明确的整体质量增益。洞察版对选择进展写得更精确，消耗更多词元并暴露内部字段。

证据：[基线报告](assets/conversation-insights-quality-20261115/later-counterexample-baseline/report.json)、[基线调用记录](assets/conversation-insights-quality-20261115/later-counterexample-baseline/attempts.jsonl)、[洞察报告](assets/conversation-insights-quality-20261115/later-counterexample-insight/report.json)、[洞察调用记录](assets/conversation-insights-quality-20261115/later-counterexample-insight/attempts.jsonl)。

## 场景 B · 远距离回复

在 #1，本人只能周五陪 ta 去眼科复查。#2 暂时保留周一的眼科号，另有周一修车安排。穿插 24 条其他话题后，#27 显式回复 #1，眼科号取消、周五未重约、修车照旧。#28 确认眼科没有新时间。核对重点是跨批联系和事项边界。

| 方法 | 请求与用量 | 人工核对 |
| --- | --- | --- |
| 一次通读 | 1 次成稿，3,036 输入、1,106 输出，耗时 25.3 秒 | 以 #1、#2、#27、#28 核对周五只是陪同条件、眼科号取消且未重约、修车单独保留。明确没有发生已改约或已经实际陪同的事实。给出确认谁联系医院、确定日期后再核对能否陪同的操作建议。 |
| 分阶段洞察 | 3 次阅读、1 次导航压缩、1 次格式修复，7,905 输入、4,444 输出，耗时 71.7 秒 | 覆盖 28/28。最后一批正确认出 #27 回复 #1，记录周一眼科号取消、周五未重约和修车照旧。第 4、5 次响应均为合法 JSON，但根字段是 `nodes`，其下有 18 项。压缩协议需要单个带 `text` 和 `sourceIds` 的根对象，两次均遭校验拒绝，结束状态为 `INVALID_INSIGHT_OUTPUT`。没有进入成稿，无法评估面向用户的最终文稿。 |

证据：[合成原文](assets/conversation-insights-quality-20261115/distant-reply-insight/input.json)、[基线报告](assets/conversation-insights-quality-20261115/distant-reply-baseline/report.json)、[基线调用记录](assets/conversation-insights-quality-20261115/distant-reply-baseline/attempts.jsonl)、[洞察调用记录](assets/conversation-insights-quality-20261115/distant-reply-insight/attempts.jsonl)、[最后一批阅读响应](assets/conversation-insights-quality-20261115/distant-reply-insight/response-03.txt)、[首个压缩响应](assets/conversation-insights-quality-20261115/distant-reply-insight/response-04.txt)、[格式修复响应](assets/conversation-insights-quality-20261115/distant-reply-insight/response-05.txt)、[失败结论](assets/conversation-insights-quality-20261115/distant-reply-insight/result.json)。

### 场景 B 的导航协议修复复测

原任务保留失败状态和 5 次调用记录。离线回归使用真实错误响应里的 `nodes` 外层结构，确认原重试指令同时包含两种输出结构。修复后压缩调用只声明单个顶层 `{text,sourceIds}`。同一组 28 条消息使用独立任务复测一次。

| 请求与用量 | 观察结果 |
| --- | --- |
| 2 次阅读、1 次导航压缩、1 次成稿，6,738 输入、3,370 输出，耗时 59.8 秒 | 覆盖 28/28，导航压缩响应符合预期，报告通过结构校验。报告的「关于你」「你们的相处」段落及引用均为空。只有三条限制。其中一条把成稿阶段看不到全文表述为没有逐字原文，遗漏了任务实际读取全部合成原文的上下文。另两条局限和建议保留了眼科号取消、未重约周五和单独确认修车安排。 |

结构错误在本次复测未再出现。报告依旧缺失正文和精确引用，面向用户的完整性不达标。一次全文基线在相同材料上给出了能逐条回查的报告。

证据：[复测输入](assets/conversation-insights-quality-20261115/distant-reply-insight-regression/input.json)、[复测调用记录](assets/conversation-insights-quality-20261115/distant-reply-insight-regression/attempts.jsonl)、[修复后的压缩响应](assets/conversation-insights-quality-20261115/distant-reply-insight-regression/response-03.txt)、[复测报告](assets/conversation-insights-quality-20261115/distant-reply-insight-regression/report.json)、[复测结果](assets/conversation-insights-quality-20261115/distant-reply-insight-regression/result.json)。

### 场景 B 的成稿复测与引用离线重放

成稿协议明确阅读记录来自本任务原文。无核查判断时，模型仍可写有引用的中性事实；未逐字提供的内容用转述。保留材料不足行为，未增加流程。

| 请求与用量 | 观察结果 |
| --- | --- |
| 2 次阅读、1 次导航压缩、1 次成稿，6,548 输入、3,510 输出，耗时 67.8 秒 | 覆盖 28/28。原始响应有两节正文和三组引用，正确区分只能周五陪同、周一眼科号取消且无新号、修车安排照旧。引用 #25 支持包裹可顺路取走且未确认已取。程序拒绝 #25，返回引用错误 `INVALID_EVIDENCE`，真实运行未保存报告。 |

从该次断点重建成稿请求，输入估算与原日志的 5,402 一致。原请求确实在未结束事项笔记中传入 #25，该编号也在冻结来源中。引用校验原先只收导航观察和核查结果的编号，遗漏了已发送的这项笔记。修复后许可集合加入实际发送的未结束事项来源。使用同一断点和完整的实际成稿文本离线重放，修复前被拒绝，修复后八条引用可用。定向测试仍拒绝同范围里尚未提供给成稿的消息。此次重放调用真实模型零次，原实测失败记录保留。

证据：[末次复测输入](assets/conversation-insights-quality-20261115/distant-reply-insight-writing-regression/input.json)、[末次复测调用记录](assets/conversation-insights-quality-20261115/distant-reply-insight-writing-regression/attempts.jsonl)、[原始成稿](assets/conversation-insights-quality-20261115/distant-reply-insight-writing-regression/response-04.txt)、[真实运行结果](assets/conversation-insights-quality-20261115/distant-reply-insight-writing-regression/result.json)、[离线重放结果](assets/conversation-insights-quality-20261115/distant-reply-insight-writing-regression/offline-replay-result.json)。

## 判定与边界

本节保留前轮17次请求的结论。用户随后授权的[主动核查诊断与真实验证](conversation-insights-verification-20261115.md)另用14次请求验证了一个样本的自主回读和反例修正，不改变下列原始试验结果。

- 第一轮 4 个任务实际发出 9 次请求，共 13,784 输入词元、7,664 输出词元。两次复测各 4 次请求。合计 17 次，实际用量 27,070 输入词元、14,544 输出词元。全部收到 HTTP 200，统计包含结构校验失败与格式修复。各任务均在请求、用量和时限内，无范围外传输记录。
- 实际服务接受本轮 OpenAI Chat Completions 输出上限。四个洞察任务的阅读都返回空核查候选，实际核查阶段调用为零。真实模型的多轮核查仍待验证。
- A 洞察完成后补上报告面向用户的用语约束，A 保留原始结果。B 首次复测仍把成稿阶段输入的限制表述成缺乏原文，末次复测的原始成稿改为对具体行为和材料边界的说明。最后的引用许可修复经过原响应离线验证，未再调用真实模型。
- 两种样本的简单基线都产出可核验报告，分阶段洞察的总体质量增益尚无证据。按停止条件收尾，发布质量及默认预算仍待验证。

## 复现

[试验脚本](../../scripts/insight-quality.mjs)使用当前仓库代码构建隔离 Electron 入口。提供已授权的 `WHOMI_QUALITY_DB`、`WHOMI_QUALITY_PROVIDER_ID`、`WHOMI_QUALITY_MODEL_ID`。先运行 `node scripts/insight-quality.mjs --dry-run` 验证系统凭据，预检产生零模型调用。原始对照参数为 `later-counterexample baseline`、`later-counterexample insight`、`distant-reply baseline` 和 `distant-reply insight`。两次复测参数分别为 `distant-reply insight --regression` 和 `distant-reply insight --writing-regression`。已有同名结果目录会阻止重复任务。上文证据链接指向仓库中归档的合成原文、模型响应、报告、结果和调用记录。

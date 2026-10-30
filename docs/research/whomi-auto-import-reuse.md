# 免填导入与自动追加

2026-10-31；实现与测试只使用虚构数据及隔离数据库，不读取真实聊天，不调用模型。

本轮适配固定来源 [ChatLab/ChatLab bf8d5ac77443512b9973ff3a236f258424202bbc](https://github.com/ChatLab/ChatLab/tree/bf8d5ac77443512b9973ff3a236f258424202bbc)，通过 GitHub 连接器读取实际文件后实现。源码依据为：

- [auto-import-matcher.ts](https://github.com/ChatLab/ChatLab/blob/bf8d5ac77443512b9973ff3a236f258424202bbc/packages/node-runtime/src/import/auto-import-matcher.ts)：可靠身份优先、旧会话最后五条有效消息在新文件中的连续窗口，以及候选读取失败向上传递。
- [message-deduplicator.ts](https://github.com/ChatLab/ChatLab/blob/bf8d5ac77443512b9973ff3a236f258424202bbc/packages/node-runtime/src/import/message-deduplicator.ts)：平台消息编号优先；不同编号的相同正文不能互相去重。
- [incremental-importer.ts](https://github.com/ChatLab/ChatLab/blob/bf8d5ac77443512b9973ff3a236f258424202bbc/packages/node-runtime/src/import/incremental-importer.ts)：写入前固定历史消息范围，按出现次数消费无编号记录，保留重复消息数量。

这些业务文件适用仓库根 [GNU Affero General Public License 第 3 版](https://github.com/ChatLab/ChatLab/blob/bf8d5ac77443512b9973ff3a236f258424202bbc/LICENSE)，原文件未带独立版权头。本轮是在 Whomi 现有数据库事务、成员与消息模型上适配相应机制，不是把 ChatLab 的整个导入运行环境直接安装进 Whomi。具体组合许可由项目第三方声明统一记录。

## 已实现的流程

用户选择或拖入文件后，只有一个入口时直接解析并保存；多个入口时仅选择要导入的文件。解析、保存和结果替换同一个中心操作区，不再要求预览、填写目标或账号别名。解析显示每批实际检查数；保存有真实总数时显示已处理条数和进度，无总数时使用不定进度。已处理与已提交保存分开显示。保存前取消返回文件选择，部分保存后取消保留已提交成果及打开入口；请求失败保留重试按钮。后台已结束的失败仍可重新选择失败来源。

例如，虚构文件首次含六条记录，第二份文件含旧会话末尾五条及一条新记录。唯一匹配且身份不冲突时，第二次保存到原会话，新增一条、跳过五条。若两个旧会话的末尾均匹配，则新建会话，避免替用户选择目标。

## 适配与保护

目标识别和消息去重分别执行。可靠来源身份沿用 Whomi 平台、命名空间、导出账号及来源会话键；规范化保留解析器提供的导出账号与群身份。同一文件指纹及来源会话键的已保存记录也是精确来源证据，因此只有两条消息的同文件重导仍可零新增；若这组证据对应多个历史会话，则新建。补充匹配要求真实时间、稳定发送者账号、消息类型及正文的连续五条窗口，并排除明确的平台、账号和同一命名空间会话键冲突。两个消息均有平台编号时还核对编号，读取错误不作为零匹配。

无编号去重与每个来源文件写入前的历史消息比较，同一发送者、时间、类型、正文、引用与附件均相同才按历史出现次数消费。比如旧记录同一毫秒出现两次示例文字，新文件出现三次，只跳过两次，第三次保留。同一任务首次导入两份重叠文件时，第一份有两次、第二份有三次，也只保留三次，而非叠加为五次。不同稳定编号、附件或引用的记录保留。无法验证的记录保留为新增，不按昵称或语义合并。已存在的原文、来源、附件、引用和会话摘要事务边界继续保留；原有显式导入决定仍兼容。

Whomi 没有迁入上游依靠平台编号推导账号漂移的映射，也不把会话标题当身份。账号或时间缺失时不能使用正文窗口证明身份；没有可靠来源证据且不足五条或多个候选时自动新建。

匹配索引只保留已有会话各自末尾五条签名，新文件只保留一个五条滑窗，不累积全部新消息窗口。每 500 条让出事件循环并检查取消。无编号去重按 500 条或 4 MiB 的历史正文页构建 SQLite 文件临时计数表，表内只保存固定长度摘要和出现次数；临时数据库缓存设为 2 MiB。后续消费使用索引更新，不在 JavaScript 中保存全部去重键，也不一次载入同一时间的全部正文。这个限制针对新增匹配与去重状态，不能推导整个导入进程在任何记录大小下都有同一内存占用。

## 验证

- 后端新增回归先观察到五项失败，再实现身份不足自动归属、出现次数去重、错误传播及解析账号回退；随后额外复现并修复同秒不同附件与引用的保护。
- 界面新增八项回归先观察到五项失败，再实现单入口自动推进、不显示格式标识、保存重试、等待期间取消和完成打开。
- `npm run test:backend -- tests/backend/auto-import.test.ts tests/backend/runner.test.ts tests/backend/merge.test.ts tests/backend/identity.test.ts tests/backend/import-contract.test.ts tests/backend/ipc.test.ts`：六个文件、80 项通过。
- `npm test -- src/conversation-acceptance-fixes.test.tsx src/components/import/import-flow.test.tsx src/data/use-import.test.tsx`：三个文件、29 项通过。
- `npx tsc -p tsconfig.electron.json`：通过。
- `npm run typecheck`：最终类型检查通过。
- `auto-import-memory.test.ts` 两项独立进程验证分别通过：64 MiB JavaScript 堆下流式匹配一百万条；同样堆限制下重导二十五万条同时间、每条含 512 字示例正文的记录，新增零条、重复二十五万条。后者在修复前因堆内存耗尽退出，修复后约 30 秒完成；这是本机合成输入的回归结果，不是任意机器的性能承诺。

`npx playwright test tests/desktop/import.spec.mjs`：最终共同构建下四个真实 Electron 用例全部通过，用时 36.7 秒。覆盖自动追加、同文件零新增、本人确认、原文件字节不变、脚本内容按正文展示、重启稳定编号、六页阅读锚点、多入口取消、部分保存及失败来源修复后重导。十万条合成消息文件在真实解析时显示已检查 5000 条的截图，取消后没有保存会话。

全部九张截图在最终构建重新生成并逐张目检；外壳统一 20 像素圆角、细边框和轻阴影。解析与单会话结果居中，完成主次操作并置，多会话结果左对齐。部分失败只在对应文件下显示具体记录诊断，没有目标选择提示或同一问题的重复通用提示。960 × 720 内容窗口无水平溢出。截图只含虚构记录，保存在被忽略的 `release/auto-import-20261031/`：

| 文件 | 验收状态 |
|---|---|
| `01-file-selection.png` | 文件选择起点 |
| `02-completed.png` | 自动保存完成，主要操作为打开会话 |
| `03-completed-narrow.png` | 960 × 720 内容窗口完成结果 |
| `04-entry-selection.png` | 多入口必要选择，不显示格式技术名 |
| `05-cancelled-restored.png` | 保存前取消，恢复初始区域 |
| `06-partial-failure.png` | 保留已保存消息与对应失败诊断 |
| `07-recovered.png` | 修复失败来源后重新导入成功 |
| `08-real-parsing.png` | 实际检查 5000 条，不定进度条 |
| `09-parsing-cancelled.png` | 解析期间取消，未创建会话 |

全量集成测试与安装包验证由本轮统一交付记录汇总，本文件不把上述合成数据验证扩展为任意导出器版本均兼容的承诺。

# 事实保留修复试验：失败记录

对应[试验报告](../../conversation-insights-memory-preservation-20261115.md)。这是 `memory-preservation-20261115` 的原始22次请求记录，不是完整准确性对照结果。

- `shared-workload-reading/`、`shared-workload-reading-resume/`、`shared-workload-reading-resume-2/`：三阶段分别3、10、9次请求；全部以失败结束，最后已读完120条但未完成压缩。
- `input.json` 和 `snapshot.json`：实际材料、范围、模型名称与任务预算；`materials.json` 补充两组固定合成材料，第二组未在本轮调用模型。
- `request-*.json`、`response-*.txt`、`attempts.jsonl`、`events.jsonl`、`result.json`、`checkpoint.json`：原样保存，未重新生成或修改模型输出。
- `implementation*.json`、`implementation*.patch`：首轮、两次恢复开始前的代码状态，不能当成后续修复后的最终版本。
- `preregistration.md`：首个真实请求前保存的设计；两份 `halt-resolution` 及相应阶段的原停止文件记录恢复依据；根目录 `halt.json` 保留最后失败。
- `offline/`：原响应零网络重放、收缩与剩余容量审计、相关红绿回归和类型检查。离线模拟派发不计为真实模型请求。
- `archive-audit.json`：实际用量、候选状态、材料摘要，以及89个原始文件副本的逐文件摘要与字节数。副本合计1058029字节；材料文件、本说明及归档审计本身不在该89项清单中。

原 `audit.json` 的 `referenceIdsAndRevisions=passed` 表示遍历中未发现错误。由于本轮没有最终报告，该字段不能理解为报告引用验收通过；归档审计已明确标为不适用。

已核查的自然更新链：第一个恢复阶段第9次提出候选1；第二个恢复阶段第1次解决同一候选；下一次请求携带已解决状态。候选的核查轮数为0，没有实际回读。反例保存在修正文字和87的原文摘录中，结构化反例编号数组为空。

只归档合成材料与净化后的调用记录。未包含安装版配置、用户数据库、运行目录或凭据；敏感模式扫描未发现密钥值、授权令牌或用户私有目录路径。

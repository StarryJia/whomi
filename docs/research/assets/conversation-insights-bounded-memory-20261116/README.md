# 有界事实压缩试验：失败记录

对应[试验报告](../../conversation-insights-bounded-memory-20261116.md)。本目录保存独立轮次 `memory-bounded-20261116` 的全部28次请求及两次恢复。它属于中途修正协议的开发诊断，未完成准确性对照。

- `shared-workload-reading/`：24次请求，17批通读及7次压缩，6个压缩输出被接受。
- `shared-workload-reading-resume/`：3次压缩，再接受1个输出，其后两次因旧字符硬上限失败。
- `shared-workload-reading-resume-2/`：1次压缩，20条未知被拆为40条，事实体积增加7.05%，最终停止。
- `source/`、`source-after-mixed-unknown/`、`source-after-volume-progress/`：三次真实阶段开始前的完整实现快照，各13个文件；与各自 `implementation*.json` 的摘要一致。后续代码修复不属于这些快照。
- `run-profile.json`、`preregistration.md`、`halt-resolution-*.json`、`recovery-note-*.md`、各阶段原停止文件及根目录 `halt.json`：固定设置、原始设计、两次恢复依据和最终停止记录。
- `offline/`：红绿回归、类型检查、零网络响应重放、容量预检及恢复账本校验。模拟派发不算真实模型请求。
- `validation/`：专项、完整后端、前端和桌面检查证据；`summary.json` 汇总实际边界。桌面完整套件43通过、11失败、2跳过，其中7项在旧提交复现，其余4项尚未归因。
- `materials.json`：两组固定合成材料。第二组未在本轮发送给模型。
- `audit.json`：最终派发、用量、来源、候选、压缩节点核验；没有报告，引用语义与准确性评分不适用。
- `archive-audit.json`：172个原样副本的摘要与大小，合计2702685字节。材料文件、验证摘要、本说明及归档审计自身不在这172项清单中。

本轮候选数为0，没有核查或成稿。更早 `memory-preservation-20261115` 的22次失败轮中自然解决过1个候选，该证据不计入本轮。两次事实保留修复轮合计50次请求，先前41次长对照单独保留。

旧请求中的 `maxFactTextLength` 按旧硬上限审计；最后请求中的 `targetFactTextLength` 按文字目标记录。是否接受只由当阶段真实检查点认定，未用新规则改写旧失败状态。

原产物和源快照已进行敏感模式扫描，未发现密钥值、授权令牌或用户私有目录路径。未收集安装版配置、数据库、运行目录或凭据；所有复制内容保持原始字节。

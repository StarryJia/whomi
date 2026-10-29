# 会话导入实施裁定归档

2026-10-30；范围为已确认的桌面会话导入计划。以下是实施选择与其代价，不增加新功能或公开发布授权。附录按执行账本中的原始顺序保留所有包含 Ruling: 的记录；这些记录含早期进度，当前完成状态以[验收](conversation-import-validation.md)为准。

## 影响使用和维护的选择

- 继续已授权的 main 分支，由一个实施者顺序更新；保留既有前端。代价是没有独立工作区隔离，需要持续检查基线和本地改动。
- 只复用 ChatLab 的必要格式模块和类型，保留来源与修改记录；版本调整必须有实际兼容证据。代价是仍需维护本地适配和回归测试，不能把支持结构扩写成所有历史版本兼容。
- 组合许可尚未明确，只做本地集成和未签名验证包。AGPL 指 GNU Affero General Public License，GSAP 指启动动画采用的 GreenSock Animation Platform；二者的公开分发兼容与对应源码交付仍需确认。代价是不能据此公开发布当前组合二进制。
- Google Chat 接收清单或已解压目录，不引入整个上游压缩包导入服务。例如用户先解压 Takeout，再选择目录；代价是不能直接选 ZIP 压缩包。
- 来源文件通过受控快照和允许列表读取；适配器报告来源声明数量，暂存层不另写一套原始格式解析。代价是遇到未支持的畸形字段会明确阻断，而非猜测丢弃正文。
- 共享的导入请求区分暂存与提交；暂存视图只验证同任务候选，不替用户决定归属。多个文件确认属于同一目标时，按目标会话一个事务保存。代价是大目标回滚清理可能比取消接受更慢，不能为速度改成半份正式保存。
- 去重键采用正式会话、解析器声明的消息标识命名空间与原始标识；导出账号变化不自动改写标识命名空间。虚构例：同一目标中的原 m2 再出现时跳过，保留旧正文；代价是可靠归属必须单独确认，无可靠标识的不同文件保守处理。
- 本人确认通过同一个写入队列和消息保存事务执行。未选择沿用已有确认，明确不指定本人会持久保留该选择，指定成员必须来自当前候选；同一目标的冲突选择阻断整组。代价是用户需要澄清冲突，不能按同名或账号后缀自动认定本人。
- 数据库状态机用新增迁移和字段扩展，保留已提交记录与外键关系；内部健康检查与测试探针只在受校验临时目录启用，不作为渲染页面的通用数据库接口。代价是维护明确的迁移和测试边界。

前述取消、未知标识和目标事务的实际结果见[验收例子](conversation-import-validation.md)。导入限制仍是单文件全量 32 MiB、逐行格式 2 GiB、单记录 8 MiB，MiB 是 1,048,576 字节，GiB 是 1,073,741,824 字节；2 GiB 没有生成并实测，超限应重新选择或拆分来源，而非认为已支持所有大小。

## 原始账本记录

以下英文记录中的 API 指应用程序接口，UI 指用户界面，ID 指标识，FK 指数据库外键，JSON 指 JavaScript Object Notation 文本格式，JSONL 指每行一个 JSON 对象的文本格式；SIWX 是该计划中的微信导出工具代号。Task 数字表示执行任务，GREEN 表示相关检查通过。

1. Ruling: Use current main checkout, no new worktree — user explicitly authorized main and preserving existing frontend — loss of isolation accepted, only one implementer writes at a time.

2. Ruling: Use fresh gpt-6.1-sol implementer/reviewer for multi-file tasks, higher model for final review per skill — tasks involve integration — escalate if complexity warrants.

3. Ruling: Internal health/probe test functionality is not a renderer database API — Task 1 needs persistence evidence before Task 2 schema — keep probes gated to test temporary data and remove/reuse when real schema arrives.

4. Ruling: Task 6 owns StartImportRequest union (stage/commit); Task 8 only transports it — one shared contract — divergent APIs would break import state transitions.

5. Ruling: Generated/imported upstream source receives behavior tests at adapter boundary, no rewriting vendored code solely to manufacture red tests — user asked reuse — preserve upstream provenance.

6. Ruling: Package/model versions may be adjusted only based on concrete compatibility evidence, record here — approved plan delegates same-architecture dependency adjustments — no silent format reduction.

7. Ruling: Continue authorized local parser integration with preserved notices; do not choose whole-project license or publish combined binary — upstream audit notes document AGPL/GSAP distribution uncertainty — public release remains unapproved and uncleared.

8. Ruling: Task 2 also refactors electron/data/entry.ts to use openStore/migrateStore, preserving health/probe tests — Task 1 currently initializes SQLite inline; production must use the tested migration path — one extra touched file, avoids duplicate connections/configuration.

9. Ruling: For Google Chat, support parser manifest and ordinary extracted export directory through minimal own discovery/manifest preparation in Task 4; do not claim raw ZIP support — selected scope is parser/file/directory import, upstream ZIP service not selected — user can extract archive first. Task 3 verifies manifest parser, Task 4 verifies extracted Takeout folder integration, matrix documents boundary.

10. Task3 first GREEN reported: 61 parser/SIWX cases, all 14 modules invoked, typecheck passes; edge strengthening and full checks pending. Ruling: redirect vendor filesystem imports through narrow parser snapshot-fs facade to enforce allowlist at opening — upstream manifest parsers otherwise read dependencies directly — Task4 remains responsible for immutable source snapshots. Async context must cover generator consumption, descriptor validation precedes content reads.

11. Task3: fix round1/5 (4 addressed,0 open — duplicate keys, callback exceptions, QQ timestamp, Instagram share; commits86f3a3d..12f74cd). Scoped reviewer /root/finish_rereview_task3_r1 confirms all addressed/no new Critical or Important. Task3: complete (commits a95171d..12f74cd, review clean). Dependency audit residual and public licensing boundaries remain documented, not cleared. Task4 base12f74cd. Ruling: Task4 may make minimal additive parser metadata/diagnostic changes needed for declared-count validation; don't reparse raw formats in staging — parsed expected-count evidence belongs adapters — test affected adapter behavior. Ruling: Introduce exact shared task/result enums now; existing formal generic status schema can be migrated when Task6 persists full state machine, no silent rewriting an applied schema version.

12. Task4 first GREEN13/13 incl actual Windows junction/no formal writes. Ruling: minimally reject malformed text field shapes where staging tests prove silent content loss (Telegram raw.text object unsupported, verified analogous formats only) — complete staging validation relies on adapter not erasing malformed content — add regressions and preserve valid empty/rich text; no broad rewrite. Other current fixes: declared QQ totals, filename-independent logical-role fingerprint, byte-bounded staged reader batches.

13. Task4 second GREEN24 cases/typecheck reported. Ruling: staged.conversation(candidateIds) only validates controlled read view membership (same job, unique ids, all staged/unblocked), not source identity equality — Task5 resolves explicit user choices/aliases and Task6 groups same validated target — otherwise missing identities would prevent legitimate grouped atomic merge. No renderer exposure/no identity override; Task6 must not commit same-target candidates one-by-one.

14. Task4 fix round1/5 (1addressed,0open — distinct manifests; commits7327217..027ba68), independent /root/rereview_task4_r1 confirms all addressed/no new Important. Task4 complete12f74cd..027ba68 review clean. Ruling: Task5 confirmSelf is low-level validated synchronous mutation, Task6 service must serialize it on same writer queue as imports; no separate queue in Task5 — preserves one writer authority. Same-task multi-candidate group read view already supports differing source identities; Task5/6 target decision must authorize grouping.

15. Task5 ruling: preserve message_keys contract formalConversationId + adapter semantic idNamespace + originalId; do not encode owner/exporter metadata into namespace — explicit target resolution is separate from message-key reliability, metadata changes must not create duplicate keys — same-key dedup works after explicit target choice despite incomplete owner. Stable contradictory source conversation mapping handled in target resolution, no-ID ambiguity remains conservative. Implementer acknowledged.

16. Resume development after cost/status explanation: main72e80ea clean, fetch/pull success ahead10behind0. Ruling: use gpt-6.1-sol for ordinary implementation and scoped review; higher model only concrete difficult integration/final review. Persist findings early; focused verification, no repetitive full reread. Task5 final review file task-5-review.md has2Important: cross-namespace same-platform owner conflict, durable null self opt-out. Fix round1 /root/fix_task5_r1 dispatched base72e80ea, original implementer unavailable. Minimal additive schema migration allowed for durable preference, never rewrite v1.

17. Task5 fix round1/5 (2addressed,0open — cross-namespace owner/durable self optout;72e80ea..834c410), independent Sol re-review clean. Task5 complete027ba68..834c410. Task6 base834c410. Ruling: Full persisted import phase may be additive columns alongside existing generic status constraints, rather than destructive recreation of referenced tables — retain committed status/FKs and exact public phase map — choose minimal correct migration3.

18. Task6 implementer /root/implement_task6 (Sol high) base834c410. Ruling: extend TargetDecision with optional selfMemberKey?:string|null to carry approved pre-save identity UI selection — undefined existing reuse rules, null explicit optout, string validated staged member sourceKey — Task6 persists in same transaction after membership mapping and rejects conflicting same-target explicit choices. Existing post-save confirmSelf remains queued. No selection required for ordinary save/read.

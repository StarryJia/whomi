# 来源排序试验首次停止审计

只审计第一阶段，未结算整轮。原产物保持原样；未读取凭据或调用模型。

20 次请求：19 次通读、1 次压缩，37516 输入词元、17997 输出词元、350864 毫秒。120 条原文全部读完；0 次核查、0 次成稿；第二组未运行，准确性未评分。材料摘要 6f63b461c034eacaebc473ea5637bef13119aae59e286fa1d449347d9c6af756。

首次压缩为 request-20/response-20，16 项转 12 项，全部输入编号覆盖，无外来编号；正文 589 字低于目标 608；完整事实笔记 3548→2205 字节，缩小 37.85%。已知条目 8:0、11:0 只映射到 unknown，记录的失败为 INVALID_EVIDENCE。原 checkpoint 保持 142 叶、cursor 0、nextRoots 空、repairs 0，未接受该响应；体积与编号完整不能代替事实类别校验。

候选 1：call 12 读到消息 86 后提出（events 第 38 行 pending）；call 13 收到 87 的本人承认后自然 resolve（第 41 行 finished）；call 14 收到 91 的主动撤回后再次 resolve 更新（第 44 行 finished）。call 14–19 的请求持续收到同一候选的 finished 状态，最终 checkpoint 保留 86、87、91 三条原文摘录，均逐字匹配来源，rounds 为 0。63 原文曾在 call 9 通读；call 12 只见 relatedSourceIds 63，并未重复发送该原文。后续解释保留本月具体负担，撤回每次都由本人安排的绝对化说法；此证据说明通读自然解决候选，不能用来判断实际回读收益。

恢复前需要保留原 result/checkpoint/input/snapshot/requests/responses/events/attempts/run-profile 字节及本次 SHA-256 清单，并快照诊断修复实现。先用 validateReadingChain 在内存中把原 halt 内容当作 archivedHalt 做零网络验证。审定恢复后，将根 halt.json 原字节移动到 shared-workload-reading/halt-before-resume.json（目标必须不存在，移动后复核摘要），才允许建立新 shared-workload-reading-resume 目录。不要重写原错误或 checkpoint；恢复必须使用同 runId、50/104 预算，原 20 请求继续计费。

命令仅记录、没有执行：

```powershell
node scripts/insight-quality.mjs --long-comparison shared-workload reading --resume-reading --task-call-limit=50 --run-id=memory-source-order-20261116
```

本轮若进行诊断恢复，需额外确认原 coverage 违规回放及仅在副本消耗一次修复机会。原冻结实现首次失败与后续诊断必须分别说明，不能称为固定实现完成。原文件 48 份读取前后摘要一致；完整轨迹及摘要见同名 JSON。

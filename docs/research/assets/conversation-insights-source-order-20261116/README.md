# 来源排序试验归档

本轮`memory-source-order-20261116`已关闭失败，不再恢复。两阶段累计34次请求、58342输入词元、29217输出词元、538951毫秒有效时间。19次通读、15次压缩；0次核查、0次成稿，第二组未运行。自然候选1个、接受更新2次，没有最终报告或准确性评分。

[研究报告](../../conversation-insights-source-order-20261116.md)保留原设计和诊断修订经过。[归档核验](archive-audit.json)记录源文件摘要、复制范围与两份实现快照校验；[最终只读审计](audit.json)核对原文、元数据、来源继承和总账。审计通过表示这些证据一致，不表示试验完成或模型准确性通过。

## 主要证据

- [首次预注册](preregistration.md)和[首次实现清单](implementation.json)，对应`source/`中的13个文件。
- [覆盖协议修订记录](after-coverage-repair/preregistration.md)和[修订实现清单](after-coverage-repair/implementation.json)，对应其`source/`中的16个文件，包含恢复工具与测试材料。
- [首次阶段结果](shared-workload-reading/result.json)：20次请求后停止；原停止文件保留为[halt-before-resume.json](shared-workload-reading/halt-before-resume.json)。该目录保存原输入、20次请求与响应、检查点、事件及总账。
- [恢复阶段结果](shared-workload-reading-resume/result.json)：额外14次请求后停止；[迁移记录](shared-workload-reading-resume/recovery-migration.json)固定原检查点、请求与响应摘要，只在副本将已用修复次数从0设为1。恢复目录保存全部14次请求与响应。
- [最终停止记录](halt.json)保持原错误`INVALID_INSIGHT_OUTPUT`。旧响应20未被后续成功节点追认为已接受。
- [候选完整轨迹](offline/source-order-first-failure-audit.json)：消息86后提出，87后自然解决，91后再次更新；原文摘录逐字匹配，后续始终finished，核查轮数0。
- [阶段审计](offline/source-order-after-coverage-phase-summary.json)与[最终两次响应回放](offline/source-order-local13-14-parser-audit.json)：2694→2210/2192字节，分别缩小17.97%/18.63%，均通过完整事实解析，但未达到20%收缩要求。没有证明无法继续压缩。
- [零网络恢复验证](offline/source-order-coverage-resume-preflight.json)：原48份证据不变，副本承接20次调用，下一次请求为21且`repair:true`，无网络调用。
- [工程检查摘要](validation/summary.json)：84项专项、29项工具、类型检查和构建通过；全后端667通过、1个既有Grok端口环境失败；最新桌面目标流程1项通过、10.6秒。

## 保存与限制

158份原件共2351645字节按原字节复制，全部摘要一致；另外生成材料、检查摘要、归档核验及本说明。两组原材料见[materials.json](materials.json)，实际仅运行第一组。前两轮事实保留修复50次与本轮34次分别结算，三轮共84次、151868输入词元、77887输出词元；不含更早的长聊天初始对照。

敏感模式扫描未命中。运行时目录、数据库、已安装模型配置、凭据和基线源码压缩包未归档。`offline/`中的首次停止及阶段审计保留当时观察范围，整轮结论以研究报告、本说明和`archive-audit.json`为准。冻结的审计脚本使用原release路径，重放时须把它指向归档副本；不修改本归档的请求、响应或检查点。

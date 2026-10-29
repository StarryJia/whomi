# ChatLab 解析代码复用审计

固定来源为 ChatLab/ChatLab 的 f19beeadda27bd57eedc1bfbe75e7ed1b9e86833；2026-10-29 在引入代码前核对源码与锁文件。解析包是私有工作区包，并非公开 npm 产品。

复用范围：14 个 formats 模块、其必要 browser 工具、formats/utils/telegram-utils、types、format-ids、utils，以及共享类型中解析所需的枚举与接口。排除桌面业务、原生加速、预处理器、导入数据库和上游样本。虚构夹具由本项目编写，没有复制私人聊天或上游测试数据。逐文件原始 SHA-256 摘要及变更见 vendor 的 UPSTREAM.md。

上游根 LICENSE 为 GNU Affero General Public License v3（AGPL-3.0）；树内解析目录无独立许可覆盖。保留代码头、原始许可、来源与修改说明。分发修改版本时须核查对应源码、许可证与修改告知义务；远程网络交互的修改版本还涉及第 13 条。这里只批准本地开发，不据此宣称整个 Whomi 采用 AGPL，也不把本地打包测试称为公开发布授权。

现有 GSAP 3.15.0 与 @gsap/react 的许可指向 GSAP Standard License，其使用限制不能视为已证明与 AGPL 兼容。公开分发前仍需确认组合许可、对应源码和完整第三方声明；本任务不替换 GSAP、不替用户选择全项目许可证。AGPL 第 2 条允许在不传播情况下制作、运行和修改，当前没有发现阻止已授权本地集成的具体证据。此记录是工程审计，不是法律意见。

依赖按固定上游 pnpm-lock.yaml 锁定：stream-json 1.9.1、stream-chain 2.2.5、@types/stream-json 1.7.8、@types/stream-chain 2.1.0。直接导入的 stream-chain 显式声明，不依赖间接提升。两运行库声明 BSD-3-Clause，类型包声明 MIT；安装后复核。

原生分支通过 withNativeChatlab、withNativeWeflow、withShuakamiQqNative 包装 TypeScript 回退；本地复制断开包装器和预处理器入口，文件读取重定向到受控快照适配层，保持原始转换逻辑。上游部分流式读取会累积全部输出，不能当成有界流式解析。

Google Chat 模块消费 chatlab-google-chat-takeout 清单。用户已解压的 Takeout 目录由后续发现层准备清单，例如将一个虚构群的 group_info.json、messages.json 和 user_info.json 纳入同一受控快照。这里不声明原始 ZIP 导入能力。

## 实际验证范围

以下全部是自行编写的虚构夹具，证明这些结构经过固定版本模块与本地适配层的行为，不代表覆盖每个导出器版本、语言或所有历史导出。每一行均通过正例、非匹配探针、损坏输入及缺字段测试；消息数指原始记录数与输出消息数一致。Telegram 全量正例含两个会话。

| 模块标识 | 正例消息/会话数 | 模式 | 消息稳定标识范围 | 结果 |
|---|---:|---|---|---|
| chatlab | 2 / 1 | 受限全量 | 明确的 Discord、Telegram、Google Chat 平台消息键 | 通过 |
| chatlab-jsonl | 2 / 1 | 逐行事件 | 同上 | 通过 |
| qq-shuakami | 2 / 1 | 受限全量 | 导出内流水号不用于跨导出去重 | 通过 |
| qq-shuakami-chunked | 2 / 1 | 受限全量 | 同上；需白名单分块 | 通过 |
| weflow | 2 / 1 | 受限全量 | 非零 serverId/platformMessageId，微信消息命名空间 | 通过 |
| echotrace | 4 / 1 | 受限全量 | 同上；localId 不作稳定键 | 通过 |
| discord-tyrrrz | 2 / 1 | 受限全量 | 来源会话内 Discord 消息键 | 通过 |
| telegram-native | 4 / 2 | 受限全量 | 来源会话内 Telegram 消息键 | 通过 |
| telegram-native-single | 2 / 1 | 受限全量 | 同上 | 通过 |
| google-chat-native | 2 / 1 | 受限全量 | 来源会话内 message_id | 通过 |
| instagram-native | 2 / 1 | 受限全量 | 无已证明稳定消息键 | 通过 |
| whatsapp-native | 2 / 1 | 受限全量 | 无已证明稳定消息键 | 通过 |
| qq-native | 2 / 1 | 受限全量 | 无已证明稳定消息键 | 通过 |
| line-native | 2 / 1 | 受限全量 | 无已证明稳定消息键 | 通过 |

例如用户导入虚构 SIWX 四条记录时，可观察到 text、image、reply、unknown 四种类型；第一条正文保留首尾空白和换行，引用缺可靠目标键时保留摘要而不猜测关联，图片无媒体信息时保留 missing 描述。账号后缀不自动合并；isSend 与导出账号冲突产生警告，后续身份确认由任务 5 负责。

ChatLab、Google Chat 和 Instagram 的显式成员名单保留未发言成员。Instagram、LINE、WhatsApp 名称不作为稳定账号；未知 ChatLab 平台只保留会话内来源键。例如虚构平台 example-local 中 inactive 成员没有发言，仍保留其昵称和导出者提示，但 stableAccountKey 为 null。

所有受限全量输入最多 32 MiB，分块和 Google 清单关联文件按总字节数计；上游输出和原始记录会同时存在，32 MiB 不是进程内存上限。ChatLab JSONL 单文件最多 2 GiB，每条原始行在累积时执行 8 MiB 上限，规范化消息另受 8 MiB 限制。成员索引会随不同发送者数量增长；没有宣称任意规模下恒定内存。取消在读取、事件和记录间检查；全量 JSON.parse 本身不可中断。大规模性能验证留给任务 11。

来源探针只有扩展名、最多 64 KiB 前缀和大小；检测分数仅用于候选识别。快照门禁拒绝未列出的文件、目录联接别名和打开前已替换的文件，先核对文件描述符再读字节。门禁不会创建不可变副本或计算文件摘要；这些由任务 4 完成。不得将可被任意改写的用户原文件直接作为正式 ParserInput 使用。

## 依赖安全检查与兼容性限制

2026-10-29 执行 `npm audit --json --registry=https://registry.npmjs.org --offline=false`，结果为 stream-json 一个 moderate 依赖、三条公告，无 high/critical。依赖仍锁定 1.9.1，未声称审计清零，也未未经验证升级到大版本 3.x。

- [嵌套过滤器的平方复杂度](https://github.com/advisories/GHSA-528h-pc64-c93x)：上游确实使用 Pick。适配层在调用任何上游解析前线性扫描 JSON，最大容器嵌套 128 层，超限阻断。虚构 129 层数组得到 json-depth，且没有会话事件。
- [Assembler 原型污染](https://github.com/advisories/GHSA-mjw6-4jj6-33hc)：上游确实使用 Assembler/StreamValues。适配层用原生 JSON.parse 预检所有 JSON 输入，拒绝解码后的 __proto__、constructor、prototype 属性，包括 Unicode 转义拼写；普通正文包含这些词仍可导入。虚构恶意属性得到 unsafe-property，且没有会话事件。
- [JSONC 注释重复扫描](https://github.com/advisories/GHSA-hqr4-qq8f-hg3x)：本闭包不调用 JSONC 解析/校验入口；预检只接受严格 JSON，包含注释的对象被拒绝。

这些门禁是本应用入口的缓解措施，不是对依赖包的补丁。直接绕过适配器调用 vendor、引入新的读取路径或更换预检链路时必须重新审计；未来兼容升级可移除对应包级风险。兼容性代价是嵌套超过 128 层、或任何层具有上述三个属性名的文件会被阻断，即便导出器将其当普通元数据使用。现有虚构夹具全部在限制内。安全测试不替代真实源文件不可变快照及后续集成验证。

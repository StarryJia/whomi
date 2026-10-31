# Cherry 对话模块接入记录

2026-10-31 阅读完善已追加：回答使用 Cherry MarkdownCore，标题与统计改为读取该轮生成时的模型版本；摘要与主要详情共用生成速度，并加入原始回答复制。下方关于统计显示当前模型的描述为本次完善前行为。完整来源、适配与截图见[阅读完善记录](../designs/whomi-conversation-reading-polish.md)。例如模型改名或停用后，已有回答不随当前模型菜单改名。

本轮固定参考 Cherry Studio 提交 `f19aa72f969b782ed72f81be80976b237ae26605`。上游包版本标记为 2.1.9；没有把这一标记当作用户截图所用版本的证明。许可证全文见 `electron/vendor/cherry-studio/LICENSE`，业务模块按 AGPL-3.0 记录。

## 来源与适配

| 上游文件 | Whomi 文件 | 已接入的行为与必要差异 |
| --- | --- | --- |
| `src/renderer/components/composer/variants/ChatComposer.tsx`、`ComposerCore.tsx`、`ComposerSurface.tsx` | `src/components/conversation-ai/workspace.tsx` | 采用输入、工具栏、模型入口和提交后的草稿交接；Whomi 使用本地请求快照、当前会话引用及后台线程。例：发送问题后立即腾出输入区，回答期间写下的新问题不会被旧回答完成事件清空。 |
| `src/renderer/components/ModelSelector/ModelSelector.tsx`、`ModelSelectorRow.tsx`、`useModelSelectorData.ts` | `src/components/conversation-ai/model-selector.tsx`、`src/data/conversation-ai-client.ts` | 使用同类 Radix 浮层，按启用服务商分组，按名称、编号、服务商或分组搜索；支持方向键、首尾键、回车和 Escape，选择后恢复焦点。例：两个服务商都有同名模型，选择结果仍保留正确的服务商编号。 |
| `src/renderer/components/chat/messages/frame/MessageTokenDetailsCard.tsx`、`messagePerformance.ts` | `workspace.tsx`、`message-performance.ts` | 采用模型与服务商标题、生成时间、三项主要统计及两列详情；生成速度扣除首个输出前的等待，端到端吞吐包含等待。例：100 个输出单位、总耗时 10 秒、首个输出等待 9 秒，分别显示 100 和 10 Token/秒。 |
| `src/main/ai/runtime/agentContextWindow.ts`、`src/main/ai/runtime/pi/modelInjection.ts` | `src/shared/model-limits.ts`、`electron/agent/runtime.ts` | 未声明容量保持空值，请求层使用上游 256000 上下文与 8192 最大输出回退值；Whomi 限制实际输出小于上下文，并按最大输入裁剪材料。例：目录没给容量时，设置不冒充已知 256K，但请求仍可执行。 |

上游文件均可从[固定提交](https://github.com/CherryHQ/cherry-studio/tree/f19aa72f969b782ed72f81be80976b237ae26605)按路径核查。布局尺寸、交互状态和计算方式迁入后，颜色、字体和边框使用 Whomi 主题。源模块依赖 Cherry 的全局会话、工具和云服务状态；这里接入现有本地接口，没有直接引入这些应用级依赖。

## 数据含义

Pi 是本项目使用的模型会话运行库。它的输入计数不含已命中的缓存，服务商报告的总输入另存为 `totalInputTokens`。统计中的输入优先使用服务商总数，旧记录才按已报告的未缓存、缓存读取与缓存写入相加。缺失字段显示横线，不把未知值填成零。

请求开始、结束时间来自本轮实际调用，完成后进入本地用量记录，重启后仍可查看。历史记录没有时间戳时显示横线；不使用打开统计窗口的时间伪装生成时间。缺少首个输出时间时，模型生成速度保持未知，只显示能计算的端到端吞吐；这里没有采用上游旧记录计算中把缺失等待时间设为零的回退。统计显示当前已配置模型的名称，模型被删除时使用通用名称，未声称已保存历史名称快照。

## 状态与边界

- 同一时刻只有一个输入区。打开 AI 对话后，原文区域不显示重复引用或前往右侧的提示；已发送引用归入对应消息。
- 失败重试沿用原请求，保留后来输入的草稿。停止、离页、模型保存失败和后台恢复仍走既有本地线程接口。
- 分析浮层中的模型菜单有明确归属，点击其选项不会触发父浮层的外部关闭；Escape 先关闭当前子菜单。
- Whomi 当前运行链路接入单个文本模型。Cherry 的多模型并发、工具调用、联网检索、附件输入、历史消息编辑分支和流式跟进队列没有因此接入；页面未添加无效入口。这是当前兼容边界，不能把本轮交付称为整个 Cherry 对话模块已原样移植。

## 验证

失败回归和修复覆盖草稿交接、新草稿不被覆盖、原请求重试、引用唯一呈现、同名模型归属、嵌套菜单、缓存统计、未知容量请求回退及统计重启持久化。桌面使用临时数据库、合成聊天和本机受控模型服务，不读取用户聊天或密钥。完整结果及截图见本轮验收记录。

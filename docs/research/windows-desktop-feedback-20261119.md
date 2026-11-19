# Windows 手测反馈验收

基线为 `origin/main` 的 `6b9d5db`。维护者确认从该基线建立独立分支，并批准历史报告尺寸、26 项预置与错误日志目录策略。

| 工单 | 可观察结果 |
| --- | --- |
| [#30 对话面板顶栏](https://github.com/StarryJia/whomi/issues/30) | Windows 还原窗口中，面板顶栏左、中、右均能移动主窗口，重开后可继续拖动。示例横坐标依次从 360 到 390、390 到 360、360 到 390。系统按钮和对话按钮可点击，分隔线只调节面板。 |
| [#31 历史报告宽度](https://github.com/StarryJia/whomi/issues/31) | 同一份合成《我们的记忆》在 960、1200、1920 像素窗口中的宽度分别为 720、900、960 像素，正文分别为 655、790、790 像素。缩回 960 后可滚动至末段，关闭按钮始终可操作，Escape 与关闭按钮均返回原行。普通删除确认框仍为 440 像素。 |
| [#32 模型服务预置](https://github.com/StarryJia/whomi/issues/32) | 新配置默认展示 26 项，搜索 OpenRouter 无预置结果。合成升级样例中，已保存的 OpenRouter 默认模型使用原来的本机模拟地址和凭据完成对话，通过「添加服务商」配置的中转模型重启后可在选择器选用。 |
| [#33 错误日志目录](https://github.com/StarryJia/whomi/issues/33) | 示例数据目录设在 D 盘，可用资源管理器打开其 `logs` 并定位模型、洞察和导入故障。合成洞察读完 1 条后用尽输出预算，日志按编号记下成稿阶段和 32,768 词元上限。另覆盖空目录、目录写入权限、用户目录备用、原目录回查、旧导入记录和迁移。 |
| [#34 洞察任务行](https://github.com/StarryJia/whomi/issues/34) | 示例任务的标题、进度、用时、状态、模型名称和空白打开同一任务。暂停、继续、重试及详情分别操作，鼠标和键盘均已检查。窄窗用例额外检查换行和点击范围。 |
| [#36 系统提示词](https://github.com/StarryJia/whomi/issues/36) | 设置可编辑人工智能对话及洞察阅读、核查、成稿。合成旧库仍能读《我们的记忆》，旧任务在第二批恢复并使用原提示词。旧报告和提示词证据分别由前端和后端覆盖。 |

## 预置范围

保留 OpenAI、OpenAI Codex、Anthropic、Gemini、深度求索、智谱开放平台、Z.ai、月之暗面国内版和海外版、百川、千问 AI 平台、QwenCloud、阶跃星辰、豆包、MiniMax 国内版和海外版、Grok、Mistral、Perplexity、腾讯云 TokenHub、百度云千帆、龙猫、小米 MiMo、英伟达、Ollama 和 LM Studio。TokenHub 等平台保留第一方模型的官方接入，Ollama 和 LM Studio 提供本机模型连接。[TokenHub 迁移指南](https://cloud.tencent.com/document/product/1823/131382) · [英伟达模型目录](https://build.nvidia.com/explore/discover) · [LM Studio 本机服务](https://lmstudio.ai/docs/developer/core/server)

移出 CherryIN、硅基流动、AiHubMix、Intel OVMS、ocoolAI、Alaya NeW、DMXAPI、唯一 AI、BurnCloud、302.AI、蓝耘科技、PH8、SophNet、PPIO 派欧云、七牛云 AI 推理、OpenRouter、AMD GPU Cloud、TokenDance、New API、LiteLLM、Claude Code、Grok CLI、oMLX、OpenCode Go、Azure OpenAI、Vertex AI、GitHub Copilot、Groq、Together、Fireworks、Jina、ModelScope 魔搭、天翼云息壤、GPUStack、Voyage AI、AWS Bedrock、Poe、Hugging Face、Vercel AI Gateway、Cerebras AI、ComfyUI。此名单包含聚合转发服务、其他推理和本机运行产品，以及需专用认证或面向其他任务的入口。已配置账号继续显示于账户列表。[OpenRouter 路由说明](https://openrouter.ai/blog/insights/model-routing/)

## 实际回归

- 前端全量 646 项通过，整体复审后再次运行设置及洞察两组用例，33 项通过。后端全量 753 项通过。类型检查、网页构建和桌面构建通过。
- 14 项定向 Windows 场景均有通过记录。复审后的合并运行通过 11 项。资源管理器截图曾因前台焦点和按窗口句柄截图超时中断，独立复测通过 1 项，实测 D 盘和用户目录。另两项模拟订阅账号测试在对齐居中详情栏、全局提醒和关闭提醒的操作后均通过。
- 首次原生拖动复现窗口横坐标停在 360。历史报告样例补齐后实际复现了 440 像素的旧弹窗宽度。各次运行分别保留版本、命令、时间、退出码、完整标准输出和标准错误、结果及关键截图。

## 待维护者复核

用已有真实备用资料升级安装版，检查默认模型仍可用、旧报告可读、暂停任务按原指令恢复。在没有 D 盘的 Windows 设备打开错误日志目录。日志和测试截图使用隔离资料及模拟模型服务，未发送真实聊天或调用付费模型。大批次洞察的性能和预算优化见 [#35](https://github.com/StarryJia/whomi/issues/35)。

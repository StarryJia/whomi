# Cherry 文本连接协议接入记录

2026-10-31。固定来源为 Cherry Studio 提交 `f19aa72f969b782ed72f81be80976b237ae26605`。本轮接通其自定义服务商的四种文本协议，范围是 Whomi 已有的文本分析、模型连接检测和对话；没有迁入整个 Cherry 服务商平台。

## 来源核查与复用

该提交的入口已经是 [ProviderEditorDrawer.tsx](https://github.com/CherryHQ/cherry-studio/blob/f19aa72f969b782ed72f81be80976b237ae26605/src/renderer/pages/settings/ProviderSettings/ProviderList/ProviderEditorDrawer.tsx)，不是旧路径的 AddProviderPopup。实际选项来自 [customProviderCreation.ts](https://github.com/CherryHQ/cherry-studio/blob/f19aa72f969b782ed72f81be80976b237ae26605/src/renderer/pages/settings/ProviderSettings/ProviderList/customProviderCreation.ts)。文本协议与 Pi 的对应关系核查自 [piModelCompatibility.ts](https://github.com/CherryHQ/cherry-studio/blob/f19aa72f969b782ed72f81be80976b237ae26605/src/shared/ai/piModelCompatibility.ts)，运行时地址处理和凭据注入参考 [modelInjection.ts](https://github.com/CherryHQ/cherry-studio/blob/f19aa72f969b782ed72f81be80976b237ae26605/src/main/ai/runtime/pi/modelInjection.ts)。上述文件按上游 AGPL-3.0 处理。

| 自定义文本端点 | Whomi / Pi 协议 | 实际请求和模型目录 |
|---|---|---|
| OpenAI Chat Completions | `openai-completions` | `POST /chat/completions`；`GET /models`；Bearer 密钥 |
| OpenAI Responses | `openai-responses` | `POST /responses`；`GET /models`；Bearer 密钥 |
| Anthropic Messages | `anthropic-messages` | `POST /v1/messages`；`GET /v1/models`；`x-api-key` 和版本头；目录使用 `after_id` 分页 |
| Google Generate Content | `google-generative-ai` | `POST /models/{model}:streamGenerateContent`；`GET /models`；`x-goog-api-key`；目录使用 `pageToken` 分页 |

表中路径相对于填写的接口前缀；Anthropic 的 `/v1` 由其软件开发工具包添加，Whomi 会先去掉地址末尾重复的 `/v1`。OpenAI 和 Google 原样使用用户填写的根路径或自定义前缀，不推断或追加版本目录。例：已有 OpenAI 示例地址 `http://127.0.0.1:1234` 仍请求 `/models` 和 `/chat/completions`；Anthropic 示例地址 `https://example.test/proxy/v1` 请求 `/proxy/v1/messages`；Google 示例 `https://example.test/v1beta` 请求 `/v1beta/models/example-model:streamGenerateContent`。这些是合成示例，不是已验证的公网服务。

上游同一创建入口还包含图片生成和图片编辑两个端点，它们不属于文本协议。Azure 的专用适配器属于预设平台配置，也不是上述四种自定义文本选项。当前未接入图片生成、云账号登录、Azure 专用部署参数、Vertex 或 Bedrock 认证，界面没有提供这些无法执行的选项。

## 已实现的操作与数据行为

采用已有 Pi 完整软件开发工具包 1.4.0 的四个原生适配器，不另写文本流解析器或引入新运行依赖。`src/shared/model-protocol.ts` 统一协议枚举、标签、旧值默认和运行地址；`electron/agent/protocol-usage.ts` 识别各协议实际报告的计数。

- 用户创建或编辑服务商时选择连接协议，保存后目录同步、连接检测、分析和对话都使用同一个值。例：将示例服务改为 Anthropic 后，模型目录通过 `x-api-key` 请求，后续文本生成调用 Messages；不再向该地址发送 Chat Completions 请求。
- 服务商的协议变更会创建关联模型的新版本，并使用已有活动任务保护。旧分析、旧对话绑定的模型版本保留原协议和加密凭据；没有协议字段的旧记录按 Chat Completions 读取。例：已有模型版本 1 使用 Chat Completions，改协议后版本 2 使用 Anthropic，版本 1 数据不被覆盖。
- 密钥沿用主进程加密通道；公开设置快照只返回是否存在密钥。原始密钥通过 Pi 的运行时凭据接口传递，注册配置只含固定占位符。例：合成密钥 `!literal-$key` 按原字符发送，不被解释成命令或环境变量。
- 目录解析只保留允许的模型字段，Google 的 `models/` 前缀会转为调用所需的模型编号，明确只支持嵌入的条目不加入文本列表；Google 输入上限只保存为最大输入，不伪造总上下文。目录同步不会自动添加模型，仍由用户选择确认。例：目录包含文本模型 `models/first` 和仅嵌入模型时，只展示文本条目 `first`。
- Anthropic、Google 的分页受总响应字节、总条目数、页数和重复游标限制；拒绝重定向。目录中途失败不会返回一份伪装完整的部分结果，也不改动已保存模型。例：远端反复返回同一 `nextPageToken` 时同步报错，用户可重试或手动添加。
- 用量按各协议实际字段计算：Responses、Chat Completions 和 Google 的输入总量包含缓存，Anthropic 的普通输入、缓存读取、缓存写入分别报告；未报告字段保持未知。例：合成响应报告输入总量 12、缓存读取 2、输出 3 时显示普通输入 10、总输入 12、输出 3；未报告用量时不显示虚构的零。

Whomi 目前仍是一条服务商记录对应一个文本协议和一个接口地址。Cherry 原入口允许同一服务商配置多个端点并选择默认端点；该多端点编辑能力没有迁入。当前选择控件复用已有 Radix 选择基础并映射 Whomi 主题，不宣称是上游多端点编辑表单原样迁入。

## 验证证据与限制

新增 `tests/backend/provider-protocols.test.ts` 在系统临时目录创建隔离数据库和本机 HTTP 模拟服务，使用合成密钥及合成模型。首次运行观察到三种新增协议仍请求错误路径、配置校验拒绝协议字段，共 7 项预期失败；接入后通过。

- 四种原生请求路径、认证头、输入正文、流式输出、真实用量与缓存计数均经实际 Pi 请求验证。
- 三种新增协议的模型目录认证、Google 与 Anthropic 两页结果、协议版本固定、旧配置默认、未知协议拒绝及密钥不返回公开快照均通过。
- 四种协议缺少计数时保持未知、401 错误不隐式重试、不透传服务端错误正文、取消不返回已提交检查点，以及重复页游标拒绝均通过。
- 初轮协议集成测试 13 项通过；此前同轮关联 Pi 运行器、设置服务、设置仓库回归共 37 项通过。主进程 TypeScript 检查通过。随后针对根路径地址补充 5 项回归，先观察到旧配置目录、旧模型运行和显式 OpenAI / Google 协议运行全部失败，再移除自动追加版本目录的行为；协议与设置服务定向回归最终 2 文件、25 项通过。
- 设置表单回归实际打开协议菜单、选择 Anthropic 并保存，检查提交的数据包含协议字段；单项通过。桌面设置流程已验证四种协议菜单、模型目录与编辑，截图见 `release/design-review-refinements-20261031/04-protocol-options.png`。完整结果见[会话与模型交互补正](../designs/whomi-conversation-model-refinements.md)。

Anthropic 请求中的 `?beta=true` 来自当前 Pi 所调用的 Anthropic 客户端，已通过本机实际请求确认。上述验证证明本地协议接线和受控响应行为，没有使用真实云端凭据或调用付费服务，也不证明任意第三方兼容网关支持同一可选参数、模型容量或流格式。

# Cherry 预置模型服务商

固定来源为 CherryHQ/cherry-studio 的提交 `f19aa72f969b782ed72f81be80976b237ae26605`。本地目录合并 Cherry 注册表中全部地区的服务商，沿用条目顺序。截图中用户自己添加的服务商不属于预置来源。

- `registry.json` 保存注册表版本、67 个稳定编号、原名、简体中文显示名、原始文本和非文本端点地址、适配器类型、地区、公开服务商链接及源文件声明的认证类型。网页字段 `apiKey` 表示申请密钥的网址。服务商初始记录与实际凭据分开。[源注册表](https://github.com/CherryHQ/cherry-studio/blob/f19aa72f969b782ed72f81be80976b237ae26605/packages/provider-registry/data/providers.json) · [固定版本初始化逻辑](https://github.com/CherryHQ/cherry-studio/blob/f19aa72f969b782ed72f81be80976b237ae26605/src/main/data/db/seeding/seeders/presetProviderSeeder.ts)
- 显示名通过 `providerKeyMap` 将编号映射到简体中文词条，例如 `silicon` 显示为硅基流动，`gateway` 对应 `provider.ai-gateway`。仅提取设置列表实际使用的词条。[映射](https://github.com/CherryHQ/cherry-studio/blob/f19aa72f969b782ed72f81be80976b237ae26605/src/renderer/i18n/label.ts) · [中文词条](https://github.com/CherryHQ/cherry-studio/blob/f19aa72f969b782ed72f81be80976b237ae26605/src/renderer/i18n/locales/zh-cn.json)
- Cherry 的服务商初始化器写入服务商行。模型目录中的能力、定价与供应商模型覆盖记录用于模型检索，不是用户已添加的模型。CherryAI 和本地嵌入产品有独立初始化器，上游通用服务商设置页专门隐藏这两项。因此本目录中的 67 个可见服务商不自动添加模型。[列表可见条件](https://github.com/CherryHQ/cherry-studio/blob/f19aa72f969b782ed72f81be80976b237ae26605/src/renderer/utils/providerSettings.ts)
- `index.ts` 将 Cherry 的默认文本端点转换成 Whomi 的协议名与实际请求根地址。例如 OpenAI 库内原值为 `https://api.openai.com`，运行时补成 `https://api.openai.com/v1`；已有 `/v3/openai/`、`/v4/` 等版本路径时予以保留。Anthropic 由 Whomi 的客户端补请求版本。注册表中保留原始地址；`baseUrls` 对应有明确地址且 Whomi 能表达的文本协议。需要自行输入地址的 GPUStack 保留空地址。Ollama 选用其显式声明的 Anthropic 兼容端点。专用认证、非文本服务和 Vercel 原生网关保留原条目及说明，不混作四种通用文本客户端。[Cherry 地址处理](https://github.com/CherryHQ/cherry-studio/blob/f19aa72f969b782ed72f81be80976b237ae26605/src/main/ai/provider/config.ts) · [版本路径处理](https://github.com/CherryHQ/cherry-studio/blob/f19aa72f969b782ed72f81be80976b237ae26605/src/shared/utils/api/format.ts)
- `icon-keys.json` 与 `art/` 按上游 `resolveProviderIconRef` 的顺序解析编号别名，先查服务商标志，再查模型标志。67 项复用 63 个本地轻色矢量资源。OpenCode 使用上游组件转引的通用 `open-code.svg`，AMD GPU Cloud 将上游组件里内嵌的徽标和布局还原为静态 SVG，其余资源来自固定版本的图标目录。客户端不访问任何远程图片。[品牌映射](https://github.com/CherryHQ/cherry-studio/blob/f19aa72f969b782ed72f81be80976b237ae26605/packages/ui/src/components/icons/registry.ts) · [上游图标](https://github.com/CherryHQ/cherry-studio/tree/f19aa72f969b782ed72f81be80976b237ae26605/packages/ui/icons)

New API 和唯一AI 使用同一上游 `newapi` 适配器。它们为多种协议声明端点，但是只填一份主机地址，切换时由当前协议决定路径。例如 New API 预设从 OpenAI 切换到 Google 后应从 `http://localhost:3000/v1` 改为 `http://localhost:3000/v1beta`。Whomi 只为注册表实际声明的文本协议派生这些地址，保留原始空字段。其他缺少地址的预置不会借用该规则。[上游 New API 路径格式化](https://github.com/CherryHQ/cherry-studio/blob/f19aa72f969b782ed72f81be80976b237ae26605/src/main/ai/provider/config.ts#L955-L977)

67 项中，56 项可以进入 Whomi 的文本连接配置，11 项仅展示资料与对应说明。Jina 在注册表中声明了 OpenAI 风格端点，但该地址公开的聊天请求模型为文档图像识别的 `jina-ocr-v1`，所以按资料项处理。[Jina 官方 API 定义](https://api.jina.ai/openapi.json)

更新时按 `providers.json` 的编号和顺序逐条核对初始化规则、中文词条、原始端点与登录方式。核对新增服务商和图标别名，再检查四种协议的请求路径。不要根据注册表的模型覆盖记录自动为用户配置模型；也不要将端点元数据解释为对所有账户或模型的端到端验证。

注册表采用 [MIT 许可证](LICENSE)，Cherry 界面包 [package.json](https://github.com/CherryHQ/cherry-studio/blob/f19aa72f969b782ed72f81be80976b237ae26605/packages/ui/package.json) 同样声明 MIT。品牌标记归各自权利人。Cherry 应用中的简体中文标签等沿用项目已有的 [AGPL-3.0 许可声明](../../../electron/vendor/cherry-studio/LICENSE)。

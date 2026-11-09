# Cherry 对话核心隔离兼容验证

2026-11-08。关联 [003 · AI 对话模块对齐 Cherry](../planning/ideas/003-cherry-chat-alignment.md)。用户明确批准约 1–2 小时的隔离验证；本轮没有正式迁入产品页面，也没有扩大附件、工具或材料访问范围。

本文保留隔离研究阶段的结果。原型文件仍在 `D:/University/github/whomi/prototypes/cherry-chat-alignment`，下方原型链接指向该研究工作区；未将原型代码带入正式开发工作区。正式迁入后的结果见[产品验收记录](cherry-chat-migration-acceptance.md)。

**结论：已验证的输入核心、消息列表及滚动模块可以接入现有 Whomi 后端。** 桌面流程 9 项操作断言、来源校验及原型构建通过；严格运行诊断未通过，捕获到 61 条尺寸观察器通知。独立诊断未观察到停止或完成后的持续通知、静置抖动或阅读位置漂移。这里证明的是有限范围内可以复用，没有证明整套 Cherry 聊天工作区可以直接替换，也没有交付正式产品功能。

## 验证对象与证据边界

固定 Cherry 提交为 `263667f7a99dfed736c939708a55deb435164820`。原型在 `prototypes/cherry-chat-alignment`，使用独立依赖清单和本机合成数据。已有未提交文档改动保持原样；正式 `src`、`electron`、根 `package.json` 及锁文件未修改。

| 层次 | 实际运行内容 | 本轮不能推出的结论 |
|---|---|---|
| 输入器 | 原 ComposerCore、ComposerSurface、完整 Tiptap 编辑运行逻辑和发送、停止控件 | 未迁入 ChatComposer、AgentComposer 的完整应用状态；草稿接入由原型宿主管理 |
| 列表 | 原 MessageVirtualList、滚动跟随、阅读归属、锚点和位置记忆 | 未迁入 MessageListProvider、MessageGroup、MessageFrame、历史编辑和分支操作 |
| 基础控件 | 原 Button、ScrollArea、Tooltip、Popover 和门户上下文 | 原型主题和发送图标不是 Cherry 完整视觉主题 |
| 正文 | Whomi 已迁入的 Cherry MarkdownCore 与既有分块适配 | 未证明升级或整体迁入能修复模型输出中的不规范加粗语法 |
| 数据与生成 | 正式 Whomi 客户端、会话服务、数据仓库、SQLite、PiRuntime，经本机服务生成合成回答 | 未调用真实云模型，合成用量不是性能或计费结论；未验收正式 Electron 跨进程通信 |

共核对 65 个复用文件：输入器 49 个、列表与滚动 10 个、共用控件 6 个。原输入与滚动逻辑没有重写；导入路径适配保留清单，65 个缓存原文件与固定提交的 Git 对象一致。[可复查脚本](D:/University/github/whomi/prototypes/cherry-chat-alignment/verify-source.mjs) · [输入器清单](D:/University/github/whomi/prototypes/cherry-chat-alignment/composer/source-manifest.json) · [列表清单](D:/University/github/whomi/prototypes/cherry-chat-alignment/messages/source-hashes.json)

## 已取得的运行证据

后端连续场景已通过正式客户端到本机 Pi 调用的完整链路：生成、停止保留部分文本、失败后原轮次重试、关闭并重新打开数据库、拒绝跨会话引用和不开放模型配置写入。失败重试沿用同一轮编号，尝试次数变为 2，没有新增重复提问。[后端验证](D:/University/github/whomi/prototypes/cherry-chat-alignment/backend/probe.test.ts)

原列表独立核查中，同一轮合成文字从 744 增到 816 个字符，内容高度从 5254 增到 5335 像素，向上阅读的位置保持在 3885。停止后等待 800 毫秒，文本和位置都未变化，仍处于阅读状态；点击原回底按钮后恢复跟随，距底部为 0。960×720 窗口未出现页面横向溢出。[几何与状态记录](D:/University/github/whomi/prototypes/cherry-chat-alignment/messages/evidence/reading-stop.json) · [阅读期间内容增长](D:/University/github/whomi/prototypes/cherry-chat-alignment/messages/evidence/reading-during-growth.png) · [停止后保留阅读位置](D:/University/github/whomi/prototypes/cherry-chat-alignment/messages/evidence/stopped-while-reading.png)

最终桌面复跑于北京时间 2026-11-08 19:32 完成，9 项操作断言通过，另 1 项严格运行诊断未通过，脚本以非零状态退出。窗口由隐藏改为非激活显示，使用真实鼠标与键盘操作；组合输入例外，使用合成浏览器事件。主执行者复核了运行记录、断言及关键截图。完整证据见[最终运行记录](assets/cherry-chat-alignment/verification.json)和[来源校验结果](assets/cherry-chat-alignment/source-verification.json)。

| 场景 | 实际结果 |
|---|---|
| 中文组合输入 | 合成组合输入期间按 Enter，没有新增轮次；未验证 Windows 系统输入法候选窗 |
| 正常发送及新草稿 | 回答真实渲染为表格；发送后输入区腾出，生成期间输入的下一条草稿保留 |
| 引用返回 | 点击本轮引用 1 后，高亮对应合成原文，引用 2 未被高亮；未覆盖正式应用的跨页原文定位 |
| 上滚与恢复跟随 | 最终复跑中内容高度 4954→5174 像素，阅读位置保持 3642；原回底按钮恢复跟随，新增文字继续显示在底部 |
| 停止 | 保留 336 个字符，等待 800 毫秒后没有继续增长 |
| 失败重试 | 第 5 轮失败后在同一编号重试，尝试次数为 2，没有新增提问，后来输入的草稿保持不变 |
| 数据库重开 | 真实关闭服务与 SQLite，再打开同一数据库，轮次编号、状态和文本一致 |
| 关闭及打开面板 | 对话区域隐藏后可再次打开，草稿和已存消息保持；没有宣称卸载或重启应用后恢复未发送草稿 |
| 960×720 窗口 | 输入器和发送操作可见，文档宽度为 960，没有横向溢出 |

早期报告仅监听 Playwright 页面错误，未捕获浏览器原生窗口错误通知。主执行者从 Vite 日志发现缺口后，补充了导航前的窗口错误和未处理拒绝捕获，没有屏蔽通知。最终复跑捕获 61 条 `ResizeObserver loop completed with undelivered notifications.`，因此严格的零运行错误断言失败；其中初始加载 1 条、正常生成 25 条、滚动与跟随场景 9 条、失败重试场景 26 条，未捕获其他错误类型。

独立尺寸诊断另捕获 47 条同类通知，均在内容增长期间；完成、停止及窄窗口后分别静置 2.5 秒，新增通知与观察器回调均为 0。上滚阅读时内容高度 2686→2965 像素，位置保持 1478，停止后也未漂移。每条通知同帧都有虚拟列表库 virtua 的尺寸回调；这能说明时间相关性，尚不能证明唯一原因。virtua 0.49.1 的[官方说明](https://github.com/inokawa/virtua/blob/0.49.1/README.md#what-is-resizeobserver-loop-completed-with-undelivered-notifications-error)列有该现象，本次没有修改原核心或过滤日志使检查通过。[独立诊断记录](D:/University/github/whomi/prototypes/cherry-chat-alignment/messages/evidence/resize-observers.json)及[核查边界](D:/University/github/whomi/prototypes/cherry-chat-alignment/messages/README.md)保留详细数据；这些有限样本不代表所有尺寸变化场景都没有影响。

最终复跑的控制台错误与页面外网请求计数均为 0，请求监听在页面导航前建立，没有拦截网络。后台模型端点固定为 127.0.0.1；本次未进行系统级流量审计。

关键截图均为同一原型的真实窗口，使用合成数据，不是 Cherry 原应用的视觉一致性对照：

- [初始窗口](assets/cherry-chat-alignment/01-initial-1280.png)、[表格与下一条草稿](assets/cherry-chat-alignment/02-table-and-next-draft.png)。
- [生成期间上滚阅读](assets/cherry-chat-alignment/03-streaming-reading-held.png)、[停止保留部分回答](assets/cherry-chat-alignment/04-stopped-partial-answer.png)。
- [失败时保留新草稿](assets/cherry-chat-alignment/05-failure-and-draft.png)、[原轮重试完成](assets/cherry-chat-alignment/06-retry-completed.png)、[960×720 窗口](assets/cherry-chat-alignment/07-narrow-960.png)。

## 试验暴露的接入工作

| 实际问题 | 根因与处理 | 对正式迁入的含义 |
|---|---|---|
| 开发服务首次请求失败 | 原型使用 Vite 的 runner 配置加载器，后台请求时模块运行器已关闭；改用默认配置打包加载方式 | 属于原型启动方式，不能算 Cherry 组件不兼容；正式应用仍需按自己的主进程接线 |
| 输入器启动时崩溃 | 原日志接口调用 `verbose`，最初的外围服务替身未提供；补齐日志接口，原编辑代码不变 | 必须列清原组件需要的宿主服务，不能只复制可见组件 |
| 隐藏窗口上滚后仍在跟随 | 隐藏 Electron 窗口没有派发滚轮事件；显示临时窗口后同一输入送达，阅读状态正常 | 验收必须观察真实事件，不能用程序设置滚动位置代替用户上滚 |
| 程序定位表格与跟随冲突 | 流式列表仍在跟随时，脚本要求程序滚入指定元素；源逻辑会继续回底 | 测试应先通过真实鼠标滚动进入阅读状态，再检查目标内容可见 |
| 严格运行诊断失败 | 原生窗口错误通道捕获到尺寸观察器通知；独立采样未发现静置后的持续循环或位置漂移 | 保留未通过状态和原始通知，正式迁入时覆盖更多内容尺寸及长会话场景 |

滚轮诊断保存了输入前后的滚动位置和捕获事件。隐藏时滚轮与滚动事件均为 0，显示后真实滚轮到达且原跟随状态转为关闭；没有为通过测试修改上游滚动逻辑。[诊断记录](D:/University/github/whomi/prototypes/cherry-chat-alignment/messages/evidence/wheel-diagnostic.json)

## 采用建议与剩余范围

采用 Cherry 原输入核心及列表滚动模块，复用 Whomi 的 Pi、会话服务与数据库，自行实现必要的消息、事件及引用接入。验证中不需要迁入 Cherry 整套数据库或云服务，也没有触发扩大材料范围的停止条件。例如用户停止回答时，原停止控件调用 Whomi 终止请求；保存与恢复继续使用现有数据仓库。

完整消息外壳、消息动作、历史编辑、草稿与引用呈现仍需逐项核对宿主接口。例如修改较早提问后，后续回答如何保留和分支尚未验证，不能只接一个编辑按钮就称为与 Cherry 一致。附件、语音、工具、多模型及快捷面板仍在本轮范围之外。

原型构建通过，但入口压缩后约 1.09 MB、输入器延迟加载块约 450 KB，构建仍提示大分块。这些是原型构建大小，不是正式安装包增量或启动性能结论；正式迁入时需保留按需加载并重新衡量实际成本。上游后续升级仍须复核宿主接口、依赖版本与这些操作流程。

后续已按用户请求形成[正式迁入方案第 1 版候选](../designs/whomi-cherry-chat-migration-v1.md)，列出原模块、Whomi 接入、剩余问题和验收范围，仍待用户确认。本次隔离验证与方案编写不包含正式开工、不创建开发工单、不提交或推送，也不发布应用。

运行入口与数据说明见[原型说明](D:/University/github/whomi/prototypes/cherry-chat-alignment/README.md)。临时资料只含合成消息；后台绑定 127.0.0.1，不需要真实密钥。组合输入验证使用浏览器合成事件，真实 Windows 输入法候选窗操作仍未验证。

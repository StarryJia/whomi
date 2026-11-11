<p align="center">
  <img src="build/icon.png" width="112" height="112" alt="Whomi 的笑脸放大镜标志">
</p>
<h1 align="center">Whomi</h1>
<p align="center"><strong>从会话中发现自己</strong></p>

<p align="center">
  <a href="https://github.com/StarryJia/whomi/releases/tag/v0.1.11"><img src="docs/readme/badges/version.svg" alt="Version v0.1.11"></a>
  <a href="#安装包启动"><img src="docs/readme/badges/windows.svg" alt="Windows x64"></a>
  <a href="#开源许可"><img src="docs/readme/badges/license.svg" alt="License AGPL-3.0"></a>
</p>

<p align="center">
  我们在交谈中表达想法，也会流露出自己尚未察觉的感受，选几句聊天原文，与AI一起进行讨论。<br>
  Whomi 陪你重读这些对话，看看自己在意什么，又习惯怎样回应别人。
</p>
- 

## 支持的会话平台

<p align="center">
  <a href="docs/getting-started.md#微信"><img src="docs/readme/platforms/wechat.svg" alt="WeChat（微信）"></a>
  <a href="docs/getting-started.md#qq"><img src="docs/readme/platforms/tencentqq.svg" alt="QQ"></a>
  <a href="docs/getting-started.md#telegram"><img src="docs/readme/platforms/telegram.svg" alt="Telegram"></a>
  <a href="docs/getting-started.md#whatsapp"><img src="docs/readme/platforms/whatsapp.svg" alt="WhatsApp"></a>
  <a href="docs/getting-started.md#discord"><img src="docs/readme/platforms/discord.svg" alt="Discord"></a>
  <a href="docs/getting-started.md#google-chat"><img src="docs/readme/platforms/googlechat.svg" alt="Google Chat"></a>
  <a href="docs/getting-started.md#instagram"><img src="docs/readme/platforms/instagram.svg" alt="Instagram"></a>
  <a href="docs/getting-started.md#line"><img src="docs/readme/platforms/line.svg" alt="LINE"></a>
</p>
## 功能演示

演示视频待补充。

## 数据处理边界

Whomi 仅对用户主动提供的聊天文件进行解析、整理和分析，不提供聊天平台数据库解密、平台密钥提取或从聊天平台导出记录的功能。比如，你将一份已取得的聊天文件导入 Whomi 后，可以阅读原文、引用提问或整理记忆。

请仅导入你有权获取和处理的数据，并遵守适用法律及平台规则。指南中提及的第三方工具由用户自行选择和运行，Whomi 不调用这些工具获取聊天记录。

聊天记录保存在本机，阅读原文无需连接模型。使用模型功能时，发送范围如下：

- **提问：** 所选模型服务会收到问题、引用、相关对话历史，以及当前会话已有的有效记忆内容。
- **整理记忆：** 以确认页核对时当前会话中已导入的全部记录为范围。点击「生成记忆」后，将其中可分析的消息分批发送给所选模型，跳过系统消息和空白消息。选中几句原文不会缩小整理范围。

Whomi 默认开启昵称匿名化和数据脱敏，在本机处理待发送的材料，保留本机聊天原文：

- **昵称匿名化：** 将发言者昵称替换为 `U1`、`U2` 等人物编号，正文中匹配到的多字成员昵称也会替换。
- **数据脱敏：** 按规则替换匹配到的邮箱、中国大陆手机号和身份证号、座机号、银行卡和信用卡号，以及常见接口密钥和授权令牌。网络地址和网址默认保留，可在「设置 → 消息处理」中勾选替换。

例如，虚构消息 `小明：发到 xiaoming@example.com` 经过处理后，可变为 `U1：发到 [邮箱]`。这些设置同样用于提问时发送的问题、引用、对话历史和记忆内容。你可以在「设置 → 消息处理」调整开关和规则；脱敏可能遗漏真实姓名、地址等身份线索，发送前仍需确认材料是否适合交给所选模型服务。

## 快速开始

### 安装包启动

1. **安装。** 在 64 位 Windows 上下载安装并启动 Whomi。[下载安装包](https://github.com/StarryJia/whomi/releases/download/v0.1.11/Whomi-Setup-0.1.11-x64.exe)
2. **导入。** 点侧栏「会话」旁的 **＋**，选择已准备好的聊天文件，打开会话并选择本人。
3. **配置模型。** 在「设置 → 模型服务」添加可用的服务和文本模型。
4. **开始探索。** 选几句原话向模型提问，或点「整理成记忆」生成文稿，在「记忆仓库」重读。

聊天文件准备、虚构示例和详细操作统一放在[使用指南](docs/getting-started.md)。

### 源码启动

安装 Node.js 24.x 及其自带的包管理工具 npm。在仓库首页选择 **Code → Download ZIP** 下载并解压源码，然后在包含 `package.json` 的目录打开终端，依次运行以下命令。

```sh
npm ci
npm run native:electron
npm run desktop:dev
```

最后一条命令会打开 Whomi 桌面窗口。Windows PowerShell 若提示禁止运行 `npm.ps1`，将命令中的 `npm` 改为 `npm.cmd`。

如果提示缺少编译工具，安装 Python 和对应系统的构建工具后重试：Windows 使用 Visual Studio Build Tools 的「使用 C++ 的桌面开发」组件，macOS 使用 Xcode 命令行工具，Linux 使用 `make` 和 C++ 编译器。

## 核心特性（Key Features）

- **把聊天留在本机重读。** 导入聊天文件后即可浏览原文，重复导入时跳过已保存的消息。
- **带着原话提问。** 选中几句聊天，与模型讨论自己没留意到的细节，再从引用回到上下文核对。
- **把往来整理成记忆。** 将当前会话整理为共同经历与关系解读，在「记忆仓库」重读。整理任务暂停后可以继续。
- **查看不同关系中的人格倾向。** 「个人总览」汇集已生成记忆中的观察，并保留来源。材料不足的维度显示「暂难判断」。
- **自行选择模型与发送设置。** 配置模型服务，调整昵称匿名化与数据脱敏规则。具体发送范围和处理方式见[数据处理边界](#数据处理边界)。

## 路线图（Roadmap）

## 参与贡献（Contributing）

欢迎反馈问题、提出功能建议，也欢迎改进代码、文档和示例。

### 提交问题或建议

提交前先搜索已有的 Issue（问题或建议记录），相同问题请补充到原记录。反馈中请移除私人聊天内容、账号密钥等信息。[查看已有记录](https://github.com/StarryJia/whomi/issues)

- **问题反馈**按模板填写 Whomi 版本、操作系统、复现步骤、预期结果和实际结果。例如导入失败时，注明聊天平台与文件格式，附错误提示，必要时提供能复现问题的虚构聊天文件。[问题反馈模板](.github/ISSUE_TEMPLATE/bug_report.md)
- **功能建议**说明谁在什么情况下想完成什么任务、目前哪里不方便，以及期望看到的结果。例如希望对照朋友与工作中的表现，可以说明要比较哪些经历、希望从对照中理解什么。[功能建议模板](.github/ISSUE_TEMPLATE/feature_request.md)

两个模板都包含「是否愿意提交合并请求」，请选择愿意、需要协助或暂时只反馈，方便安排后续协作。

### 提交代码或文档修改

PR（Pull Request，合并请求）用于提交待审阅的修改。新增功能或较大改动，请先用功能建议记录讨论需求、现成方案与实施范围，确认后再开发。

1. 从最新 `main` 创建工作分支，一次合并请求围绕一个问题。例如修复导入失败时，将相关提示与恢复操作放在同一份修改中。
2. 按模板说明原来的问题、修改后的行为、验证方式和结果，并关联已有的问题记录。[合并请求模板](.github/pull_request_template.md)
3. 根据改动范围完成检查。代码修改运行类型检查与相关测试，文档修改检查事实和链接。涉及界面时，核对正常完成、取消、失败重试和窄窗口，并附关键状态截图。具体要求见[项目约定](AGENTS.md)。
4. 复用外部代码或素材时，保留来源与许可说明，并更新第三方声明。

## 开源许可

[AGPL-3.0](LICENSE) · [StarryJia/whomi](https://github.com/StarryJia/whomi)

感谢 [ChatLab](https://github.com/ChatLab/ChatLab) 和 [Cherry Studio](https://github.com/CherryHQ/cherry-studio) 的开发者与贡献者分享他们的工作。Whomi 的聊天文件解析、模型设置和回复排版复用了其中的部分实现，具体来源与许可见[第三方声明](THIRD_PARTY_NOTICES.md)。

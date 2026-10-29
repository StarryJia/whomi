# 会话导入虚构夹具

本目录全部内容由 Whomi 开发任务自行编写，账号、名称、消息与 example.invalid 地址都是虚构数据；没有复制私人聊天或 ChatLab 上游样本。

各格式目录的 fixture.json 列出允许读取的辅助文件。positive 文件用于结构和计数验证；corrupt 与 missing 文件用于损坏、缺字段结果；具体覆盖范围见 docs/research/chatlab-parser-reuse.md。Telegram 全量夹具包含两个会话，SIWX 使用 echotrace 模块并覆盖未知类型、缺失媒体和无可靠目标的引用。

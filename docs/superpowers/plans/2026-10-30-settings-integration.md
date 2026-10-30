# 设置、模型服务、消息处理及数据目录正式接入

> 执行采用 writing-plans、dispatching-parallel-agents 及 requesting-code-review；完成后按 verification-before-completion 验收。不提交或推送。

**Goal:** 将已确认的 A 专注分栏设置接入真实本地存储、模型调用和消息处理，增加会话数据保存目录配置。

**Architecture:** 复用现有 React 预览、Electron 隔离通信、SQLite 写队列、系统密钥加密和 Pi 模型运行器。增加独立 SettingsApi，服务商配置关联既有版本化模型；消息处理只作用于发送副本并保留来源编号；数据迁移在服务关闭后复制校验，成功才切换目录，失败恢复原目录。

**Tech Stack:** 现有 React/TypeScript/Electron/SQLite/Vitest/Playwright，不新增运行依赖。

**Spec:** 用户已确认本聊天全部推荐项；视觉参考 docs/designs/whomi-settings-design.md。新增数据存储分类承接路径配置，原有模型服务、消息处理、关于whomi保持已选布局。

## 约束与已确认决策

- 当前 main，保留所有既有改动。fetch/pull 已成功，领先16、落后0。
- 模型表单显式保存，离开有保存/放弃/继续编辑；处理开关自动保存，失败恢复并支持重试。
- 连接仅支持当前 OpenAI Chat Completions 兼容协议；初始服务商为空，支持自定义云端/本地地址，不强制检测。
- 同步模型只添加勾选项；手动添加始终可用；同名不同服务商不冲突。可用性变化不静默换模型；运行任务需先停止再停用/移除。
- 系统加密密钥，已有密钥不回传前端；本地图片。测试连接使用固定短内容，不发送聊天。
- clean/merge/anonymize/redact默认开启，denoise关闭；合并60秒、1～600秒、步长1；脱敏默认8项（除ipv4/url外）。关闭保留子选项；规则恢复只影响规则。
- 清洗仅识别明确结构；去噪仅空内容和无正文系统占位；否定、语气和表情保留。处理保留原始记录与全部证据编号；设置变化不自动重分析。
- 调试默认关闭，仅版本/运行环境/经过筛选错误信息，支持复制，不记录正文或密钥。
- 设置返回保留原页面、阅读位置、草稿；设置修改后模型选择器刷新且记住功能上次选择。
- 保存目录迁移只在用户明确确认后执行；开发验收只用隔离虚构数据。拒绝非空目标、源内目标和不安全路径，不覆盖用户文件。保留原目录备份。

## Task 1：模型服务持久化

所有者 settings_backend。创建 electron/data/settings/repository.ts、electron/main/settings-service.ts 及后端测试；可编辑 electron/data/entry.ts、dispatch.ts、src/shared/ai-contract.ts、ai-validation.ts、electron/data/ai/repository.ts。不编辑 main/index、preload、App 或前端设置组件。

接口 src/shared/settings-contract.ts 为共同依据。数据进程增加 settingsStorage分发。main工厂提供除目录/诊断/restart以外的SettingsApi方法，注入storage、secrets、testModel及修改模型前检查任务的回调。保存服务商同步既有模型版本及启停，移除仅停用历史模型/删除配置关联，保留历史报告。初始化迁移已有模型为明确服务商。同步模型请求限定用户地址、超时/大小限制、不跟随重定向、只返回模型标识。

- [x] 先写行为回归并运行确认失败，再实现持久化、输入边界与真实同步。
- [x] 验证重启恢复、同名不同商、密钥不泄漏、失败不丢配置、历史不丢失。

## Task 2：会话目录迁移

所有者 settings_storage。创建 electron/main/storage-location.ts 及隔离文件系统测试，不编辑 main/index。导出工厂或函数供root接入；固定userData内仅保存目录指针，默认兼容当前userData。迁移复制只包含应用管理的数据（数据库含日志、模型session、资源），服务先关闭，校验复制后原子写指针；原目录不删。使用选择目录授权token，取消不变更；失败回滚；返回restartRequired以便重启/恢复流程。与root协调集成细节。

- [x] 验证首次/自定义路径启动，非空/子目录/符号链接目标拒绝、失败回滚、数据完整复制。
- [x] 给出启停和重启接入方法，不操作用户真实目录。

## Task 3：正式设置界面

所有者 settings_ui。仅创建 src/components/settings/** 与其测试；复用设计预览视觉组织，避免依赖预览入口。SettingsPage props为 api:SettingsApi,onClose:()=>void,onChanged?:()=>void。所有接口见共同contract。根App与preload由root集成。

- [x] 阅读产品/设计及Impeccable craft-floor与相关参考；实现空/成功/失败/取消/窄窗及键盘操作。
- [x] 模型服务工作区、编辑与离开保护、模型同步/手动/检测；消息处理保存与回滚、规则；关于与诊断；数据存储目录显示/选择/确认迁移/重启。
- [x] 添加有效交互回归，运行类型检查并报告接口问题。

## Task 4：发送副本处理与完整集成

所有者root。创建 electron/main/message-processing.ts 与测试；编辑 ai-service、main/index、preload、App、desktop-api、模型选择组件。敏感信息处理覆盖引用/历史/画像中发送文本；系统指令不做用户数据脱敏。服务持久化版本防止恢复混用旧处理上下文。

- [x] 回归验证清洗/连续合并/去噪/匿名/8规则及原文编号保留。
- [x] 接入正式设置入口、通信校验、模型刷新和选择记忆。
- [x] 接入数据目录迁移服务启停与启动指针，导入/模型任务活动时保护。
- [x] 独立审查；全套类型、前后端及桌面完整流程；截图验证；更新设计完成状态与中文提交说明。

## 验收重点

服务商保存重启后存在；检测失败后修正重试成功；模型选择与禁用一致；处理后的实际请求不含被选敏感信息且来源可回查；设置返回草稿位置保留；数据迁移取消/失败/成功重启后完整；窄窗口无横向溢出。

2026-10-31 已完成。最终结果：前端 206、后端 346、桌面 13 项通过，设置重启按钮补验通过；完整类型检查及桌面构建通过。独立审查发现的问题均已修复，行为、截图和验收边界见[正式接入记录](../../designs/whomi-settings-implementation.md)。

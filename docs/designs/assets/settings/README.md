# 设置设计参考附件

日期：2026-10-28。状态：用户已选择 A 专注分栏，按四处标注制作修订；未实现正式设置界面。

| 文件 | 来源与用途 | 证据边界 |
|---|---|---|
| `whomi-current-context.png` | 本轮从本地运行的 Whomi 实际页面截取；用于延续侧栏、字体与品牌 | 不是 Cherry 或 ChatLab 的截图，当前截取为窄窗口导航展开态 |
| `variant-A.png` | 内置 image_gen 生成；A 专注分栏 | 静态概念，设置侧栏、服务商列表、详情三列 |
| `variant-B.png` | 内置 image_gen 生成；B 顶部分类 | 静态概念，顶部分类与下方双栏 |
| `variant-C.png` | 内置 image_gen 生成；C 客户端内嵌 | 静态概念，保留客户端侧栏及顶部分类 |
| `generation-prompts.json` | 本轮完整生成提示及原始品牌参考路径 | 不包含真实凭据或聊天材料 |

三张候选的服务商、地址、模型和选中状态全部是示例。图片只比较整体结构，不验证控件、连接、消息转换或保存。图片中的蓝色图标、粗选中线、Logo 细节和模型行差异不作为设计规范；后续预览直接引用原始 Logo、现有图标及 Whomi 样式。

用户选择与四处标注保存在 [feedback-r2.md](feedback-r2.md)。修订版采用[独立交互预览](../../previews/settings/index.html)，直接引用原始品牌资产，不重绘 Logo；后续浏览器截图另存为 `revision-*.png`，保留本轮候选原图。预置服务商清单仍等待用户提供，演示云服务与演示本地服务不代表真实预置。

已归档修订截图：`revision-models.png`、`revision-messages.png`、`revision-rules.png`、`revision-about.png`、`revision-add-provider.png`、`revision-model-picker.png`、`revision-narrow.png`。桌面截图为 1440 × 960，窄窗为 360 × 800；均是实际浏览器渲染，不是生成图，也不证明真实模型或处理算法可用。

关于页后续修订以 `revision-about-r3.png` 和 `revision-debug-r3.png` 为准，均为 574 × 892 实际渲染；简介改为一个了解你的程序，底部改为调试面板。调试开关仅展开静态演示信息，不读取真实日志。旧 `revision-about.png` 保留为历史版本。

用户提到的 Cherry 与 ChatLab 截图未随本轮消息收到。尚未归档任何用户原始参考截图，不能用上述生成图代替。收到后按原始文件逐字节保存到本目录的 `references/` 子目录，记录原始文件名与来源，不压缩、不裁切、不重绘；截图中的额外入口、默认值和示例数据不自动成为需求。

源码参考版本与许可记录在[设置设计文档](../../whomi-settings-design.md)。生成候选同时归档到本机 design-shotgun 配置的项目设计目录；用户已在后续消息明确选择 A，选择记录与修订依据一同保存，不将候选默认值写为用户偏好。

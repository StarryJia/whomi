# Cherry Studio 对话模块来源

固定版本为 `263667f7a99dfed736c939708a55deb435164820`。各来源清单列出上游路径、本地目标及原始文件的 SHA-256 摘要。消息与共用文件清单还记录 Git 内容对象摘要。[固定源码](https://github.com/CherryHQ/cherry-studio/tree/263667f7a99dfed736c939708a55deb435164820)

## 许可范围

| 上游来源 | 本地范围 | 许可 |
| --- | --- | --- |
| Cherry 应用 `src/renderer` | `composer/` 和 `messages/` 中来自应用的代码、从 `ChatComposer` 提取的提交逻辑，以及 `shared/layout/` 和 `shared/fonts/` | GNU Affero 通用公共许可证第 3 版（AGPL-3.0）。保留上游[根许可证](LICENSE)。 |
| Cherry 界面包 `packages/ui` | `shared/primitives/`、`shared/lib/utils.ts` 和 `shared/composites/flex.tsx` | 固定版本包清单声明 MIT，作者为 Cherry Studio。随附 [MIT 文本](shared/LICENSE)。 |

界面包固定版本通过 `package.json` 声明其许可和作者。随附 MIT 文本按这项声明及作者署名记录。[上游根许可证](https://github.com/CherryHQ/cherry-studio/blob/263667f7a99dfed736c939708a55deb435164820/LICENSE) · [界面包清单](https://github.com/CherryHQ/cherry-studio/blob/263667f7a99dfed736c939708a55deb435164820/packages/ui/package.json)

## 本地适配

- [输入器清单](composer/source-manifest.json)记录原 Core、延迟加载 Surface 和纯文本编辑器 Runtime。Whomi 接入请求受理、停止、引用及按独立对话划分的内存草稿和输入历史。移除附件、语音、快捷面板、自动排队和历史消息编辑的 Cherry 宿主分支。纯文本粘贴在内容进入编辑器解析器前取出文本。
- [消息清单](messages/source-manifest.json)记录原列表、上下文、分组、消息框架、正文部件、动作注册器、流式历史分层和虚拟滚动。Whomi 将已保存轮次、原文引用、末轮重试和整轮统计投影到原模块。移除分支、重生成、工具、朗读及依赖 Cherry 服务的动作。阅读位置按独立对话保存在本次运行的内存中。
- [共用控件清单](shared/source-manifest.json)分别记录应用布局和字体，以及界面包的控件与工具。Whomi 编写 `composer/composer.css`、`messages/messages.css`、`shared/theme.css` 与 `shared/ui.ts` 以接入本地主题和导入入口；`src/components/conversation-ai/cherry/messages.tsx` 是 Whomi 轮次适配层。
- 助手正文仍经 Whomi 的 `AnswerContent` 接入既有 MarkdownCore。该正文模块来源为 Cherry 界面包提交 `f19aa72f969b782ed72f81be80976b237ae26605`，沿用既有安全链接规则和分块适配。整轮统计沿用 Whomi 已有的 `message-performance.ts` 计算。[既有正文来源](../cherry-markdown/UPSTREAM.md) · [既有统计来源](../../../docs/research/cherry-conversation-reuse.md)

## 复核

在 Whomi 仓库根目录执行以下命令。默认读取 `artifacts/cherry-chat-source-263667f`。若原文件位于其他目录，传入该固定版本的源码根目录。

```sh
node scripts/verify-cherry-chat-sources.mjs
node scripts/verify-cherry-chat-sources.mjs "D:/sources/cherry-studio-263667f"
```

缓存中的原文件按原始字节核对 SHA-256 和清单提供的 Git 内容对象摘要。使用 Git 检出源码时，可关闭自动换行转换以匹配固定版本的原始字节。共用清单中的文件、消息清单标记 `modified: false` 的文件，以及输入清单标注「原样保留」的文件另外核对本地内容。对这些本地文本仅容许行尾在 LF 和 CRLF 之间转换，二进制按字节比较。适配文件核对原文件散列及本地目标是否存在，具体改动可按清单逐文件比较。

例如复核编辑器焦点交接时，用输入清单中 `ComposerSurfaceRuntime.tsx` 的原始路径与本地目标执行 `git diff --no-index`，查看保留的焦点和键盘逻辑及删除的宿主分支。校验脚本退出码为零表示来源摘要及本地文件检查通过。

本地桌面包将本页、两份许可证和三份来源清单放入 `resources/licenses/cherry-chat`。本次授权范围为本地集成与验证，公开发布需另行授权。

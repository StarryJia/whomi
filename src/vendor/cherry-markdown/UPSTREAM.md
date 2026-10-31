# Cherry MarkdownCore

来源：CherryHQ/cherry-studio，固定提交 f19aa72f969b782ed72f81be80976b237ae26605，packages/ui/src/components/composites/markdown。文件末尾空行统一为一个换行。

packages/ui/package.json 声明本界面包为 MIT，作者为 Cherry Studio；根应用业务代码采用另一许可，不能混同。本目录保留 MarkdownCore、静态及流式入口、上下文、消毒规则和内部转换插件的依赖闭包。来源可按文件相对路径在固定提交下核查。

本地差异：internal.tsx 将三个插件导入改为直接路径，避免桶入口带入不使用的高亮、数学及图表插件。渲染样式由 Whomi 的 answer-content.css 映射。Whomi 的 React 环境中直接重复渲染 Streamdown 2.5，最终快照替换片段时可复现旧文字残留；从 streaming 切到 static 则会重建正文。AnswerContent 复用同版本 remend 片段补全和 parseMarkdownIntoBlocks 分块，每个稳定编号的区块交给原 MarkdownCore static 渲染，内容变化时刷新该区块，保留未变化区块的节点及局部横向滚动位置；终态仅停止片段补全。没有自行解析 Markdown，也没有修改依赖安装文件。自动滚动观察正文实际高度。对应回归同时检查最终快照替换、表格节点保留与上下滚动。

维护代价：Streamdown 2.5.0 的发布包直接依赖 Mermaid，锁文件因此包含其传递依赖；本轮未启用图表或高亮插件。升级时需重跑最终快照替换、流式补全、停止保留位置和危险链接用例，不能仅核对构建通过。

固定依赖 streamdown 2.5.0。已核对上游 patches/streamdown@2.5.0.patch：动画插件修改 inline code 跳过及 AST 数组更新，高亮插件限制过期异步回调。Whomi 关闭动画并覆盖 code/pre，不使用高亮插件，故未应用这两处补丁；启用相关能力前必须重新核查。保留上游清理、URL 协议限制和标题编号逻辑；本地不自动加载模型给出的远程图片，也不开放文件链接协议。

阅读场景、固定输入与测试见 docs/superpowers/plans/2026-10-31-conversation-reading-polish.md。复用不包含 Cherry 全局状态、模型请求、数学、图表、附件或代码高亮服务。

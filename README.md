# Whomi

本地优先的自我探索工具。本仓库目前实现首页与可折叠侧栏，采用 React、TypeScript 和 Vite，按需改写 shadcn/ui 的组件结构。

## 本地运行

本轮使用 Node.js 24.12.0 与 npm 11.6.2 验证。

```sh
npm ci
npm run dev
```

打开终端显示的本地地址，默认是 http://127.0.0.1:5173。服务仅监听本机。

```sh
npm test
npm run build
npm run preview
```

`npm test` 运行首页行为测试；`npm run build` 完成类型检查并输出 `dist/`；`npm run preview` 在本机预览构建结果。

## 已实现

- 主区显示简单问候；未传入称呼时为 Hello。
- 展开态品牌入口只定位首页并保持侧栏展开；桌面将焦点移入主区，窄屏将焦点保留在品牌入口。
- 桌面侧栏展开、收起和本机偏好保存；存储受限时仍可操作。
- 展开态右上按钮收起；收起态默认显示 Logo，悬停或键盘聚焦时替换为展开图标并提示展开侧栏，点击后才展开。
- 窄屏图标轨道与展开面板，支持 Escape、点击遮罩和焦点恢复。
- 键盘焦点、图标提示、不可用入口和减少动态效果样式。

例如，鼠标移到收起态 Logo 上时只切换图标，点击后展开；在窄屏点击展开态品牌仍保留导航面板，可用右上按钮、Escape 或遮罩收起。2026-10-27 修订后的最终验证进度见[本轮实现约定](docs/designs/whomi-home-implementation.md)。

称呼由 `App` 的可选 `displayName` 参数提供。例如 `<App displayName="阿嘉" />` 显示 Hello，阿嘉，阿嘉仅为示例。当前没有称呼设置页面，也不读取私人记录推测姓名。

导入、会话资料库、分析、个人仪表台和设置业务尚未实现，对应入口明确不可用。首页不读取聊天记录、不调用模型、不发送称呼或侧栏偏好到云端；本机仅保存 `whomi:sidebar-open` 这一界面偏好。

## 结构与设计依据

- `src/App.tsx`：首页、品牌与导航组合。
- `src/components/ui/`：侧栏状态、提示组件。
- `src/styles.css`：共用颜色、间距、尺寸与响应式样式。
- [产品上下文](PRODUCT.md)、[设计原则](DESIGN.md)、[本轮实现约定](docs/designs/whomi-home-implementation.md)。
- [第三方许可与品牌来源](THIRD_PARTY_NOTICES.md)。

原始品牌图片保持不变，页面只裁去外围留白。桌面打包、聊天导入及模型能力按后续方案独立推进。

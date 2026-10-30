# 第三方来源

`src/components/ui/sidebar.tsx` 的状态上下文与桌面、移动端分离结构，以及 `src/components/ui/tooltip.tsx` 的 Radix 包装方式，参考并改写自 [shadcn/ui](https://github.com/shadcn-ui/ui)。本项目用局部样式和本机偏好替换其通用样式、快捷键和 Cookie 保存方式，仅保留当前首页需要的部分。

来源：[Sidebar](https://ui.shadcn.com/docs/components/radix/sidebar)、[Tooltip](https://ui.shadcn.com/docs/components/radix/tooltip)、[许可证](https://github.com/shadcn-ui/ui/blob/main/LICENSE.md)。

## shadcn/ui

MIT License

Copyright (c) 2023 shadcn

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## 品牌资产

首页直接引用仓库已有 `assets/branding/whomi-symbol.png` 与 `assets/branding/whomi-wordmark.png`。本轮未重新生成、重绘或修改这些文件；页面保持比例调整显示尺寸，并通过布局裁去外围留白。原始图片不含透明通道，品牌入口内的局部正片叠底混合仅用于让近白图片底色融入浅色悬停背景，不改变图片文件。

启动动画的 `whomi-lens-layer.png` 与 `whomi-face-layer.png` 是用户授权从 `whomi-symbol.png` 逐像素分离的透明派生资产，保留原画布和各自位置。`scripts/extract-brand-layers.py` 使用 Pillow 与 NumPy 处理白底和透明度；这两者仅用于重新生成素材，不是页面运行依赖。生成式图像编辑试验的结果未采用或打包。

## 其他依赖

### ChatLab 会话解析模块

本地导入后端复用 [ChatLab/ChatLab 固定提交 f19beeadda27bd57eedc1bfbe75e7ed1b9e86833](https://github.com/ChatLab/ChatLab/tree/f19beeadda27bd57eedc1bfbe75e7ed1b9e86833) 的 14 个格式模块与必要工具、类型。原始代码按 GNU Affero General Public License v3（AGPL-3.0）提供，完整原文保存在 [electron/vendor/chatlab-parser/LICENSE](electron/vendor/chatlab-parser/LICENSE)，逐文件来源、原始摘要及本地修改见 [UPSTREAM.md](electron/vendor/chatlab-parser/UPSTREAM.md)。没有复制上游测试样本、原生加速或桌面业务代码。

新增运行依赖 stream-json 1.9.1、stream-chain 2.2.5 按各安装包声明的 BSD-3-Clause 提供；开发类型依赖 @types/stream-json 1.7.8、@types/stream-chain 2.1.0 按 MIT 提供。锁定版本与固定上游锁文件一致，安全限制及审计残留见 [复用审计](docs/research/chatlab-parser-reuse.md)。

当前只完成已授权的本地集成。与下述 GSAP 许可组合的公开分发条件尚未确认；本声明不改变整个 Whomi 的许可证，也不构成公开发布授权。

本地 Windows 验证包的 resources/licenses 目录附本声明、ChatLab 原始许可证与逐文件来源修改清单。打包只纳入生产 out、运行依赖和上述声明；不纳入虚构测试夹具、测试探针、临时数据库或私人导出。公开分发前仍必须明确全项目组合许可，准备与二进制对应的完整源代码、锁文件、构建安装说明和全部依赖原始许可，并核对修改告知义务；当前本地验证包不表示这些发布条件已满足。

### GSAP 与 React 集成

启动动画使用 [GSAP](https://github.com/greensock/GSAP) 3.15.0 的时间轴与快速位置更新，以及 [@gsap/react](https://github.com/greensock/react) 2.1.2 的 `useGSAP` 生命周期集成。

本机安装包的 `gsap/package.json` 声明 Standard no charge license，`@gsap/react/package.json` 声明 SEE LICENSE AT；二者均指向 [GSAP Standard License](https://gsap.com/standard-license)。这些运行依赖按该许可提供，不将 GSAP 技能仓库的 MIT 许可套用到运行库。实际依赖版本与许可标识可核对 `package-lock.json` 及安装包元数据，本文件不替代原许可条款。

动效方向参考了 [Loading.io Magnify 搜索等待动画](https://loading.io/spinner/magnify/-searching-for-loading-icon) 中图形保持朝向、平移搜索的表达。本项目未下载、复制或打包其动画素材。

### 其余依赖

本轮会话后台使用 [Pi](https://github.com/earendil-works/pi) 的完整 `@earendil-works/pi-coding-agent@1.4.0` 发布包，安装包元数据声明为 MIT。模型适配、Agent 会话和原生历史复用该包；本项目自行维护业务权限、任务和统计归属。锁定依赖及传递依赖见 `package-lock.json`；仅在应用专用后台进程运行，没有把上游终端界面代码复制到本项目源文件。

React、Vite、Radix、Lucide 等运行和开发依赖的实际版本见 `package-lock.json`，各自许可按安装包声明提供。本文件不替代各依赖的许可声明。

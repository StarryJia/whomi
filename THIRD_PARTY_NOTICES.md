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

## 其他依赖

React、Vite、Radix、Lucide 等运行和开发依赖的实际版本见 `package-lock.json`，各自许可证随安装包提供。本文件不替代各依赖的许可声明。

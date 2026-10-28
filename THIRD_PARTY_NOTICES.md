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

### GSAP 与 React 集成

启动动画使用 [GSAP](https://github.com/greensock/GSAP) 3.15.0 的时间轴与快速位置更新，以及 [@gsap/react](https://github.com/greensock/react) 2.1.2 的 `useGSAP` 生命周期集成。

本机安装包的 `gsap/package.json` 声明 Standard no charge license，`@gsap/react/package.json` 声明 SEE LICENSE AT；二者均指向 [GSAP Standard License](https://gsap.com/standard-license)。这些运行依赖按该许可提供，不将 GSAP 技能仓库的 MIT 许可套用到运行库。实际依赖版本与许可标识可核对 `package-lock.json` 及安装包元数据，本文件不替代原许可条款。

动效方向参考了 [Loading.io Magnify 搜索等待动画](https://loading.io/spinner/magnify/-searching-for-loading-icon) 中图形保持朝向、平移搜索的表达。本项目未下载、复制或打包其动画素材。

### 其余依赖

React、Vite、Radix、Lucide 等运行和开发依赖的实际版本见 `package-lock.json`，各自许可按安装包声明提供。本文件不替代各依赖的许可声明。

# virtua 尺寸观察器补丁

本项目固定使用 [virtua 0.49.1](https://www.npmjs.com/package/virtua/v/0.49.1) 的 React 构建。原包采用 MIT 许可证，原文见 [LICENSE](LICENSE)。安装包的完整性由 `package-lock.json` 锁定，两个 React 入口文件的原始与补丁后 SHA-256 校验值见 [补丁脚本](../../../scripts/patch-virtua-resize.mjs)。

长回答流式增长时，virtua 在 `ResizeObserver` 回调内同步提交列表行尺寸和位置。Chromium 在这次交付期间发现已观察的尺寸再次改变，会记录未交付的通知。补丁仅替换 React 构建中创建观察器的一处调用，将同一目标的最新测量合并到所属窗口的下一动画帧，再交给原回调。移除观察目标或断开观察器时清理未交付的测量。

`npm ci` 通过项目的 `postinstall` 自动应用补丁。跳过安装脚本后，可执行 `node scripts/patch-virtua-resize.mjs` 单独应用。脚本只接受固定版本和精确校验值，重复执行可验证两个构建入口均已打补丁。

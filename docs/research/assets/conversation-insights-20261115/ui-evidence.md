# 对话洞察真实桌面界面证据

2026-11-15。运行对象为本仓库构建的 Electron，使用 os.tmpdir 直属 whomi-runtime-insight-ui- 隔离资料库和 127.0.0.1 合成模型服务。未访问用户安装实例、真实聊天或外部模型。

截图中的姓名、聊天、报告与长文章均为合成数据。名称带 simulated 的截图使用主进程接口故障注入，检验真实渲染、焦点及恢复操作；不代表真实网络服务发生过同样错误。生成中、暂停、失败、完成来自真实任务及合成服务响应，未把数据库直接写成这些状态。

## 实际运行汇总

共5个不同桌面用例：4个界面用例和1个桥接用例，各自均已在当前最终构建通过。不能把多次执行累计成更多不同用例，也不能把存在一次超时的组合运行写成一次性全绿。

| 运行日志 | 实际结果 |
| --- | --- |
| desktop-insight-ui.log | 组合4项：3项界面通过，桥接60秒超时，工作进程退出额外超时30秒；不是全通过 |
| desktop-insight-followup.log | 桥接9.1秒、长文10.2秒，2项通过，合计20.7秒；启用操作跟踪，前次超时未复现 |
| desktop-insight-error-retry.log | 增补删除失败与首次原文读取失败后，主界面13.7秒、长文9.9秒，2项通过，合计24.8秒 |
| desktop-insight-exact-source.log | 同片段第1、3条精确证据且第2条保持普通样式，长文用例10.4秒通过，合计11.6秒 |

命令使用项目本地 Playwright：node node_modules/@playwright/test/cli.js test tests/desktop/insight-ui.spec.mjs --workers=1。桥接文件为tests/desktop/conversation-insights.spec.mjs。最新构建在进度环修复后执行，构建锁已释放。

## 当前14份设计图与实际截图

| 设计依据 | 实际截图 |
| --- | --- |
| startup-current-conversation-v2.png | 01-startup-all.png、04-startup-dates.png |
| startup-scope-states-v1.png | 02-startup-invalid-dates.png、03-startup-empty-range.png、04-startup-dates.png、25-startup-no-model.png |
| startup-self-required-v1.png | 24-self-required.png |
| progress-collapsed-v1.png | 05-progress-collapsed.png |
| progress-expanded-v1.png | 06-progress-expanded.png |
| progress-task-states-v1.png | 07-progress-paused.png、08-progress-failed.png、09-progress-complete.png |
| management-g-v2.png | 18-narrow-management.png、20-management-running.png、22-management-paused.png、23-management-failed.png |
| management-task-details-v1.png | 21-management-details.png |
| management-list-read-states-v1.png | simulated-26-management-loading.png、simulated-27-management-read-failed.png |
| report-reader-a-v2.png | 10-report-reader.png、16-narrow-report.png、29-long-report-bottom.png |
| report-reader-rename-v1.png | 11-report-rename.png、simulated-rename-save-failed.png、28-narrow-long-title.png |
| source-dialog-v2.png | 12-source-first.png、15-source-second.png、17-narrow-source.png |
| source-dialog-states-v1.png，仅上两格 | 13-source-browse-earlier.png、14-source-browse-later.png、simulated-source-next-failed.png |
| report-delete-confirm-v1.png | 19-delete-confirm.png、simulated-delete-failed.png |

## 可重复操作与结果

- 取消启动后任务列表仍为空。日期倒置和合法空范围均阻止启动，修正为2026-10-09至2026-10-10后显示3条；资料库共有284条，模型请求仅包含范围内3条。
- 等待合成核查响应时暂停，继续后模拟成稿服务错误；再次重试同一任务后保存报告。展开详情与管理行不会打开报告或创建模型请求。
- 改名取消恢复原标题和入口焦点；模拟保存失败后草稿保留，成功后阅读页与列表同步。
- 原文初次100条，前分页后200条，继续向后滚动新增记录。前插、后插的阅读锚点位移均为0像素，记录见ui-results.json。自由浏览仍保持当前片段计数，回到引用重新定位；上下段不循环。
- 同一片段绑定第1、3条证据时，两条精确高亮，第2条仍为普通上下文；有真实窗口中元素属性断言，32-source-noncontiguous-evidence.png为窄窗可见部分。
- 模拟下一段读取失败保留当前消息和1 / 2；重试成功才变2 / 2。模拟首次失败时不显示消息，重试后定位。
- 在960×640窗口保持展开的240像素侧栏；原文按钮、报告返回和重命名可达，页面与原文无横向溢出。80字标题自然换行。10段合成长文滚动到末尾后打开原文，关闭恢复原scrollTop与引用焦点。
- 删除取消恢复报告行焦点；模拟删除失败保持目标与报告行，重试成功才移除。删除后原始284条聊天仍可读取，最后一份报告删除后焦点落在对话洞察标题。
- 未选本人时先完成本人确认，保存不自动启动；无可用模型时开始按钮禁用。列表首次失败可原地重试，重试不调用模型。

## 视觉审查

真实截图发现原文头像与气泡脱离、管理进度环显示黑实心圆。产品代码由主任务修复后重新构建。修复后的来源头像左右位置有几何断言；管理进度环修复前图为before-management-ring.png，修复后为21-management-details.png。原文修复前截图未另存，不能据此声称磁盘存在原文修复前后成对截图。

## 验证边界

本组桌面验证未覆盖所有同名报告隔离、置顶拖动排序、已有列表刷新失败、来源请求进行中快速关闭与迟到响应、删除整个会话后的跨页面退出。其他层级测试若覆盖这些行为，应独立列出，不由本组截图替代。

组合执行时桥接用例出现一次60秒超时及工作进程退出超时，未给出失败断言；带操作跟踪独立重跑9.1秒通过，根因尚未确认。原始失败与重跑日志分别为desktop-insight-ui.log、desktop-insight-followup.log。四个界面用例均在当前构建实际通过，追加恢复验证见desktop-insight-error-retry.log。

## 截图完整清单

共37张：36张当前运行状态与1张进度环修复前对照。均位于本文件同目录。旧failure-ui截图已移除，避免将测试开发阶段的过期画面混入交付。

- [01-startup-all.png](01-startup-all.png)
- [02-startup-invalid-dates.png](02-startup-invalid-dates.png)
- [03-startup-empty-range.png](03-startup-empty-range.png)
- [04-startup-dates.png](04-startup-dates.png)
- [05-progress-collapsed.png](05-progress-collapsed.png)
- [06-progress-expanded.png](06-progress-expanded.png)
- [07-progress-paused.png](07-progress-paused.png)
- [08-progress-failed.png](08-progress-failed.png)
- [09-progress-complete.png](09-progress-complete.png)
- [10-report-reader.png](10-report-reader.png)
- [11-report-rename.png](11-report-rename.png)
- [12-source-first.png](12-source-first.png)
- [13-source-browse-earlier.png](13-source-browse-earlier.png)
- [14-source-browse-later.png](14-source-browse-later.png)
- [15-source-second.png](15-source-second.png)
- [16-narrow-report.png](16-narrow-report.png)
- [17-narrow-source.png](17-narrow-source.png)
- [18-narrow-management.png](18-narrow-management.png)
- [19-delete-confirm.png](19-delete-confirm.png)
- [20-management-running.png](20-management-running.png)
- [21-management-details.png](21-management-details.png)
- [22-management-paused.png](22-management-paused.png)
- [23-management-failed.png](23-management-failed.png)
- [24-self-required.png](24-self-required.png)
- [25-startup-no-model.png](25-startup-no-model.png)
- [28-narrow-long-title.png](28-narrow-long-title.png)
- [29-long-report-bottom.png](29-long-report-bottom.png)
- [30-long-report-source.png](30-long-report-source.png)
- [31-long-report-returned.png](31-long-report-returned.png)
- [32-source-noncontiguous-evidence.png](32-source-noncontiguous-evidence.png)
- [before-management-ring.png](before-management-ring.png)
- [simulated-26-management-loading.png](simulated-26-management-loading.png)
- [simulated-27-management-read-failed.png](simulated-27-management-read-failed.png)
- [simulated-delete-failed.png](simulated-delete-failed.png)
- [simulated-rename-save-failed.png](simulated-rename-save-failed.png)
- [simulated-source-first-failed.png](simulated-source-first-failed.png)
- [simulated-source-next-failed.png](simulated-source-next-failed.png)

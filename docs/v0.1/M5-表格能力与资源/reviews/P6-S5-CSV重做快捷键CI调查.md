# P6-S5 CSV 重做快捷键 CI 调查

2026-11-03。当前为已批准云端预验收中的局部测试前提修正；**新的真实浏览器通过结果尚待取得**。不恢复本机浏览器长测，不修改产品、SDK、断言、超时或重试策略。

## 原始失败

固定 `2fcd4b2e604f068e81620cbc5491d0dbc5f0750f` 的 [CI 41622949552](https://github.com/open-nerve/NerveOffice/actions/runs/41622949552) 中，生产容器 job `125873024246` 已结束：342 passed、1 failed、11 did not run。唯一失败为 `editor/csv-public.spec.ts` 的公开 CSV 导入故事，首次和原配置的一次重试均在第 43 行等待“CSV导入”标签恢复时失败。11 条未运行是常规项目失败后没有执行的 4 条 crash、7 条 restart 依赖；不是新增平台跳过，也不能计为通过。

该 job 的资源处置核验及报告上传步骤成功，但这不等于产品通过或实测销毁 GitHub VM。另一个非浏览器完整门禁 job 已成功；四个浏览器分片尚在执行，整轮结论待收齐。没有重新调度或重跑该失败 SHA。

原 ZIP、job 日志、API 身份和下载摘要已提前按 Archives 登记于主目录 `.codex/handoffs/m5-p6-20261102/s5/central-acceptance/ci-evidence/ci02-container-early-41622949552/`。ZIP 16,357,794 bytes，日志 241,386 bytes；JSON/HTML 均为 354 条且案例身份一致，已通过既有报告配置环境检查。两次 trace 中实际 `keyboardPress` 都是 `Control+Z` 撤销，接着 `Control+Shift+Z` 重做，trace 的宿主为 Linux/Chromium；只读派生摘要为 `keyboard-trace-survey.json`。全轮收集完成后按原件摘要协调重复 bulk，不永久留下两份完整报告。

## 根因及最小修改

`pressUniverShortcut` 只按 SDK 的 `navigator.appVersion` 判断选择 Meta 或 Control，剩余按键由调用者原样提供。CSV 故事传入 `Shift+Z`，因此 Linux Chromium 实际发送了未注册的 `Control+Shift+Z`。

固定安装的 `@univerjs/ui@1.0.1` ES 入口明确注册：

- `RedoShortcutItem.binding = 89 | 4096`，即 Ctrl/Cmd+Y；
- `RedoMacShortcutItem.binding = undefined`，仅 `mac = 90 | 4096 | 1024`，即 Cmd+Shift+Z。

仓库已有 `support/read-only-checks.ts:621` 与 `support/sheet-capabilities.ts:85` 均使用 `pressUniverShortcut(page, 'Y')`。全 E2E 中，CSV 这一处是唯一直接传入 `Shift+Z` 的调用。原失败不是由等待时间不足解释，也没有证据指向 CSV 正文或撤销栈损坏。

本次只将这一调用改成 `Y` 并注明 SDK 平台差异。仍通过公开页面的真实键盘做一次重做；不改为 Facade/命令探针，不重复按键，也不跳过失败断言。未提交正文、原表保留、导入类型、一次撤销、一次重做、保存重开与下载字节的检查全部保留。通用键盘辅助和 SDK 不改。

## 验证与接续边界

原 CI 的两次真实失败及 SDK 注册是 RED/根因证据，不额外创建本机浏览器环境复现。先在受管非浏览器命令中完成该文件 lint、E2E 类型检查与四项目只读列举；经独立增量审查后正常提交。实际命令、原文件和安装来源摘要保存在 `central-acceptance/csv-redo-fix/`，结果按完成回执更新。

待原六项运行结束并收齐原件，再按已批准[集中方案](P6-S5-Linux集中预验收与环境方案.md)登记新的固定 SHA、正常 hooks 推送唯一 P6 分支并运行原六项 CI。原失败轮保持失败，新一轮须给出真实绿色结果；原 Mac 验收、最终 main 同 SHA CI、S6 独审与 M5 关闭条件不变。

静态与独审已完成：受管 `02b65e69-847d-455c-9e09-bdd5982088b0` 的零告警 lint、E2E 类型检查与四项目各 3 条列举通过；实际浏览器执行为 0。该轮进程组已退出，cleanupStage=complete，scratch 与短根实际不存在。`csv-redo-fix/independent-review.md` 的限定增量结论为 C/I/M=0/0/0，独立核对了原始 ZIP、两份 trace、SDK 注册及源码差异。新浏览器 GREEN 仍待取得，不把静态通过冒充实际故事完成。

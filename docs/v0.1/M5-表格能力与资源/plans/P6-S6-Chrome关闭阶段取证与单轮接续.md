# P6-S6 Chrome 关闭阶段取证与单轮接续实施计划

> **For agentic workers:** 使用 `superpowers:executing-plans` 在现有 P6 worktree 顺序实施；测试先行，增量完成后一次独立代码审查。

**Goal:** 给 CI95 中唯一关闭超时的 Chrome 用例补足有界阶段记录，沿用户已经批准的唯一下轮原六项 CI 取得实际结果。

**Architecture:** 在正式 context 夹具交出原 Chrome context 前安装观察器，保留到默认底层夹具执行真正关闭。观察器同步保存一个小型、独占且已登记的报告，不额外等待浏览器、不代理私有协议，不改变原方法返回值或异常。

**Tech Stack:** 固定 Playwright 1.63.0、TypeScript、Node fs、Vitest；默认夹具模型使用真实 Playwright Node 调度器和假的浏览器边界，不启动浏览器。

**Spec:** 已批准的 `reviews/P6-S6-CI95结果与Chrome收尾取证建议.md`，提交 `b0e303d2`；用户答复“批准新增取证，按原单轮授权继续（推荐）”。原磁盘诊断 `a69d4366` 已完成，不重做。

## Global Constraints

- 主目录 main `46b5e8f4` 保持；仅既有 `codex/m5-p6-closeout` worktree。原断言、次数、240 秒单例时限、flaky 判失败、六项矩阵及 12/16/5 GiB 门槛保持。
- workflow 仅 Chrome 分片启用 `E2E_CONTEXT_CLOSE_DIAGNOSTIC=1`；只选定原 file/title、project `chrome`、retry 0/1。
- 仅观察公开 `context.close`、`context.request.dispose`、`context.tracing.stopChunk` 与 context close/browser disconnected；原 this、参数、Promise、同步异常透传。不开新的 context，不增加 await、sleep、重试或关闭调用。
- 每 attempt 独占 `testInfo.outputPath('context-close-diagnostic.json')`，最多 32 KiB/64 条；原两次合计最多 64 KiB。创建后先登记 attachment/owner，再安装观察器。无参数、错误正文、Cookie、存储或全量环境。
- 初始和挂起状态明确不完整；每个开始事件立即落盘，不能等关闭成功才写。写入、身份、上限问题留固定不完整注解，不能改变产品结果或当作诊断通过。
- 本机只运行受管小型验证，临时根继承 TMPDIR；成功立即清理，异常保留原证据并按原机制核对。本机浏览器长测继续暂停。
- 只有一轮新的原六项 CI；不重跑 CI95、不并叠、不自动追加第二轮。未知问题再次停止。M5 完整验收/标签和 Mac DEF-074 保持开放；不启动 M6。

## Review Focus

- 外层 `provide` 返回后底层才关闭：真实默认夹具模型证明观察没有提前撤销。
- 原 Promise 长期挂起或同步抛错：身份、参数、Promise、原错误保持，开始记录可在没有完成事件时读取。
- 其他用例/浏览器/retry、畸形 run/SHA 或已有报告：不认领，不覆盖，显式不完整。
- 记录文件被替换、写入失败、重复事件或并发方法调用：有界、没有额外未处理拒绝，不误改其他文件和观察者。
- 只有小型模型通过不能证明 Chrome 故障已修复：实际新 SHA 关闭记录和三阶段磁盘记录必须随最终原件另审。

### Task 1: 有界观察与正式夹具接线

**Files:** 新建 `tests/e2e/support/context-close-diagnostic.ts`、相应 `.test.ts`；小型默认夹具模型放 `context-close-diagnostic.test-support.ts`。修改 `fixtures.ts`、`.github/workflows/ci.yml`、`tools/src/verify/ci-workflow.test.ts`、测试生命周期规范和当前批准摘要。

**Interfaces:** `isContextCloseTarget({ file, title, project, retry }, enabled): boolean`；`watchContextCloseDiagnostic(context: BrowserContext, testInfo: TestInfo): void`。观察不暴露要求调用方提前 stop 的 API；只输出当前已登记的有界 JSON attachment。Task 2 消费此附件及已实现三阶段磁盘日志。

- [ ] 先写精确选择、成功/拒绝/同步异常、原 this/args/Promise、挂起/并发、先登记、文件替换/重复、64 条/32 KiB、无秘密字段的小型测试；观察缺少新模块/行为时 RED。
- [ ] 实现最小观察器：owner 字段从固定白名单验证；文件独占创建，每次只写身份匹配的原文件，打开/关闭描述符在同一次同步写入内。完成状态需要记录关闭调用完成和上下文关闭事件；挂起/采集错误保持不完整。
- [ ] 实现正式 fixture 接线和 Chrome-only workflow 开关；真实 Playwright 默认 context fixture 模型只替换 browser 边界，分别验证成功与 teardown 挂起两种结果，不启动浏览器。child 异常/超时不自行删除无法确认闭合的临时根。
- [ ] 串行运行 `python3 -B tools/test-resources/run.py unit -- pnpm exec vitest run --project unit tests/e2e/support/context-close-diagnostic.test.ts tests/e2e/support/login-popup-diagnostic.test.ts tools/src/verify/ci-workflow.test.ts tools/src/verify/plan.test.ts`。Expected: 全部通过，失败模型保留 expected timedOut，不改原产品结果；实际资源闭合。
- [ ] 运行 lint、类型检查，增量独审；有阻断发现先 RED→GREEN 修复，再复验相关组。更新持久规则/复核记录，正常中文提交。

### Task 2: 唯一下轮 CI 与实际收尾

**Interfaces:** 消费 Task 1 的干净提交、原 CI95 failure completion、既有工程收尾授权；产生新 main SHA/run 绑定的六份日志、必要报告、磁盘/关闭阶段证据和真实处置回执。

- [ ] 固定输入与 push 意图，正常 `--no-ff` 合 main、原 pre-push 快速门禁、推送；只读识别该 push 的唯一新 run，不能重复触发。
- [ ] 串行处理本机检查，云端按既有六项独立 VM 编排；下载先核对大小、归属、余量。停止/失败不自动整轮重跑。
- [ ] 按实际原件核对六项结果、精确用例、原 skip/retry、清理状态和两个新增诊断；缺失/不完整不接受。独立复核，必要证据 pin，重复下载及时清理。
- [ ] 仅原标准全部成立后刷新退役清单/固定输入，完成已批准的工程交接与 P6 资源/worktree/分支退役；否则保存具体断点说明。保持 Mac/M5 完整验收开放，停止等待用户安排。

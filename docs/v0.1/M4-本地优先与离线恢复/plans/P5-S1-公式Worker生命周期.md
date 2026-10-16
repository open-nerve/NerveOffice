# P5-S1 公式 Worker 生命周期：实施计划

> 状态：已完成｜日期：2026-10-16｜所属：M4-P5
> **For agentic workers:** REQUIRED SUB-SKILL: 使用 `superpowers:executing-plans` 在当前会话逐任务实施；执行既有自主授权，沿用唯一 Phase 工作区。

**Goal:** 准确区分 Worker 故障、保留就绪后的故障信号，并让页面可在生产选择已有主线程变体。

**Architecture:** 监听器拥有 Worker 的启动期限及首错状态；适配层负责实际实例，不自动切换。页面在后续 Step 决定何时安全重建。本 Step 不改保存协调和权限行为。

**Tech Stack:** TypeScript、现有 Univer 精确锁定版本、Vitest/jsdom、Vite，零新依赖。

**Spec:** `../05-P5-公式Worker的退路.md` §2、§3.2、§4。

## Global Constraints

- 主目录始终为 `main`；全部改动在 `codex/m4-p5-formula-fallback`。
- Worker 握手 20 秒、主线程计算停止异常上限 30 秒；不增加重试/跳过/预算。
- 不修改 SDK、快照格式或内部 API；保留 IMAGE 限制、打开自检、只读守卫、每实例内存存储。
- 生产模式只能由显式参数选择，不读取 URL；测试查询参数仍只在测试构建动态加载。
- 只记录枚举，故障信息不携带快照或 Worker 脚本地址。
- Task 可不单独提交；整个 S1 验证通过后中文提交一次。证据保留在本 plan 的忽略工作区。

## Review Focus

- Worker 在成功回报之后、页面订阅之前报错：getter 保留首错，Task 1/2 测此间隙。
- 先失败后收到成功或不同错误：不得恢复健康或通知两次，Task 1 覆盖。
- 主线程渲染/IMAGE 失败与 Worker 故障重叠：不错误归类，Task 2 保留普通错误对照。
- 挂载中途失败时尚未等到 Worker：销毁清理计时器与事件，不出现无处理的异步拒绝，Task 2 覆盖。
- 主线程显式选项遇到测试 URL 指定 Worker：生产恢复参数优先，Task 2 验证；原计算停止顺序仍有回归。

## Task 1: Worker 启动与运行期的首错状态

**Files:**
- Create: `apps/web/src/editor/formula-worker-failure.ts`
- Modify: `apps/web/src/editor/image-function/worker-image-policy.ts`
- Test: `apps/web/src/editor/image-function/worker-image-policy.test.ts`

**Interfaces:**
- Consumes: `SheetEditorLoadError`、`readImagePolicyReport(data)` 与浏览器 Worker 事件。
- Produces: `FormulaWorkerFailure` 枚举联合、`FormulaWorkerError(failure, options?)`、`FORMULA_WORKER_READY_TIMEOUT_MS = 20_000`。
- Produces: `WorkerImagePolicy.installed: Promise<void>`、`failure(): FormulaWorkerFailure | undefined`、`onFailure(listener): () => void`、`dispose(): void`；`watchWorkerImagePolicy(worker)` 签名保持。

- [x] **Step 1：写失败测试**。保留既有消息/失败用例；增加就绪后 error/messageerror、失败后迟到成功、首次失败锁存、取消订阅、销毁后事件无效及假时钟 19,999/20,000 ms 边界。先针对已存在的 installed 错误断言 `failure` 字段，在实现前应失败于字段缺失，不靠模块找不到证明行为。
- [x] **Step 2：运行 RED**。
  - Run: `pnpm exec vitest run --project unit-web apps/web/src/editor/image-function/worker-image-policy.test.ts`
  - Expected: 新断言因缺少结构化故障/运行期监听/期限而失败；既有正确路径仍通过。
- [x] **Step 3：实现类型与监听**。首错锁存；启动期限从监听开始，回报/失败/销毁均清理；已成功后错误以 after-ready 分类。IMAGE 安装失败映射原 image-policy-failed，其他映射 worker-failed；原因只用固定文案。观察者抛错只报告自身，不打断其他观察者与状态清理。自己的 Worker error 由结构化路径接住并取消默认上报，其他页面异常不受影响。
- [x] **Step 4：运行 GREEN 与回归**。
  - Run: `pnpm exec vitest run --project unit-web apps/web/src/editor/image-function/worker-image-policy.test.ts apps/web/src/editor/image-function/worker-report.test.ts`
  - Expected: 全部通过，零未处理异常；销毁后没有剩余期限计时器。

## Task 2: 适配层明确模式与持续故障出口

**Files:**
- Modify: `apps/web/src/editor/sheet-editor.ts`, `apps/web/src/editor/index.ts`
- Modify: `apps/web/src/editor/sheet-editor.test.ts`
- Modify: `apps/web/src/features/sheet-editor/edit-mode.test.ts`, `editor-page.test.ts`, `editor-slot.test.ts`（仅补完整 SheetEditor 替身的新字段）
- Modify: `docs/adr/ADR-010-编辑器适配层与内部API登记.md`、本 Phase/计划文档。

**Interfaces:**
- Consumes: Task 1 的 `FormulaWorkerFailure`、`FormulaWorkerError`、完整生命周期监听器。
- Produces: `CreateSheetEditorOptions.formulaMode?: FormulaMode`；`SheetEditor.formulaMode: FormulaMode`、`workerFailure(): FormulaWorkerFailure | undefined`、`onWorkerFailure(listener): () => void`；从适配层 index 导出公开类型与错误。

- [x] **Step 1：写失败测试**。构造器抛错归类 create 且不建 Univer；显式主线程在普通构建不创建 Worker、配置不注册 RPC；显式模式优先于测试 URL；正常 Worker 在 create 返回后仍通知错误、公式不再 settled；销毁清理监听；创建后到返回之间的错误不能返回健康编辑器；主线程 IMAGE/渲染失败保持普通分类。原异步停止/销毁用例继续执行。
- [x] **Step 2：运行 RED**。
  - Run: `pnpm exec vitest run --project unit-web apps/web/src/editor/sheet-editor.test.ts`
  - Expected: 新行为断言失败，缺失的是显式模式/首错出口；不以错误的 SDK 替身行为作证据。
- [x] **Step 3：接线**。`createFormulaHost` 包装构造失败并登记终止；mount 不再就绪即撤监听；主线程空故障出口不建 Worker/计时器。创建返回前检查首错；`formulasSettled`/`settleFormulas` 不把失效 Worker 当作收齐，`onFormulaProgress` 合并真实公式信号与故障变化并正确退订。不改变实际重建、保存、租约或错误展示。
- [x] **Step 4：S1 完整验证**。
  - Run: `pnpm test`
  - Expected: 全部单元测试通过，无未处理异常。
  - Run: `pnpm lint` 与 `pnpm typecheck`
  - Expected: 退出 0。
  - Run: `pnpm --filter @nerve-office/web run build` 与 `pnpm gate artifacts budgets`
  - Expected: 生产构建通过；没有测试源码进入产物，原体积预算不扩大。若产物门禁需要其他工作区产物，先正常 `pnpm build`。
- [x] **Step 5：自审、记录与中文提交**。核对 diff 只实现 S1；ADR 明确尚未接上页面自动退化；更新本 plan 与 Phase 进度，正常 Git hook 提交，再由 task-done 留下整步单元结果。继续 S2，不合并、不推送中间 Step。

## 自审与完成标准

2026-10-16 已按 Phase 契约核对：Task 1 提供的类型/监听全部由 Task 2 原样消费；未把 Worker ready 与主线程 Rendered 混同。创建失败/运行期故障/晚订阅/销毁以及非 Worker 负对照均有任务。真实重建与保存完整性留给 S2/S3，S1 不宣称 US-M4-13 已完成。

- [x] 两个 Task 的 RED/GREEN、单元、lint、类型与生产产物证据齐全。
- [x] 代码、ADR 与中文提交完成，主目录仍为 main。

实际验收：455 文件 / 9,220 单元通过；全仓 lint、类型、生产构建、产物与原预算通过。
五处变异均失败于预期断言，原码恢复；详见 `../reviews/P5-S1-自审记录.md`。

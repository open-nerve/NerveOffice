# P4-S5：SDK 内存存储与旧数据清理实施计划

> **For agentic workers:** 使用 superpowers:executing-plans 在当前 Phase 工作区逐 task 实施；各 task 留 RED/GREEN 记录，Step 完成后一次中文提交，独立整 Phase 审查归 S6。

**Goal:** 完成退出和确证停用的全部本机数据清单，同时停止 SDK 偏好的跨页面持久化。

**Architecture:** SDK 服务替换只在编辑器适配层。共享无 SDK 的旧数据清理经 browser-cleanup 注入已有 LocalCleanup，沿用原用户许可及同源互斥；pending-save 的纯键规则由共享 lib 提供。

**Tech Stack:** TypeScript、Univer 1.0.1、Vitest、真实 IndexedDB/Storage、Playwright 三浏览器。

**Spec:** `docs/v0.1/M4-本地优先与离线恢复/specs/P4-S5-SDK内存存储与旧数据清理.md`

## Global Constraints

- 主目录保持 main；只用现有 P4 worktree，不新拆分支或提交到 main。
- 每个 Step 测试全绿后一次中文提交；task 不单独提交。不增加依赖、不调整原预算。
- 不接管恢复身份；pending-save 只提供等待提示；edit-request 仍是当前 Document 内存。
- 只删精确旧库/清单键；新登录换代后原重试无副作用；数据库等待最多 3 秒。
- 浏览器测试 workers=1，串行且运行期间不编辑源码、不跑其他门禁；数据库用隔离 53522。
- 日志、浏览器报告、变异原件归档主目录 `.codex/handoffs/m4-p4-20261014/`；SDD 只保留计划账本与任务日志。

## Review Focus

- SDK UI 插件延迟注册覆盖核心 override：Task 1 用真实 UI 插件注入与实例销毁测试。
- 旧实例销毁后异步 SDK 回调又写入：Task 1 验证读取仍为空，不留引用。
- IDB blocked 后新登录，删除请求迟到：Task 3/4 验证只删退役库，不能迟到续删用户键。
- 邻近前缀或其他用户被误清理：Task 2/3 用字面键/多账户反例；Task 5 用真实存储核对。
- 服务端已退出而旧库仍占用：Task 4/5 验证分别报告、有限等待、可重试及新会话使重试失效。

### Task 1: SDK 每实例内存服务

**Files:** 新建 `apps/web/src/editor/internal-api/memory-local-storage.ts`、`.test.ts`；修改同目录 `index.ts`、`registry.ts`、`registry.test.ts`，`editor/profile/sheet-profile.ts`、`.test.ts`。

**Interfaces:** 产生 `MemoryLocalStorageService implements ILocalStorageService`（另有 dispose）和 `memoryLocalStorageOverride(): DependencyOverride`；消费于 UI 插件配置 override。

- [x] 写实际 UI 插件配置产生服务的测试：两实例同键不互见，销毁后读空、旧引用写入不复活；SDK 全方法及 clone/iterate 终止测试。
- [x] Run: `pnpm exec vitest run --project unit-web apps/web/src/editor/internal-api/memory-local-storage.test.ts`。Expected: 新服务/覆盖缺失导致失败，先核对不是环境错误。
- [x] 实现内存服务、UI 注入及内部 API 登记；更新档案测试保持原只读菜单行为。
- [x] Run: `pnpm exec vitest run --project unit-web apps/web/src/editor/internal-api apps/web/src/editor/profile apps/web/src/editor/sheet-editor.test.ts`。Expected: 全通过。

### Task 2: 用户隔离的保存中记号

**Files:** 新建 `apps/web/src/shared/lib/editor-storage-keys.ts`；修改 `features/sheet-editor/pending-save-marker.ts`、其测试、`editor-page.ts`/测试、`start.tsx`、`edit-mode.ts` 和现有 pagehide 测试。

**Interfaces:** `pendingSaveKey(userId: string, documentId: string): string`；`pendingSaveMarker(userId, documentId, options): PendingSaveMarker`；页面 factory `(userId, documentId)`。

- [x] 测试字面新键、同文档不同人、旧键不读取、clear 不影响其他账户；已知 signed-out/other-user 且保存未知时 pagehide 不补记号。
- [x] Run: `pnpm exec vitest run --project unit-web apps/web/src/features/sheet-editor/pending-save-marker.test.ts apps/web/src/features/sheet-editor/edit-mode`。Expected: 新隔离和停写用例失败。
- [x] 接已确认 userId、共享键规则及已知非 active pagehide 限制；更新调用点和 E2E 字面键夹具。
- [x] Run: `pnpm exec vitest run --project unit-web apps/web/src/features/sheet-editor`。Expected: 既有保存/接手与新增反例通过。

### Task 3: 旧库与记号精确清理

**Files:** 新建 `shared/local-drafts/legacy-storage.ts`、`.test.ts`；共享键文件补清单常量；现有 reload 清理委托共享的退役 session 记号清理。

**Interfaces:** `clearLegacyStorage(userId, { localStorage, sessionStorage, indexedDB, timeoutMs? }): Promise<MetadataCleanupOutcome>`；`clearLegacySessionMarkers(storage): void`（异常由调用方按用途处理）。

- [x] 测试清单删除、其他用户和近似键保留、不读值；getter/key/remove 错误、IDB throw/error/blocked/超时/迟到成功和重试。测试端口只替代浏览器事件，真实浏览器留 Task 5。
- [x] Run: `pnpm exec vitest run --project unit-web apps/web/src/shared/local-drafts/legacy-storage.test.ts`。Expected: 新清理实现缺失而失败。
- [x] 先枚举固定匹配键，再逐个删除（删除允许重排 Storage 索引）；IDB request 只操作精确旧库，blocked 立即 pending，3 秒限时；不在迟到回调里删其他数据。
- [x] Run: `pnpm exec vitest run --project unit-web apps/web/src/shared/local-drafts/legacy-storage.test.ts apps/web/src/features/sheet-editor/recovery/reload-marker.test.ts apps/web/src/features/sheet-editor/issued-request.test.ts`。Expected: 全通过。

### Task 4: 完整清理组合与结果说明

**Files:** 修改 `shared/outbox/local-cleanup.ts`、`local-cleanup-session.test.ts`；新建 `shared/local-drafts/browser-cleanup.ts`；修改 browser-logout/session-failure/maintenance、`shared/i18n/zh-cn/local-data.ts` 及对应 UI 测试。

**Interfaces:** `MetadataCleanupOutcome = { kind: 'cleared' } | { kind: 'pending' } | { kind: 'failed'; error: unknown }`；`LocalCleanupOptions.clearMetadata?`；`createBrowserCleanup(sessions, storeOptions): LocalCleanup`。

- [x] 补清理反例：无效许可不删键；附加 pending/failed 仍清 outbox 但不 finish；重试在原许可下完成；旧请求迟到不触碰新登录键；UI 显示本机数据未清完而服务器已退出。
- [x] Run: `pnpm exec vitest run --project unit-web apps/web/src/shared/outbox/local-cleanup-session.test.ts apps/web/src/features/local-data`。Expected: 旧实现误 finish/旧文案导致新增失败。
- [x] 接入附加端口和统一浏览器组装；各入口启动清自己的退役 session 记号（不读取或授予身份）；扩展结果文案。
- [x] Run: `pnpm exec vitest run --project unit-web apps/web/src/shared/outbox apps/web/src/shared/local-drafts apps/web/src/features/local-data apps/web/src/app`。Expected: 全通过。

### Task 5: 真实存储及完整退出链路

**Files:** 新建 `tests/e2e/specs/local-drafts/cleanup-storage.spec.ts`，按需补 support 和 SDK 测试构建探针；修改已有清理/退出辅助仅适应真实新清理事实，不吞失败。

**Interfaces:** 消费真实页面、Storage、IDB 与已有 outbox 测试支持；浏览器结果和源码 hash 外部归档。

- [x] 新故事验证 SDK 注入不持久写、重建不继承；本人退出清全清单保留别人的 scoped 键/无关库；旧库真实占用 pending、服务端已结束、释放后重试；新登录使旧重试失效。
- [x] 先构建 API/web:e2e 并跑 Chromium 调试；任何失败先定位实际时序，不把重试掩盖成通过。Run: `pnpm --filter @nerve-office/e2e test specs/local-drafts/cleanup-storage.spec.ts --project=chromium --workers=1`（经 with-test-db.py）。Expected: 全通过。
- [x] 同文件及相关 cleanup-logout/auth、editor 交接/会话回归在 Chromium/Chrome/WebKit 串行通过；具体文件按现有故事定位后记账，不猜路径。Expected: 原报告无意外失败/重试。
- [x] 新文件在 `E2E_AUTOSAVE=running` 三浏览器再验，排除 `@test-build`。Expected: 生产节奏主链路通过。

### Task 6: Step 审查、门禁与提交

**Files:** S5 审查报告、Phase/M4 进度、故事登记，必要的架构事实随 Step 记录。

- [x] 自审需求与实际注入/清理边界；对关键用户键隔离或 finish 守卫做变异核对并恢复源码。
- [x] Run: `pnpm test`、`pnpm typecheck`、`pnpm lint`、`pnpm build`、`pnpm gate artifacts budgets stories`。Expected: 全通过且原预算保持；不与浏览器并行。
- [x] 激活通过的 US-M4-08；归档原始报告和源码 manifest，核对无未说明失败；记录 S6 尚待完整门禁及独立审查。
- [x] 正常钩子提交整个 S5，详细中文提交信息；确认 W 干净、根目录 main 未变。Expected: 提交成功且主目录仍 d9fa57f1。

## 计划自审

- [x] 各 spec 条款均归属 Task 1–6，无新增架构或范围决定。
- [x] clearMetadata 在原许可内运行；失败不阻断草稿清理，未完成不 finish；退出网络在锁外。
- [x] 用户独享开发按原授权直接实施，不因技能默认审批/每 task 提交另行停顿。

## 验收记录

2026-10-14：Task 1–6 已完成；完整结果、两轮浏览器失败及修复、键枚举反例与 2/3/1 项守卫变异见 `../reviews/P4-S5-审查报告.md`。正常钩子提交 S5 后继续 P4-S6，独立整 Phase 审查与最终累计门禁不在本 Step 冒充完成。

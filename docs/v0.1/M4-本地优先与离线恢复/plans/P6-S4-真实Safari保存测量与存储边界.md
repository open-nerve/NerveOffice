# P6-S4 真实 Safari 保存测量与存储边界：实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 补齐真实 Safari 的三样本 × 在线/离线 × 20 轮本机保存实测，以及隐私窗口 OPFS、持久授权与七个使用日清理的证据边界。

**Architecture:** 沿用 P2 的测量起止点和生产保存管线，将浏览器内计时提取为测试构建的共用函数。页面只读真实草稿、匹配 Worker 回包并独立解密；宿主独立核对网络和数据库。离线通过本轮专用代理断开应用 API 传输实现，控制端点仍只传测试事实；不修改系统网络、生产定时器或租约。

**Tech Stack:** 现有 TypeScript/Vitest/Playwright、自检页面、Safari 专用场景、Node 本机代理；WebKit 官方文档及固定版本源码核对。

**Spec:** `06-P6-M4收尾.md` §3.4、M4 总设计与 `reviews/P2-S6-端到端测量.md`。范围已在 Phase 设计自审，沿用用户授权的本会话实施、Phase 末独立审查。

## 全局约束

- 仍在唯一 P6 worktree；主目录 main 不动。S3 已按独立实机证据及回归以 `6aec1bbb` 提交；本 Step 不替代 S6 的整阶段验收。
- 正式测量为约 1 MiB、约 5 MiB、perf-50k，在线/离线各 20 轮，共 120 轮。校准可以明确选择 2 轮，但不能冒充正式报告。
- 最后输入至本机完成 p95 ≤ 2000 ms（公式完成 ≤ 900 ms 的条件内样本）；约 1 MiB 同步捕获 p95 ≤ 100 ms。所有轮次、条件外样本与失败都保留；全部公式轮次均不满足条件时按 P2 对全部样本验证更严格的 2 秒门槛。
- 计时不包含随后读盘、解密或传输的开销；证明不能只依赖 UI 保存文案。必须匹配本轮 user/document/writeEpoch/writer/draftSeq/修改正文摘要及真实 Worker written。
- 恢复正常 capture/upload 默认节奏；不调用 flush、直接写 IDB、伪造 Worker 回答、缩短 TTL 或改变系统时钟来改善数字。
- 离线的准确含义是本轮浏览器至应用 API 的 HTTP 连接失败，不声称关闭了宿主网卡。断开后的应用 API 不得有成功的上游保存；本机仍实际持久写成且可解密。必要测试控制 POST 不改变产品联网状态。
- Safari 开始前解锁、连续空闲 120 秒，外部活动/锁屏/监测失效作废；性能轮次与构建、测试、归档及 VM 串行。采集负载、版本、源/构建摘要及每组实际持续时间。
- 不改变系统或 Safari 安全设置；仅使用任务专用场景、测试隐私窗口和本轮来源。凭据、密钥及正文不落宿主报告。

## 审查重点

1. 旧的 saved 文案或上轮 Worker 回答不能结束本轮计时（Task 1 的旧状态/错 seq 负例）。
2. 在线 ACK 清掉草稿之前必须取得属于本轮的原件，不能把缺失草稿算通过（Task 2 的读盘竞争负例）。
3. 离线后仍有请求在代理上游继续成功会污染结果（Task 3 的切断边界和在途请求负例）。
4. 少轮、重复 round、换 boot、公式条件外与缺失样本不能被统计过滤掉（Task 2/3 的报告判定负例）。
5. 隐私窗口 API 可用不等于关闭后持久；persist 返回 true 也不等于永久保留（Task 4 的同源重开实测及文档/源码边界）。

## Task 1：复用现有浏览器内计时

**Files:**
- Create: `apps/web/src/editor/testing/local-save-timing.ts` 与 `.test.ts`。
- Modify: `tests/e2e/support/local-save-measure.ts`、`eslint.config.ts` 的 `SELFTEST_SHARED_FILES`。

**Interfaces:** 导出 `MeasuredEdit`、`LocalSaveTiming` 与 `observeLocalSaveEdit(edit: MeasuredEdit): Promise<LocalSaveTiming>`；函数只读 `window.__nerveEditorProbe` 和保存状态 DOM，除本轮公开编辑命令外不修改管线。原 `measureLocalEdit(page, edit)` 仅委托 `page.evaluate(observeLocalSaveEdit, edit)`。只将这个测试共用文件加入既有跨测试入口名单，不放宽整个目录。

- [x] RED：旧 saved、不增加修改序号、未经过 unsaved、公式尚未完成、超时各自不能返回成功；成功起点包含同步命令、终点对应本轮 saved，释放 MutationObserver/计时器/动画帧。
- [x] 提取现有 P2 算法，保持 15 秒单轮界限和字段口径；不改生产状态或 P2 门槛。
- [x] 运行相关单元、lint/typecheck；用原 P2 三浏览器测量各 2 轮校准提取结果，保留独立报告。

## Task 2：真实草稿、逐轮正文与页面测量场景

**Files:**
- Create: `apps/web/src/editor/testing/selftest-local-save.ts`、`local-save-report.ts` 及必要单元。
- Modify: `selftest-persistence.ts`、`selftest.ts`、`selftest-report.ts`、`features/sheet-editor/selftest-hook.ts`（以上均在既有测试边界）。

**Interfaces:** `loadSelftestKey(csrfToken)` 返回只在页面内保存的版本和不可导出 CryptoKey，`decryptWithSelftestKey(draft, key)` 独立核对原 AAD；原 `decryptSelftestDraft` 委托这两项，保留 S3 行为。`local-save-report.ts` 定义 `LocalSaveSample`（round、cold、时刻、editorSeq/draftSeq、capture/Worker/公式时延、rawBytes、snapshotHash、核对结果）及纯判定/统计，不含正文或密钥。新场景 `local-save-online` / `local-save-offline` 使用既有三种样本，不纳入默认 29 步。

- [x] RED：错 Worker/seq/writer、错误正文或公式缓存、缺草稿、缺轮/重复轮/非有限时长、公式条件外样本丢失均拒绝通过。
- [x] 在 load 前安装只读 Worker 观察；测量前取得独立解密密钥，断开 API 后不再为核对请求密钥。每轮按 P2 的修改点执行、等实际本机完成后读原件、核对、解密；读盘失去竞争就失败并保留原件。
- [x] 每轮记录本机保存时刻及 Worker written 匹配事实；在线组在继续下一轮前确认这轮服务端正文，离线组不恢复传输来做正文核对。收尾释放观察与密钥引用。
- [x] 测试构建重新构建后，三浏览器各 2 轮校准全部六组；保留旧 P2、S3 暂停/崩溃解密校准。

## Task 3：本机网络编排及 Safari 正式六组

**Files:**
- Create: `tests/e2e/support/local-save-session.ts`、`local-save-evidence.ts` 及测试。
- Create: `tests/e2e/safari/local-save.ts`、`local-save-proxy.ts` 及测试。
- Reuse: `scenario-proxy.ts` 的限定同源入口/转发边界，`desktop.ts` 的活动检测，数据库只读与样本辅助。

**Interfaces:** 会话固定 runId、bootId、documentId、userId、sample、network、rounds。阶段为准备 → 网络已确认 → 测量 → 报告 → 独立核对完成；错误进入失败。离线代理记录切断时刻、在途上游数量及其终态、后续被断开的应用请求；同源控制仅协调这个会话，不接受任意 URL/文件/进程。

- [x] RED：错身份、旧 boot、提前测量、错误网络确认、少轮、重复轮、先完成后断网、离线后上游成功保存、跨来源/非本机/超限控制请求均失败。
- [x] 复用受限传输，离线之前等本页已进入编辑、真实 Worker 就绪且取得核对密钥；确认在途应用请求结束后断开后续 `/api/` 连接。记录客户端真实请求失败与服务端零保存；持续编辑时允许续约或会话请求先失败并使产品暂停上传，不强制正文 PUT 出现。控制连接失败不能充当应用失败，不能用返回一个假成功/假草稿替代断开。
- [x] 独立读取数据库 gzip 原件，核对在线最后正文及逐轮确认，离线修订/正文保持基线。异常恢复测试代理可用性、停后端、关闭自建控制资源，保持用户网络不变。
- [x] 正式 Safari 六组各 20 轮串行运行；保留每轮和分布、条件外样本、可见性、活动检测、主机负载、代码/构建摘要、独立 HTTP/数据库核对。失败轮次不覆盖，原因修复后重跑对应完整组。

## Task 4：隐私 OPFS 与存储政策

**Files:** 新建最小测试探针和 `reviews/P6-S4-真实Safari保存与存储边界.md`；更新 DEF-009/012 与相应架构/ADR 的事实，最终关闭仍须 S3/S6 完成条件。

- [x] 在任务专用隐私窗口分别尝试 OPFS 根目录、Worker 同步句柄写入/flush/读回与 `persisted/persist/estimate`；失败记实际错误类型，不把 API 存在算成功。
- [x] 保持同一来源与运行标识，关闭本次隐私窗口后重新打开，确认数据是否保留；正常窗口做同样对照。只能关闭本任务创建的窗口，不清其他来源或用户隐私窗口。
- [x] 核对 WebKit 官方 Storage Policy、ITP 七个 Safari 使用日及隐私浏览文档；以固定 SHA 源码辅助解释 persisted 与删除豁免的关系。明确官方承诺、上游实现推断、当前 Safari 实测三层证据，不把主干当成本机二进制源码。
- [x] 更新报告和延期项；记录没有真实等待七个使用日，也没有作永久存储保证。相关门禁通过后按 Step 提交中文详细 commit；独立审查与完整门禁仍在 S6。

## 自审

2026-10-17：P2 已有实际 DOM 计时和三浏览器 360 轮历史证据，S4 复用口径，不重新定义性能终点。S3 的独立解密目前每次调用会联网取密钥，离线测量须在断开前取得不可导出 key 并以共用只读函数解密；这仅调整测试代码。网页接口可用、持久授权与实际保留时长分别验证，性能测量不与当前 S3 十分钟实测并行。新场景和网路边界按任务逐项校准后才用于实机验收。

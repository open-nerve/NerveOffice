# UR-035 WebKit 在 COOP 进程切换时取消同一次页面导航

> 状态：本地已复现，上游已有问题与候选修复，未由本项目提交外部消息｜发现：M4-P6 S6，2026-10-18｜延期项：DEF-073

## 现象与根因证据

打开带 `Cross-Origin-Opener-Policy: same-origin` 的页面时，WebKit 将导航交给新进程；旧进程的迟到 `didStartProvisionalLoadForFrame` 又取消了同导航的临时页面，最终停在 `about:blank`。发生在页面提交和应用启动之前。

纯 loopback HTML、无产品和数据库代码的独立对照已复现。两组使用相同 Playwright 1.63.0 / Linux WPE WebKit r2359、Node 24.21.0、ARM64 镜像、2 CPU、1 个浏览器连接和 8 个并行循环；每轮新建 context/page，最多 2000 轮，单次导航 10 秒、整轮 900 秒，零重试。检测到首次失败即停止新轮次，已启动轮次正常结束。无 COOP 组 2000 次全部成功；COOP 组第 178 次导航超时，最终 218 轮中 217 次成功、1 次失败。两组无 OOM、驱动或收尾错误。URL 组名、轮次和动态端口用于归属；同步诊断日志会影响调度，不用该比例估算用户故障率。

失败导航的单连接身份：proxy3355 / frame4294967649 / loader3438，旧 target3356 / PID20165，新 provisional target3442 / PID20589。UTC 时间顺序：

1. 21:46:34.844，服务器完成 HTTP 200。
2. 21:46:34.846–.847，native 日志记录 COOP 进程切换、新临时页面、`ProvisionalPageProxy::cancel`，随后旧进程 `didStartProvisionalLoadForFrame`。
3. 同一协议流记录 provisional target 创建、同 loader 的 `provisionalLoadFailed: Load request cancelled`、非崩溃销毁、旧 target 迟到的 `requestWillBeSent`；之后没有 response 或页面 commit。
4. 21:46:44.755 导航超时；21:46:44.757 才开始测试清理。因此取消先于清理。

主审与独立审查均解压核对原始 63,764 条记录、26,229,070 字节及结束摘要，确认当前实验复现了上游签名。

## 上游与结论边界

- [Playwright #42957](https://github.com/microsoft/playwright/issues/42957)：维护者将问题归到 WebKit；issue 关闭不表示缺陷已修复。
- [WebKit 325840](https://bugs.webkit.org/show_bug.cgi?id=325840) 和 [PR 75569](https://github.com/WebKit/WebKit/pull/75569)：候选修复比较导航身份，避免同次导航被取消。2026-10-18 本轮查询时 PR 仍 open、未合并，head 为 `8158e7c563ec535014ef76ca7fdb80e12c95766b`。
- Playwright 1.63.0 的 WebKit 基础提交为 `4d05d732e5a84f32675bef4cc135a2e7a9269a87`。已检查 1.64.1 的基础源码和发布补丁，相关无条件取消逻辑未改变；没有运行或验收替换版本，不能称升级已解决。
- 原 CI `39059604657` / main `4f07e393` 的 WebKit 用例首次导航超时、重试通过。原件缺少协议/native 日志，**尚不能唯一证明原 CI 与本次竞态同因**。超时收尾的 `Target closed` 不证明自发崩溃。
- 当前复现为 Linux ARM64、额外诊断日志和最小网页；历史 CI 是 x64、产品上下文。不能扩大成所有 Safari 版本均受影响或 Chrome 已被证明没有任何导航问题。

## 原件与接续

原件根目录为仓库根下 `.codex/handoffs/m4-p6-20261017/`，在 P6 工作区外，清理 worktree 不得删除：

- `r4-diagnostics/upstream-reproduction-proof.json`：关联原件摘要和因果重建。
- `r4-diagnostics/upstream-coop-arm64-none/`、`upstream-coop-arm64-coop/`：完整 cases、HTTP、协议、native、容器状态和完整性审计；COOP 失败不记通过。
- `r4-diagnostics/playwright-coop-race.cjs`、`run-coop-race.py`、`protocol-sink-v2.cjs`、`audit-coop-race.py`：固定版本的有界对照与完整性核对。通过运行器创建新的证据目录；不得直接在旧目录启动 fixture。`audit.json` 是可重写的派生回执，重审前先保留旧版本。已释放的官方镜像缓存可按 `r5-playwright-image-cache-before.json` 中的固定摘要和架构重新下载。
- `r4-five-file-review.md`、`r4-upstream-candidate-review.md`、`r4-diagnostic-evidence-review.md`：独立复核及工具边界。
- `ci/39059604657/`、`ci-diagnostics/39059604657/`：历史 CI 六份报告/日志与失败回执。

开发接续与重开条件见 [P6 WebKit 阻断交接](../v0.1/M4-本地优先与离线恢复/handoffs/P6-WebKit导航阻断交接.md)。上游修复仍须在正式可固定的发行版上重新对照并执行完整项目回归；仅出现一次绿灯不关闭本项。

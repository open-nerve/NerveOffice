# P1 合并后 CI：关页前确认拦截结果

> 日期：2026-10-10｜基线：main `8db89a6e`｜修复分支：`codex/m4-p1-ci-fix`。本报告只处理两处 E2E 前提建立的竞态，未修改生产代码。

## 故障与证据

[首次合并的 CI 38021340220](https://github.com/open-nerve/NerveOffice/actions/runs/38021340220) 中，生产容器的 `handover-request.spec.ts`“发出过请求的那一页已经不在”用例首次失败、重试通过。`failOnFlakyTests` 正确将 job 标为失败。

用例要模拟：旧页已经发出编辑请求，离开时撤回没送到服务器；新页带着旧页的记号恢复等待。原实现安装 `route.abort`，但只等 `waitForRequest` 就立即关闭旧页。请求已经发出不等于拦截已经完成，关页会让尚未被拦住的 keepalive 请求继续发送。

CI 服务端日志给出了完整证据：03:50:49.685 的 POST 建立请求；03:50:49.753 的 DELETE 成功返回 204；03:50:52.103 的重新载入查询里 `request=null`。失败页面显示“请求编辑”，与服务器上已经撤回的事实一致。浏览器 trace 把关页中的 DELETE 记为没有响应，不能仅凭这一条判断请求没送到。

## 修复

- `handover-request.spec.ts`：在派发 `pagehide` 之前开始等对应 DELETE 的 `requestfailed`，收到事件后才关页。
- `handover-takeover.spec.ts`：“旧页已关、释放没送到”也有相同的先发出后立即关页顺序，一并等待对应 DELETE 失败。
- 保留原有恢复等待、不重新 POST、续期得到 `pending`、租约未结束和本人接管后的保存等断言。

超时、重试次数、CI 对 flaky 的判定及生产行为均未调整。

## 验证

| 验证 | 结果 |
|---|---|
| 根因复现：仅在原用例的 `route.abort` 前临时延迟 250 ms | Chromium 在同一个“取消请求”断言失败，服务端收到 DELETE；原故障重现 |
| 保留同一诊断扰动，加上等待 `requestfailed` | 两个用例在 Chromium、Chrome、WebKit 共 6/6 通过；无重试 |
| 撤掉诊断延迟后的两份完整 spec，自动保存照常运行 | Chromium、Chrome、WebKit 共 63/63 通过，零重试；1.6 分钟 |
| 相关 ESLint 与 E2E 类型检查 | 通过 |
| 生产镜像的完整容器 E2E | `CI=true pnpm test:e2e:container`：239/239 通过，零失败、零重试、零跳过；测试 2.9 分钟。重启三条用例、部署核对和主密钥日志扫描通过；环境自动清理 |
| 独立代码审查 | `p1_ci_review` 只读审查通过，无 Critical / Important / Minor；须完成正式回归后合并 |
| 修复合并后的六项 CI | 待推送后核对；本机结果不替代 CI |

诊断延迟仅用于根因实验，最终代码不包含它。日志及诊断 trace 在工作树 `.superpowers/sdd/P1-CI-修复/`，合并前备份到主目录 `.codex/handoffs/m4-p1-20261010/`。

## 独立审查

审查者 `p1_ci_review` 与主会话使用相同的继承模型，单独只读检查两处 diff、生产页面退出与释放的幂等处理、Playwright 事件与超时实现、原 CI 和诊断日志。审查者没有运行测试；上述执行结果来自主会话保存的日志与 JSON。

结论为无阻塞问题，等待正式回归通过后可合并。保留恢复与保存的全部结果断言，没有用测试拦截替代业务行为。审查中特别核对并排除了以下情况：

- `requestfailed` 单独不证明服务端未收到，但本例已经预先安装 `route.abort`，且关闭操作在失败事件之后，前提成立。
- 真实关闭再次派发 `pagehide`：`withdraw` 同步清空请求进度，租约 `release` 同步记录释放状态，不会再发送第二次 DELETE。
- 浏览器错误文本差异：不匹配具体错误字符串；两类等待使用相同的既有超时。
- 同类遗漏：另一个拦截 DELETE 的中断用例退出后继续使用页面，不立即关闭；不属于本次竞态。真实关闭后成功释放的 keepalive 行为仍由既有独立用例覆盖。

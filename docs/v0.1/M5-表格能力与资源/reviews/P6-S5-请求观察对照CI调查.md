# P6-S5 请求观察对照 CI 调查

2026-11-03。原 CI `41622949552` / `2fcd4b2e` 的 Chrome 分片已失败，另有浏览器尚在执行。以下为局部测试夹具调整及证据边界，**尚未取得调整后的真实浏览器 GREEN**；原失败和既有三次请求断言保持。

## 原件与已确认事实

- Chrome job `125873024373` 的原汇总为 804 passed、2 failed、24 did not run。两处失败分别是已单独调查的 CSV 重做按键与本篇请求观察对照；24 条依赖未执行不能记为平台豁免。
- 原报告 ZIP 为 `central-acceptance/ci-evidence/ci02-chrome-early-41622949552/output/e2e-reports-chrome-41622949552.zip`，20,337,031 bytes，SHA-256 `80c4e9b15cc892129152bd288a2134cdcae413f330949b86cbd5a440914294d0`。创建前登记 Archives 后只读下载，原件不改写；完整收集后核对重复归档，按原保留策略处理。
- 两次实际尝试（retry 0/1）的 `request-observer-control` 附件均为两次 `/probe` 和一次 `/new-page`，但 `targetHits=4`。原 trace 也只列这三个目标请求；`/new-page` 的响应为 `text/plain`。页面/Worker 的允许结果、前两次服务端计数与三项 context 请求列表均已通过，最后 `expect(target.hits()).toBe(3)` 失败。
- 原 `startTargetServer` 不分路径累计所有请求，未保存路径。安装的 Playwright 1.63.0 `lib/coreBundle.js` 在 `_isFavicon` 时从 context request/response 事件直接返回；判定包含以 `/favicon.ico` 结尾的 URL。因此 trace/context 列表不能用于证明未发生隐式图标请求。

派生读取记录：`central-acceptance/ci-evidence/ci02-chrome-early-41622949552/request-control-survey.json`。JSON 和 HTML 的已知环境对象检查通过；两个只读解析脚本前置错误（空可选 trace 成员、导入搜索路径）均未改原件，修正后读取得到上述原始事实。

## 判断与局部调整

**工作假设是新页导航触发了自动 `/favicon.ico`。** 原件没有第四次请求的服务端路径，所以不将这个推论写成已实测根因。两次相同的 3/4 差异、纯文本导航及 Playwright 的显式隐藏逻辑支持该假设。

在既有 P6 常规局部修复授权内，只调整 CSP 的测试目标端与其附件：

1. `/new-page` 返回带显式内嵌 SVG 图标的最小 HTML，仍执行原跨源新页导航；页面/Worker 的 `/probe` 及其他路径的响应不变。
2. 所有到达请求仍累计，不过滤 favicon 或未知 URL。原 `0 / 2 / 3` 次计数、请求列表、CSP 与全部结果断言保持；没有改变超时、重试、浏览器范围、生产代码或 CI。
3. 附件补 `targetRequests`：最多前 32 个原始路径，每项 2048 字符，完整到达次数仍由 `targetHits` 记录。若再次失败，可直接区分额外路径；不能凭这个调整追认旧失败或自动重跑同一 SHA。

## 验证与后续

先新增真实 HTTP 小样例：证明 `/favicon.ico`、未知路径不能从计数与诊断中被过滤，以及样本上限不截断完整计数。原夹具的两项均因缺少路径记录按预期 RED；实现后与既有请求观察测试共 **5/5** 通过。新增用例只验证诊断契约，不冒充浏览器图标行为的证明。

限定 ESLint 零告警、E2E TypeScript 与四浏览器 CSP 的 12 条只读列举通过，实际浏览器执行 0 条。三轮受管结果及实际资源删除在外部回执中核对，不以脚本退出代替清理检查。限定独立审查 **C/I/M=0/0/0**；原 ZIP、两个 trace、冻结源码和三轮实际根删除均核对一致，报告位于 `central-acceptance/csp-observer-fix/independent-review.md`。

等原六项全部完成并保留原件后，以通过相关检查和独审的新 SHA 正常推送、运行原六项 CI。在真实结果仍未满足三次断言前，本项保持未验证；若出现额外路径，依据新原件继续局部定位，不扩大断言。Mac 长测暂停、Linux/Mac 平台边界、P6 未合并和 M5 未完整验收保持。

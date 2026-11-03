# P6-S5 云端首轮结果与 WebKit 总时限建议

2026-11-03。原六项 CI [41622949552](https://github.com/open-nerve/NerveOffice/actions/runs/41622949552) 已结束，固定输入 `2fcd4b2e604f068e81620cbc5491d0dbc5f0750f`、P6 分支、workflow_dispatch、attempt 1。**整体失败，未验收。**没有重跑旧 SHA，也没有移动远端受测分支。

## 已取得的结果

| 分片 | 原报告事实 | 尚欠 |
|---|---|---|
| verify | 742 文件、17,667 项单元/集成通过；lint、类型、静态/构建/依赖/预算/审计门禁成功 | 原日志包含将图片样本 README.md 误按代码解析的覆盖率警告，原件保留；未修改覆盖率配置或宣称日志无告警 |
| Chromium | 805 passed、1 failed、31 依赖用例未执行 | CSV 重做按键；crash/restart 不能记为平台跳过 |
| Chrome | 804 passed、2 failed、24 依赖用例未执行 | 同一 CSV 按键及请求观察对照 |
| Edge | 805 passed、1 failed、24 依赖用例未执行 | 同一 CSV 按键；对照附件另有下述迟到到达记录 |
| WebKit | 821 passed、8 个原平台跳过、1 interrupted；没有断言失败或 flaky | 最后一条写入原子性用例被整批总时限中断，不能纳入平台豁免 |
| 生产容器 | 342 passed、1 failed、11 依赖用例未执行 | 同一 CSV 按键；crash/restart 尚未执行 |

五份 E2E JSON 与 HTML 的案例集合、尝试次数、状态逐项一致，范围与固定列表相同，已知环境序列化检查均通过，报告未见全局 errors/flaky。Playwright 将 WebKit 中断例也汇入 skipped=9；逐尝试原件表明只有 **8 个真实平台 skip 和 1 个 interrupted**。

四个浏览器各 29 条 selftest 均首过。US-M5-14 每个浏览器 14 条：Chromium/WebKit/Edge 的测试断言通过，Chrome 13 通过、对照 1 失败。**Edge 对照断言当时通过，但 finally 附件 targetHits 已变为 4、context 列表仍为 3**；不能只凭绿色案例接受整个对照，后续须核对最终附件也为 3。它与 Chrome 两次 3/4 差异相符，第四路径仍因旧服务未记录而未知。

## 两项局部调整已完成，但真实 GREEN 待取得

- `734daafd`：CSV 改用 SDK 注册的跨平台 Ctrl/Cmd+Y；原内容、一次撤销重做、保存重开与下载断言保持。静态检查和限定独审 0/0/0 通过，详见[按键调查](P6-S5-CSV重做快捷键CI调查.md)。
- `8d1c8975`：对照新页显式内嵌图标，同时记录有界的真实到达路径，不过滤 favicon/未知路径，不改变原 0/2/3 次断言。两项 HTTP 诊断样例先 RED，相关 5/5、lint/类型/只读列举及限定独审 0/0/0 通过；三轮临时资源实际清理。详见[对照调查](P6-S5-请求观察对照CI调查.md)。图标解释是待真实验证的工作假设，非旧原件中已观察到的路径。

两次修改均经正常中文提交/hooks。主目录仍 `main@82c3c266`，远端 main 仍 `884591c8`，远端 P6 仍为受测 `2fcd4b2e`。尚未推送这两项调整。

## WebKit 中断的直接原因

原 supervisor snapshot 的 `runtime.startedAt=1793703286124`，`stop.at=1793708686124`，差值 **5,400,000 ms**；`reason=deadline`，16 ms 后发起软停止。结果为 `stopped=true / forced=false / quiescent=true`，owned 数组为空，退出诊断没有 unavailable。

最后一例为 `crash/write-atomicity.spec.ts:212` 的发件箱 Worker 写入管道：收到“写入之前”信号后按原随机窗口结束浏览器，核对读回旧或新的一份。它运行 2,589 ms 后被外层中断，错误列表为空、retry 0；前 821 条通过。这证明**本次直接阻断是整个分片的 90 分钟运行预算**，不能从尚未完成的一例推断产品通过，也不证明提高时间窗口后必然成功。

WebKit 最终原环境计量约 8.19 GiB、可用盘约 73.45 GiB、报告约 30.26 MiB，分别在既定 16 GiB/12 GiB 余量/5 GiB 报告界限内。其他五项也未报告预算越限或 cleanupError；全部 producerQuiescent。此为本轮记录，不能据此证明此前 Mac 的 WindowServer 根因已解决，也没有完整内存/CPU 采样可断言绝无性能压力。

六项资源回执均保持 `host-disposal-pending / cleanupComplete=false`；没有实测 GitHub VM 删除。容器原台账的闭合也已独立按当前校验器重放。原失败/中断状态不改写。

## 建议：仅调整云端 WebKit 的整批窗口

这份建议**尚待用户决定，未修改执行器或工作流**。当前功能断言和单例性能预算保持，建议为现有 830 条整批预留运行余量，而非靠同一 90 分钟窗口碰运气。

| 项目 | 当前值 | 建议值 |
|---|---:|---:|
| 仅 WebKit 分片的执行器整批 runMs | 90 分钟 | 120 分钟 |
| 仅 WebKit 的 verify E2E 外层 step | 115 分钟 | 145 分钟 |
| 仅 WebKit 的整个 job | 140 分钟 | 170 分钟 |
| Chromium/Chrome/Edge，verify/生产容器 | 原值 | 保持 |
| 15 分钟退出收尾、1 分钟强制核验、单例时限/次数/数据规模/断言/重试判失败 | 原值 | 保持 |
| 16 GiB 原环境停止阈值、12 GiB 磁盘余量、5 GiB/14 天报告及所有清理身份规则 | 原值 | 保持 |

具体执行顺序：

1. 在唯一 P6 内，以固定分片名称选择预算，只在 `E2E_BROWSERS=webkit` 对应的创建前 owner 记录使用 120 分钟。默认与其他分片保持 90 分钟；不接受任意分钟数参数，不在运行中修改或重新认领 owner/计时起点。
2. 同步原 `ci.yml` 的 WebKit step/job 上限，保持原六项、事件/触发规则、并发与进程停止模型。历史 P4 成功签署脚本及其固定 90 分钟原件不改写；本轮 P6 外部证据核验读取并验证实际分片预算。为新 SHA/run 新建的只读监视窗口须覆盖 170 分钟 job 与最终状态同步余量；旧 `ci02-monitor.py` 的 155 分钟窗口及本轮原件不改写，监视窗口不增加测试运行预算。
3. 先跑小型固定映射、原截止时间不重置、软停止及收尾验证，相关 lint/typecheck 和独审。用秒级子进程即可，不在本机启动浏览器或模拟 120 分钟等待。
4. 正常中文提交，走原 pre-push hooks 推送新固定 SHA，再经已登录网页手动启动一次原六项 CI。旧 API 403 不重复调用，先查同 SHA 是否已有运行；不重跑原失败 SHA。新轮仍按原实际失败和资源异常停止条件处理。
5. 按原件审核最后一条 WebKit、CSV 完整故事、对照最终附件、依赖项目、selftest、报告与资源；在真实全绿前不签署 Linux 预验收，更不自动合并 P6 或宣布 M5 收官。

不建议删除最后一例、减少原子性迭代、放宽单例超时、只补跑一例拼成整轮成功，或现在恢复本机长测。拆分新增 CI job 也可降低单片时长，但会扩大现有编排、依赖及证据身份契约；相较之下，本次固定 WebKit 整批窗口调整范围更小。

需要这次决定的具体依据是已批准[集中方案](P6-S5-Linux集中预验收与环境方案.md)第 4 项明确保持“原断言、覆盖率、预算、超时、重试判失败、报告安全检查和工作流接线不改”。用户原 P6 提前推送与新 SHA 接续授权继续有效，不重复申请发布；这里只请求上述总运行窗口的有限变更。无需用户准备新机器、增配 Docker、提供密码或启动脚本。

## 原件、清理与后续边界

`central-acceptance/ci02-collection-result.json` 登记本次 6 份日志和 10 个 ZIP，原 payload 合计 **97,793,950 bytes（93.26 MiB）**，无缺件。16 件均已复算 SHA-256，与本地收集回执相符；其中 10 个 ZIP 另外与 GitHub API artifact digest 逐件相符，6 份日志没有 API digest。`ci02-initial-survey.json`、`ci02-s2-s3-survey.json`、`ci02-resource-summary.json` 保存逐项事实和限制；原 ZIP 没有全量解压，完整 VM/profile/数据库未下载。

独立事实与方案复核原为 C/I/M=0/0/1，唯一 Minor 是上文摘要来源措辞，限定更正后为 0/0/0；原发现保留于 `central-acceptance/ci02-result-proposal-review.md`。完整失败证据包现已实际 pin，理由限定为此固定 SHA/run 的必要诊断，不代表验收通过。

早期容器和 Chrome 的三个重复 output 已核对逐字节相等，经过原归属、锁及完整句柄检查后，按预登记事务实际退役 **36,936,211 bytes（35.23 MiB）**。完整包 16 件原件、early 索引和派生诊断的前后摘要均未变，重复 prune 没有进一步删除。磁盘可用空间从 **94,681,706,496** 到 **94,719,639,552 bytes**，观察净增 **37,933,056 bytes**；APFS 和其他写入可影响这一差值，不能等同本轮唯一释放量。清单及结果为 `ci02-duplicate-retirement-inventory.json` / `ci02-duplicate-retirement-result.json`。本篇不替代完整成功证据审查。

本机浏览器/完整长测暂停，Mac 执行方式仍需 Linux 预验收之后单独决定。S6 全 Phase 审查、架构/ADR/交接/延期更新、最终 main 同 SHA CI 和 Phase 关闭仍欠；Excel、Safari/Finder、M4 DEF-073/UR-035 及 M4 验收/标签按原授权独立留账。M5 未完整验收。

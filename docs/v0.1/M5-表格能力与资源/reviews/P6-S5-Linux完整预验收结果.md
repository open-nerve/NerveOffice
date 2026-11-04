# P6-S5 Linux 完整预验收结果

2026-11-04。固定提交 `ad6e947032a2b19d6e93c4acb5548730b2a2113e` 的 [CI94 / 41682412692](https://github.com/open-nerve/NerveOffice/actions/runs/41682412692) 原六项任务全部成功。原始报告已收齐，精确用例和资源审计通过，**独立原件复核已接受，必要唯一证据已实际 pin**。本文只接受该固定输入的 Linux 完整预验收，不签署 Mac 完整 Gate、P6 合并、最终 main CI 或 M5 完整验收。

## 本轮结果

唯一 P6 分支 `codex/m5-p6-closeout` 正常 pre-push 通过后推送；提前登记意图，只触发一次 `workflow_dispatch`，attempt 为 1。六项均对应上述 SHA、workflow `367624220` 和原 Ubuntu 24.04 环境，运行期间未移动远端分支。

| 项目 | 实际结果 | job 耗时 |
|---|---|---|
| 非浏览器完整门禁 | 744 文件、17,673 项单元与集成通过；其余原静态、覆盖率、构建及依赖门禁通过 | 21 分 06 秒 |
| Chromium | 833 passed、4 原平台 skipped；共 837 | 62 分 33 秒 |
| Chrome | 826 passed、4 原平台 skipped；共 830 | 75 分 51 秒 |
| WebKit | 822 passed、8 原平台 skipped；共 830 | 78 分 18 秒 |
| Edge | 826 passed、4 原平台 skipped；共 830 | 64 分 57 秒 |
| 生产容器 | 354 passed；包含 4 条生产崩溃恢复与 7 条后端重启 | 29 分 14 秒 |

四浏览器合计 3,307 passed、20 原平台 skipped；容器无跳过。所有 3,681 条浏览器/容器记录均只有初次 attempt，零重试、flaky、失败、未运行或全局错误。用例身份与同 SHA 只读列举完全一致，20 个跳过的身份、原因及对应源码守卫保持，未新增 skip。

本轮真实核对：

- 每个浏览器 29 条 selftest、14 条 US-M5-14 请求故事及 19 条 CSV 用例全部首过；容器 15 条 CSV 用例首过。CSV 的 Linux 重做路径已通过，未改原数据/撤销/重做断言。
- 四浏览器请求对照的最终附件均为实际到达 3 次、观察 3 次，路径严格为 `/probe`、`/probe`、`/new-page`。旧轮第四次请求的确切来源仍未被观测，不把本轮 GREEN 写成旧 favicon 假说已证实。
- WebKit 上轮被整批时限中断的最后一条写入原子性用例本轮首过；两条写入管道的六个原子性用例均执行。四浏览器与容器共 83 份崩溃附件、223 轮，原进程归属/退出及 OPFS 证明通过。
- 实际 owner 中 WebKit `runMs=7200000`，其他三个分片 `5400000`；cleanup/force/poll 仍为 `900000/60000/250`。四个监督器均正常退出、quiescent=true，无强制停止、未知采样或残余所属进程。本轮 WebKit 提前完成不推翻上轮恰好 90 分钟截止的事实，也不证明时长稳定。

覆盖率原汇总为行 94.02%、语句 93.97%、函数 94.86%、分支 90.44%；没有降低原门槛。JSON 与 HTML 内嵌报告逐例身份、状态、attempt、附件一致，已通过当前 `report_safety.py` 的已知序列化环境边界检查；这不是对任意日志内容不存在秘密的泛化保证。

## 资源与证据

主目录 `.codex/handoffs/m5-p6-20261102/s5/central-acceptance/` 保存本轮材料：

- `ci03-collection-result.json`：6 份日志、10 份原 ZIP，共 **49,097,324 bytes（46.82 MiB）**。16 件本地尺寸/SHA-256 与实际字节相符；其中十份 ZIP 另与 GitHub artifact digest 逐件相符，六份日志没有 API artifact digest。输出独占创建，无重复下载、覆盖或解包整个环境。
- `ci-evidence/ci03-41682412692/output/`：原件、run/jobs/artifact 元数据；已封存，并在独立接受后实际 pin 此必要唯一通过证据。
- `ci03-initial-survey.json` 与 `ci03-audit-precheck.json`：实际清单/原跳过、报告安全边界及审计前固定输入。
- `ci03-audit-completion.json`、`ci-evidence/ci03-audit-2e8fe220-0e7f-42f7-ab33-d6bf5fd032d1/output/`：实际资源重建复核和原运行记录；自动审计通过，原始回执保持当时“独立接受待完成”状态。后续独立接受及两份必要归档的实际 pin 另见 `ci03-result-completion.json`，不改写原执行回执。

审计使用同 SHA 的十个资源校验模块，在受管临时目录中串行复核六份资源包及必要的有界持久性证明，未启动真实浏览器或 Docker。run `2e8fe220-0e7f-42f7-ab33-d6bf5fd032d1` 退出 0、producerQuiescent=true、cleanupStage=complete；进程组已退出，scratch 与短目录实际不存在，46,212 bytes 的审计报告/原台账另按归档规则封存。

云端各 run 仍遵守方案 B：稳定导出和身份/退出/容量检查成立，原目录的 `cleanupStage=host-disposal-pending`、`cleanupComplete=false` 保持，**未实测 GitHub VM 最终删除**。生产容器独立证据确认本轮 4 容器、1 网络、2 卷及 1 测试镜像闭合；不得把这一事实扩大为整个宿主原环境均已删除。

审计工具独审原为 C/I/M=0/1/1。重要项 I-01 的精确 6 日志/10 ZIP 及 API digest 绑定已通过真实 KiB 反例 RED→GREEN，相关 19 项全过。Minor M-01（自动冻结跳过输入）保留：当前 20 个唯一跳过及七份守卫已独立核实；本轮审计前后均人工核对原输入 SHA-256 `2b3ea9658b67c435dd06d65bf4b35eb9bc839860fd76b33e79ee7ef0933854aa`，无漂移。没有宣称自动加固已经实现。

## 独立接受

原件与九份结果/状态文档的独立复核报告为 `central-acceptance/ci03-evidence-review.md`，13,579 bytes，SHA-256 `d2b9e154bd572aacde235800443245a6b0507cfcecc0ae3ebc73c99d065b8b72`。审查重新计算 36 件冻结输入，逐例核对 3,681 条 identity 和 804 个附件的真实字节，核对实际预算、资源原回执、十个校验模块的 Git blob 及本机临时目录清理事实，接受本轮 Linux 完整预验收证据。

初审 C/I/M=0/0/1，唯一文档 Minor M-DOC-01 为区分 16 件本地摘要与 10 ZIP API digest；本文已按原事实澄清。原审查和受审摘要保持，未将初审改写为零发现，也未因此重跑测试或审计。审计工具 M-01 仍是上段独立延期项。

随后在归档根保留锁及两个 bundle 锁内核对归属与封存状态，实际 pin 原 CI 包和 46,212 bytes 审计原件。`ci03-result-completion.json` 记录原审查摘要、pin marker/理由和真实清理；`linuxPreacceptanceAccepted=true`，Mac、最终 main CI、M5 完整验收和 VM 实测删除均保持 false。

## 接续边界

旧 CI02 `41622949552` 的失败及必要原件继续保存；本轮通过不追认旧 CSV、请求附件或超时结果。全 P6 源码范围 `82c3c266..ad6e9470` 的 93 件文件已获[独立源码接受](P6-S6-阶段源码审查.md)，它与本篇的实际结果复核分开记录。

当前 main 保持 `82c3c266`，P6 未合并；远端 main 保持 `884591c8`。Mac 完整 Gate 与 WindowServer 首次崩溃根因仍未解决，原生 Excel/Safari/Finder 和 M4 欠账保持；US-M5-14 的本轮 Linux 实测不自行改变故事状态或平台验收范围。

本轮原件已独立接受并保存，下一步呈交[Mac 平台验收与工程接续建议](P6-S6-Mac平台验收与工程接续建议.md)。改变 P6 工程合并前置顺序仍须明确决定；尚未合并、推 main、恢复本机长测或打 `v0.1-m5`。

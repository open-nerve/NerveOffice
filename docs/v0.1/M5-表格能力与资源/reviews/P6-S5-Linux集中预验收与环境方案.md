# P6-S5 Linux 集中预验收与环境方案

2026-11-02。状态：方案待用户决定；本轮仅进行了只读环境核验，未推送分支或触发 CI。

## 结论与已核实环境

**建议复用现有 GitHub Actions 原生 Linux x64 runner，用户暂时无需购买或安装新环境。** 当前 Mac 的 Docker 内存无需增加，也无需升级本机 Chrome/Safari 来解决 Linux arm64 缺少品牌浏览器的问题。已安装的 Playwright 1.63.0 的 Chrome/Edge Linux 安装脚本在 aarch64 明确拒绝；本轮 29 条通过的运行器只提供 Linux arm64 Chromium 证据。

只读核验已确认：

- `open-nerve/NerveOffice` 为公开仓库，未归档，默认分支 main；现有 Git 凭据能读取 GitHub API，账户有仓库写权限。未要求用户提供密码或令牌；细粒度令牌的推送/调度能力仍以实际执行结果为准。
- CI workflow `367624220` 已启用，默认分支含 `workflow_dispatch`；当前 P6 的 `.github/workflows/ci.yml` 与远端 main 的文件逐字节相同，SHA-256 为 `113b38f8ea3bbd329dc7d5caed09f1ac51ab5569f306d37ef4989015bfc2e655`，不需要新增 runner 或修改 CI 触发器。
- 远端 main 为 `884591c8`，最近的定时 run [41432219452](https://github.com/open-nerve/NerveOffice/actions/runs/41432219452) 六项通过；它只验证旧 P4 输入，不能用于签署当前 P5/P6。原生 x64 云端路径已有实际使用记录。
- 本地 main 仍为 `82c3c266`；唯一 P6 worktree 为 `codex/m5-p6-closeout`，远端该分支尚不存在。当前代码/文档基线为 `1dbcdbaa`，本方案提交后固定新 SHA 再执行。
- GitHub 官方将标准 `ubuntu-24.04` runner 列为 x64，公开仓库规格为 4 CPU/16 GB RAM，标准 runner 计算使用免费；实际磁盘必须在本轮预检，不从宣传容量推断可用空间充足。[runner 文档](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)

原件位于主目录 `.codex/handoffs/m5-p6-20261102/s5/central-acceptance/`：`remote-readonly01.json`、`recent-ci-readonly01.json` 和 `remote-main-ci.yml`；未保存凭据。

## 选择与取舍

| 选择 | 用户需要准备什么 | 取舍 |
|---|---|---|
| **建议：现有 GitHub Actions** | 当前无需新设备或安装；需要批准现有 P6 分支提前推送并手动运行原 CI | 原生 x64、原六项任务和既有回收策略可复用；要改变本次分支推送时序，仍须另行处理 Mac 验收差异 |
| 自备独立 Linux x64 主机 | Ubuntu 24.04 x86_64、可访问的普通用户和 Docker；建议 4 CPU/16 GB RAM、至少 80 GiB 空闲盘作为准备余量，非实测最低门槛 | 可在本地门禁之外隔离长测，但需建立远程源码、凭据、资源归属和报告运输，不如现成 CI 直接 |

当前不建议为此启用本机 amd64 模拟或恢复 Mac 全量浏览器。已有证据不能证明 WindowServer 首次崩溃根因已解决。首选是执行者建议，并未将其写成用户已批准的选择。

## 可执行范围

1. 继续唯一 P6 分支；批准后记录授权，固定干净 SHA、远端 main/Phase ref 和 workflow 摘要。检查源码未夹带凭据、当前受管资源已清理，并按现有流程完成相关检查。迁移门禁额外明确以已核实的远端 main 为基准；当前 migrations 与远端无差异，手动 CI 的 `HEAD^1` 默认值不能替代整个未发布范围的核对。
2. 正常推送 **现有 `codex/m5-p6-closeout` 分支**。保留 pre-push 的 `pnpm verify --fast` 和全部 hooks，不 force，不推 main，不合并，不另建分支；若远端分支意外已有不同历史，先核实，不覆盖。主目录 HEAD 始终为 main。
3. 通过已有 `workflow_dispatch` 手动触发该 Phase 分支的原 CI。默认分支已存在入口，官方支持选择非默认分支；使用既有凭据，不把它写入命令参数/日志。[手动运行文档](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow)
4. 原六项任务完整运行：非 E2E 完整门禁、Chromium/Chrome/WebKit/Edge 四个 E2E 分片、完整生产容器。原断言、覆盖率、预算、超时、重试判失败、报告安全检查和工作流接线不改。原 CI 的六个任务在各自独立 VM 中按现有编排运行；本机重型检查继续串行，不在 Mac 另开浏览器负载。
5. 推送和调度意图先落盘。HTTP 超时/中断时先只读核对远端 ref 和 run 列表，不重复 POST 猜测重试。run 必须与预登记 SHA、分支、workflow、event 和时间窗对应；匹配不唯一时停止。运行中不移动受测远端分支。
6. 收齐同一 SHA 的六项结果、必要 JSON/HTML/资源/源码证明和有界日志。下载前核对 artifact 清单、大小及磁盘余量，报告沿本 worktree 合计 5 GiB/14 天规则管理；证据审查后只 pin 必要最终材料。原环境继续按方案 B 登记 `host-disposal-pending`、`cleanupComplete=false`，不能声称实测删除了 GitHub VM。
7. 任何失败都保留实际结果和原件，不自动重跑同一失败 SHA。已定位的局部问题仍在本 P6 分支修复、相关验证和审查后，按本方案登记新的固定 SHA 接续；未知资源/身份/权限故障、跨模块或高风险问题按原决策边界停止说明，不放宽规则或无界重试。

## 验收边界与后续

这是当前 P6 输入的 **Linux 完整预验收**。原工作流各分片在检查步骤上与完整 Gate 对应，但 Linux 不能冒充本机三个浏览器、真实 Safari 或 Mac 平台行为。即使六项通过，也不自动满足原“本机完整 Gate”条款，不合并 P6、不打 M5 标签。

取得这份完整 Linux 结果后，继续整理 Mac 专属/条件用例和跨平台差异，再提交本机有界补验或明确的平台执行裁决；不能把原自动化失败记成环境缺口放行。最终 main 的合并、推送及同最终 SHA CI 仍按原收官流程执行，Phase 分支的结果不能替代最终 main 结果。Excel、Finder/Safari 和 M4 已登记欠账保持原边界。

若平台资源或权限实测不满足，先给出准确缺口。届时用户可能只需调整 GitHub 授权/资源，或选择备用 x64 主机；现在不要求安装 Excel、解锁桌面留空闲、启动 Terminal、提供密码或购买服务器。

## 本次需要的决定

批准本次 M5-P6 的限定例外：**在合入 main 之前推送唯一 P6 分支，并按上述范围进行云端完整预验收及有依据的新 SHA 接续。** 项目 `CLAUDE.md` 的现行规则是“只在合并到 main 之后推送 main；进行中的分支只保留在本地”，当前授权尚未覆盖这一发布时序。批准后补记本次例外；默认分支纪律和原最终质量要求保持。

方案独立复核 C/I/M=0/0/0，核实了原六项 CI、固定输入/调度/资源边界和官方环境说明，可提交交用户决定。此结论不等于发布授权；没有运行新测试、推送或触发 CI。

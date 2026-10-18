# M5-P1-S6 lint 容量修正独立复核

日期：2026-10-19。独立审查者：m5_p1_phase_review，沿用父会话继承模型；未另派 agent、未使用 code-review 插件。

## 结论

本次修正可接受，未发现 Critical、Important 或 Minor 问题。证据支持当前全仓库类型感知 lint 的工作集超过 Node 默认约 4 GiB 旧生代容量；将 ESLint 这一个 Node 进程的旧生代上限设为 6 GiB，是有对照证据的容量修正。扫描范围、规则、零警告门槛和 verify 步骤均未降低。

这不表示整个 P1 门禁已通过，也不证明 lint 的内存使用不存在进一步优化空间。默认完整门禁及最终 CI 仍需按父任务计划执行，不作为本次新增缺陷。

## 范围与执行限制

审查工作区为 /Users/xiaoruan/project/nerve-office/.codex/worktress/codex/m5-p1-assets，当前提交 5f877fe8f9635de9b841887ba07bbfc2efeb5168，复核该提交之上 package.json 与 CLAUDE.md 的未提交差异。未修改仓库，未运行 lint、测试、浏览器或容器；仅阅读文件、已安装 CLI 入口、日志与 JSON，并用只读脚本统计日志。唯一写入是本报告。

## 原因与对照证据

| 证据 | 已读取事实 | 判断 |
|---|---|---|
| s6/s6-gates/task4-verify-01-20261018T161023901711Z/run.json | 完整默认范围 verify 在 lint 失败；整体 exit 1；sourceChanged 为空，后续没有结果。 | 首轮是实际失败，不能当门禁通过或 M4 例外。 |
| s6/task4-lint-debug-01.json、log | 同一 HEAD，未设置 NODE_OPTIONS；130.599 秒后 SIGABRT；RSS 4,792,188,928 B。日志末尾连续 Mark-Compact 后仍有约 4,062.7 MB 堆，明确报 JavaScript heap out of memory。 | 支持 V8 堆容量不足，并非测试失败或普通 lint 规则报错。 |
| s6/task4-lint-heap-control-01.json、log | 显式 6144 MiB，附加只用于观测的 trace-gc/debug；exit 0，117.533 秒，RSS 5,569,511,424 B，后段 GC 后约 4,525.8 MB 堆。 | 新上限使同一完整扫描成功，实际存活工作集超过原上限；提高到 6 GiB 有依据。 |

以上相对证据路径均以 /Users/xiaoruan/project/nerve-office/.codex/handoffs/m5-p1-20261018 为根。本审查重新统计两个 debug 日志的配置文件路径集合：均为 1,980 个且完全相同；成功轮实际完成 lint 的文件为 1,754 个，未发现工作区副本、node_modules、dist-e2e、test-results 或 playwright-report 被纳入完成 lint 的文件集合。既有忽略配置未变。

计数口径应保持准确：失败轮为 1,680 次 Parsing successful、1,716 个文件完成 lint；成功轮为 1,713 次 Parsing successful、1,754 个文件完成 lint。全体 lint 文件含非 JS/TS 类型，不能把 1,754 写成全部 JS/TS 解析数。

现有 ESLint 配置启用类型感知，已安装的 @antfu 配置使用 TypeScript projectService；该机制与全仓库多个工程的内存保留相符。日志足以支撑本次容量决策，但没有堆快照可把每一段内存逐项归因到具体工程或规则，因此不作“已证明无泄漏/无优化空间”的额外断言。

## 命令、范围与预算边界

1. [package.json:14](../../../../package.json#L14) 将入口改为 node --max-old-space-size=6144 node_modules/eslint/bin/eslint.js . --max-warnings 0。已核对安装的 eslint 10.11.0 的 package.json：其公开 bin 本来就是 ./bin/eslint.js；原 pnpm shim 也最终执行该入口。此次没有换 lint 引擎或跳过检查。
2. Node 选项放在脚本路径之前，后面的点号和 --max-warnings 0 继续传给 ESLint。没有添加 cache、ignore、quiet 或规则覆盖；[verify 的 lint 步骤](../../../../tools/src/verify/plan.ts#L75) 仍执行 pnpm lint，CI 继续调用同一 verify 流程。
3. [package.json:15](../../../../package.json#L15) 的 lint:fix 复用 pnpm lint --fix，保留完整范围、预算与零警告要求，避免两个入口以后漂移。当前仓库没有名为 lint 的 pnpm 内置命令冲突；脚本参数按既有 pnpm 运行方式转交给 lint。
4. 命令仅使用 node、pnpm 和项目相对入口路径，没有 POSIX 专有的环境变量赋值或绝对宿主路径。Node 能处理该正斜杠相对文件路径；项目已启用 shellEmulator。静态检查未发现 macOS/Linux/Windows 命令语义问题。本轮没有运行 Windows，因而不宣称已在 Windows 实测。
5. 6144 的单位是 MiB，等于 6 GiB；它限制 V8 旧生代，不能当成 ESLint 整进程 RSS 硬限，机器需要为其他堆区、原生分配和同机服务留出内存。[CLAUDE.md:81](../../../../CLAUDE.md#L81) 已在旧生代上下文中说明该预算、开发机/CI 容量与禁止全局 NODE_OPTIONS。此次未修改生产启动、图片子进程限制、容器预算或全局环境。

## Findings

Critical 0；Important 0；Minor 0。没有需要修复的实现缺陷或审批阻断项。上述日志计数口径属于证据记录澄清，不是 package.json 的代码问题。

## Declined to judge

- 不判断未知规模未来仓库的 6 GiB 容量是否仍够；本次依据当前文件集合和实际成功工作集。
- 不以本机 ARM64 对照宣称 Linux CI 或 Windows 已实测通过；最终 CI 结果仍由实际运行提供。
- 不在本轮要求改写 ESLint 项目服务、拆分规则或降低检查范围；目前没有证据要求这种更大范围的改动。
- 不判断尚待执行的整个 P1 完整门禁、容器与原生 x64/同 SHA CI 结果，不适用 M4 既有例外。

父任务可提交这一小范围容量修正并继续完整验收。若后续 CLI/规则/范围或预算继续变化，应以新差异和实际回执重新判断。

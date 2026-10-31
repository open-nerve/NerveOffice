# P4-S6 Linux 进程身份观察补正实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax. 用户已授权自主推进；保持唯一 P4 worktree，不再请求例行批准。

**Goal:** 修正已证明的 Linux 合法退出形态兼容缺口，并让未知解析失败留下足够且不泄漏内容的诊断。

**Architecture:** 将 stat 解析和有界读取集中为独立模块；监督器只消费完整正身份或有依据的不存在结果。精确退出哨兵在 reader 内完成有界重新观察，不能进入归属/发信号模型。诊断继续复用已有阶段错误与静态快照链。

**Tech Stack:** 现有 Node 24.21.0、TypeScript、Zod、Vitest、Linux /proc 和受管测试资源入口；不加依赖。

**Spec:** [Linux 进程身份观察补正](../specs/P4-S6-Linux进程身份观察.md)。

## Global Constraints

- 主目录始终 `main@3dc2cde057cef1810b443fab0e81fa11ee5ad4f9`；实现只在既有 `.codex/worktress/codex/m5-p4-history-gc`。初始 Phase tip 为 `e472b6d768ece6ad54d2069e9ac79c310da05d76`。
- 可授权身份继续正 PID/正 PGID/非负 UID/十进制字符串 start；已知状态固定 `R S D T t X Z P I`。
- 只有完整 `ppid=0, pgrp=-1, session=-1, num_threads=0` 触发 reader 重新观察；识别首个完整哨兵时启动 25 ms 消歧窗口，首次观察计入最多 3 次总数，可接受记录最多 4,096 B，额外 1 B 仅用于检测超限（I/O 总上限 4,097 B；overflow 摘要只代表实际读取前缀）。后续观察前后检查同一截止时间，未知、持续异常与预算耗尽仍阻断。首次正常身份、既有过滤和真实消失不新增 25 ms 时延条件。
- 单份失败诊断最多 2 KiB、最多 3 次观察，阶段诊断合计不超过 16 KiB；不保存 comm、argv、environ、路径、原始 stat 或异常正文。
- 原案例、skip、retry、断言、worker、运行/收尾预算及实际资源清理保持；没有新增依赖、产品功能或全局例外。
- “本次 CI 根因未证明”持续保留；不以合成样例、两轮未命中或未来绿色结果倒推旧原因。
- 所有手工测试走 `tools/test-resources/run.py` 或既有 `Q/run-checked-command.py`；只有一个测试槽。任何未闭合资源先处理，不重复创建环境。独立审查及正常提交由 root 统一安排，不绕过钩子。

## Review Focus

1. group=0 或负组与坏字段同时出现，不能提前过滤而跳过校验。
2. PID 在重新观察时复用，不继承旧 start/UID/组或运行授权。
3. 首个哨兵后的两次读取很快但累计跨过 25 ms，不能因重读重新起算预算；同步调用超调后仍拒绝。正常首次读取不会因模拟调度延迟而新增失败条件。
4. comm 含括号、换行和非法 UTF-8，不影响数字字段定位，也不能泄漏到诊断。
5. parse failure 在 wrapper、recordProcessFailure 和 snapshotDiagnostics 之间不能被剥掉字段、放大或改成成功；持续未知不能促成空扫描。

### Task 1: 有界读取、严格身份与诊断闭合

**Files:**
- Create: `tools/src/ci/e2e-proc-stat.ts`、`tools/src/ci/e2e-proc-stat.test.ts`。
- Modify: `tools/src/ci/e2e-process.ts`、`e2e-process.test.ts`、`e2e-process.test-support.ts`、`e2e-diagnostics.ts`、`e2e-diagnostics.test.ts`；仅在诊断末端确有需要时修改 `e2e-cli.ts`。
- Update: 本 plan 的实际进度；`reviews/P4-S6-Linux进程身份观察复核.md` 记录事实、验证与限制。

**Interfaces:**
- 保留 `parseProcessStat(text: string | Buffer, uid: number, expectedPid?: number): ProcessRow | undefined`；既有字符串调用和从 `e2e-process.ts` 的导出保持。负退出哨兵不产生可授权 ProcessRow。
- 新模块导出 `readProcess(pid: number, uid?: number): ProcessRow | undefined` 和供 runtime schema 共用的正身份 schema/type；`e2e-process.ts` 统一消费并重新导出 reader，避免重复解释。
- 诊断模块扩展固定 schema 与受控异常类型，原 operation/code/pid 字段语义保持。具体枚举/字段名由实现者在报告中逐一列出；只允许规格定义的数据，不引入自由异常正文或通用日志系统。

- [x] **Step 1 — 准备可验证的原行为。** 读取规格、原 reader/各调用点、诊断和真实 Linux 合同。为行为测试仅先公开原 `readProcess`（原函数体不改），记录此机械准备差异；不得以新模块不存在或 import 失败当 RED。
- [x] **Step 2 — 编写 reader 行为 RED 并受管执行。** 通过真实 reader 控制流，仅替换文件 I/O/单调时钟。至少覆盖以下具名用例与预期：`exit_sentinel_then_absent`（后续 ENOENT/ESRCH 才返回 undefined）、`exit_sentinel_then_valid_identity`（返回新完整身份，不借旧 start）、`persistent_sentinel_blocks`（3 次仍异常抛错）、`invalid_state_and_group_zero_block`（坏状态/结构与零组同现仍拒绝）、`budget_does_not_restart`（首个哨兵后的单次 25 ms 窗口耗尽拒绝）、`diagnostic_does_not_expose_comm`（仅允许字段与原字节摘要）。RED 必须是预期行为失败。
- [x] **Step 3 — 实现独立 stat 模块与诊断。** 按规格校验完整记录、明确状态白名单与请求 PID；从同一 FD 读取 UID/有界字节并完整关闭；处理 comm 的非文本字节。只有精确哨兵可触发有界重读，其他异常按原规则失败。未知读取期间不改 owned/known/空扫描/停止预算。不得把重读或额外采样加到产品 E2E 用例。
- [x] **Step 4 — GREEN 与反例覆盖。** 补全非精确负值、字段缺失/超长、PID 路径不符、UID/启动 tick 变化、I/O EACCES/EIO、边界耗时、FD 关闭以及三阶段诊断传播。明确覆盖首次正常读取模拟延迟超过 25 ms 仍按原语义返回、首次哨兵之后才启动窗口、后续合法身份/消失在截止后返回仍拒绝及总观察最多三次。原 parser 测试的断言保持；如原人工 fixture 非完整 stat，只机械补齐真实字段结构并注明。`signal` 与 `settle` 的测试须证明未知仍拒绝、PID 复用/无关进程不被发信号或归档。
- [x] **Step 5 — 运行适当验证并真实收尾。** 通过 `Q/run-checked-command.py <唯一 label> -- pnpm exec vitest run tools/src/ci/e2e-proc-stat.test.ts tools/src/ci/e2e-process.test.ts tools/src/ci/e2e-diagnostics.test.ts tools/src/ci/e2e-command.test.ts` 验证全部相关单元；受管执行 `pnpm --filter @nerve-office/tools typecheck` 和改动文件 ESLint。再用既有受管 container/ContainerRunResources 入口，在缓存镜像中运行原 `node --test tools/src/ci/e2e-process.test-support.ts` 及新增 reader 消费路径；Linux 条件不能在 Mac 以 skip 代替通过。无浏览器/DB，不构建/拉镜像，限制 1 CPU/512 MiB/128 PID，测试窗口不超过 90 秒，串行并实际检查清理。结果记录模拟与真实范围，不补签原 CI。
- [x] **Step 6 — 自审并交独立复核。** 列出代码/类型接口、RED/GREEN 原件、Linux 实测、资源闭合、每项 Review Focus 与对应验证；记录已证实兼容缺陷和旧 CI 未知的边界。root 核对后按项目节奏正常中文提交并生成独立审查包；实现者不合并/推送/跑完整门禁，不改 r10 已冻结工具或接受回执。后续完整门禁与最终同 SHA CI 仍由 root 按实际新输入安排。

## 自审与执行裁决

规格 1–7 均由这个不可拆开的 reader/诊断任务覆盖；五项 Review Focus 分别进入 Step 2/4/5。规格是权威，若实现发现接口矛盾，先报告 root，不擅自降低身份或验收要求。此次修复属于已获授权的 P4 CI 收尾；不新增 Phase/分支，也不再为例行方案确认停下。独立只读复核已确认：官方内核路径与行为 RED 足以修正已证明的兼容缺陷，但不能把它写成旧 CI 的确定根因。

## 实际执行状态（2026-11-01）

Task 1 的实现、自审和局部验证已完成，等待 root 正常提交与独立代码审查；勾选 Step 6 表示已交复核材料，不表示独立审查已通过或 Phase 已关闭。原 reader 行为 RED 8 项预期失败；最终四个 CI 单元文件 63/63、tools 类型与局部 lint 通过，真实隔离 Linux 原 12 项及新增 5 项共 17/17 通过（8.217 秒、0 skip/fail/cancel、stderr 0）。未知 I/O 不发信号/不签归档、PID 复用保护及诊断实际落盘/快照均已验证。

所有检查串行，本机临时环境已实际清理；Linux 父 run `ebb1bf72-da5a-4c91-a9eb-be6af505c191` 的文件、进程、锁及 11 项 Docker 查询由 root 独立复核。实现与验证详情见[实现复核](../reviews/P4-S6-Linux进程身份观察复核.md)。旧 CI 根因仍未知、WebKit 报告仍缺；当前结果不替代新实际输入的完整门禁及最终同 SHA CI，P4/DEF-061 与 P5 状态不变。

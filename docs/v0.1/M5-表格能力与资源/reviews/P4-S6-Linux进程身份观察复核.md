# P4-S6 Linux 进程身份观察实现复核

状态：2026-11-01 实现、局部单元、真实隔离 Linux 契约及资源闭合已完成；待 root 正常提交和独立代码审查。P4/DEF-061 未关闭，P5 未开始。本文不替代新实际输入的完整门禁、合并后同 SHA CI 或最终关闭证明。

## 事实与根因边界

main `3dc2cde0` 的 CI `41220859473` 五项成功，WebKit 在 307 条通过日志后因监督器 `parse-process / UNKNOWN` 停止。原始 stat 字段未留下，原 PID 是否属于本轮也未知；后续恢复 `quiescent=true` 只说明收尾，不等于产品完成。六份原始 job 日志和九份 artifact 已收集，缺 WebKit 产品报告，本轮不接受。

Linux `do_task_stat` 在任务退出竞争中存在合法 `ppid=0,pgrp=-1,session=-1,num_threads=0` 路径，state 在锁前采样。旧 reader 的正组校验会直接拒绝；这是独立证明的兼容缺口。两次隔离 Linux 采样分别读取 36,207/1,480,938 次，均未捕获真实负 PGID，不能认定它就是旧 CI 原因。依据及原件见[规格](../specs/P4-S6-Linux进程身份观察.md)；本次模拟 RED/GREEN 和未来绿色 CI 同样不能倒推旧原因。

## 实现与原合同

- `e2e-proc-stat.ts` 集中完整 stat 解析和 FD 读取，监督器全部调用点消费同一实现。可授权 Identity 仍为正 PID/PGID、非负 UID、十进制 start；已知状态只接受 `R S D T t X Z P I`。
- 同一 FD 取得 UID/内容并完整关闭；请求 PID 必须匹配内容。有效零组仅在完整结构、字段、状态验证后过滤，坏字段不能绕过。comm 可含空格、括号、换行和非 UTF-8；NUL/非法尾字段拒绝，前后数字按明确 ASCII 校验。
- 只有精确完整退出哨兵才重新观察；它自身不能证明不存在。首次哨兵之后启动一次 25 ms 单调窗口，最多三次总观察，后续观察前后均核同一截止。正常首次读取不附加时延条件。后续真实 ENOENT/ESRCH 或新的完整身份才走原有消失/过滤/归属路径；持续未知、坏字段、非消失 I/O 和消歧超时继续抛错。
- 可接受记录上限 4,096 B，额外最多 1 B 仅检查 overflow；总读取上限 4,097 B。超限摘要显式标为 overflow，只描述读到的有界前缀，不冒称完整文件 hash。
- 诊断新增固定原因、验证过的数字/状态或 `invalid`、字节数/字段数/结构及 SHA-256。没有 comm、argv、environ、路径、原始 stat 或异常正文。每个完整失败对象 <=2 KiB，最多三次观察；六个固定阶段槽共用落盘/快照 schema，合计 <16 KiB。中途 I/O 失败保持准确 operation/errno 与既有观察。
- known/组归属/发信号前身份比较/空扫描逻辑与原 90 分钟运行、15 分钟收尾预算不变。产品、SDK、工作流矩阵、案例/skip/retry/worker/断言未修改。

## 验证结果

所有命令串行，经现有受管入口执行。Q 指主目录 `.codex/handoffs/m5-p4-20261022/s6/hosted-vm-policy/final-ci-40947141649-investigation/`。

| 检查 | 结果与原件 |
| --- | --- |
| 原 reader 行为 RED | `proc-stat-reader-red01`：8/8 预期失败；原函数体不改，仅导出，I/O/时钟替身以下均为生产控制流。原 patch/测试在 `proc-stat-repair-evidence01`。 |
| 新 reader 初始 GREEN | `proc-stat-reader-green01`：8/8 通过。 |
| 后续 I/O 诊断 RED | `proc-stat-reader-boundary-red02`：33 通过/1 预期失败，证明 EIO 会丢失先前退出观察；补有界观察链后通过。 |
| 结构反例 RED | `proc-stat-structure-red01`：34 通过/1 预期失败；NUL comm 与数字范围检查补齐。 |
| 最终四个 CI 单元文件 | `proc-stat-unit-green02`：63/63 通过，含完整解析、PID/UID 变化、窗口边界、字节上限、FD 关闭和诊断运输。 |
| 类型检查 | `proc-stat-typecheck03`：`pnpm --filter @nerve-office/tools typecheck` 通过。 |
| 局部 lint | `proc-stat-lint02`：七个改动 TS 文件通过，零输出；规则未改。 |
| 真实隔离 Linux | `proc-stat-linux-contracts01`：原 12 项加新增 5 项，17/17 通过，0 fail/skip/cancel，stderr 0，实际 8,217 ms。 |

Linux 环境是 Linux 6.10.14-linuxkit/arm64、Node 24.21.0、缓存固定摘要镜像；不是 GitHub Ubuntu runner。真实用例覆盖正常退出、一次软停止、独立收尾预算、快速孤儿/空环境、PID 复用与无关进程保护，并新增 FD 身份读取、启动未知不 spawn、settle 未知不签归档、signal 再读未知不发 SIGINT、六阶段诊断实际落盘/静态快照。新增 I/O 反例明确是注入故障，没有声称观测到原 CI 负 PGID。

原 parser 测试的简写人工样例机械补齐剩余零数字列和换行，原断言保持。单元日志两条 Python 找不到 checker 脚本的信息是未改动 `e2e-command.test.ts` 的既有缺文件反例，不是新失败。一次测试括号语法错误、一轮 TS 缩窄错误和格式修正的全部失败原件保留；这些非行为失败不计为 TDD RED，修复过程未降低任何断言。

## 资源与来源闭合

Linux 候选先由 root 核对 25 项 main/W 输入及四项候选文件，再单次执行。绑定的是当前 P4 dirty 工作区，其文件摘要与 Git 状态前后相同；主目录保持 `main@3dc2cde0`。容器限制 1 CPU/512 MiB/128 PID，无网络、非 root、只读根，无浏览器、数据库、构建或拉镜像；本轮 8 MiB tmpfs 与容器一起删除。

父 run `ebb1bf72-da5a-4c91-a9eb-be6af505c191` passed/0，root 独立核验 scratch、短根、别名实际不存在，owner/子进程组退出、文件锁可取得、完整 lsof 无本轮引用；同 daemon 下 11 项本轮 Docker 查询为空，共享 PostgreSQL 身份未变。所有本机小检查也逐轮完成同类实际文件闭合。仅保留日志、TAP、来源快照与台账，没有留下完整容器/profile/数据库。

- 入口审查：`Q/proc-stat-linux-contracts01-root-review.json`，SHA `da89c80a541f95c98626a57e10a70025a2de7f1a67335cb484262e7b1ce2440d`。
- Linux 与实际闭合：`Q/proc-stat-linux-contracts01-root-result.json`，SHA `7670ecd9ded16aa4a3d15bdad9c5a0e6f24dc3ca2f1b6c4af97453c8359d9882`。
- 原 CI 成功项补充扫描：`Q/r10-webkit-ci-failure01/available-report-summary01.json`，SHA `b16bd0d519f7da76a5745a6c7c3144504a47bc00c3d4641952f8cd231b09154d`。容器 339、Chromium 814、Chrome 807、Edge 807 均 first-pass，无额外尝试/全局错误；三个浏览器各四个原跳过。托管成功报告仍为 `host-disposal-pending / cleanupComplete=false`，不能写成本机删除证明。

## 后续

root 先按正常中文提交保存当前实现及文档，再做独立代码审查；有实际修复则对应复验。通过后，以新的实际提交绑定完整本机双门禁及正常合并推送、同 SHA CI 和实际冻结清理。旧 r10 原件和接受回执保持不变，旧 CI 缺件/失败不被未来结果覆盖。

# P4-S6 CI 清理边界复核与调整建议

日期：2026-10-28。状态：**待用户决定，尚未实施**。仅记录实际失败与建议，不接受本次 CI，不关闭 P4，不启动 P5。

## 已确认的断点

诊断代码 `c576c1fe` 已正常 no-ff 合并为 main `18892db5`，正常 pre-push 263.27 秒后推送成功。本机诊断回归为 Python 151/151、CI 接线 12/12；其临时目录、短根和进程组已回收。这些结果不替代新源码的完整门禁。

[CI 40600596503](https://github.com/open-nerve/NerveOffice/actions/runs/40600596503) 在该 main SHA 上结束，0 成功、6 失败，全部停在安装依赖之前的小型资源预检。各任务 Docker 服务检查不再是首个错误；container 没有注入服务 scope，也遇到宿主记录问题。

| 任务 | 不完整记录数 | 样本是否截断 |
|---|---:|---|
| verify | 53 | 否 |
| Chromium | 54 | 否 |
| Chrome | 53 | 否 |
| WebKit | 52 | 否 |
| Edge | 53 | 否 |
| container | 19 | 否 |

六项均为 lsof 返回 0、stderr 为空；实际记录包含 `sock / protocol: UNIX-STREAM`、UDP、TCP、NETLINK、QIPCRTR，以及 `mem / REG / anon_inode:bpf-map (stat: No such file or directory)`，各任务的集合不同。每项恰有一条 fd3 的 UNIX-STREAM 记录。不能从 PID 数字或协议名猜测后台程序身份。安全回执均为 `cleanup-pending`、childGroup=null、scratch/短根仍存在；产品子命令没有开始。回执收集成功不表示回收完成。

主目录 `.codex/handoffs/m5-p4-20261022/s6/ci-early/40600596503/` 保留六份原日志；收集回执 `failure-collection-20261027T231447Z.json` SHA-256 为 `e7a509ac1bb76b052820b026773b5e8b554920e3a45892c33bd22b370778d5af`。紧凑逐任务审计在 `s6/ci-resource-path-fix/ci-40600596503-assessment/actual-ci-audit.json`，SHA-256 `58fe02bc96509dc2d7dfe3c4d8149bd284af0b610b8c851e326eef49482a6073`。

## 根因及现有方案的限度

当前 `Run.assert_quiescent → open_paths` 在匹配本轮路径之前，要求整台宿主机的所有 lsof 记录可解释。因此一个尚未启动测试、只有预登记目录的运行，也会被宿主其他进程的模糊记录阻止。之前的 Docker scope 只证明固定 PostgreSQL 服务，不能解释宿主其他进程。

精确的非文件系统协议或匿名对象可以逐类核实，但这不能解决 UNIX-STREAM：该协议可以是有路径、抽象地址或无地址套接字。现有 pfnt 没有 socket inode。lsof 的 PID/FD 筛选不会自动切换网络命名空间；持有者当前的网络命名空间也未必是套接字创建时所在的命名空间。重新查询只有正向匹配同一对象才构成证据，查不到不能证明不存在路径。旧托管机已结束，不能用新进程代替旧 PID 取证。此判断依据 [UNIX socket 地址与 FD 传递](https://man7.org/linux/man-pages/man7/unix.7.html)、[进程网络 namespace 视图](https://man7.org/linux/man-pages/man5/proc_pid_net.5.html)及固定 lsof 4.95/Linux v6.8 源码；它说明现有文本的证明限度，不是对实际 runner 二进制/内核的逐字鉴定。

继续要求全宿主完整可见，会涉及 inode/进程身份绑定、跨 namespace 观察和新的特权查询；不应继续靠放行协议名或排除 PID 来推进。这里暴露的是测试资源管理的责任边界问题，不是本次产品测试已发现新的功能失败。

## 方案比较

| 方向 | 能解决什么 | 代价与限制 |
|---|---|---|
| A：补充 Linux 全宿主引用检查 | 维持“VM 内立即删除之前证明全局无引用” | 新增 namespace/inode/特权查询及竞争处理；没有一个简单开关可保证解释所有宿主 socket。仍需真实 Linux 验证。 |
| B：按持久机器与一次性 CI VM 区分回收责任（建议） | 本机严格删除；CI 的未知引用资源留在本 job VM，由宿主结束后销毁 | 需要明确的新状态、证据冻结、容量限制及验收契约，不能只把 cleanup-pending 改成成功。 |

GitHub [托管 runner 使用文档](https://docs.github.com/en/actions/how-tos/manage-runners/github-hosted-runners/use-github-hosted-runners)说明每个 job 获得新的 VM，并在 job 结束后自动退役。[runner 概念文档](https://docs.github.com/en/actions/concepts/runners/github-hosted-runners)区分完整 VM 与单 CPU 的容器 runner。本轮六项实际 jobs metadata 均为 `ubuntu-24.04`，属于不同 GitHub Actions runner。该平台承诺不是本项目对每台 VM 的独立销毁测量。

## 建议方案 B 的明确边界

以下是待批准的负责人建议，不是用户已经作出的决定。

1. **本机保持严格规则。** Mac、普通 Linux、自托管 runner、未知上下文与旧台账，继续持锁、查进程/打开句柄、归属不明保留；不自动扩大 sudo 范围、不重启共享 Docker、不触碰业务或其他任务资源。
2. **只对显式托管的一次性 VM 使用新策略。** 限定当前六项 GitHub-hosted Ubuntu 24.04 job，在资源创建前绑定 repo/run/attempt/job 与本轮 UUID。环境不符或台账不符即拒绝，不把普通 CI=true 或本地模拟当作真实宿主身份。
3. **回收状态与测试结果分开。** `host-disposal-pending` 只表示本轮资源交给宿主 VM 生命周期；不等同全局无引用、清理器已删除或测试通过。测试失败、中断、写入者未退出、报告不完整、容量超限均仍失败。CI 验收若接受此状态，须明确依据平台约定，不能伪造“实际销毁完成”回执。
4. **只导出稳定、必要的证据。** 仍核验本轮锁、所有权、监督器/进程退出和报告来源；没有写入者退出或稳定证据则拒绝报告验收。未知引用的原目录不精简、移动或删除。全局 lsof 的未知对象继续阻止手工删除，但不再单独阻止非破坏的报告快照；这项证据边界也属于本次待批准调整。只有报告归属/生产者退出已经核实、无已知本轮活动引用、能稳定复制并核对来源/大小/摘要时，才复制指定报告和 OPFS 证明；报告归属、写入者或内容稳定性未知仍失败，省略项须记录。完整 VM/profile/数据库不上传 artifact，不写缓存；固定报告口仍串行且不得覆盖未知内容。
5. **同 job 不能无界堆积。** 建议该 job 所有受管临时原环境合计上限 16 GiB，并继续保留至少 12 GiB 可用磁盘；这两个条件独立执行，超限停止本轮，记录而不扩大限额。16 GiB 是拟定硬上限，不是可用容量或用量目标，尚未由本方案的真实 CI 验证。GitHub 的[标准 runner 规格表](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)列出 14 GB SSD，不能据此假定实际可用量能容纳该上限；能力预检与运行中须记录实际磁盘余量，原环境、报告、构建和镜像共同占用的磁盘也受 12 GiB 余量条件约束，短别名不重复计数。若现有托管机容量不足，先报告事实，不自行降低余量、扩容或产生付费资源。便携诊断原有 4 MiB/文件、16 MiB/用例、64 MiB/轮，以及报告 5 GiB/14 天限制不扩大。本机完整失败 profile 的 256 MiB/轮、2 GiB 总量、7 天规则不变；CI 原环境改为仅在本 job 临时存在、受上述总量上限约束并等待宿主销毁，这一差异必须显式批准。
6. **成功、失败和中断都处理同轮归属。** 正常结束先冻结/导出允许的报告，再登记等待宿主回收；可捕获中断仍停止本轮进程并保留诊断；强制终止时不能虚报收尾成功，由宿主生命周期兜底。后续同 job 启动识别本 job 的待回收项并计入预算，不认领跨 job/run/attempt 的目录。
7. **完整门禁保持。** 不改浏览器范围、产品断言、重试、用例超时或 CI 六项要求。先小型机制回归、独立审查及实际 CI 能力核验，再对最终源码串行运行新 full13/container03，正常提交/no-ff/推送并取得同 SHA 六项完整 CI，通过最终证据审计后才关闭 P4、清理唯一 worktree、进入 P5。

## 影响范围与验收

如批准，下一步在现有 P4 分支补详细实施计划，再改 `tools/test-resources/lifecycle.py`、`run.py`、CI 回执/接线和必要的报告验收处；同时更新 AGENTS、测试规范及 P4 外部收尾工具对新状态的理解。不能挪用冻结 v2/full12/container02 的证明覆盖新契约，也不把无关功能拆进这次调整。

小型验证须覆盖：本机与自托管仍严格拒绝；只对合法托管身份允许委托；同名/跨 run/attempt/链接/活动锁不接管；本轮或其他活动写入者保护；失败与中断仍非零；重复收尾安全；必要报告复制完整、原环境没有被删/上传；16 GiB 计量与超限使用可注入的小额样例验证；不可捕获中断仅有宿主责任记录，不伪造完整证据。无需为机制测试创建大型环境。

必须同步审查调用链：启动预检、结束清理、异常恢复、发布口轮转、CI 报告验收和最终关闭。只有状态含义一致，才能在不误删数据的前提下解除当前阻断。

独立研究回执位于主目录 `.codex/handoffs/m5-p4-20261022/s6/ci-resource-path-fix/ci-40600596503-unix-research/research.json`（SHA-256 `531ebfdedd4058ed0cf67c14cba78a8936506d0bf24d891c9f9550b53b549ee0`）和同一 `ci-resource-path-fix/` 下的 `ci-40600596503-kernel-research/source-semantics.json`（`76f4de0528fe697b9ffa762cc59644c801076f818e683135afc9565e6864c347`）。两项均只读，未运行测试或新增特权探针。

## 决策依据

本次已经超出上一轮“只改诊断、不改变何时能删除/保留未知资源”的检查点授权边界，涉及资源运行器、报告发布和 CI 验收的协同修改。`CLAUDE.md` 要求“跨模块的协同调整”先提交当前工作，再汇总问题和方案等待用户决策。因此先提交本报告与现有证据，**尚不实施方案 B**；审批通过后按既定自主方式完成，不逐项重复询问。

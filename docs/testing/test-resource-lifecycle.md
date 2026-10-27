# 测试资源生命周期

2026-10-26：历史 handoffs 累积约 175.1 GB，其中大量是已结束的 VM 磁盘和通过用例的完整浏览器资料。APFS 共享块使目录统计不等于可回收空间。本规范与执行脚本共同生效，取代旧文档中直接启动 Playwright 的写法。

## 正式入口

| 场景 | 入口与资源类型 |
|---|---|
| 本地 E2E、完整 verify 内的 E2E | `pnpm test:e2e` → E2E 包 `test` → `run.py e2e` |
| CI E2E | `tools/src/ci/e2e-cli.ts run` 保留原进程监督，内层经 `run.py e2e` |
| 生产容器 | `pnpm test:e2e:container` 整个命令经 `run.py container`，包括结束时采集容器日志 |
| 集成、覆盖率 | `pnpm test:integration` / `test:coverage` → `run.py integration`；系统临时目录随本轮回收 |
| 测量、模板 | E2E 包的 `measure:*` / `update:*` → `run.py measure/template` |
| 真实 Safari | E2E 包 `safari:selftest` → `run.py native`；手工 local-save/natural/pause 同样包在 native 运行中，`--output` 必须位于本轮报告目录 |
| VM 实验 | 用 `run.py vm -- <准备和实验脚本>` 包含整个生命周期；`vm-durability.ts` / `vm-product-recovery.ts` 验证磁盘与目录在本轮 scratch 内 |
| 单独清扫 | `pnpm test:cleanup`；只处理本 worktree 已登记资源，不扫描整个 handoffs |
| 小型机制回归 | `pnpm test:cleanup:check`；另有 managed-output、test-databases 的 Vitest 单元回归 |

只读配置探针显式使用 `--list`，并清除继承的 `NERVE_TEST_RUN_ID`、`NERVE_TEST_SCRATCH`、`NERVE_TEST_OUTPUT_DIR`，避免 coverage 的外层环境掩盖单独执行时的错误；实际测试仍须使用受管入口。M5-P4 的探针修复保持原项目配置与断言，不能用只读标记启动真实测试。

需要 Python 3.9+、POSIX 文件锁和 `lsof`。缺少句柄查询能力时保留原件并返回待处理状态，不冒险删除。测试的断言、范围、重试与超时不由清理器更改。真实 Safari 的解锁、空闲 120 秒和用户活动中止条件仍适用。

## 创建、终止与恢复

`tools/test-resources/run.py` 在 `.test-resources/runs/<UUID>/run.json` 落盘归属，再创建 scratch、临时目录和子进程。子进程先等待管道握手，进程组登记完成后才允许执行测试。清理先落盘 reports-collected 阶段再删除 scratch，断电发生在删除后也能恢复终态与保留期。持久浏览器目录在启动浏览器前写 `resource-owner.json`；完整 VM 位于已经登记的 scratch；SSH mux 因 Unix socket 长度限制使用 `/tmp/nerve-vm-<UUID>`，由同一运行器创建前登记、核对身份和句柄后回收，不认领其他短目录。

普通受管命令还创建 `/tmp/nerve-t-<UUID>`（macOS 实际为 `/private/tmp/…`），独占权限为 0700，只有本轮 owner 与 `t` 别名。真实临时内容仍在原 `scratch/tmp`，`TMPDIR/TMP/TEMP` 使用短根下的 `t`，以满足 Linux branded 浏览器 SingletonSocket 的路径限制；不会把临时数据搬到容量盘点之外。VM 复用自己的 `nerve-vm` 短根与同轮别名，旧 owner 格式保留。目录和别名先登记后创建，再记录实际 inode/device，恢复时逐字核对目标及身份，不接管已有目录。创建未完成、标记缺失或目录/别名被替换时保留并报告。

清理和恢复证据快照在任何精简、移动、复制之前，先核对真实 scratch 与短根两处；活动 UNIX socket 可能被 lsof 显示为短别名，不能只检查真实目录。嵌套运行的别名还须解析回其实际目标核对。lsof 的返回码、标准错误（最多 4 KiB）、超时或启动错误留下有界诊断；无法完成检查仍拒绝清理，不忽略警告或把未知当空闲。容器 E2E 保留外层短临时目录，不在变量文件目录下再次覆盖 TMPDIR。

查询明确请求 `-nP -F pfnt`，先校验整份 PID/FD/name/type 记录，再匹配受管路径。Linux 权限失败可能位于 stdout 的 `NOFD` 或 `/proc/PID/fd/N (readlink: …)` 等记录，即使退出 0、stderr 为空也不表示完整。`readlink/opendir/stat/lstat` 失败、未能识别的套接字（含仅有 `protocol:` 的记录）、映射的 path dev/inode 身份不一致及格式不完整均保留资源；不按 ENOENT 文本豁免退出竞争。唯一 Linux 匿名映射例外是 `mem`/`REG` 且名称精确为 `anon_inode:[io_uring] (stat: No such file or directory)`：内核创建的是匿名对象，lsof 4.95 把它当路径 stat 才产生该注解。路径前缀、其他描述符/类型、其他错误及其他平台均不适用。只保存不完整记录总数及最多 16 种异常样本，不保存全局 stdout。异常样本包含 PID/FD/type/reason/operation、最多 512 字节的 name 摘要、原名字节数与 SHA-256、脱敏/截断标记及重复次数；绝对路径正文脱敏，只保留区分匿名映射和错误类别所需的标志；尾注仅输出精确的 ENOENT/EACCES/EPERM/ESTALE C locale 文本或纯数字 dev/inode，并锚定行尾。文件名伪注解和未知错误正文不能进入摘要，仍由 operation、原字节数与 hash 留下关联。样本按完整记录身份聚合，截断由总异常数与已保存样本的重复次数之和判断；重复本身不等于截断。类型/名称诊断不改变原拒绝条件，失败后观察到的 PID 身份不能冒认原查询身份。实际 macOS 的 PIPE、NPOLICY、NEXUS 是非文件路径对象，可有显式的空 name 字段；仅在 Darwin 且类型精确相符时接受这种协议记录，整行 name 缺失仍拒绝。REG、DIR、UNIX socket、未知或相似拼写类型缺名仍保留，错误注解优先拒绝。

普通运行使用直接查询。现有 GitHub Ubuntu 24.04 job 显式设置 `NERVE_TEST_LSOF_MODE=github-ubuntu-sudo`；运行器同时要求 Linux、`CI=true`、`GITHUB_ACTIONS=true`、`RUNNER_ENVIRONMENT=github-hosted`、`RUNNER_OS=Linux` 及 `/etc/os-release` 的 Ubuntu 24.04，才调用固定 `/usr/bin/sudo -n -- /usr/bin/lsof -nP -F pfnt`。没有自定义命令或自动提权回退，测试和清理程序仍为普通用户；提权失败、超时或输出不完整继续拒绝。GitHub 的[默认变量](https://docs.github.com/en/actions/reference/workflows-and-actions/variables)及[托管 VM 权限](https://docs.github.com/en/actions/reference/runners/github-hosted-runners#administrative-privileges)说明这一明确 CI 上下文；这些环境检查并非宿主身份的密码学证明。隔离容器中的 root 可能仍缺少检查其他进程的能力，不能仅因 UID 为 0 就认定完整；PID/网络命名空间及实际可见性仍须由运行环境保证。

现有 verify、E2E 运行与 settle 步骤另通过 `NERVE_TEST_CI_POSTGRES_SERVICE_ID=${{ job.services.postgres.id }}` 明确指定本 job 的固定 PostgreSQL 18.6 服务；该变量只放在允许使用 job context 的步骤环境，生产容器 job 不注入。新 Run 在 scratch 创建前登记服务 epoch、UUID/repo、GitHub run/attempt/job 与固定根，再记录实际目录身份。服务必须是 pinned 镜像的标准启动、精确 `HostConfig.Runtime=runc`、独立 GitHub bridge 网络、无 Options 的 local 匿名卷；privileged、增加 capability、设备、宿主 bind、VolumesFrom 或共享 namespace 不成立。卷来源与真实根、短根/别名双向相交时拒绝。没有这一创建证明的旧台账不能补签。

`service_scope.py` 只用固定 `/usr/bin/docker --host unix:///var/run/docker.sock` 选择必要 inspect/volume inspect/top 字段，不读取 Config.Env；namespace 身份用固定的非交互 sudo/readlink 系统命令读取；卷 Source 经本服务 inspect/volume inspect 验证后，再用固定 `/usr/bin/sudo -n -- /usr/bin/readlink -e -- <Source>` 取得唯一绝对规范路径，不把普通调用者遇到 EACCES 后的词法结果当作 canonical，不读目录内容。每个辅助命令最多 5 秒、stdout/stderr 合计 64 KiB，最多 128 个服务进程；查询前后的完整证明共用 30 秒预算，最多取 3 轮快照。只有已确认的 PID 消失/复用或快照成员变化可重新采样，权限、格式、Docker 错误立即保留；这些重采样不重跑测试用例。错误只保存固定枚举、errno/返回码，不保存全局 lsof stdout 或任意第三方正文。

`open_paths(root, owner=None)` 默认严格。只有持有原运行锁、重新核对台账及根 inode/标记/报告原子搬迁链的 owner 才可使用 service scope；台账用 `O_NOFOLLOW|O_NONBLOCK` 打开并经 fstat 限定普通文件，拒绝叶子或父目录链接，FIFO 不得阻塞扫描。当前 Run 即使没有 service scope，也必须先核对租约和台账；查询前后服务 epoch、top 成员、starttime、cgroup 和 mount/net/PID namespace 必须一致。scope 只处理已核实服务 PID 的绝对路径 `mem/REG` stat ENOENT 或明确 path dev/inode 不一致，以及数字 FD、`sock` 类型且整行精确为 `protocol: UNIX`、`protocol: UNIX-STREAM`、`protocol: TCP`、`protocol: UDP`、`protocol: TCPv6` 或 `protocol: UDPv6` 的记录。UNIX-STREAM/TCP/UDP 来自本轮自有 PID 的实际跨 namespace 输出；TCPv6/UDPv6 来自固定 [lsof 4.95.0](https://github.com/lsof-org/lsof/blob/4.95.0/dialects/linux/dsock.c#L4992) 与 Linux v6.8 的 [TCPv6](https://github.com/torvalds/linux/blob/v6.8/net/ipv6/tcp_ipv6.c#L2315)、[UDPv6](https://github.com/torvalds/linux/blob/v6.8/net/ipv6/udp.c#L1757) 和 [sockfs 名称返回链](https://github.com/torvalds/linux/blob/v6.8/net/socket.c#L370) 的源码推导，未称 IPv6 fallback 实测或实际 CI 内核字节一致。全流仍保留，真实文件、短别名 socket、deleted 或带注解的路径命中继续阻止清理；NOFD/readlink/lstat、其它 errno、未知协议、缺失/重复字段、stderr 和异常返回码不放行。报告轮转和过期清理在原 Run 锁内核对；archive 不传 owner。标准拓扑的实际 Linux/CI 验收仍是独立门禁，本机制不声称证明宿主 root 没有额外执行 nsenter/SCM_RIGHTS 注入。

启动命令前，运行器在资源登记完成后先执行同一套句柄与归属核对；查询警告、超时或启动失败时，子命令不会启动，错误与待回收状态会保存。查询期间收到 SIGINT/SIGTERM 也不再启动子命令。此预检避免清理能力已失效时仍运行长测，不能取代测试结束后的再次检查。

相同 worktree 的报告发布口持锁，第二轮不会覆盖第一轮。不同 worktree 分别拥有管理根。测试程序继承独立 `TMPDIR/TMP/TEMP`；非 VM 子运行不继承父 VM 的短根授权；不改宿主机全局设置。开始前及运行中检查可用磁盘，低于 12 GiB 时停止本轮，不继续写满磁盘。控制台日志上限 32 MiB。

SIGINT/SIGTERM 只转交本轮仍存活的子进程组，等待后才回收。根进程已退出却仍有子进程、打开句柄或查询失败时，标记 `cleanup-pending` 并保留；不凭可能重用的进程组号码继续杀进程。强制终止、崩溃之后，下一次运行或 `test:cleanup` 通过文件锁、原进程组与句柄复核接续回收。资源归属或父目录链接不合法时失败关闭。未解决的同类待清理运行会阻止继续堆积新环境。

数据库有独立生命周期：E2E/集成测试以主机标识、PID、随机后缀登记隔离库；正常退出按原夹具回收。下一次启动只挑本主机已失活 PID 的库，再确认数据库没有连接，以不带 FORCE 的 DROP 清理；连接竞争或占锁时跳过。仍有依赖的测试角色保留。业务库、其他主机的测试库与活跃库不动。容器沿既有专属标签和 compose 清理流程；Docker 不可用时保留其数据，不直接删除 Docker 磁盘。

## 证据与容量

| 内容 | 成功 | 失败或中断 |
|---|---|---|
| VM 磁盘、临时文件、可重建缓存 | 删除 | 删除；保存配置、运行日志、结果、复现信息，不默认保留完整 VM |
| 浏览器完整资料 | 删除 | 每轮最多 256 MiB、总共 2 GiB、7 天；超限在回执记录省略 |
| 小型失败诊断 | 无需复制成功资料 | 日志/配置/崩溃记录：4 MiB/文件、16 MiB/用例、64 MiB/轮，进入现有 CI/handoff 报告 |
| JSON/HTML、trace、截图、OPFS 归档 | 保留 | 保留；失败尝试按 results 的 attempt 注解关联，重试通过不覆盖先前失败归属 |
| 报告历史 | 14 天或 5 GiB 总量 | 同左；清理回执、运行摘要继续保留 |

OPFS 的 manifest、真实文件摘要和 cleanup 证明校验后保留；校验失败时不精简原资料。原始 profile 转移先写逐项记录，中断后幂等继续。完整失败资料仅在本机短期目录，CI/handoff 携带的是小型诊断、trace、OPFS 和清理回执，不承诺无限期保存完整环境。

CI 的 settle 在监督器确认退出后，按本轮 owner token 恢复精简与发布；其他运行不动。若中断导致 OPFS 证明未完成，原件不精简，仅发布诊断快照（256 MiB/文件、512 MiB/轮，排除完整 profile），附明确的 diagnostic-only 状态和省略清单，不能据此通过验收。

固定发布位置仍为 `tests/e2e/test-results` / `playwright-report`；测量发布到 `tests/e2e/measure/` 对应两目录，Safari 发布到 `tests/e2e/safari-results/` 对应两目录。发布前始终持有本轮锁；原目录不为空且未经登记时拒绝覆盖。旧受管报告移入原运行再执行保留策略。报告内 `resource-run.json` 与 `cleanup-receipt.json` 可独立核对归属和省略项。

## handoff 归档

`tools/test-resources/archive.py` 管理显式登记的新归档，已有历史材料不自动认领。当前本地 P4 的 `.codex/handoffs/m5-p4-20261022/s6/run-full-gate.py` 创建 bundle 时先登记并持锁；结束时先在发布/run 锁内转存报告，再记录资源清扫，最后在 retention 锁与原 bundle lease 内审计并 pin 必要通过证据，释放后才 prune。成功、失败和异常均有释放与接受状态处理。此处的额外接受流程仅属于本 P4 外部包装，完整顺序见下节，不泛指上表所有入口。

仅回收已登记、未被使用且非 pinned 的 `output/`、`prior-output/`、`command.log`，合计 5 GiB 或 14 天，保留日志尾、运行摘要、源码快照、补丁、目录与原校验索引，并新增退役回执。开始删除前保存 pending 清单；中途崩溃后沿同一清单继续，保留首次删除的字节记录。旧索引不改写；退役后不得再宣称它支持完整环境复现。外部归档机制的原脚本备份和本轮清理账在 `.codex/handoffs/test-residue-cleanup-20261026/`。

阶段最终验收通过后，在下一轮可能回收之前标记长期证据：

```sh
python3 tools/test-resources/archive.py /绝对路径/归档根 --pin 已结束bundle名 --reason '某 Phase 最终验收证据，关联提交与审查报告'
```

pin 只用于经过审查的必要最终证据；不要 pin 每次失败重试。新写的门禁或调查脚本同样使用 Archives 创建/封存，不自行永久复制运行环境。CI 继续使用工作流已有 14 天 artifact 保留策略。

## 清理回归与局限

Python 小型回归覆盖成功释放、失败限额与过期、SIGTERM、遗留恢复、打开句柄/活动锁、父目录链接、重复执行、失败重试归属、转移中断续作、发布锁、容器重复发布和 handoff 源码/最终证据保护。TypeScript 回归覆盖受管目录、VM 越界、纯函数导入兼容与数据库连接竞争。

强制断电期间无法执行任何清理；重新运行时才能回收。未知历史目录和未确认的业务/测试数据保留待核对。保留期限和容量由每次启动/退出及手工清扫执行，不安装系统定时任务。大环境运行中可达到高于留档限额的峰值，12 GiB 余量只是中止条件，不能替代为大型实验预估容量。

## M5-P4 外部完整门禁的附加接受流程（2026-10-27）

本节只说明当前P4主目录外部入口 `.codex/handoffs/m5-p4-20261022/s6/run-full-gate.py` 与 `guard-archive-review.py` 的额外原件验收，不代表上表全部普通测试命令、CI或其他Phase已经使用这套包装。普通入口仍按前文负责同轮资源生命周期与固定报告发布。

1. 等待本轮写入者退出，在报告发布锁与对应run锁内核验归属、终态及路径，先把固定报告转存到本轮bundle。父/叶目录、run.json、marker不得为链接，目标已存在时拒绝覆盖；不先执行可能回收尚待审查报告的清扫。
2. 转存后执行本worktree受管资源sweep，保存`resource-cleanup.json`，记录本轮清理结果；源码/安装SDK前后清单及原件摘要一同冻结。未知或待处理资源不能伪装成清理完成。
3. 保持原bundle lease，并持归档根`.retention.lock`，依次seal、运行原件审计、精确核对该轮资源runId/终态/无scratch和活动写入者/原件未被prune，再写资源证明、pin必要通过原件并记录accepted状态。原始审计覆盖精确案例、JSON/HTML、原件摘要及OPFS证明；pin理由绑定该bundle和受测HEAD。
4. 完成上述操作后才释放bundle lease并执行归档prune；按既有期限/容量处理未pin输出，源码、补丁与原索引仍保留。原始审计或资源核验异常时明确写accepted=false并传播失败，不能只凭测试命令退出0签署。

full10因启动时已使用旧包装器，曾由`guard-archive-review.py`独立守护持retention锁，待该轮结束/封存并取得bundle锁后完成审查；full11及后续包装器在原lease内复用它的`accept`函数，不为同一活动轮叠加两套接受流程。full10实际失败、不被接受；full11与同源码container01已各自通过原件与资源核验并pin。

后续签署/关闭读取`archive_review_evidence.py`证明：精确bundle的status必须accepted=true，资源证明绑定同轮runId、清理完成及未回收原件，真实pin的owner和理由匹配；status/resources/pin/raw audit摘要共同进入gate proof。测试退出0、清理成功、普通报告存在或手工pin中的任一单项，都不能替代这份接受证明。该接受仍只覆盖对应一轮门禁，本轮同源码容器已有独立接受证明，整个Phase仍须同SHA CI、最终冻结与实际清理。

已审查的工具摘要和轻型反例在`.codex/handoffs/m5-p4-20261022/s6/resume-20261027/independent-review.json`；两轮独立接受回执为同目录`full11-independent-acceptance.json`与`container01-independent-acceptance.json`。这些外部回执不改变普通入口的权限、测试范围、原断言或预算。

## CI 安装前的小型能力预检

现有 verify、四浏览器分片及 container job 在检出代码后、安装 Node/pnpm/依赖/浏览器之前，运行 `python3 -B tools/test-resources/run.py ci-preflight -- /usr/bin/true`。只创建本轮预登记的 KiB 级目录，沿用相同的归属、锁、短路径、句柄查询与回收；verify/e2e 步骤注入本 job 实际 PostgreSQL 服务 ID，container 不注入。预检只能说明当前查询/收尾路径可用，不替代真实测试后的删除前核验，也不独立证明所有外部引用均可识别。

紧接的 `ci_preflight_receipt.py` 步骤使用 `if: always()`，无需 pnpm，向原 job 日志输出最多 64 KiB 的安全 JSON 摘要，最多读取 128 个登记目录、输出 4 个 `ci-preflight` 运行。只读核对 owner/台账与锁，拒绝链接、FIFO、活跃或不可信记录；单台账最多 64 KiB。仅包含运行身份、状态、有限错误与 scratch/短根是否仍存在，不输出 command/env、不读取或上传 scratch 内容。收集成功不等于预检通过或资源已回收；缺失和拒绝必须显式记录。预检失败仍令 job 失败，后续重型步骤不会启动；日志经既有 CI 原件收集路径保存。

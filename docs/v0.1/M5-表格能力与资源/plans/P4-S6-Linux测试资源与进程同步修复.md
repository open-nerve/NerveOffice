# P4-S6 Linux 测试资源与进程同步修复

2026-10-27，仍在唯一 `codex/m5-p4-history-gc` 分支。main/origin main 为 `1277dcb9`，正常推送已成立；CI 40525146257 已结束，1 成功、5 失败，未通过验收。此前 full11/container01 的结果属于旧输入，不能说成覆盖本次修复。

## 已知事实与边界

- Chrome / Edge 的 Linux 日志明确报 SingletonSocket 路径过长：受管 TMPDIR 111 字节，套接字实际路径 152/153 字节，浏览器启动阶段失败。
- 两个分片的监督器随后异常退出且没有 result.json；恢复阶段确认进程已退出，但全局 lsof 检查失败。现有日志丢失具体操作/errno/返回码，不能猜测后直接放宽检查。
- 基础 verify 为 16,906 通过、1 失败：SIGKILL 故事的“API 已在第二批锁上等待”前置检查未在 Vitest 默认 1 秒内成立。首批记忆和 SIGKILL 尚未执行，不能报告检查点丢失。SIGTERM 使用项目已有的锁归属/进程提前退出协调器。
- 小型 AF_UNIX 实验证实短路径别名可使用；lsof 将套接字显示在别名路径，单独检查 scratch 会漏掉，必须在任何精简/移动/快照之前同时检查两处。24 轮 Linux 子进程退出实验未复现监督器异常。

## 实施与验证顺序

1. 给受管命令创建预登记、独占、0700 的短目录。真实临时内容仍在原 scratch/tmp，以唯一且可逐字验证的 t 链接暴露；TMPDIR/TMP/TEMP 指向短别名。VM 既有短根与 owner 格式兼容。普通短根只接受 owner.json 和登记别名，不接管外部目录。别名被替换/归属不清/创建中断均保留并报告。
2. 清理、恢复证据快照在修改资源前检查 scratch 与验证过的短根；退出与重启恢复幂等。保留文件锁、进程组、打开句柄、预算和 fail-closed。增加短路径/活动套接字/中断/别名替换/外部目录/重复回收的小型红绿测试。
3. 容器 E2E 继承已验证的受管 TMPDIR，不再拼出更长的子目录；配置环境目录仍独立归属。实际 Linux branded 浏览器红绿试验确认路径有效，临时容器串行、有限额且清理后核对。
4. 为监督器添加固定枚举阶段/操作、PID、errno 的有界诊断，不记录命令行、环境或任意第三方异常正文。为 lsof 失败保留有界返回码/标准错误/超时信息，不弱化任何无法确认退出时的保护。用可控故障验证诊断与保留行为；取得实际错误后才选择处理。
5. 给检查点进程测试补测试侧启动/退出/锁等待诊断，复现后统一为精确的持锁者协调。SIGKILL 与 SIGTERM 的终止语义分别保持；不改产品、预期计数、批次持久性断言，不用盲目重试处理。若采用项目已有 10 秒锁等待预算，须明确记载从原隐式 1 秒的变化及原因。
6. 独立代码审查后按实际变更范围复验，重型测试串行，监测磁盘/内存，结束即处理本轮残留。最终正常中文提交、no-ff 合 main、正常推送、核对新 SHA 六项 CI。旧失败原件保留。P4 实际冻结清理后才进入 P5。

## 证据位置

主目录 `.codex/handoffs/m5-p4-20261022/s6/ci-early/40525146257/` 保留原始失败日志与监督快照；`ci-resource-path-fix/` 保留归因、探针与后续回执。不得将诊断信息充足等同测试通过。

## 解析器补充发现

Linux 官方 `fs/proc/array.c` 的状态表包含 `t (tracing stop)`，现有 `/^[A-Z]$/` 会拒绝这个合法状态。小型单元 RED 已实际得到 14 通过、仅 t 失败。只增补这一合法状态，不能把 tracing stop 当退出；当前 `live` 对它继续视作活进程。未知/多字符状态仍拒绝，PID/start/uid/group 归属规则不变。实际 Linux/浏览器对照继续验证；这是已证实的解析缺陷，尚不称为原 CI 无正文异常的唯一根因。

来源：https://github.com/torvalds/linux/blob/master/fs/proc/array.c 。

## 2026-10-28 接续

Chromium/WebKit 最终全部已执行断言通过，但清理查询失败，报告未归档上传；旧 lsof 无原始返回码与 stderr，原因仍待实证。短路径 57 项、监督器 70 项、最终检查点 19 项定向回归通过。新增命令启动前的同一套句柄检查，查询失败或期间收到信号均不启动子命令。Linux branded 浏览器本地探针尚无有效浏览器结果，完整门禁与新 SHA CI 不能省略。详细原件、局限及残留账见最终CI与关闭复核。


## 2026-10-28：固定 CI 数据库服务的查询边界

阶段提交 `903d0849` 保存已审 lsof 解析修复（76项通过）；真实 Linux 全流仍保守拒绝一条映射身份冲突。lsof4.95 直接 stat 调用者路径视图、只读调用者 `/proc/net/`，sudo 不代表可解析其他 mount/net namespace。此问题不按环境延期，不放宽质量门禁。以下由根负责人根据两位独立审查者意见收敛，为同 Phase 内的测试基础设施修复；不更改产品、测试范围或测试超时。

1. **适用上下文。** 保持固定 GitHub-hosted Ubuntu 24.04 只读 sudo 查询。仅 verify 的实际运行步骤、E2E 运行与 settle 步骤注入 `${{ job.services.postgres.id }}`；不在 job env 使用不可用的 job context，不给生产容器 job 注入服务 ID。只接受该精确64位十六进制 ID及工作流现有 pinned PostgreSQL18.6镜像，禁止任意 PID/所有 Docker 容器的自动豁免。
2. **创建证明。** 新 Run 在创建 scratch 前取得并持久化服务 epoch、UUID、repo、GitHub run/attempt/job以及允许的根，实际创建顺序形成证明。旧台账、任意 root、跨run/attempt、事后补签一律没有服务 scope；时间戳比较不能单独构成证明。短根仍用既有登记/inode/owner/唯一别名验证。
3. **有限只读核验。** 小模块使用固定 `/usr/bin/docker --host unix:///var/run/docker.sock` 的 inspect、volume inspect、top，选取必要字段，不保存完整 inspect 或 Config.Env。核对 Running、相同 Id/StartedAt/init PID/标准启动及精确 `HostConfig.Runtime=runc`，缺失或未知 runtime 拒绝；同时拒绝 privileged、CapAdd、设备/DeviceRequests/DeviceCgroupRules、VolumesFrom、bind，以及 host/container共享 PID/IPC/network。仅接受本 job 独立桥接网络和无 Options 的 local volume，挂载源与 scratch/短根/别名不得双向相交。普通调用者可能无法遍历 Docker 卷目录；仅对已核实的本服务 volume Source，使用固定 `/usr/bin/sudo -n -- /usr/bin/readlink -e -- <Source>` 取得单个绝对规范路径，同样受总 deadline/输出上限约束，失败保留，不依赖受限 Path.resolve 的词法回退。每命令有超时与输出上限，错误仅记录固定枚举及errno/返回码。
4. **查询前后身份。** 服务在本轮新根创建前由标准 Docker 启动，不透传宿主文件/目录FD，只有独立桥接 TCP 通道。查询前后重新核对服务epoch、每个拟处理记录PID在top中的成员关系、`/proc/PID/stat` starttime、cgroup和mount/net/PID namespace身份；必要的namespace inode读取仅使用固定只读系统命令。PID复用/新PID/退出或成员变化不自动加入scope；最多3次有限的只读快照重新取得且总预算不超过30秒，仍无法证明则保留，不能重试测试用例。
5. **保留全流。** 不使用 `-p` 排除整个PID。结构校验始终严格；任何真实REG/目录/UNIX socket、带deleted/错误注解的绝对路径或短别名命中仍阻止清理。仅在完整scope成立时，处理已核验服务PID的精确namespace语义：`mem/REG` 的 stat ENOENT 或 path dev/inode不一致，以及数字fd、`sock`类型且整行精确为 `protocol: UNIX`、`protocol: UNIX-STREAM`、`protocol: TCP`、`protocol: UDP`、`protocol: TCPv6` 或 `protocol: UDPv6`。其中 UNIX-STREAM/TCP/UDP 已有本轮自有 PID 的跨 namespace 实录；TCPv6/UDPv6 根据固定 lsof 4.95.0 与 Linux v6.8 官方生成链推导，历史 PG IPv6 监听记录不等于 fallback 实测，也不证明 CI 当前内核与该 tag 相同。NOFD/readlink/lstat/其它errno/其它未知协议、缺失/重复字段、stderr和异常返回码仍拒绝。其它实际协议形态需有原始证据与反例后才能扩大，不能用前缀通配省略调查。
6. **明确调用点。** `open_paths(root, owner=None)` 默认严格。Run.assert_quiescent/retire_short_root传已校验且持锁的owner；Store.prune在锁内重新核对owner后传入；rotate_reports先取得原run锁、验证台账和published marker，再查询。原 Run 台账使用 `O_NOFOLLOW|O_NONBLOCK` 打开并以 fstat 确认普通文件，拒绝叶子及父目录链接；当前 Run 即使无 service scope 也须先核对仍持有租约及磁盘台账。报告scope须有本轮创建/原子搬迁归属链。archive.py不传owner；其它未知历史数据保持原保护。
7. **轻型验证与审查。** 保留76项并补RED/GREEN：无owner/旧台账/任意root/跨run或attempt；错误CID/image；volume bind options/共享namespace/设备/capability；服务重启/PID复用/成员变化/新PID；scope内真实scratch文件、短别名socket、deleted文件；NOFD/readlink/未知协议；inspect/top超时/截断/异常；archive严格及注册中断。原始日志与前后源码摘要、实际清理回执归档。独立审查通过后正常提交，再采集full12开始前来源，串行原完整verify与container02，正常no-ff/推送和同SHA六项CI。

该契约不声称覆盖宿主root刻意进行nsenter/SCM_RIGHTS注入；inspect/top本身无法证明不存在这种额外特权操作。未知启动方式或宿主FD/UNIX入口通道不满足scope。所有路径命中保留，避免整PID过滤隐藏已知占用。原CI日志的标准docker create行只作历史设计依据，不能替代当前运行证明。实际CI未通过前，本节不代表P4关闭。

# NerveOffice Agent 执行规则

先阅读本目录 `CLAUDE.md`。这里补充所有 Agent 均须执行的测试资源规则，覆盖与旧文档不一致的旧测试启动示例。

- 主项目目录 HEAD 始终保持 `main`。每个 Phase 一个分支和 worktree，Codex 路径为 `.codex/worktress/<branch>/`；不在主目录切分支。整个 Phase 验证与审查通过后才 `--no-ff` 合入 main。
- 提交信息用中文。既有未提交修改及源码、Git、活动 worktree、业务数据不得作为测试垃圾处理。
- **测试完成必须处理本轮残留**，包括成功、失败、异常与可捕获中断。不得把完整 VM、浏览器 profile、数据库或反复重试的完整环境永久复制进 handoffs。
- 使用已接入的 `pnpm test:e2e`、`test:e2e:container`、`test:integration`、`test:coverage` 及 E2E 包的测量、模板和 Safari 命令。手工执行测试也须经 `python3 tools/test-resources/run.py <类型> -- <命令>`；只读列举 `--list` 除外。
- 本轮资源只放运行器提供的 `NERVE_TEST_SCRATCH` 和 `TMPDIR`（VM SSH 使用同轮预登记的 `NERVE_TEST_SHORT_ROOT`）；必要报告放 `NERVE_TEST_OUTPUT_DIR`。先登记后启动资源，VM 的准备、克隆与重启实验必须在同一轮受管命令中。不得认领外部已有 VM 或个人浏览器资料。
- 浏览器临时目录继承运行器的短 `TMPDIR/TMP/TEMP`，不得在测试入口重新拼成长路径。真实内容仍属于本轮 `scratch/tmp`；短目录和唯一别名同轮登记，清理及诊断快照前同时核对真实目录与短目录。已有目录、被替换的别名、句柄查询异常一律保留并报出有界原因；不能用忽略 lsof 告警代替核验。
- lsof 必须先核对完整 `p/f/n/t` 输出中的不可见记录，再筛选受管路径；`NOFD`、逐 FD 读链/目录/状态查询失败不能因退出 0 或 stderr 为空而放行。只有 CI 显式设置 `NERVE_TEST_LSOF_MODE=github-ubuntu-sudo` 且符合 GitHub 托管 Ubuntu 24.04/Linux 上下文时，才允许固定的 `/usr/bin/sudo -n -- /usr/bin/lsof` 只读查询；本机不自动提权，不接受自定义 root 命令，root 查询仍须完整核验。
- 固定 CI PostgreSQL 服务的 namespace 记录仅可使用本轮 scratch 创建前登记的 service scope；服务 ID 由实际运行与 settle 步骤注入。服务 epoch、runc 标准启动及独立桥接/本地卷拓扑、PID/starttime/cgroup/namespace 及受管根创建/报告搬迁链均须核实。不得排除整个 PID；真实路径命中、NOFD、readlink 和未知协议仍保留。无 owner、旧台账、任意路径及 archive 查询保持严格，不能事后补签。
- 成功立即释放临时环境；失败完整浏览器资料最长 7 天、每轮 256 MiB、合计 2 GiB。便携诊断只导出日志/配置/崩溃记录，单文件 4 MiB、单用例 16 MiB、每轮 64 MiB。JSON/HTML、trace、截图及 OPFS 证明按报告策略保存。
- 普通报告最多保留 14 天、每个 worktree 合计 5 GiB；新登记的本地门禁 bulk 归档另设 14 天/5 GiB 上限。最终审查通过的唯一证据须显式 pin 并记录理由。源码快照、补丁、摘要与索引不按垃圾回收。
- 重新启动会检查登记清单、文件锁、进程组和打开句柄；归属不清、句柄检查失败、仍有写入者的资源保留并报告。不得凭文件名、时间或 PID 单项依据批量删除。`pnpm test:cleanup` 可重复运行，但不能代替调查未登记旧材料。
- 同一 worktree 固定报告发布口串行；跨 worktree 隔离。缺少可安全清理的条件时，不继续反复创建同类环境。
- **2026-10-28 用户批准的方案 B**：上述立即删除规则继续适用于本机、普通 Linux、自托管及未知环境。仅显式 `NERVE_TEST_RESOURCE_POLICY=github-hosted-vm` 且固定 GitHub Ubuntu 24.04、仓库/run/attempt/job/runner/boot/SHA 与创建前台账相符时，原环境可保留到 job VM 销毁；不再注入 PostgreSQL service scope。必须持锁核对根身份、本轮生产者退出、完整 lsof 格式及已知本轮路径，非破坏导出并验证有界报告。语义未知引用仍留诊断并禁止删除，格式损坏/命令异常/已知引用/活跃写入者仍拒绝。
- 托管委托状态为 `cleanupStage=host-disposal-pending`、`cleanupComplete=false`，产品 `passed/failed/interrupted` 独立保留。不得把平台销毁承诺写成实测删除完成。每 2 秒计量同 job 全部受管原环境，16 GiB 为停止阈值（不是配额，允许采样和停止等待超调），12 GiB 可用空间独立检查；报告仍合计 5 GiB、artifact 14 天。完整原环境不上载、不缓存、不移动、不压缩；重启、prune 不手工删除此类目录。身份/预算/稳定导出有问题时停止，不能无界重试。
- 完整规则、入口、归档 pin 与验证命令见 `docs/testing/test-resource-lifecycle.md`。清理规则的验证使用 KiB 级临时样例，不为验收机制再创建大型环境。

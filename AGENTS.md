# NerveOffice Agent 执行规则

先阅读本目录 `CLAUDE.md`。这里补充所有 Agent 均须执行的测试资源规则，覆盖与旧文档不一致的旧测试启动示例。

- 主项目目录 HEAD 始终保持 `main`。每个 Phase 一个分支和 worktree，Codex 路径为 `.codex/worktress/<branch>/`；不在主目录切分支。整个 Phase 验证与审查通过后才 `--no-ff` 合入 main。
- 提交信息用中文。既有未提交修改及源码、Git、活动 worktree、业务数据不得作为测试垃圾处理。
- **测试完成必须处理本轮残留**，包括成功、失败、异常与可捕获中断。不得把完整 VM、浏览器 profile、数据库或反复重试的完整环境永久复制进 handoffs。
- 使用已接入的 `pnpm test:e2e`、`test:e2e:container`、`test:integration`、`test:coverage` 及 E2E 包的测量、模板和 Safari 命令。手工执行测试也须经 `python3 tools/test-resources/run.py <类型> -- <命令>`；只读列举 `--list` 除外。
- 本轮资源只放运行器提供的 `NERVE_TEST_SCRATCH` 和 `TMPDIR`（VM SSH 使用同轮预登记的 `NERVE_TEST_SHORT_ROOT`）；必要报告放 `NERVE_TEST_OUTPUT_DIR`。先登记后启动资源，VM 的准备、克隆与重启实验必须在同一轮受管命令中。不得认领外部已有 VM 或个人浏览器资料。
- 浏览器临时目录继承运行器的短 `TMPDIR/TMP/TEMP`，不得在测试入口重新拼成长路径。真实内容仍属于本轮 `scratch/tmp`；短目录和唯一别名同轮登记，清理及诊断快照前同时核对真实目录与短目录。已有目录、被替换的别名、句柄查询异常一律保留并报出有界原因；不能用忽略 lsof 告警代替核验。
- 成功立即释放临时环境；失败完整浏览器资料最长 7 天、每轮 256 MiB、合计 2 GiB。便携诊断只导出日志/配置/崩溃记录，单文件 4 MiB、单用例 16 MiB、每轮 64 MiB。JSON/HTML、trace、截图及 OPFS 证明按报告策略保存。
- 普通报告最多保留 14 天、每个 worktree 合计 5 GiB；新登记的本地门禁 bulk 归档另设 14 天/5 GiB 上限。最终审查通过的唯一证据须显式 pin 并记录理由。源码快照、补丁、摘要与索引不按垃圾回收。
- 重新启动会检查登记清单、文件锁、进程组和打开句柄；归属不清、句柄检查失败、仍有写入者的资源保留并报告。不得凭文件名、时间或 PID 单项依据批量删除。`pnpm test:cleanup` 可重复运行，但不能代替调查未登记旧材料。
- 同一 worktree 固定报告发布口串行；跨 worktree 隔离。缺少可安全清理的条件时，不继续反复创建同类环境。
- 完整规则、入口、归档 pin 与验证命令见 `docs/testing/test-resource-lifecycle.md`。清理规则的验证使用 KiB 级临时样例，不为验收机制再创建大型环境。

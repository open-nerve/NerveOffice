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

相同 worktree 的报告发布口持锁，第二轮不会覆盖第一轮。不同 worktree 分别拥有管理根。测试程序继承独立 `TMPDIR/TMP/TEMP`；不改宿主机全局设置。开始前及运行中检查可用磁盘，低于 12 GiB 时停止本轮，不继续写满磁盘。控制台日志上限 32 MiB。

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

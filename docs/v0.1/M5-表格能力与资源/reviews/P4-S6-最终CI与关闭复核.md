# M5-P4 最终验收与关闭复核

## 2026-10-30 当前断点：full18/container07 同源本地接受

受测提交为 `be62f490e5b1472e0478e7d7b5b874a6cfdd3436`，本轮合并前 main/origin/main 基线为 `988bb89cc805282d0b22c80d19838cbfce6ab27b`。测试专用观测和容量文件分组的 Task 1、整支代码独审均无遗留问题；正常提交钩子已通过。原七万规模、17 条断言、60 秒整例时限及 SQL/事务预算保持；分组落实重型测试串行，不作为旧 CI 底层原因的证明。

本节所有 `s6/` 均相对主目录 `.codex/handoffs/m5-p4-20261022/`。r09 工具真实冻结于 full18 开始前，收据为 `s6/hosted-vm-policy/tools-frozen-before-full18-r09.json`，SHA-256 `9b34a11c0f3931985f9cbf31f4bab31621e49ae392f730236dd79636c54bd26d`。两轮开始前完整清单分别为 2,440/339 项，原 timeout/expectedStatus/status/annotations 保持；四份 `*-source-before-r09.json` / `*-source-after-r09.json` 在真实开始前和结束后采集，没有补签旧运行。

| 范围 | 本轮实际结果 |
| --- | --- |
| full18 | `s6/s6-gates/full18-20261029T232645508057Z`，2026-10-29 23:26:46 至 2026-10-30 02:04:53 UTC；原完整 `pnpm verify --ci` 和桌面守护均 exit 0。713 文件/17,074 项单元与集成通过；E2E 2,424 通过、16 个原平台跳过，零重试/flaky/全局错误。完整十阶段通过，JSON/HTML 案例及原跳过身份、理由一致；11,574 条 checksums 独立复算。 |
| 容量与覆盖率 | 同一次 coverage 包含原七万例；322 条观测为 161 对 started/passed，无截断，终尾累计 9,613 ms。行/语句/函数/分支覆盖率 93.94%/93.85%/94.53%/90.32%，原五组阈值全部通过。全部构建预算保持并通过；原依赖审计策略通过不等于全依赖零漏洞。 |
| 崩溃与数据证据 | full18 的 59 份崩溃附件覆盖 168 轮、891 个归属终止进程，late 0；945 份 OPFS 含 842 文件/109,117 B。历史会话、图片、链接零外部请求、正文拒绝和原恢复断言均经原 auditor 复算。 |
| container07 | `s6/s6-gates/container07-20261030T021856709603Z`，2026-10-30 02:18:57–02:27:58 UTC；原 `pnpm test:e2e:container` 和桌面守护均 exit 0。339/339 首过（328 常规、4 崩溃、7 重启），零跳过/重试/flaky/全局错误；4,670 条 checksums 独立复算。4 份崩溃附件覆盖 4 轮/16 个归属进程，容器无 OPFS 附件，不冒充 full18 证据。 |
| 容器原断言与预算 | 实际 linux-arm64 原生材料、私有图片卷及 GC、缺备份声明暂停删除、3 项错误配置拒绝、代次和配额回放、重传可读均通过。44 项图片矩阵、5 接受/5 忙准入、18 项正文拒绝及后续恢复通过；四服务日志主密钥扫描通过。8 个 cgroup 样本最大整容器 memoryPeak 为 784,314,368 B，原 4,294,967,296 B 上限保持，oom/oomKill 均 0；不解释为单图片独占内存。 |
| 同源 | 四份 capture 和两轮原件证明 4,616 项源码、类型、模式、链接目标及 16 个 SDK 包一致；两轮间精确变更路径为空。工具冻结和真实时间顺序保持。这里只接受受测输入，结果文档到最终合并 SHA 的精确来源证明仍须在实际提交、合并后生成。 |

本机 integration/e2e/container 三个产品 run 均为 passed/0、cleanup complete；scratch、短根/别名、owner/进程组退出、文件锁与完整 pfnt 句柄核验成立。full18 的 1,113 个和 container07 的 8 个 profile 已清理，完整 profile 与便携诊断保留字节均为 0。必要 JSON/HTML、trace、崩溃与 OPFS 证据已按原策略保留并实际 pin；未复制完整 VM、数据库或浏览器环境。

Docker 证据由原创建日志、末态 `ps.txt`、固定 Compose 范围及正常收尾，加上实际精确 project label 空结果和逐名 inspect 缺失组成：本轮 `nerve-office-e2e-37753` 项目下没有容器、网络或卷，本轮镜像 tag 也不存在。已接受的是本轮命名环境退出；没有保留或追回历史容器全长 ID，app 曾重建，不能把末态四个服务当作生命周期实例总数，也不宣称镜像内容或构建缓存全部删除。共享 PostgreSQL 的 ID 与 StartedAt 不变，共享 Docker 和旧约 345 MB 句柄挂账保持。

两轮 WindowServer 均保持 989，未触发桌面保护。full18 守护首个采样至结束可用空间为 103,014,461,440 → 103,550,484,480 B，净 +536,023,040 B，守护采样最低 87,682,723,840 B；container07 为 100,938,682,368 → 103,636,140,032 B，净 +2,697,457,664 B，最低 100,060,344,320 B。首个采样不冒充命令启动瞬间，以上均为整文件系统 APFS 观测，不全归因为本任务释放。详细汇总在调查目录的 `full18-root-resource-summary.json` 和 `container07-root-resource-summary.json`。

独立接受回执均位于 `s6/hosted-vm-policy/`：

- `full18-r09-independent-acceptance.json`：SHA-256 `77c0524a61e6e1280ab1cca435cbc85850240efca587e8ce8ecfc0b6e56ee6d5`，02:17:51 UTC，接受 full18。
- `container07-r09-independent-acceptance.json`：SHA-256 `39e3668b6a89bac49ee94be161d78a4bfc066bd093b2c308129238772203a133`，02:42:29 UTC，接受 container07，记录上述 Docker 证据限制。
- `full18-container07-r09-independent-acceptance.json`：SHA-256 `5fa2109f2d99a3b8457dfd16378b9b3c5b4079e09418f0ad992b599d991ccd1a`，02:42:29 UTC，接受本地同源双门禁。三份均无遗留审查问题。

独审期间 full18 辅助脚本初版误把 SDK 路径指向 worktree 根 `node_modules`，该轮 failed/1 原件及实际清理保留；仅修正为真实 `apps/web/node_modules` 后的第二轮通过，不算产品失败或重跑产品。container07 独审只使用一个受管只读轮次，通过并实际清理；较早的派生记录中 `pending` 状态保持为生成时事实，不覆盖原件。

后续按既定 r09 顺序完成：这五份既有结果文档的实际差异独审 → 正常中文提交 → `--no-ff` 合入 main → 精确文档 before/after 和合并来源绑定 → 正常 pre-push/main 推送 → 同最终 SHA 六项 CI 与十份原报告审计 → 独立关闭复核、冻结及唯一 P4 worktree/分支实际清理。此刻未完成后半段，不预签 P4/DEF-061 关闭或 P5 开始。旧 CI `40947141649` 失败、coverage 缺件和底层原因未知，以及 Excel/Safari/Finder、M4 DEF-073/UR-035、完整验收和标签、M7 演练挂账均保持。托管原环境符合方案 B 时仍只记 `host-disposal-pending`、`cleanupComplete=false`、`ciRawCleanupObserved=false`。

## 2026-10-30 历史断点：CI 40947141649 的七万资源用例超时

下方 r08 的本地双门禁已完成正常结果提交 `6ec8e2ac`、`--no-ff` 合并 `988bb89cc805282d0b22c80d19838cbfce6ab27b`、原 pre-push 门禁与 main 推送。最终同 SHA [CI 40947141649](https://github.com/open-nerve/NerveOffice/actions/runs/40947141649) 六项均已结束：四个浏览器及容器首次通过；verify 唯一产品失败是七万资源用例 60,017 ms 超时，17,059/17,060 项通过。原整轮不接受，P4/DEF-061 未关闭、P5 未开始。

六份日志和九份现存 ZIP 共 39,207,908 B 已校验归档；覆盖率 JSON/HTML 因测试失败未生成，`reports-40947141649` 缺件。没有降低原十份报告合同，也没有用补件回执替代最终接受。独立核对五项成功报告：Chromium 814 通过/4 原跳过，Chrome 807/4、Edge 807/4、WebKit 803/8、容器 339/0；无 flaky、重试或全局错误。资源仍按方案 B 记为 `host-disposal-pending`、`cleanupComplete=false`，不称托管 VM 已实测删除。

本轮外部调查目录为 `s6/hosted-vm-policy/final-ci-40947141649-investigation/`；现存原件位于其中 `ci-supplement-20261029T215150601239Z/`。独审 `final-ci-partial-evidence-review.md` 的 SHA-256 为 `4646b4334c3c4e333a81b0f8b0889dc9dc5fa471927abe6f14706a6733aa2f83`。新增观测与两次本机定向取证见[七万资源调查](P4-S6-七万资源往返超时调查.md)。它们不改生产实现，也不能用本机通过判定 CI 根因已解决。原规模 SQL 补充诊断没有支持修改数据库结构的证据；现按用户重型串行要求显式将容量文件排在同一次 coverage 的普通组收尾后，原数值与断言保持，87 项局部回归和完整清单守恒已通过。此调整不证明旧 CI 的底层原因；后续须按真实新输入完成 full18/container07 及同 SHA CI；下方 r08 接受仅覆盖旧输入，旧失败和冻结材料均不覆盖。

## 2026-10-30 接续：full17/container06 同源本地接受

本轮受测提交为 `bdb7ddc38d09e3ce881b20c3ea88f2265d3e63d5`，合并前 main 基线为 `2ad8c3242127fa56cee094e40ec09e6b6e5efa7b`。清理竞争用例仅调整未授权页面的前置准备和异步收尾，原 5 秒、锁等待及旧宿主拒绝/新会话重存断言保持；背景见[前置同步复核](P4-S6-清理竞争用例前置同步复核.md)。以下只接受本地双门禁与资源终态，本次文档的独审、正常提交/合并/推送、最终同 SHA CI、冻结和 P4 关闭仍按后续实际回执完成。

下列 `s6/` 路径均相对主目录 `.codex/handoffs/m5-p4-20261022/`。r08 工具在 full17 开始前真实冻结，启动前分别核对 2,440/339 个完整身份及 timeout/expectedStatus/status/annotations；四份 `*-source-before-r08.json` / `*-source-after-r08.json` 分别在真实开始前和结束后生成。旧 r06/r07 原件及 full16 的旧外层审计失败保持，不用后来的冻结时间补签旧运行。

| 范围 | 本轮实际结果 |
| --- | --- |
| full17 | `s6/s6-gates/full17-20261029T163511059941Z`，2026-10-29 16:35:12–19:10:59 UTC；原完整 `pnpm verify --ci` 与外层均 exit 0。711 文件、17,060 项单元/集成通过；E2E 2,424 通过、16 个原平台跳过，零重试/flaky/全局错误，完整十阶段通过。 |
| full17 内容与预算 | JSON/HTML、2,440 个案例及原 16 跳过身份/理由一致；11,568 条 checksums 复算通过。59 份崩溃附件覆盖 168 轮、891 个已归属终止进程，late 0；945 份 OPFS 含 842 文件/181,038 B。行/语句/函数/分支覆盖率为 93.98%/93.89%/94.62%/90.35%；平台 179.9/180 KiB、编辑器 2143.2/2350 KiB、历史预览 2033.7/2350 KiB、公式 Worker 679.1/800 KiB、outbox Worker 15.0/15 KiB，原预算保持。原依赖审计策略通过不扩大为全依赖零漏洞。 |
| 本次修复的完整门禁结果 | “清理先得锁”的完整案例在 Chromium、Chrome、WebKit 均 retry 0 首过，日志耗时分别为 1.2/2.6/3.2 秒。旧 Linux HTML 导航未完成的底层原因仍未知，不将前置编排修正写成浏览器底层问题已解决。 |
| container06 | `s6/s6-gates/container06-20261029T192652728027Z`，2026-10-29 19:26:53–19:35:37 UTC；原 `pnpm test:e2e:container` 与外层 exit 0。339/339 首次通过（328 常规、4 崩溃、7 重启），零跳过/重试/flaky/全局错误，4,664 条 checksums 与 JSON/HTML 核验通过。 |
| 生产内容与预算 | 实际 Linux arm64 原生图片、uid 1000 私有资源卷、备份缺失暂停 GC、3 项错误配置拒绝、退休标记、新代次和重放不重复释放均通过。44 项图片矩阵（20 接受/24 拒绝）、5 接受/5 ASSET_BUSY 及 18 项正文拒绝保持；8 个 cgroup 样本最大 memoryPeak 813,047,808 B，memoryMax 4,294,967,296 B，oom/oomKill 均 0。峰值属于整个容器生命周期；本轮不代签 Linux x64 或真实原生输入。 |
| 同源与时序 | 四份真实 capture、两轮源码字节/类型/模式及 16 个 SDK 包一致，共 4,610 个受测输入，两个门禁之间没有文档或源码变化。局部同源回执 `s6/hosted-vm-policy/final-ci-40882447516-investigation/r08-local-pair-source-check.json`（SHA-256 `fe7a5254a6b20aa876800bb70665922713c5d6c74f5f3e7fb66d9e2d6c67bfcb`）仅证明这两轮，最终合并源码等价还须绑定真实文档增量与 Git 提交。 |
| 资源与桌面 | 两轮分别精简 1,113/8 个浏览器 profile，raw profile 与便携诊断保留均 0；原件已按实际审计 pin。scratch、短根/alias、owner/进程组、锁及完整 pfnt 由独审核实，先核完整流再筛路径。本轮容器 4 个、网络 1 个、卷 2 个和测试镜像均实际移除，原 Docker 对象及开发 PG 身份/启动时间/端口保持；共享 Docker 与构建缓存未清扫。两轮 WindowServer 均保持 989，未触发守护停止。 |
| 有限留档 | 两轮 checksums 所登记文件分别为 143,782,396 B / 74,116,769 B，包含必要报告、附件和源码快照，不是运行中的完整环境大小。container06 实际资源回执 `s6/hosted-vm-policy/final-ci-40882447516-investigation/container06-actual-resource-closure.json`（SHA-256 `a197af4ae0a7f5d0d952a0a2112dd8736c43c447689af52e91137e1ec57f816a`）另保留全盘可用空间观测；不把目录逻辑大小或共享缓存当作本轮实测释放量。 |

full17 独立接受：`s6/hosted-vm-policy/full17-r08-independent-acceptance.json`，SHA-256 `2c750c1bbd84d0f9ead7aafc45658b4364071dbc825cbeffb5556f60fca96fba`。container06 及本地同源双门禁独立接受：`s6/hosted-vm-policy/container06-r08-independent-acceptance.json`，SHA-256 `3aa209f30760d0899aa5a45b15f3e4591977dba26046c9439f4578741a8e6178`。两份同名 Markdown 记录方法和边界；原 audit、archive-review/resources、运行前后 capture、桌面守护及受管辅助轮均由回执索引。full17 独审中的目录初始化和标题筛选两次辅助错误原样留档，修正后小型只读复算通过；产品门禁没有为此重跑。container06 独立受管复算首次通过并完成清理。

原 CI `40882447516` 的失败、full16 旧 outer failed/1 与运行后补审、旧 full15/CI `40787715273` 等历史记录继续保留。Excel、Safari/Finder 原生缺口、M4 DEF-073/UR-035、完整验收/标签及 M7 联合备份/PITR/升级回滚边界保持；DEF-061 没有可用历史时不能保证恢复，最终收口仍以实际 P4 关闭为准。

### r08 后续完成条件

1. 仅对本批既有结果文档的精确差异作独立审查，再正常中文提交，得到真实 Phase tip T。
2. 正常 `--no-ff` 合入 main 得到 M，父节点必须为 `[2ad8c3242127fa56cee094e40ec09e6b6e5efa7b, T]`；M 与 T 同树。用实际四份 capture、精确文档 before/after 与 Git blobs 生成 r08 来源等价证明，再正常推送并保留原 pre-push 门禁。
3. 获取同一个 M、attempt 1 的六项 CI 和十份原件，独立核对案例、原生 x64/浏览器/容器及资源合同。方案 B 继续只表示 `host-disposal-pending`、`cleanupComplete=false`、`ciRawCleanupObserved=false`，不把托管 VM 的销毁承诺写成实测删除。
4. 独立收尾复核、真实冻结、唯一 P4 worktree/分支实际清理及 finalize 后，才关闭 P4/DEF-061，并从 main 进入 P5 即时设计。既有架构总览与 ADR-023/024 已在前一轮落档，本次不改功能、权限、备份或预算语义。

后续实际状态以主目录 `.codex/handoffs/m5-p4-20261022/progress.json` 及真实生成的 `s6/p4-ci-binding-r08.json`、`s6/source-equivalence-r08-v3-<实际M前12位>/receipt.json`、`s6/main-push-r08/normal-push-receipt.json`、`s6/ci-<实际run>-hosted-audit-r08.json`、`s6/p4-ci-ready-r08.json`、`s6/p4-final-r08/`、`s6/p4-completion-r08.json` 为准。这些是流程入口，不预签未来提交、CI 或关闭已经完成。

## 2026-10-29 历史断点：CI 40882447516 有一项 flaky

下方 full16/container05 的本地接受仍是对应输入的历史事实。随后结果文档提交 `98df13b4`、正常 no-ff 合并 `2ad8c3242127fa56cee094e40ec09e6b6e5efa7b`、原 pre-push 门禁与正常推送均已完成。对应最终 CI [40882447516](https://github.com/open-nerve/NerveOffice/actions/runs/40882447516) 五项通过，WebKit 因一个 flaky 失败；六份日志与十份 ZIP 已完整收集；十份 ZIP 合计 44,532,392 B，六份日志另为 2,575,902 B。没有执行 r07 的最终接受/冻结/关闭，P4 和 DEF-061 尚未收口，P5 尚未开始。

唯一 flaky 为“清理先得锁”：首轮原 5 秒内只看到一个锁等待者，新页 HTML 尚未完成、真实授权没有发出；重试通过。旧 CSRF/登录故事及新增 IDB 边界首轮通过。局部修复仅提前加载未授权探针页，原临界段仍真实登录并授权，全部业务断言与时限保持；受控前后对照、最终三浏览器 54 项及类型/lint 已通过，详见[前置同步复核](P4-S6-清理竞争用例前置同步复核.md)。不称未知的 WebKit 导航底层问题已经解决，也不以环境欠账豁免本轮失败。

当前外部证据根为 `s6/hosted-vm-policy/final-ci-40882447516-investigation/`。新 r08 工具候选只用于准备正常 full17/container06 证据链，启动前核对 2,440/339 完整案例及元数据；待真实修复提交绑定、轻型验证与独审后再执行。新的 capture、门禁结果、最终提交/合并、推送、CI 和关闭均不得预填。下列 r06/r07 的旧工具、失败与接受时序保持，不事后覆盖。

## full16/container05 历史本地接受

**2026-10-29 本轮本地双门禁验收：full16 经 r07 补充审计、container05 及两轮同源均已独立接受。** 完整门禁受测提交为 `000022ae6810aa156f0ae0d1fd724d53c6b3d4f4`，本轮合并前 main/origin/main 基线为 `323b957b5302208de965e76e6590052cc60a84e2`。真实 capture 保持 r06，后续来源绑定/正常合并推送/同 SHA CI/关闭走 r07；本记录不预签最终 main 来源、推送、CI 或 P4 关闭。

## full16/container05 历史门禁：r06 实际运行、r07 补充审计

本节集中记录本轮结果；下方日期章节保留旧输入和当时状态。引用活动 INSERT 集合化 `50ba1c8d`、WebKit 有界诊断 `1deac003`、图片 401 恢复 `f2e28647` 与 CSRF 停写/确认协调 `000022ae` 均已提交；局部事实分别见[批量写入复核](P4-S6-引用活动批量写入复核.md)、[WebKit 诊断](P4-S6-WebKit登录导航诊断.md)、[图片恢复复核](P4-S6-图片401与本机资格复核.md)与[协调复核](P4-S6-CSRF停写与确认协调复核.md)。

### full16 实际结果与旧审计失败

原件目录为主目录 `.codex/handoffs/m5-p4-20261022/s6/s6-gates/full16-20261029T082831673040Z`（以下 `s6/` 均相对 `.codex/handoffs/m5-p4-20261022/`）。默认完整 `pnpm verify --ci` 于 2026-10-29 08:28:32–11:08:36 UTC 执行，原产品命令 exit 0，十个既定阶段全部通过：711 文件 / 17,060 项单元与集成，完整 E2E 为 2,424 通过、16 个原平台跳过；无失败、重试、flaky、全局错误或未登记缺项。Chromium/Chrome 各 787 通过，WebKit 784 通过/3 跳过，crash 三项目分别 20/4、20/4、19/5，restart 7 通过。JSON、HTML 和运行前真实 catalog 的 2,440 个身份一致，16 个跳过身份及理由逐项等于原 P3 基线。

**旧 outer 和旧审计没有通过。** 外部预期目录仍登记 2,437，漏了实际运行前已列入 catalog 的同一个原生 IDB 边界用例在 Chromium/Chrome/WebKit 的三项身份，导致原 outer 保持 `failed/1`，`s6/archive-review/full16/status.json` 保持 `accepted=false/review-failed`。这些失败原件永久保留，原启动审查漏查登记一致性的限制也不改写。产品 exit 0、资源回收成功和旧外层失败分别记实。

r07 仅精确补登这三项为 2,440；无删除、改名、新跳过或超时/断言/预期状态放宽，容器原 339 项范围不变。r07 工具在 full16 结束之后完成小型验证和独审，12:15:49 UTC 新冻结，12:16:02–12:16:07 UTC 对同一原件完成补充审计，随后独立复算全部原审计断言；没有重跑产品。该冻结是 full16 后、container05 前的实际冻结，不能倒称 full16 的运行前冻结。原 r06 冻结、08:27:57 UTC 的真实 before 与 11:11:16 UTC 的真实 after 保持；capture 继续固定 r06，后续 binding/push/CI/close 走 r07。

### full16 接受证据与边界

| 范围 | 已接受事实 |
|---|---|
| 来源与原件 | 4,609 项源码运行前后字节、模式与链接相同，16 个 SDK 包输入不变；独审复算 11,565 条原始 checksums，JSON/HTML 精确结果一致。当前结果文档及未来最终提交的等价证明仍须另行完成。 |
| 原预算与覆盖率 | 原构建/产物预算通过：平台 179.9/180 KiB、编辑器 2143.2/2350 KiB、历史预览 2033.7/2350 KiB、公式 Worker 679.1/800 KiB、outbox Worker 15.0/15 KiB。行/语句/函数/分支覆盖率 93.94%/93.85%/94.53%/90.32%；原依赖审计策略通过不等于全部依赖零漏洞。 |
| 崩溃与数据 | 59 份附件覆盖 168 次真实 Darwin 崩溃、891 个已归属终止进程，late 0，无幸存者/缺角色/工具问题。945 份 OPFS、840 文件、156,107 字节及清理标记核对。15 项链接零外部请求、6 项历史续期与 44 项图片矩阵原断言成立；本机附件不冒充容器峰值。 |
| 本机资源 | integration/e2e 原 run 均 passed/0、cleanup complete；1,113 个 profile 已精简，raw profile 与便携诊断保留均为 0。独审核对原 outer、两个产品 run 和 r07 补充审计 run 的 12 个 scratch/短根/alias 均不存在，owner/进程组退出、锁可用且字节不变；完整句柄核验先检查全流，再筛本轮路径，命中 0。必要报告约 170 MiB 已 pin，未保留完整环境。 |
| 磁盘与桌面 | 原结束实查为 WindowServer 989；整文件系统可用空间从 106,951,503,872 B 到 106,721,210,368 B，净变化 -230,293,504 B，守护最低 90,818,932,736 B。以上为全盘观测，不归因于本轮净释放量，也不表示共享 Docker 旧句柄已释放。 |
| 正式接受 | `s6/full16-audit-r07.json`、`s6/archive-review-r07/full16/status.json` 与 `resources.json` 及实际 pin 相互绑定。独立接受回执为 `s6/hosted-vm-policy/full16-r07-independent-acceptance.json`，SHA-256 `30d1b197fcad666215389c38c8be0ebc73059185b8657eb53459ff2ecd26db62`，2026-10-29 12:27:03 UTC，0 C/I/M；同名 Markdown 说明复算与限制。只接受本机 full16，不代签容器、最终来源/文档、推送、CI 或关闭。 |

原 `s6/hosted-vm-policy/full16-post-exit-resource-audit.json` 和稍后的 `full16-r07-root-validation.json` 分别保留生成时的 gateAccepted=false / independentGateAcceptancePending=true；正式独审回执记录后续接受，不覆盖旧文件。

### container05 实际结果、同源与资源

原 bundle 为 `s6/s6-gates/container05-20261029T122759893976Z`，2026-10-29 12:28:01–12:36:47 UTC 按原三层 wrapper 串行执行原完整生产容器入口；产品命令与 outer 均 exit 0。339/339 首次通过：普通 Chromium 328、crash 4、restart 7；零跳过、失败、重试、flaky，JSON/HTML 精确案例和原摘要核验一致。4 份崩溃附件覆盖 4 轮、16 个归属终止进程，late 0。容器 OPFS 归档为 0，其证明由 full16 承担，不伪造容器材料。

| 范围 | 原件、来源、资源及独立验收事实 |
|---|---|
| 原生与图片 | 实际 linux-arm64 原生图片材料和私有 `/var/lib/nerve-office/assets`（uid 1000、可写且隔离）核验通过，不扩称 Linux x64。图片矩阵 44 项（20 接受/24 拒绝），准入 5 接受/5 ASSET_BUSY，重启持久化 revision=2 与 SHA 一致；18 项正文拒绝含 15 次声明长度和 3 次 chunked，原规范错误及随后正常上传断言通过。原附件只直接存状态，不称每个错误正文都被独立存档。 |
| GC 与配置 | 私有资源卷、缺备份声明时暂停删除、3 项错误配置拒绝、零字节退休标记、同 hash 新代次、重放不重复释放配额与重新上传可读均核验通过。容器配置与清理检查按原入口完成。 |
| 内存 | 图片及正文拒绝的 8 个 cgroup 样本，最大 memoryPeak 为 729,010,176 B，memoryMax 均为 4,294,967,296 B，oom/oomKill 均 0。此为整容器生命周期峰值，不能称图片独占内存或单次上传峰值；原预算未改。 |
| 两轮同源 | `s6/hosted-vm-policy/r07-local-pair-source-check.json`（SHA-256 `488b2ab3ff05897a2301e6288d1e72f6405ef0026f35da86e3456084b02f4625`）核对全部四份 4,609 源码/形状与 16 个 SDK 包输入相同。container05 真实 r06 before/after 的 SHA 分别为 `cc6c5cd21f6ae530c4dc4cc9cf951878578a02108d5c57763f8ca9d20c678984` / `470a54bfe48cc28ae175899539ce2ec778e6357e519a11bf2cb6e1c124e5c316`；未用新工具补签 capture，未来最终文档/合并等价证明尚未生成。 |
| 临时资源与 Docker | inner `560e7fd9-cfd0-4eee-b876-895d03b43caf` 和 outer `d0cae0f9-f49e-474f-8973-1aa2a4f88020` 均 passed/0、cleanup complete；8 个 profile 已精简，raw/便携诊断保留均 0。实际 scratch/短根/alias/owner/进程组与守护退出、锁可取且字节不变；完整句柄先全流核验再筛路径，命中 0。本轮 4 容器（含 migrate）、1 网络、2 卷、镜像标签实际不存在；原专用 PG 同 ID 仍运行，共享 Docker 和构建缓存未动。 |
| 磁盘与桌面 | 实际启动前 readiness 基线为 106,592,456,704 B，守护最低 104,118,616,064 B，收尾 106,144,448,512 B，净变化 -448,008,192 B；均为全文件系统观测，不全归因本轮，也不倒称在命令开始瞬间采样。WindowServer 保持 989。 |
| 归档与资源回执 | `s6/container05-audit.json` SHA `24a7886987f5983215356b203fbd6fcfcb5ba849eabbfb8e057832bd2505453d`；`s6/archive-review/container05/status.json` 为 accepted=true，SHA `3856e6f53a9341e7cda8af2dd664a0ac17f4e4166540f594099787baaef560b5`，必要报告已 pin。实际清理回执 `s6/hosted-vm-policy/container05-actual-resource-closure.json` SHA `c415b1522719a497cf67e7dea7efb63a4f3a6b492e0a316460410c99b247e90c`。该原状态按既有 schema 以 `accepted=true` 表明接受，没有 `status` 字段；独立接受另见下节回执，不补造原字段。 |

### 本地双门禁独立接受与后续条件

2026-10-29 12:46:23 UTC，`s6/hosted-vm-policy/container05-r07-independent-acceptance.json` 正式接受 container05 及其与 full16 的同源双门禁，0 C/I/M，SHA-256 `532f1993a04fde9c5e49ce1880297c057805f170b6119bda31f8a56e45e681c9`；同名 Markdown 记录复算方法与限制。独审未重跑产品，重算原 auditor 全部断言和 4,663 条 checksums，与原审计完全一致；同时核对两项容器历史会话、图片/GC/配置及日志主密钥检查。两门禁四份 4,609 项源码/形状和 16 个 SDK 包输入一致，容器两轮六个临时根、进程/锁/完整 pfnt 与 Docker 实物另经独立只读核验。

本次接受只覆盖本地完整门禁及同源关系。原 `r07-local-pair-source-check.json` 的 `containerIndependentAcceptancePending=true` 保留为生成时事实，由新独审回执记录后续接受；不覆盖旧文件。full16 的旧 outer failed/1、旧 review-failed 和运行后补登时序继续保持。

接下来须依次满足：

1. 对本批既有结果文档的实际差异、before/after SHA 进行独立审查，再正常中文提交。该审查发生在文字形成之后，本记录不自签其 accepted 或未来提交 SHA。
2. 按既定规则正常 no-ff 合入 main，以真实 r06 captures 和 r07 合同证明最终合并源码与两轮受测输入等价；保留正常 pre-push 门禁，仅推 main。
3. 对同一最终合并 SHA 的六项 CI、十份必要原件、来源/报告/资源合同逐项核验。既有本机接受和诊断 CI 不替代该最终 Linux/浏览器/容器结果。
4. 独立关闭复核、证据冻结与唯一 P4 worktree/分支实际清理完成后，才记录 P4 工程关闭和 DEF-061 收口，再从 main 进入 P5。

实际接续状态以主目录 `.codex/handoffs/m5-p4-20261022/progress.json`、本目录所引原件，以及后续流程实际生成的 `s6/p4-ci-binding-r07.json`、`s6/p4-ci-ready-r07.json`、`s6/p4-final-r07/` 和 `s6/p4-completion-r07.json` 为准。以上列明后续记录位置，不预签文件已经存在或验收成功。本文的受测提交和合并前基线是固定历史输入，不宣称它们永远是当前 HEAD；最终 Phase tip、merge SHA、推送、CI 与关闭不预填。

旧 full15 的 395 项通过、1 项失败及其余未完成状态，以及旧 CI `40787715273` 的 verify/Chrome/WebKit 三项失败保持。该轮 SQLSTATE 57014 不能倒填到缺少 SQLSTATE 的旧 CI `40718430340`。WebKit 原 Linux 导航根因仍未知；下一次实际 Linux CI 须核对首次/重试、附件是否存在及 incomplete/truncated/dropped、服务端完成日志。新本机首次通过不解释旧 Linux 根因。

Excel、Safari/Finder、DEF-004、M4 DEF-073/UR-035、M4 完整验收与标签按原交接挂账。无可用历史不能保证恢复；未声明备份时物理删除继续暂停，生产规模/联合备份与实际升级恢复仍属 M7。方案 B 托管状态保持 `host-disposal-pending`、`cleanupComplete=false`、`ciRawCleanupObserved=false`，不写成已观察宿主销毁；环境欠账不豁免产品失败和原门槛。

> **full15 启动前记录**：main/origin/main 仍为 `323b957b`；原P4分支已正常提交0038数据库修复 `50ba1c8d` 和WebKit有界诊断 `1deac003`，未再次合并/推送。数据库完整coverage已通过（708文件、16,987项），不覆盖后续浏览器改动。Chrome图片重复401已在中间失败轮 `chrome-images-local01` 的trace从每轮544次降为1次；中间一轮六场景5通过/401两次失败保留，页面匹配本机stopped后补真实确认的两个RED复现后，505项关联回归、lint/全仓typecheck以及最新原六场景E2E均通过，零重试/跳过/flaky，原产物与体积预算通过。局部修复不改beginRestore、共享会话或恢复协议。WebKit macOS原故事首次通过但导航附件incomplete；Linux旧故障仍未知，下一轮只增加有界诊断，原门槛不变。详细事实见图片401当前计划/复核、WebKit登录导航诊断review及主目录progress.json。局部独审提交后准备r05/full15/container05；P4未关闭、P5未开始，仍须新来源完整双门禁及最终同SHA CI。

> 上一轮 r04 历史状态：full14/container04完整门禁、同源证明、独立原件/资源接受及实际清理已完成；该轮后续正常合并/推送已发生，同SHA CI因上述故障不接受，冻结与实际关闭未执行。


## 历史本机门禁与修复记录

首次准备因磁盘低于既定 18 GiB 门槛安全停止；无损归档已关闭阶段原件后恢复余量，未放宽门禁。`full02` 完整检查在单元/集成阶段失败：700 文件、16,886 项通过，2 项失败；后续构建、E2E、漏洞审计未执行，不记通过。

两处失败是测试接线与样本前提：新增后台会话检查漏入 GET 只读快照请求表；退休权限负例的创建模式被启动 umask 077 收紧为 0600。已补真实接口探测，并显式设置故障文件 0644。相同严格 umask 下 2 文件 32 项回归通过，未修改产品权限判断或放宽断言。完整失败原件保存在 `.codex/handoffs/m5-p4-20261022/s6/s6-gates/full02-20261022T190916750119Z/`。

下一轮默认完整 verify 和同源码完整生产容器待完成。通过后需核对 JSON/HTML、精确案例、既有平台跳过、重试/偶发失败、崩溃进程、原生图片/GC 私有卷、覆盖率及原预算。

## 合并后 CI 与关闭条件

本机全门禁、代码审查与修复复验通过后正常中文提交，在 main 执行 `--no-ff` 合并，仅推 main。六项 CI 必须绑定同一完整合并 SHA；逐项下载日志、报告和监督快照，核对案例与实际进程退出、容器清理，不能只根据绿色状态关闭。

独立收尾复核、证据冻结和唯一 P4 分支/worktree 清理实际完成后，才在主目录外部关闭回执标记工程关闭。本文最终提交时尚未发生的 CI/清理不预记成功；关闭回执将绑定本文所在提交。Excel、Safari/Finder、M4 的既有挂账保持。


### 故事强制覆盖登记补齐

收尾逐项对照发现 US-M5-09/11 仍为 planned；11 已有清除、运维与过期的集成/E2E，09 已有正式宿主列表复制 E2E 及六项图片副本集成。现激活两项，并给已有副本集成套件补编号前缀，强制故事门禁必须验证两类证据存在。测试内容和 E2E 身份不变。full03 在源码未改时主动停止并保留原件，不能用于通过计数；包装器收尾遇到一次进程存活查询 EPERM，随后两种只读核对确认原进程组消失才归档。外部包装器把此查询异常保守视为尚存活，避免跳过退出确认。下一轮完整门禁在最终故事登记下重跑。


### full04 的资源定位假设与复验

full04 的 702 文件、16,888 项单元/集成及全部覆盖率通过（总行覆盖率 93.97%）；lint、类型、静态、构建、依赖、许可与原产物预算通过。浏览器阶段的安全头用例只扫描 editor 入口脚本来找公式 Worker，但新增历史预览入口后，构建器将 Worker 创建代码放入共享 session-image-access 模块，因而在安全头断言之前得到 undefined。原 trace、构建产物和另一个实际页面 CSP 用例相互印证，不是安全头策略失败。

确认失败后停止该轮并等待专属进程组退出，源码与安装 SDK 前后未变；原报告为 897 通过、1 失败、6 中断，其余未执行。完整原件在 `s6/s6-gates/full04-20261022T192428422784Z`，该轮不计通过。

用例改为在正式阅读流程中观察同源公式 Worker 的真实响应，要求唯一路径且响应 200，再沿用原逐项 CSP/HSTS/其它安全头断言。只给实际启动 SDK 的首条用例采用既有 EDITOR_TEST_TIMEOUT；探针、其它时限、重试和所有原断言不变。初次定向运行有 15 项通过，3 项在创建测试用户时因前缀加随机后缀超过 32 字符而失败；仅缩短样本前缀，失败原件保留。修正方案与正常推送脚本经独立只读复核为 0 C / 0 I / 0 M；动态结果另行验收。

三浏览器定向复验：默认 `s6-csp-resource-discovery-default02` 为 18/18，running `s6-csp-resource-discovery-running01` 为 12/12，合计 30 项全部首次通过，零失败/跳过/偶发失败/重试。原 JSON/HTML 的案例与资源路径附件逐字节一致，三浏览器都实际定位并检查公式 Worker；两套原报告及摘要分别归档。随后从完整默认门禁重新验收，定向结果不替代完整验收。

## 2026-10-27：安全更新、资源治理与恢复验收

以下分节按发生时间记录，早期“待执行”不覆盖顶部和文末的最新状态。full11与同源码container01已完成完整门禁、归档审计与独立接受复核；S6初次提交/本地合并之后的推送曾被正常钩子阻止，详见文末配置探针修复。没有用后续定向检查、资源清理或工具审查替代整阶段验收。

### 安全依赖与原接口、预算

full06 的 16,888 项单元/集成和 2,421 项 E2E、16 个既有平台跳过不能构成完整通过：最后的生产依赖审计因三项公告失败，退出码为 1。原件与不接受结论在主目录 `.codex/handoffs/m5-p4-20261022/s6/full06-terminal-summary.json`；也不能作为依赖更新后源码的通过证据。

本次精确更新 zod 4.6.5→4.6.6、body-parser 2.3.0→2.4.0、multer 2.4.0→2.5.0。两个间接覆盖分别限定 `express@5.2.1>body-parser` 和 `@nestjs/platform-express@12.1.0>multer`，已满 72 小时冷却；没有降级、全局覆盖或审计例外。依据、运行时可达性与风险边界见 [ADR-002](../../../adr/ADR-002-工具链与依赖的版本基线.md)：项目关闭 Nest 默认 bodyParser 后仍调用 express.json；没有启用 Multer 上传拦截器。

33 个无效诊断项的小样本先证明旧 zod 展开出 67 个问题，新版在集合超过 32 项时直接返回一个上限问题。body-parser 升级曾把新增 zstd 样本从预期 415 变为 201；项目 JSON 入口随后按匹配的 JSON 正文预检查编码，保持 identity/gzip/deflate/br，拒绝 zstd。独立审查再发现空 Content-Encoding 被误拒，真实 HTTP 反例先 RED，再将缺省和空字符串归一为 identity，其他值只转小写。JSON 字节、深度、元素限制和错误映射保持；三种压缩尾部的有界诊断没有复现崩溃，不据此声明没有风险。

升级后平台 gzip 产物曾为 184,337 字节，比原 184,320 字节上限多 17 字节。将独立预览的地址/身份解析从 history-page 拆至 history-preview-page，公共包导出不变，Vite 直接入口同步；实际产物恢复 179.9 KiB、3 个首屏文件，所有原预算保持。该修正的最终增量为 11 个文件，当时源码集合由 4,547 增至 4,548。GREEN02 四文件 108 项通过，精确版本、配置、依赖、许可、产物、预算与生产审计通过；全依赖审计中原有开发依赖报告不等于生产零漏洞结论被扩大。

原始 RED/GREEN 和门禁日志在 `.codex/handoffs/m5-p4-20261022/s6-dependency-*.log`。最终差异与独立回执在 `s6/dependency-audit-20261025/review-delta03.json`、`independent-review02.json`：0 Critical / 0 Important / 0 Minor，结论仅允许进入完整复验。

### full09：桌面事件后中断，不接受

full09 为 `s6/s6-gates/full09-20261025T130043297263Z`，受测输入为 4,548 个路径。桌面守护在 2026-10-25 21:42:34（Asia/Shanghai）记录 WindowServer 的 IOSurface 创建失败并请求 SIGINT；命令日志随后记录 WindowServer event port death、正在执行的 WebKit 用例中断，以及测试库连接拒绝。停止请求约 3 秒后，三个浏览器的 Cookie restore 前置检查各报 `ECONNREFUSED 127.0.0.1:53522`。

最终 JSON 为 expected 1,677、skipped 757、unexpected 3、flaky 0；命令日志另有 1 项 interrupted。未执行项不能记为允许的基线跳过，不把这些数字拼成完整通过。run.json 记录 interrupted、退出码 -2、原进程组已退出、源码前后无变化、安装 SDK 无变化。守护原 status 仍停留在 stopping，是当时原件，不覆盖最终 run.json 的终态。以上证明事件顺序与中断事实，不证明测试引发桌面故障的根因，也不把受中断影响的业务路径写成通过。原始日志、JSON/HTML 与失败材料保留；后续旧 profile 精简另有逐项退役回执。

### 测试资源治理与新的冻结输入

用户在 2026-10-26 要求暂停重型验收并实际清理残留；机制以中文提交 `a3c4edb0` 落在唯一 P4 分支，原 S6 产品变更保留。已删除六份结束实验的合成 VM 磁盘，精简 2,291 个明确通过用例的 profile；15 个失败/未完成/归属未确认的旧 profile，以及全部 OPFS 证明、源码、报告和旧索引保留。两次删除步骤紧邻观测的可用空间净增合计约 59.18 GB，不把整段约 103 GB 的变化都归因于本次清理。

每轮资源由 UUID、创建前登记、运行锁、进程组/内核身份和句柄核对管理；成功结束释放临时环境，失败完整 profile 限 7 天、256 MiB/轮、2 GiB 总量，便携诊断限 4 MiB/文件、16 MiB/用例、64 MiB/轮。普通报告及新登记 handoff 大输出各有 14 天/5 GiB 策略，未知和活动资料不自动认领，正式接受的必要证据显式 pin。原 JSON/HTML 路径、trace、截图及 OPFS manifest/files/cleanup 保持；CI 接续发布缺少完整证明时只能给有上限且明确 diagnostic-only 的快照，不能作为验收成功。

小型验证为 Python 31 项、相关 TypeScript 9 文件 118 项、相关三个工程类型检查和限定 lint；只读 Playwright 列举为 7 projects、126 顶层 suites、0 目录错误。最终 40 项输入的独立审查无 C/I/M，但不替代完整验收。详见 [治理报告](P4-S6-测试残留清理报告.md)、[治理计划](../plans/P4-S6-测试残留治理.md) 和主目录 `.codex/handoffs/test-residue-cleanup-20261026/independent-review-final.json`。

用户在 2026-10-27 明确恢复 P4 收尾，重型检查串行、结束及时清理。full10 与 full11 在 `a3c4edb0` 加原 S6 未提交内容上冻结相同 4,559 个源码路径，source-before.json 的 SHA-256 均为 `23d600fb1de9cdf86d52b9dae9cc3f576b6dad588ac631b62a1fca12ec6ee99b`。旧输入计数不能直接沿用；外部推送/关闭脚本四处计数已精确绑定为 4,559，前后摘要在 `s6/resume-20261027/source-count-binding.json`。

### 外部归档、签署和关闭工具复核

外部包装器现在持有报告发布锁与该轮运行锁检查并转存报告，拒绝链接父/叶路径、错误 run.json/归属和已有目标；先转存再 sweep。归档在 retention 锁与原 bundle lease 内 seal→原始审计→资源核验→pin，然后才释放并按保留策略清扫，避免成功原件在审查前被限额策略回收。full10 当时已启动旧包装器，因此使用冻结的 runtime 副本及外部守护；后续包装器内置这套衔接。该调整未写入活动受测源码。

签署必须核验精确 bundle 的 accepted=true、该轮 runId/终态/清理与原件未被回收证明及真实 pin；status、resources、pin、raw audit 的摘要进入 gate proof，后续签署与关闭重核。原始测试退出成功不能覆盖归档或资源审计失败，等待、失败和串轮材料均不得接受。关闭时只允许经 sweep、锁、精确白名单和单文件 32 MiB/总量 128 MiB 核对的小型 .test-resources 台账冻结；活动、未知、cleanup-pending、失败原 profile、scratch、短 VM 根或外部句柄未解决时停止。worktree 移除后的 finalize 使用外部 helper 与已冻结摘要。

独立回执 `s6/resume-20261027/independent-review.json` 逐文件记录 19 份外部工具及三个未变生命周期依赖，结论 0 C / 0 I / 0 M，可用于满足原验收条件后的收尾。已记录的轻型验证为归档 4 项、转存 9 项、归档接受 8 项、资源关闭 6 项及 -O 明确拒绝；审查者未重复运行重型检查。工具可用不等于某一轮门禁已接受或 P4 已关闭。

### full10：两条 Chrome 失败与网络事件

full10 原件为 `s6/s6-gates/full10-20261027T101851975465Z`。单元/集成 703 文件、16,907 项通过；浏览器最终 JSON 为 expected 1,589、skipped 846、unexpected 2、flaky 0。该轮有序 SIGINT 中断，退出码 -2，源码和安装 SDK 前后未变，不接受；skipped 中包含未执行项，不按允许跳过验收。

configd 的七条原始事件显示：18:47:43.204 en0 link inactive，18:47:43.431 WiFi unavailable，18:47:43.444 IPv4/DNS/Proxy 移除；18:47:44.663 仅为链路 active，IPv4/DNS/Proxy 重新登记在18:47:47.981。两例落在同一窗口，但证据强度不同：

- 真实冲突 case125：页面已显示“当前无法连接服务器，本机修改仍保留”，网络记录中的请求均成功，编辑状态 GET 200、revision=2。源码允许 navigator/offline 信号使共享 connection.available=false，直接进入保守保留分支；localhost 成功请求在 browserOnline=false 时也不会恢复 available。因此浏览器离线信号是高可信推断，trace 未直接采样 navigator.onLine 或分支命中，不能声称本例查询报了网络错误，也不能由 HTTP 200 完全排除客户端解析异常。后续副本、原文与本机草稿断言未完成。
- no-locks case143：13 个 JS 模块请求直接记录 `net::ERR_NETWORK_CHANGED`，探针未加载，失败发生在业务断言之前；afterEach 的探针缺失是后续表现。脚本加载受网络变化中断有直接证据，底层链路变化原因仍未定位。

独立归因与证据摘要在 `s6/resume-20261027/full10-failure-review.json`，系统事件在同目录 `full10-network-events.json`；没有把任一失败豁免为通过。该轮资源 runId 为 `5e1b5af2-f2b7-4196-900d-1ee49110a485`，cleanup complete，135 个 profile 已精简，保留原 profile 37,060 字节、便携诊断 972 字节，sweep 的 active/recovered/unknown/pruned 均为空。清理成功只证明资源终态，不改变本轮验收失败。

### full11：本机完整 verify 已通过并接受（2026-10-27）

full11（`s6/s6-gates/full11-20261027T105722729822Z`）于 2026-10-27 21:34:39（Asia/Shanghai）完成默认 `pnpm verify --ci`，命令退出 0、原进程组退出，未中断。lint、类型、静态、测试/覆盖率、构建、产物/原预算、完整 E2E 和生产依赖审计全部通过：703 文件、16,907 项单元/集成；总行覆盖率93.97%、语句93.91%、函数94.63%、分支90.33%。平台首屏仍为179.9 KiB/180 KiB、3文件；全依赖报告中的既有开发依赖漏洞未被改写为零漏洞。

原 JSON/HTML 共2,437个精确案例：2,421通过、16个与已接受P3基线身份及理由一致的平台跳过，零失败、偶发失败、重试和未登记缺项。Chromium/Chrome各786通过；WebKit783通过、3跳过；三个crash项目分别20/20/19通过和4/4/5跳过；restart7通过。59份crash附件共168轮，记录891个已归属并终止的进程，无幸存者、缺失角色或工具问题，late为0。

独立只读复核重算11,508个归档条目的摘要（141,509,358字节）；4,559路径的前后源码清单逐字节相同，冻结原件、当前worktree字节和链接/执行模式均对应。16个固定SDK补丁包的前后清单相同，30份实际安装文件及补丁摘要一致。JSON/HTML案例、原16跳过理由和27条已登记新增案例逐项核对。944份OPFS归档内840文件、183,796字节及全部cleanup证明重新核对通过。

本轮e2e与integration两个受管run均passed/cleanup complete、退出0；scratch与失败原资料目录不存在。1,112个profile均完成精简，只留登记元数据及适用的OPFS证明，保留raw与便携诊断均为0，sweep的active/recovered/unknown/pruned均为空。只读进程查询确认该轮已登记PID/进程组不再存在。桌面守护完成、退出0，WindowServer前后均为989，无停止请求，相关日志无IOSurface失败事件。结束时两次磁盘采样约117.6GB可用；这是当时余量，不是清理净释放量或当前余量保证。

`full11-audit.json`、`archive-review/full11/status.json`、`resources.json`与实际`.test-archive.json`的bundle、归档owner、资源runId和理由一致，accepted=true且状态pinned。独立回执在`s6/resume-20261027/full11-independent-acceptance.json`，为0 C/I/M；它确认full11可以作为P4本机verify证据。full11本身只证明本机verify；生产容器的独立结果见下一节，同SHA CI、最终冻结/清理或整个P4关闭仍待完成。full09/full10继续保留不接受状态。

### container01：同源码完整生产容器已通过并接受（2026-10-27）

container01（`s6/s6-gates/container01-20261027T133551673862Z`）在full11结束后串行运行完整`pnpm test:e2e:container`，于21:45:09（Asia/Shanghai）完成，退出0、原进程组退出。339/339首次通过，零跳过、失败、重试和偶发失败；JSON/HTML与完整目录一致，包含328条Chromium、4条公开崩溃恢复和7条restart案例。4份crash附件对应4轮实际进程突停、16个已归属终止进程，无幸存者、缺失角色或工具问题。

独立复核重算4,613个原件摘要（71,962,016字节），原始附件与日志再次证明linux-arm64原生图片材料、非root私有可写且分离的资源卷、图片保存重启后读取、44个图片格式/边界样本、并发准入5成功/5忙及18个正文拒绝请求。缺主密钥与错误主密钥两项实际拒绝启动；GC私有卷回执确认缺备份声明暂停、3种危险配置拒绝、对象退休、零字节标记、新代次隔离、重放不重复释放配额及重新上传可读。四份容器服务日志保留并核对清理路径无失败；原命令的退出0包含容器编排清理结果。

原附件记录的最大memoryPeak为784,785,408字节，memoryMax仍为4,294,967,296字节（4 GiB），所有采样oom/oomKill均0。这是整容器水位，不能解释为单次上传独占峰值；原内存预算未放宽。该轮只有Chromium项目，不凭它声称取得WebKit的OPFS归档；full11的944份OPFS实证仍是独立保留的本机证明。

受管container run `3f05bc9e-13e4-4d1b-b82a-09da6eed1a9a`为passed/cleanup complete，8个profile已精简，raw和便携诊断0字节，无scratch/失败原资料或活动进程组；sweep各项为空，桌面守护正常完成。原始审计、资源证明、accepted状态与实际pin精确绑定。独立回执为`s6/resume-20261027/container01-independent-acceptance.json`，0 C/I/M；结束时磁盘采样约113.5GB，是当时余量。

只读`reviewed_gate_inputs.prove_inputs`再次核对两轮全部原件与接受证明：同一HEAD、相同4,559路径字节、16个SDK补丁包，间轮变化为空。S6计划Task 3的四项据此完成；Task 4尚待文档落回和最终源码等价审查、中文提交/no-ff main、同SHA CI、冻结与实际清理，不提前关闭P4。

### 本机门禁后的残留收口

`s6/resume-20261027/full10-profile-retirement.json`记录在该轮run/gc锁、进程组已退出且无句柄后，退役full10中断时刚启动的WebKit统计缓存等6文件、共37,060字节。此前“保留37,060字节”是当时清理回执，保持历史记录；独立只读复核确认目标现已不存在，原full10失败Chrome trace/日志、972字节便携诊断及归因回执所列原件摘要均仍一致。此退役不改变full10不接受的结论。

`local-gates-resource-ledger.json`为实际关闭守卫的预检结果：5个终态run、1,516,030字节小型台账，failuresEmpty、scratchAbsent、strictMetadataOnly均true，sweep各项为空；独立只读清单/字节核对一致。它只证明此时资源台账符合收尾条件，不表示最终证据冻结、worktree/分支移除或关闭回执已经完成。

### 初次合并及 pre-push 配置探针修复（2026-10-27）

两轮门禁后，13份已有文档按实际结果更新并完成独立复核（0 C/I/M）。S6 正常中文提交为 `e49ee5f15f694688d247cec33b8e656b6a3bf797`；主目录始终为 main，正常 no-ff 合并为 `73c199f0b0edc3644beec6ac04c9ddee2b4a745a`，父节点为原 main `3f498f7b` 与 S6 提交。初次来源证明 `s6/source-equivalence-73c199f0b0ed/receipt.json` 核对4,559路径：4,546逐字节不变、13份文档变化；它仅对应这次初始合并，不自动覆盖后续修复。

首次正常推送的 pre-push 在 lint/typecheck 通过后，被 `playwright-projects.test.ts` 的3项 unit 阻止：565文件中564通过、1失败，11,294项通过、3失败。推送未发生，原日志保存在 `s6/main-push01/output.log`。该 fixture 导入 Playwright 配置时未显式选择只读列举；完整 coverage 外层有受管运行器注入的三项 `NERVE_TEST_*`，掩盖了隐式依赖，独立 `pnpm test` 因缺少这些变量被真实资源守卫正确拒绝。

修复仅在该 fixture 的 Node 子进程显式传入 `-- --list`，并在展开外层环境后清除三项受管变量；产品、Playwright 配置、守卫和全部项目/依赖/匹配/worker/timeout断言逐字节不变。先只清变量的 RED 精确变体得到3项预期失败；完整修复在外层故意污染的变量下3/3通过，守卫8/8通过。经资源运行器管理 TMP/进程、再由 `env -u` 清除三个变量的完整 unit 为565文件、11,297项通过；限定 lint 与 E2E typecheck 均通过。四轮受管 run 均已完成清理且无 scratch。

精确源码、命令、原始日志、回执和独立审查在 `s6/unit-config-probe-fix/`。before SHA-256为 `e74fd8c60ab5edf638a54310b0f205f32d9eebd6aea8b32928ba59e084b13b13`，after为 `77b90a88d133ca901d6275932ec88c141d1f8616820a92b7af6d5b255c569368`；独立回执 `independent-fixture-review.json` 为0 C/I/M，只接受此精确fixture增量。full11/container01仍证明原受测基线，最终来源证明必须明确列出13份文档及这1份测试变化，保持总路径4,559；不能称最终仅文档变化。正常 pre-push 与最终同SHA六项CI仍须通过。

修复留在同一 P4 分支，用新的正常提交和 no-ff 合并接续；不重写已产生的 main 历史，不另开修复分支，也不跳过钩子。旧合并、失败推送与原来源证明保留。全部最终验收和清理条件成立前不关闭 P4、不建立 P5。

### 本稿仍待补入的事实

- 修复提交及再次正常合并后的4,559路径来源证明：精确核对13份文档和1份测试fixture增量，其他源码/配置/SDK不变；随后正常推送与最终六项同SHA CI原件核对。
- 独立收尾复核、最终冻结、唯一分支/worktree 实际清理及外部关闭回执。Task 3四项已按两轮实证完成；Task 4与P4最终完成项待实际操作，不预勾。

Excel、Safari/Finder、DEF-004、M4 DEF-073/UR-035、完整 M4 验收及标签继续挂账；M7 联合备份/PITR、升级转换和回滚演练未被 P4 替代。P4 实际关闭后才从 main 建立唯一 P5 worktree 并即时设计客户端 CSV；P5/P6 未实现，不提前关闭 M5。

## 2026-10-28：正常推送完成，Linux CI 失败后的同分支修复

`d161a629` 已在本地正常 no-ff 合并为 `1277dcb9e3bb746918c00feb41bcb54f1e407284`，正常 pre-push 与推送成功。Lefthook 成功时只输出摘要，最初外部回执包装因此误判缺少详细检查输出；保留原推送日志并按原摘要、退出码、Git 事实补全回执，没有重推、跳过钩子或改写历史。证据位于 `s6/main-push02/normal-push-receipt.json` 与 `s6/source-equivalence-1277dcb9e3bb/receipt.json`。

CI 40525146257 的六份原日志和四份监督快照保存在 `s6/ci-early/40525146257/`。最终仅生产容器 job 成功，其余五项失败：

- Chrome/Edge 日志明确报 SingletonSocket 路径过长；原 TMPDIR 为 111 字节，最终 socket 路径 152/153 字节。监督器缺少 result 的异常仍缺原始操作信息，不能把后来发现的合法 t 状态解析缺陷直接认定为唯一原因。
- verify 为 16,906 项通过、1 失败，失败发生在 SIGKILL 测试的持锁前置等待；首批持久性断言及 SIGKILL 尚未执行，没有证据说明产品丢失检查点。
- Chromium 为 813 通过、4 原平台跳过；WebKit 为 802 通过、8 原平台跳过，两者均无重试且未触发原运行时限。监督记录确认进程退出，随后 lsof 核对失败，完整报告归档/上传未执行。因此两项仍失败，不能用终端通过数代替完整验收。

当前修改和红绿证据在 `s6/ci-resource-path-fix/`。Python 57 项通过，包含成功/失败/中断、身份替换、活动句柄、短别名、预检失败不启动命令及安全重复回收；最后预检增量另有独立复核。监督相关 TypeScript 70 项通过，固定格式诊断不记录任意异常正文，未知错误仍失败关闭；Linux `t` 只增补为合法且存活的状态。检查点最终版本 19/19 通过，源码前后一致，测试 API 连接 0、scratch/短根均消失；沿用项目已有 10 秒精确锁等待预算，替代原 SIGKILL 夹具隐式 1 秒 poll，原 API 产品时限、批次计数与两种终止语义保持。

本机 Linux branded 浏览器探针只到安装阶段，没有取得浏览器红绿结果；相应容器与缓存已删除，共享 Virtualization VM 仍持有约 345 MB 已删除文件的只读句柄，已登记 cleanup-pending。其他项目的容器正在运行，不重启共享 Docker、不把该空间计为已释放。轻型 Linux 进程契约的首轮在只读根上的 Docker archive 复制阶段停止，测试未执行，该轮容器和临时目录已清理。所有此类未完成结果如实保留，不代替 CI。

lsof 原错误未被旧实现保存。目前补充最多 4 KiB 标准错误、退出码和超时诊断，并在启动子命令前检查清理能力；仍不忽略警告。实际 Linux 原因、当前输入完整门禁及新同 SHA CI 都需要后续证据。冻结、worktree/分支清理和 P5 尚未发生。

轻型 Linux 进程契约的第二轮通过：沿用相同输入与资源限制，改由同 UID 的 `docker exec -i tar` 向既有 `/tmp` tmpfs 写入源码，避免 Docker archive API 对只读根的拒绝；只读根、禁用网络、无宿主挂载、32 MiB tmpfs、1 CPU/512 MiB、90 秒外层限制均保持。原生 arm64 Node 24.21 的 12/12 契约通过，无跳过/失败，前后源码与包字节一致，容器已删除且本轮受管清理完成。它覆盖进程监督协议，不覆盖 branded 浏览器或未知 lsof 原因。回执为 `s6/ci-resource-path-fix/linux-process-contract/receipt-92fca34e-5ef4-4e9e-a545-41c402ba60bb.json`。

最终四文件检查点独立审查为 0 C/I/M，精确绑定 r2 的 19 项回归、静态检查和清理回执；受控慢启动 RED 的旧 preload 为顶层 await，有限延迟语义已核对。该复现说明夹具对启动时序的脆弱性，仍不宣称已证明历史 CI 当时的所有根因。独立回执为 `s6/ci-resource-path-fix/checkpoint-independent-review.json`。


### lsof 查询完整性复核（仍未开始 full12/container02）

`e78d1fa1` 已正常提交短路径、进程监督与检查点同步修复；主目录/远端仍为 main@1277dcb9。后续 lsof 增量已阶段提交为 `903d0849`。实际小型 Linux 对照证实：普通用户会缺其他 UID 的 fd；隔离容器中的 root 也不自动拥有跨 UID 查询能力。带唯一 SYS_PTRACE 能力的独立、无宿主挂载容器可看到两 UID 自制文件/socket；该证明不覆盖宿主机其他 mount/net namespace，不能直接等价于 GitHub 托管主机。

真实 `-F pfnt` 的进一步回放揭示 `anon_inode:[io_uring] (stat: No such file or directory)` 假阳性。已知自有 PID 的直接 stat 同样 ENOENT；内核 `anon_inode_create_getfile("[io_uring]", ...)` 和 lsof4.95 的 `mem`/`S_IFREG` 回退与原件相符。修复只接受 Linux、mem、REG 与完整精确匿名名称/错误组合；其他 stat 错误继续拒绝。独立审查同时发现仅返回 `protocol: UNIX` 的未解析 socket、path inode/dev 不一致注解曾被遗漏，现同组拒绝，不因路径看似在本轮目录外就当作完整。

r2 的 RED 为6个方法中的8个预期断言失败、0 errors；目标23/23与全套76/76通过。三轮均已清理 scratch 和短根，7份源码前后指纹一致。原件索引为 `s6/ci-resource-path-fix/lsof-query-fix-r2/delivery.json`（SHA-256 `1d6ea9c6060969b29c453fa791457ff1b75b45cc494c19315e0bf72e66cd3b58`）。随后真实 Linux 全流回放已执行：io_uring 误拒消失，两 UID 自制文件/socket 活动时可见、关闭后均消失，但 root 输出仍含 PID 1 的一条 mem 映射身份冲突，整体退出1，未被接受。该条未保存具体路径/值，不猜测其底层原因、不加入豁免。原件 `linux-lsof-capability/receipt-891759f1-d73f-47a0-b035-ae5c3ead4af5.json` 的 SHA-256 为 `cfb4d65ffa21699c86c376d7ddedd7e2797601962f6e2b7232e792d03e014f14`；6.75秒结束、容器删除且受管 cleanupStage=complete，前后解析器和协议源码一致。不得将这些局部正例改写成全流或 CI 成功。

另已确认设计约束：lsof4.95 的 maps stat 使用调用者路径视图，socket 表只取调用者 `/proc/net/`，因此 sudo 本身不能消除其他 namespace 的歧义。CI 的独立 PostgreSQL 服务可能因此触发保守阻断。尚在收敛对已登记隔离服务的可达性证明，未加入任意 PID/容器豁免。原五项失败、新完整门禁、新同 SHA CI、最终关闭继续待验；未启动 full12/container02 或 P5。

新版外部来源/推送/关闭工具已独立审查，34项轻型契约与真实小 Git/blob/模式样本通过，0 C/I/M；12轮实现样例与2轮独立样例清理完成。工具审查回执在 `s6/p4-round-v2-tests/independent-review.json`。真实门禁前必须在 clean 的固定提交上分别采集 capture-before，结束后 capture-after；没有预签真实结果、binding、推送或关闭回执。


### 固定 CI 服务的查询 scope 与跨 namespace 证据（局部回归完成）

全局 lsof 不可见记录仍默认拒绝。新增 scope 只接受当前固定 GitHub 托管 Ubuntu job 的 PostgreSQL 服务 ID，在本轮 scratch/短根/报告根创建前登记服务 epoch，并核对固定镜像、runc、无宿主挂载/额外能力的独立桥接网络及匿名本地卷。查询前后核对 PID/starttime/cgroup/mount、net、pid namespace；未知 PID、身份变化或不完整查询不能据此豁免。真实文件和 socket 路径依旧遍历完整输出并阻止清理，不排除整个服务 PID。旧台账、无 owner、任意目录与 archive 保持严格；普通本机不会自动提权。

初版完整 Python 回归为 104/104，run `dbe736e8-627f-4b31-8353-fb4e64bdf3f6`，58.012 秒、退出0，10份来源前后相同，scratch/短根已清理。原件在 `s6/ci-resource-path-fix/ci-service-scope/`。独立审查随后复现：run.json 若被换成符号链接，旧 prune 可能先删除报告再由写回拒绝；当前补齐读取普通文件、拒绝父/叶链接及 FIFO、无 scope 运行的相同保护，并收紧固定 Runtime。原104项通过不能代替这些修复后的最终回归。

真实格式对照前两次止于探针自身的包选择/重复记录断言，失败原件保留且资源清理。第三次 `707690f3-a386-43c7-a4c1-24b8b1727576` 用时5.20秒、退出0。same/cross 四次观察的服务 PID、starttime、四个 FD/inode 完全一致；共享该自有服务的私有 PID namespace，mount/net namespace 不同。same 中的 UNIX 路径、IPv4 TCP/UDP 地址，在 cross 中分别成为精确 `sock` / `protocol: UNIX-STREAM`、`protocol: TCP`、`protocol: UDP`，普通文件真实路径保持；另有 mem/REG 的 path dev 注解。各控制记录重复7次且内容一致，原始自有 PID 块完整保留；未保存全局输出。查询容器只有 SYS_PTRACE，未访问宿主或其他项目的 PID namespace。两容器均按完整 ID 及归属删除、名称复核不存在，受管清理 complete 且 scratch 缺失。累计锁定的 deb 输入7,725,666字节，未创建浏览器、数据库或 VM。

实际回执为 `s6/ci-resource-path-fix/linux-lsof-namespace-format/.test-resources/runs/707690f3-a386-43c7-a4c1-24b8b1727576/reports/test-results/namespace-format-receipt.json`，SHA-256 `ebe3b4b98a2d055da0766bb2d5dc45794e5ff671b52222f335d291331b81da9d`。该原件只证明受控 Linux 格式，不是 GitHub Ubuntu 或整个 CI 通过。旧 CI 五份 PG 日志均记录 IPv6 监听；额外 `TCPv6` / `UDPv6` 由固定版本官方 Linux 协议名、sockfs xattr 到 lsof4.95 fallback 的完整源码链推导，未在该探针实测。不把源码推导称为实际 CI 通过，也不泛化为任意 protocol 前缀。

最终修复为固定六个 protocol 完整名称，仍限定已验证服务的数字 FD/sock 记录；台账授权前统一核对租约、父/叶路径和普通文件，包括无 service scope 的本机运行。实际707690原块回放中，same 的严格/带scope不完整数为0/0，cross为70/0；真实文件路径仍命中，额外未知NOFD仍拒绝。这是该自有PID块的回放，不是全局输出或CI验收。

最终 Python 为112/112（原76加新增36），0失败/错误/跳过，58.230秒；run `d95978a4-70c9-4cb0-a8ad-d221875e4c18` 位于 `ci-service-scope/review-fix/`，validation SHA-256 `44f4063a97cd70469de62d99db504e70c826dc8151a1501864341e1765d380d5`，10份来源前后一致、passed/cleanup complete、scratch/短根不存在。外部v2原34项兼容回归亦通过，run `8e835f7c-fddc-400d-b07a-3e3212adc1fd`，四份传递依赖前后相同，清理complete；补充回执 `s6/p4-round-v2-tests/review-service-scope-dependency.json` 的SHA-256为 `0fea0f64bd8fe6bee86fe8dd8c70418fe8f30c01a0805eca0f53166f76ad792e`。旧工具、旧原件和失败记录未覆盖。

局部独立审查已完成，0 C/I/M，回执为 `s6/ci-resource-path-fix/ci-service-scope/independent-review.json`（SHA-256 `b6cdd4c9f8defd5b13d17fa1c0dd2a129e9b65788124182f982542a64b2db5a9`）。两项台账/runtime发现及 namespace 格式缺口已在本次明确契约内闭环；允许正常提交和启动原范围完整门禁，不凭此单独合并或关闭 P4。后续为同一源码串行采集 full12/container02，再正常合并、推送、验收新同 SHA CI。实际 Ubuntu 部署与 P4/P5 状态仍待后续结果。


## 2026-10-28：修复提交 9abf02d2 与 full12 独立接受

修复已正常提交为 `9abf02d2c4a4d1b513cf7089e69ecdab29b34d0b`，本轮 full12 在该 clean 提交上执行。原输入 full11/container01、第一次本地合并、`1277dcb9` 正常推送与 CI 40525146257 的失败分别保留；本轮结果不倒改旧失败，也不等于新的 main 已合并或推送。

完整原件为 `s6/s6-gates/full12-20261027T185921612084Z`。本轮默认完整 verify 的十个阶段均通过，退出 0：704 文件、16,935 项单元/集成；E2E 2,421 通过、16 个原平台跳过，重试、flaky 和未运行均为 0。项目身份分别为 Chromium 786、Chrome 786、WebKit 783 通过/3 跳过，三组 crash 为 20/4、20/4、19/5，restart 7 通过。覆盖率为 lines 93.92%、statements 93.84%、functions 94.53%、branches 90.31%；产物预算与生产依赖审计沿原门禁通过，不等于全部开发依赖零漏洞。

4,566 个来源前后逐项相同，两个 source manifest 的 SHA-256 均为 `566bf27777057b39a941faad3f1da725f1e49a2252f14212b56a25074fbe1b31`；16 个已安装 SDK 包的前后清单相同。v2 来源回执 `s6/full12-source-before-v2.json`、`s6/full12-source-after-v2.json` 已实际生成并核对先后顺序。独立复核串行读取全部 11,518 个原件、共 141,980,272 字节，JSON/HTML 案例一致；59 份 crash 附件覆盖 168 轮及 891 个本轮进程，迟到进程为 0。944 份 OPFS 归档包含 842 个文件、158,918 字节；其余 168 个 profile 按原件不含该归档，没有虚报为缺失。

full12 的 integration/E2E 两个受管 run 均为 passed/cleanup complete，本轮 scratch/短根回收已核验；共精简 1,112 个 profile，保留原始 profile 和便携诊断均为 0，必要报告及 OPFS 原件保留。归档 accepted=true 且已真实 pin，sweep 四组均为空。资源回执为 `s6/archive-review/full12/resources.json`，SHA-256 `4390cc1f9a96619c639ecdf1165a4717adce56d3bb5c0e2915072a63ebcfab09`；接受状态为同目录 `status.json`，SHA-256 `1da24cf78d4ee05857e1a41de0d7842e9787369c657c9abde25d48ec0394a991`。本轮守护共 319 次采样，最小可用磁盘 94,728,241,152 字节、结束观测 110,518,538,240 字节；这些是采样时的余量，不是净释放量，也不代表共享 Docker 既有句柄已回收。

原始审计 `s6/full12-audit.json` 的 SHA-256 为 `a4b0fd719c61dec9794fa5e2bf9db7d5f4f24ba829d34ee3adba095ca596a1b3`。独立回执 `s6/resume-20261028/full12-independent-review.json` 为 0 C/I/M、接受本轮本机完整 verify，SHA-256 `75be71b91e6c56baeab3394c38ddb44ed8af84113a444996bd8b4b895a97c94c`。本机 serviceScope 为 null；本轮并未验收实际 GitHub Ubuntu PostgreSQL namespace scope。

## 2026-10-28：同源 container02 独立接受与本轮 Task 3 完成

container02 在同一 clean `9abf02d2` 上串行完成，原件目录为 `s6/s6-gates/container02-20261027T214901112459Z`，命令退出 0。339 项首次通过：Chromium 普通 328、crash 4、restart 7；失败、跳过、重试、flaky 和未运行均为 0。JSON/HTML 身份及正文证据一致；4 份 crash 附件覆盖 4 轮及 16 个归属进程，迟到进程为 0。独立复核重算全部 4,620 个原件、共 72,447,364 字节，与保存审计一致。

原生材料为 linux-arm64。图片矩阵、正文拒绝后恢复、私有卷和资源 GC 的原断言通过，缺备份时暂停删除、配置拒绝、重复回放不再次释放配额及重传后可读均核对。附件的 8 个整容器 cgroup 样本中，最大 memoryPeak 为 763,281,408 字节，memoryMax 均为 4,294,967,296 字节（4 GiB），oom/oomKill 均为 0；该峰值不解释成单次上传专用内存，也不放宽原预算。

受管 run `3a9c88dd-9b91-4c16-aff3-ffdd2dfa1026` 为 passed/cleanup complete，发布完成；8 个 profile 已精简，保留原始 profile 和便携诊断均为 0，scratch、短根、失败资料及登记进程组均不存在。精确 Compose 项目 label 与本轮镜像 reference 的只读查询确认本轮容器、网络、卷和镜像 tag 已清理；不涉及共享 Docker 的既有待回收句柄。本轮 OPFS 归档为 0，full12 的 OPFS 原件独立保留。归档 accepted=true 且已实际 pin；资源回执 `s6/archive-review/container02/resources.json` 的 SHA-256 为 `31f622c1df376f2c22773e3919e2bf5020b6104b4de8fc90394cac034ad76be3`，同目录 `status.json` 为 `f6b8c20d490c66c61b3fd8090c2a216f6ef8a09f90a23383b489c5d795418781`。

两轮四份 v2 capture 已生成并核对时间顺序、clean HEAD、4,566 个路径的字节/类型/模式/链接目标及 16 包 30 个已安装 SDK 文件；两轮完全同源，新增的 container02 回执为 `s6/container02-source-before-v2.json` 与 `s6/container02-source-after-v2.json`。原始审计 `s6/container02-audit.json` 的 SHA-256 为 `9600fa8e0fb57af659c98abba7858542d974f999ca54863d3a572ddb5c3fa7cf`；独立回执 `s6/resume-20261028/container02-independent-review.json` 为 0 C/I/M，SHA-256 `26b627628cc741d150a0224538f4ab1b80c4690de5c20d85e71981f9ce62a781`。

本轮 Task 3 的两套原范围本机门禁、原件/资源审计和独立接受已完成，结论绑定受测 `9abf02d2`。文档更新至最终合并 SHA 的精确等价证明、正常 no-ff/推送与 pre-push、新同 SHA 六项 CI 仍须实际完成；本轮未验收 GitHub Ubuntu/linux-amd64 的真实部署或固定 PostgreSQL service scope。最终证据冻结、唯一 P4 worktree/分支清理与关闭只由操作后外部回执确认，不预填已删除。DEF-061、ADR-023 的阶段关闭状态与全部既有环境债保持，不开始 P5 设计。

## 2026-10-28：第二次实际 Linux CI 的失败与诊断检查点

本机 full12/container02 的独立接受与 `cd2ee5f8` 的正常合并、推送均已成立，但不能据此关闭 P4。该 SHA 的 [CI 40593800515](https://github.com/open-nerve/NerveOffice/actions/runs/40593800515) 最终 **0 成功、6 失败**。六份 job 日志与四份小型监督原件位于主目录 `.codex/handoffs/m5-p4-20261022/s6/ci-early/40593800515/`，最后收集回执为 `failure-collection-20261027T223027Z.json`，并非完整测试报告验收。

| 任务 | 实际停止位置 | 可确认与不可确认 |
|---|---|---|
| verify 与四个浏览器分片 | `container-inspect` 固定查询返回 1 | 五项均尚未通过资源检查；verify 的 lint/typecheck/static/build/artifact/audit 等仍通过，tests 阶段失败。远端未保存 Docker stderr，不能把本机错误正文当远端原件。 |
| container | `run.py` 启动受管子命令前的 `assert_quiescent` | 全局 lsof 返回 0、stderr 空，但解析器拒绝 18 条记录（16 条样本截断），生产容器 CLI/Compose/E2E 尚未启动。日志只有 pid/fd/reason/operation，缺 type/name 与原查询进程身份，不能认定所有记录与本轮目录无关。 |

真实只读 Docker 28.1.1/API 1.49 对照在同一既有容器上复现原模板失败：`.Id` 触发 typed struct 失败后的 raw JSON 回退，随后 `HostConfig.Mounts/Tmpfs` 的省略空字段导致模板错误。仅在内存改 `ID` 后完整模板成功；正式两字段修正后，当前模块真实执行 9 条查询，container/network/volume 共 42 字段类型成立，3 个未知字段均被拒绝，容器身份不变。此处参考 [Docker CLI 的 typed/raw 执行链](https://github.com/docker/cli/blob/v28.1.1/cli/command/inspect/inspector.go#L104)。之前 112 项的 dict mock 没有执行 Go 模板，不能覆盖这个接口错误；新的永久 CI 预检将直接执行实际服务证明。

服务诊断及 RED/GREEN/源码与资源回执保存在 `s6/ci-resource-path-fix/ci-40593800515-service-diagnosis/`；两个实际只读探针的 scratch、短根和进程组均已回收。container 的只读归因保存在相邻 `ci-40593800515-container-diagnosis/diagnosis.json`。不完整全流在目标路径筛选之前阻止查询，是当前实现与全宿主状态耦合的事实；尚无证据支持新的 PID/协议例外。

下一步只做计划已登记的诊断检查点：模板局部修正、有界异常摘要、安装前的小型预检与无需 pnpm 的始终输出回执；保持失败保留、当前删除保护和六项最终门禁。诊断性合并/推送只用于取得托管 Linux 原因，不构成 P4 验收；旧 v2 的 parentMain/full12/container02/push03 及来源签署均不改写。实际 Linux 能力成立后，最终输入仍须完成新本机完整门禁与容器门禁、最终同 SHA 六项 CI、冻结和 worktree 清理。P5 未开始。

诊断检查点轻型校验已完成：最终同一输入的 Python 资源管理回归 **151/151**（59.019 秒），CI 接线回归 **12/12**（2.73 秒），修改的 YAML/TypeScript 按正常提交钩子的 ESLint 规则通过。13 份相关源码/测试/工作流的前后 SHA 完全一致；两轮受管 scratch、短根和进程组均已消失。回执为 `s6/ci-resource-path-fix/ci-40593800515-checkpoint/validation.json`（SHA-256 `c3df3d5df1f670e117126dee882adc24d99953ccc191f6bcf7917ea46c2c6795`）。独审发现的伪注解脱敏问题已以真实 RED 复现并修复，复验 27/27；回执读取器 22/22，独审无遗留 C/I/M。上述接受只覆盖诊断性提交，未运行新完整本机门禁、未取得新 CI 结果，不改变 P4 未关闭状态。


## 2026-10-28：诊断 CI 40600596503 的实测结果

诊断提交 `c576c1fe` 正常 no-ff 合 main `18892db5`，正常 pre-push 263.27 秒后推送成功；推送受管 run `912fab9d-712e-4d73-a6bd-ef2873e3c89f` 已 cleanup complete，scratch、短根和进程组均消失。回执为 `s6/ci-resource-path-fix/ci-40593800515-checkpoint/normal-push-receipt.json`，SHA-256 `f419ec725f58970c326d3991caf6ec9c894fbba8c04a7b5c16c2dc240d837686`。

新 [CI 40600596503](https://github.com/open-nerve/NerveOffice/actions/runs/40600596503) 六项全部在安装依赖前的资源预检停止；Docker 服务查询不再是首个错误。lsof 返回0、stderr为空，但每项有19–54条不能完整解释的宿主记录，样本未截断；包含 UNIX-STREAM、UDP/TCP/NETLINK/QIPCRTR 与匿名 bpf-map 映射。每项均有一条 UNIX-STREAM，不能由协议名或数字PID断定其无文件系统路径。六份状态回执为 cleanup-pending、childGroup=null、scratch/短根仍存在；没有运行产品子命令。

历史断点（方案B审批前）：六份原日志与逐任务审计已核验保存，不能用收集成功或正常推送声明CI通过。当时尚未实施方案，需要先决定持久机器与一次性托管VM的回收责任。用户随后已批准方案B，实施及本机新门禁结果见下节；原失败结论不改写。

## 2026-10-28：方案B实施与新同源双门禁

方案B实现提交为`50beb4e95ad0a019d614cae6f561916192856dc6`，正常提交钩子通过。完整资源Python回归289/289，CI相关TypeScript三文件21项、定向lint和tools类型检查通过；新外部合同15项、hosted审计器21项、v3来源与关闭工具39项通过。运输、跨模块、外部合同、hosted审计器与v3工具五份独审记录均无遗留阻断，见`s6/hosted-vm-policy/`。工具审查不是实际托管CI通过。

| 新轮 | 原范围结果 | 资源与来源 |
|---|---|---|
| `full13-20261028T120939972856Z` | 705文件、16,943项单元/集成；2,421 E2E通过、16个与旧基线身份/理由一致的平台跳过；零失败、重试或flaky | 59份崩溃附件、168轮；1,112个profile精简，仅保留必要证据；两个内层及外层临时目录实际清理 |
| `container03-20261028T144206482454Z` | 339项通过：328常规、4生产崩溃恢复、7后端重启；无跳过/重试 | 私有图片卷、GC备份水位及代次验证通过；8个profile精简，内外层临时目录实际清理 |

两轮均以50beb4e9开始，4,582源码输入和16份SDK记录前后及两轮之间一致，源码未在门禁中改变。两份`archive-review/<label>/status.json`为accepted，资源证明为本机真实cleanup complete，原件经案例/JSON/HTML/摘要/OPFS核验后pin；新四份before/after-v3回执按真实启动与结束时间采集，不覆盖旧v2证明。两轮独立接受记录分别为`hosted-vm-policy/full13-independent-acceptance.json`（SHA-256 `fa9b22a190c48ed7166f92b0c167abf58695bb5bdb22341da157cba30c44808f`）和`hosted-vm-policy/container03-independent-acceptance.json`（`7143cdc2ad1ca9de6b8990d8a083731b6ed4bf25e9fb11b430b5fcb3a47b7480`）；案例、附件与关键摘要直接复核，完整归档其余文件沿用已保存原审计，未重复运行测试。

容器为本机Linux arm64：镜像526.4 MB，应用空闲内存243.1 MiB、E2E轮询峰值409.8 MiB、结束222.1 MiB；独立核对的cgroup实际峰值732,782,592 B（约698.8 MiB），低于4 GiB上限且OOM为0，原预算保持；缺主密钥及错误格式均在1秒内退出1，四份容器日志扫描未泄露主密钥。测试编排环境已删除。两轮WindowServer身份保持989，未触发桌面保护；full13期间最低可用磁盘约87.17 GiB，清理后约102 GiB，container03收尾后约101.6 GiB。这是采样到的本机空间，不把APFS目录大小当作实际释放量。

剩余顺序：结果文档独审和中文提交→正常no-ff合main→精确文档等价及新v3绑定→正常pre-push与推送→同SHA六项CI和十份artifact的真实托管合同审计→独立关闭复核→冻结证据→实际移除唯一P4 worktree/分支→finalize。托管资源即使合格仍为host-disposal-pending、cleanupComplete=false、ciRawCleanupObserved=false，不宣称已独立观察VM销毁。P4未关闭，P5未开始，原生环境与M4挂账不变。

## 2026-10-28：790e746c 推送后预检阻断

上述结果文档、精确文档等价、正常 no-ff 合并和推送已完成。main/origin/main 为 `790e746cd1b4ab0b4c6e9d4cf8d0de55c12f1384`，正常 pre-push 292.02 秒通过；原 v3 绑定和回执保持。

随后 [CI 40713106707](https://github.com/open-nerve/NerveOffice/actions/runs/40713106707) 六项均在安装依赖前的 KiB 资源预检失败，产品子命令未启动。全局句柄列表的绝对路径在普通用户下解析别名时触发统一错误分支；日志没有实际候选路径、异常类型或 errno，不能用可能的权限原因代替实测结论。六份原日志及 hash 收据保存在 `s6/hosted-vm-policy/ci-40713106707-failure/`，详细事实和方案 B 局部修复边界见[调查](P4-S6-托管路径别名阻断调查.md)。

修复只补齐托管非破坏导出的语义未知分支；已知本轮引用、根身份、生产者及结构/命令失败仍阻断，本机严格清理保持。先完成小样例与独审，再正常诊断合并/推送核对实际托管全链。full13/container03 的旧输入接受不改写为新源码通过；P4 仍未关闭，P5 仍未开始。

## 2026-10-29：63bf7d64 诊断与活动目录计量（当时快照）

别名修复bfd31dba的55项定向和299项资源Python回归通过，独审接受后正常no-ff合main63bf7d64并推送，pre-push 291.72秒。CI40718430340六项资源预检及其回执均通过。容器随后328项常规用例通过、11项未运行，因容量采样连续目录竞态被终止；原报告保留interrupted/143，checker与artifact上传成功，job保持failure。

失败结束采样原资源41,773,490字节、空闲83,213,148,160字节；现有错误没有具体操作或目录，不能推断为磁盘满、超时或特定浏览器删除。详细原件和局部修复边界见[活动目录计量调查](P4-S6-活动目录计量阻断调查.md)。UTC 16:37后取得的verify原日志显示：705文件/16,943项中有1项真实集成失败，位于asset-references-bulk的七万资源关系INSERT SELECT unnest；其余704文件/16,942项通过，随后job达到45分钟上限而取消。原日志未保留该异常的SQLSTATE/cause，不能猜测超时、锁或数据错误。此为与容量采样分开调查的新增阻断；在根因及必要修复核实前不启动full14，也不以环境挂账放行。四浏览器仍运行。整个失败工作流不能运行要求全绿的诊断成功合同，也不签最终audit/ready。

新r04工具已完成43项小型回归与独审，但尚未冻结、full14未开始。待局部修复与本轮实际报告能力核实后，依次完整本机full14、同源容器container04、正常合并/推送、同最终SHA六项CI与十份artifact、独立关闭复核及实际worktree清理。全部最终质量门槛保持；无需为已经定位且充分取证的失败重复建立诊断环境。P4未关闭，P5未开始。


## 2026-10-29：41de69e9 诊断能力接受与 full14 实际结果

本节以已保存原件为准。正常诊断 merge 为 main `41de69e92f44dae9f51ab73d76669e53b49bf633`，Phase tip `6de31f169c56eeb661bca37996b5c34d9eb53cdf`；pre-push 294.14秒、退出0、受管清理完成。活动采样33/309、清单40/313、bulk安全诊断13及数据库日志帧134项局部验证与各自独审已完成；相关调查/修复记录保留，未改SQL、搜索契约、70,000案例规模或既有预算。

诊断 CI40742680031 六项成功，十ZIP共42,728,825字节。verify为706文件/16,968项，原70,000资源案例32,319ms通过；四浏览器3,227通过、20原跳过，container339通过。稳定导出、原件来源、压缩运输、资源核验、coverage与上传均由固定合同核对，JSON/HTML案例集合、结果/重试/错误计数一致。此为诊断能力接受，`diagnosticOnly=true`、`finalAcceptance=false`、`ciRawCleanupObserved=false`，不签最终同SHA验收或宿主原环境已销毁。历史CI的SQLSTATE/cause仍未知，新通过不反推旧原因。

旧reader与debug因额外64MiB HTML内嵌ZIP合计限额拒绝，失败原件保留。新版只对该诊断读取改为128MiB总量，同时收紧单JSON与摘要累计至16MiB，外层64MiB保持；27项KiB回归、代码独审和真实重放均成立。实际接受原件为主目录 `s6/hosted-vm-policy/diagnostic-reader-bounded-40742680031-real01/actual-independent-acceptance.json`，SHA256 `6cfc48d79afbdad8edb2007cc8faf97b249b59a3f68ee95449ba4ee31aaa9787`（本节所有`s6/`均位于主目录`.codex/handoffs/m5-p4-20261022/`）。已保存alias样本有截断，只能说明样本内的PermissionError/errno13，不能补写旧失败errno或推断全局无未知引用。

r04父提交按真实41de69e9维护，44项小回归及独审接受；14工具与7wrapper于2026-10-28 20:12:07 UTC冻结，full14 before于20:12:08采集，不补签。冻结收据 `s6/hosted-vm-policy/tools-frozen-before-full14-r04.json`，SHA256 `9931aaf372eda364247c3c9d1cfc7b3aa45a87ce903c1e6978319acfaedf5ffb`；旧v2/v3、full13/container03和候选原件保持。

full14 bundle `s6/s6-gates/full14-20261028T201220351244Z` 实际于20:12:21–22:48:35 UTC运行默认完整verify，退出0。十个既定阶段通过；706文件/16,968项单元集成、2,421 E2E通过和16既有平台跳过。4,589项源码及16份SDK前后不变；原件审计接受、报告已pin，JSON/HTML与摘要一致，168轮崩溃、944份OPFS（840文件）及1,112个profile精简均有原件记录。行/语句/函数/分支覆盖率为93.92%/93.84%/94.53%/90.31%，原预算未改。audit阶段通过不等于零漏洞：含开发依赖的总计仍为low3/moderate11/high6/critical2，按原规则报告。

full14外层 `4017d26f-e6a0-4e16-b137-e1fb8779d352`、integration `434b02ff-e8fb-4c94-bec5-8b0300b0c911`、E2E `14940838-8d7a-4860-9d4f-26fd9b2f37a5` 均passed/cleanup complete；scratch、短根、别名、owner及child process group实际消失，没有保留完整profile。既有专用PostgreSQL容器继续复用，不声称它被删除。原始资源回执为 `s6/archive-review/full14/resources.json`，实际外层核对为 `s6/hosted-vm-policy/full14-launch/completion.json`；来源after为 `s6/full14-source-after-r04.json`。**full14独立接受回执已于2026-10-28 22:55:41 UTC签发**：`s6/hosted-vm-policy/full14-independent-acceptance.json`，SHA256 `5f6f30cf14c7b2be5484fe6eb1cab7ce2a9d84d5ebdc430b5dd226ac264ff9ea`。其范围仅为该轮本机门禁，不预签后续最终CI或关闭。

container04 bundle `s6/s6-gates/container04-20261028T225617266122Z` 于22:56:18–23:04:59 UTC串行运行完整 `pnpm test:e2e:container`，退出0，339/339首次通过，零跳过/重试/flaky/全局错误。实际平台为linux-arm64，不扩写为x64；4,589项源码/形态与16份SDK在两轮前后及两轮之间完全相同。独立JSON/HTML与附件/案例审查、原件摘要、pin、原预算、部署日志和清理均接受：`s6/hosted-vm-policy/container04-independent-acceptance.json`，SHA256 `df6223b97a931056922390dd03792d51a9e2b7583172f405c87bb6d444e5b679`，签发于23:08:47 UTC。

容器图片矩阵44项（20接受/24拒绝）、准入5接受/5忙、重启重建持久化、18项正文拒绝与随后正常上传、私有卷/GC/代次/配置拒绝均有原件。8份cgroup整容器峰值记录最大741,384,192字节，低于4GiB，oom/oomKill均0；定时CLI采样峰值431.6MiB为另一口径，不混称单图片RSS。四份服务日志与秘密扫描通过。container目录不含OPFS附件，其OPFS/ACK证明由full14另行承担，不伪造容器附件。

container04外层 `1afb3772-1c08-4077-9657-e2a33a7a1cb3` 与内层 `be7a3d68-84e0-4e50-968c-841d8b521a0f` 均passed/cleanup complete，scratch/短根/alias/owner/group实际消失，8个profile已精简且未保留完整profile。本轮compose项目 `nerve-office-e2e-26704` 的容器、网络、卷与镜像标签已不存在；既有专用PostgreSQL及原卷保留。桌面guard全程WindowServer989，空闲空间最低107,294,375,936字节，无stopReason。full14 结束后、container04 启动前的只读就绪探针曾因macOS多列ps截短comm错误记录空列表；原件保留，独立pgrep/ps纠正记录另存，不改固定guard或门禁结论。

上述 full14/container04 已完成当时输入的 Task 3，不代签后续源码。本轮 full16/container05 的 r07 独立接受、旧失败与接续条件以上方“本轮门禁与收尾结果”为准；最终文档/来源、正常合并推送、同 SHA CI 与关闭仍须实际完成，不能由历史通过预勾。Excel/Safari/Finder 与 M4 既有挂账保持。

# M5-P4 最终验收与关闭复核

> **2026-10-28 当前记录**：旧输入 full11/container01 已接受并保留；正常 main 推送已成功，远端为 `1277dcb9`。该 SHA 的 CI 40525146257 最终 1 成功、5 失败。当前在唯一 P4 分支修复 Linux 临时路径、进程诊断及测试协调，已有定向复验；新输入完整门禁和最终同 SHA 六项 CI 尚待完成。下方早期记录按当时事实保留，最新接续见文末。

> 状态：P4 未关闭，P5 未启动；旧门禁不能作为当前修复已完成完整验证的依据。

## 本机完整门禁

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

`e78d1fa1` 已正常提交短路径、进程监督与检查点同步修复；主目录/远端仍为 main@1277dcb9。后续 lsof 增量尚未提交。实际小型 Linux 对照证实：普通用户会缺其他 UID 的 fd；隔离容器中的 root 也不自动拥有跨 UID 查询能力。带唯一 SYS_PTRACE 能力的独立、无宿主挂载容器可看到两 UID 自制文件/socket；该证明不覆盖宿主机其他 mount/net namespace，不能直接等价于 GitHub 托管主机。

真实 `-F pfnt` 的进一步回放揭示 `anon_inode:[io_uring] (stat: No such file or directory)` 假阳性。已知自有 PID 的直接 stat 同样 ENOENT；内核 `anon_inode_create_getfile("[io_uring]", ...)` 和 lsof4.95 的 `mem`/`S_IFREG` 回退与原件相符。修复只接受 Linux、mem、REG 与完整精确匿名名称/错误组合；其他 stat 错误继续拒绝。独立审查同时发现仅返回 `protocol: UNIX` 的未解析 socket、path inode/dev 不一致注解曾被遗漏，现同组拒绝，不因路径看似在本轮目录外就当作完整。

r2 的 RED 为6个方法中的8个预期断言失败、0 errors；目标23/23与全套76/76通过。三轮均已清理 scratch 和短根，7份源码前后指纹一致。原件索引为 `s6/ci-resource-path-fix/lsof-query-fix-r2/delivery.json`（SHA-256 `1d6ea9c6060969b29c453fa791457ff1b75b45cc494c19315e0bf72e66cd3b58`）。随后真实 Linux 全流回放已执行：io_uring 误拒消失，两 UID 自制文件/socket 活动时可见、关闭后均消失，但 root 输出仍含 PID 1 的一条 mem 映射身份冲突，整体退出1，未被接受。该条未保存具体路径/值，不猜测其底层原因、不加入豁免。原件 `linux-lsof-capability/receipt-891759f1-d73f-47a0-b035-ae5c3ead4af5.json` 的 SHA-256 为 `cfb4d65ffa21699c86c376d7ddedd7e2797601962f6e2b7232e792d03e014f14`；6.75秒结束、容器删除且受管 cleanupStage=complete，前后解析器和协议源码一致。不得将这些局部正例改写成全流或 CI 成功。

另已确认设计约束：lsof4.95 的 maps stat 使用调用者路径视图，socket 表只取调用者 `/proc/net/`，因此 sudo 本身不能消除其他 namespace 的歧义。CI 的独立 PostgreSQL 服务可能因此触发保守阻断。尚在收敛对已登记隔离服务的可达性证明，未加入任意 PID/容器豁免。原五项失败、新完整门禁、新同 SHA CI、最终关闭继续待验；未启动 full12/container02 或 P5。

新版外部来源/推送/关闭工具已独立审查，34项轻型契约与真实小 Git/blob/模式样本通过，0 C/I/M；12轮实现样例与2轮独立样例清理完成。工具审查回执在 `s6/p4-round-v2-tests/independent-review.json`。真实门禁前必须在 clean 的固定提交上分别采集 capture-before，结束后 capture-after；没有预签真实结果、binding、推送或关闭回执。

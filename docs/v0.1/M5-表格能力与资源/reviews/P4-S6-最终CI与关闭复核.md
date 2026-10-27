# M5-P4 最终验收与关闭复核

> **2026-10-27 当前记录**：安全依赖修正、测试资源治理及外部收尾工具独立复核已有证据；full09/full10 均未被接受。full11 与同源码完整生产容器 container01 均已通过门禁、原件审计和独立接受复核；正常中文提交/no-ff 合并、推送后同 SHA 六项 CI、最终证据冻结及唯一分支/worktree 清理待执行。下方早期状态和 full02/full04 记录按当时事实保留，最新接续见文末。

> 状态：完整门禁及 CI 验收进行中；尚未合并、推送或关闭 P4。结果以实际原始证据与关闭回执为准。

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

以下记录只覆盖已经发生并有原件的事实。full11与同源码container01已完成完整门禁、归档审计与独立接受复核；正常提交与no-ff合并、推送后同SHA六项CI、最终证据冻结及唯一P4 worktree/分支清理均待执行。没有用后续定向检查、资源清理或工具审查替代整阶段验收。

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

### 本稿仍待补入的事实

- 文档落回后仍为同一 4,559 路径集合的逐项等价证明；文档内容摘要会变化，不能冒充原冻结字节不变。随后正常中文 S6 提交、no-ff main 合并、推送与六项同 SHA CI 原件核对。
- 独立收尾复核、最终冻结、唯一分支/worktree 实际清理及外部关闭回执。Task 3四项已按两轮实证完成；Task 4与P4最终完成项待实际操作，不预勾。

Excel、Safari/Finder、DEF-004、M4 DEF-073/UR-035、完整 M4 验收及标签继续挂账；M7 联合备份/PITR、升级转换和回滚演练未被 P4 替代。P4 实际关闭后才从 main 建立唯一 P5 worktree 并即时设计客户端 CSV；P5/P6 未实现，不提前关闭 M5。

# 测试资源生命周期

2026-10-26：历史 handoffs 累积约 175.1 GB，其中大量是已结束的 VM 磁盘和通过用例的完整浏览器资料。APFS 共享块使目录统计不等于可回收空间。本规范与执行脚本共同生效，取代旧文档中直接启动 Playwright 的写法。

## verify 云端磁盘诊断

`ci_disk_diagnostic.py before-install|after-install|after-verify` 只在本仓库固定 GitHub Ubuntu 24.04 的 verify job 使用，复用 `hosted.context` 的仓库、run、attempt、job、SHA、runner/boot 身份检查。`.github/workflows/ci.yml` 在依赖安装前、安装后及 verify 结束时独立调用；后两步使用 `always()`，原产品步骤、断言、退出与资源合同保持。

它只查询固定 workspace、`.git`、`node_modules`、apps/packages、`.test-resources`、同级 runner `_temp` 和固定用户 pnpm store 的元数据。每项记录目录 uid/gid/dev/inode、文件系统 total/free/available、去重 inode 的分配字节及普通文件逻辑字节；链接与特殊文件只计数，不读目标或内容。目录相互重叠，**各行不能相加**；结果是非原子时点观察，不代表实际可释放的 APFS 空间。根和每级目录用不跟随链接的 fd 访问，跨设备、身份变化、读取失败及未知显式报告。

pnpm store 固定查询 runner 用户目录下 `setup-pnpm/node_modules/.bin/store`，对应已锁定 action 在 CI95 原日志中确认的 `store/v11` 布局；不使用默认 `.local/share` 猜测，也不接受任意 `PNPM_HOME` 作为读取授权。

每项最多 5 秒/20 万项/深度 64，整批最多 45 秒/50 万项；单次 JSON 最多 32 KiB，工作流外层 2 分钟。必需的工作区和 runner 临时根消失为不完整，其余固定可选根不存在明确记 missing。任何拒绝、部分/超限结果返回非零，不能冒充完整容量；查询不会判断或修改原 12 GiB 余量、16 GiB 原环境等门槛。

三步诊断都设 `continue-on-error: true`（M5-P7，D-09）：脚本的退出码不变，诊断失败只在该步骤显示告警，不跳过后续的预检、安装与 verify，也不否决 job 结论；其余步骤仍不允许失败了也算通过（`ci-workflow.test.ts`）。

诊断不创建临时环境或独立 artifact，只向原 job 日志输出固定字段；不输出环境对象、子项名称、文件内容或原异常文本。日志沿六项 CI 原件的 14 天/5 GiB 报告规则保留，必要最终证据通过原独审/pin 流程留档。成功诊断只说明观察完成，`diagnosticOnly=true`、`cleanupAuthorized=false`，不代替测试通过或资源清理。KiB 回归入口为 `python3 -B tools/test-resources/run.py unit -- python3 -B -m unittest discover -s tools/test-resources -p 'test_ci_disk_diagnostic.py'`。

## 固定 Chrome 用例的关闭阶段诊断

`tests/e2e/support/context-close-diagnostic.ts` 仅在 `E2E_CONTEXT_CLOSE_DIAGNOSTIC=1` 且原 `catalog-boundaries.spec.ts` 的指定换人故事、`chrome`、retry 0/1 时安装；workflow 只给 Chrome 分片开关。正式 `fixtures.ts` 在交出默认 context 前安装，不在外层 `provide` 返回时撤掉，让默认底层关闭也能被记录。

每 attempt 独占创建 `testInfo.outputPath('context-close-diagnostic.json')`（0600），立即登记 attachment 与受管 UUID/固定 GitHub run、attempt、SHA 和项目归属，再包装三个公开方法。开始事件同步写入，非阻塞重开后、写入前核对父目录和原普通文件 dev/inode/nlink/大小，每次写入即关闭描述符；已有文件、链接、FIFO 等身份替换、写入/注册失败均留下固定不完整注解，不覆盖原产品异常。仅保存阶段、序号、单调时间、调用关联和结果，不保存参数、错误正文、认证信息或环境对象。

每份最多 32 KiB/64 条；原 retry 0/1 合计至多 64 KiB，沿现有报告 14 天/5 GiB、稳定导出与必要证据独审/pin 策略，不增加 profile、VM 或数据库。原 Promise、this、参数和同步异常保持；不增加关闭、等待、重试或私有协议调用。`incomplete` 初始为真，只有原 close 完成、close 事件到达且已观察调用无挂起/失败时才能结束观察；超限/写入失败/缺文件/不完整状态不接受。产品与诊断结果分别核对，观察完整不等于旧根因已修复，也不覆盖原 flaky 判失败。

小型验证：`python3 -B tools/test-resources/run.py unit -- pnpm exec vitest run --project unit tests/e2e/support/context-close-diagnostic.test.ts`。其中真实 Playwright Node 夹具调度只替换 browser 边界，不启动浏览器，分别保留 passed 与预期 teardown timedOut；退出不明时保留本轮根交父运行器核对，不将模型结果冒充 Chrome 实测。

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
| 小型机制回归 | `pnpm test:cleanup:check` → `run.py unit`；另有 managed-output、test-databases 的 Vitest 单元回归 |

Vitest 的普通项目保持默认组 0；`integration-capacity` 只包含原 `asset-references-bulk.test.ts`，在组 1 等普通项目（包括 `afterAll`）结束后运行。两个集成项目共享 node/forks、source 解析、数据库及单查询 setup 和原时限；原 70,000 规模、断言与 60 秒整例上限不变。`pnpm test:integration` 同时选择 `integration` 和 `integration-capacity`；`pnpm test:coverage` 仍一次执行所有项目并生成同一份聚合覆盖率，原范围和阈值不变。这只保证本次 Vitest 内的分组次序，不保证整台机器没有其他进程；重型入口仍须串行启动。unit-web 里 M5R-I-01 的六条真实 SDK 大范围写入用例（`apps/web/src/editor/internal-api/image-commands.test.ts`）不另设项目，只在 describe 上写明 30 秒整例上限（P7-S15，2026-11-06 需求方批准；CI 覆盖率满载时约比本机慢 8 倍，默认 5 秒没有余量），规模与断言不变。

定向执行容量例须选择新项目：`python3 tools/test-resources/run.py integration -- pnpm exec vitest run --project integration-capacity tests/integration/src/assets/asset-references-bulk.test.ts`（数据库准备沿原入口）。`tools/src/verify/capacity-project.test.ts` 调用实际 Vitest，以两份无数据库小夹具验证正式选择器、组次序、普通 `afterAll` 完成和两组失败的退出码；它不替代真实七万资源链或完整覆盖率验收。有受管报告口时留存小报告，普通 `pnpm test`/推送钩子没有该变量时报告随自建临时根收尾；子进程超时或信号退出时不猜测 worker 已退出，不立即删根，交外层运行器核验。

只读配置探针显式使用 `--list`，并清除继承的 `NERVE_TEST_RUN_ID`、`NERVE_TEST_SCRATCH`、`NERVE_TEST_OUTPUT_DIR`，避免 coverage 的外层环境掩盖单独执行时的错误；实际测试仍须使用受管入口。M5-P4 的探针修复保持原项目配置与断言，不能用只读标记启动真实测试。

需要 Python 3.9+、POSIX 文件锁和 `lsof`。缺少句柄查询能力时保留原件并返回待处理状态，不冒险删除。测试的断言、范围、重试与超时不由清理器更改。真实 Safari 的解锁、空闲 120 秒和用户活动中止条件仍适用。

## 临时 Git 仓库与钩子环境

`cwd` / `git -C` 不会覆盖 pre-push 导出的仓库定位变量。针对另一仓库的 Git 子进程使用 `tools/src/shared/git-directory.ts` / `tools/test-resources/git_repository.py`，在环境副本中清除 Git 声明的局部仓库变量及配置键值项，保留 PATH、TMPDIR 与本轮资源变量；不修改父环境或全局 Git 设置。命令前核对指定工作树根，已有 `.git` 不重新初始化；新仓库初始化后再次核对归属。

`test_git_repository_isolation.py` 纳入 `pnpm test:cleanup:check`，使用本轮 TMPDIR 下的 KiB 级父仓库、linked worktree 与本地 bare 目标，真实触发 pre-push，分别运行既有迁移/证据夹具。核对父 HEAD、refs、index、共享配置和文件前后不变，并验证读取助手、变量组合与根拒绝。创建前核对外层运行台账、scratch、进程组和 TMPDIR 归属；夹具不设置逐例删除或 finalizer，超时也保留目录及回执，由外层运行器确认整组退出及句柄闭合后清理。复现只针对受管夹具，禁止把真实项目或其他任务 `.git` 注入测试环境。见 [P6 调查与修复方案](../v0.1/M5-表格能力与资源/reviews/P6-S5-推送钩子Git隔离调查与修复方案.md)。

## 嵌套运行器的失败保全

P6 的三条批准取证入口（真实 Node 协议成功、桌面屏障 kill-gone、报告轮转）使用 `fixture_retention.ManagedFixture`，详见[固定清单](../v0.1/M5-表格能力与资源/plans/P6-S5-句柄诊断与失败台账保全.md)。先核对外层运行身份、进程组和受管目录，再持锁写 `fixture-holds/<UUID>.json`，随后创建本轮 TMPDIR 中的夹具；不设逐例删除或 finalizer。`Run.finish` 在收集/删除之前拒绝任何未释放保留目录，后续 `Store.sweep` 也维持保留。清理未闭合不能仅记录日志后继续：三条实测使用 unittest fail-fast。

夹具导出原内层 run.json、存在且身份匹配的短根 owner 及摘要，首次观察不可覆盖；每子轮总计 64 KiB，所有夹具报告合计 1 MiB。夹具边界错误另有最多 64 KiB 的回执，错误片段至多 8 KiB、附完整长度/摘要及截断标记，也计入 1 MiB。导出/身份/预算失败都使当前用例失败并保留原件。仅原件导出核验、全部子轮已闭合、租约和进程组退出、scratch/短根实际消失且句柄查询完整时，才解除自身标记；只解除标记，工作文件由外层统一清理。失败后的再次 close 不重试子轮；需要调查后决定恢复，不能删除标记骗过保护。

这次仅迁移上述三个入口；其他有意损坏/伪造外部资源的旧 mock 夹具不在本轮完整闭合声明内。原 `full02` 的三个短根因创建身份证明丢失继续保留。lsof 对拒绝的 f 原值增加有界诊断（最多 64 bytes、16 样本，其他文本/绝对路径脱敏），**接受格式及原拒绝规则不变**。

## macOS 桌面会话异常停止

`tools/test-resources/desktop_session.py` 对 `e2e/container/measure/template/native/vm` 启用；外层本地门禁使用 `SessionGuard('gate')`。非 macOS 及非浏览器类型只记 `not-applicable`，没有桌面监测通过的含义，不得通过改变资源类型绕过检查。

探针只用固定 `/bin/ps -ww -axo pid=,uid=,lstart=,comm=` 和 `/dev/console`，不读取进程参数/环境、不提权、不截图。核对当前 console UID、唯一系统 WindowServer 与当前用户唯一 loginwindow 的 PID/UID/启动时间/固定路径，并核对读取前后 console 用户一致。查询超时 2 秒，取得完整输出后仅接受 1 MiB 以内的无错误结果；这是接受上限，不是采集峰值内存的硬上限。多义、缺失、格式损坏或查询失败均停止，记录固定原因而不写原始进程表或 stderr。固定基线不能在运行中自动重建。

内层在创建本轮临时资源后建立基线，实际测试命令仍受既有登记启动屏障约束；登记子进程后、释放命令前再次核对。运行中每 2 秒采样，命令结束后强制再读一次，避免返回 0 与桌面退出同时发生时被接受。只有仍存活的本轮子进程首进程允许发送组信号；沿原 SIGTERM、10 秒等待和 SIGKILL 处理，再核对整组/句柄/资源。所有正常及 finally 发送路径容忍组恰好消失，并在升级前重新核对首进程。首进程退出后存在其他引用时继续保留，不能凭旧组号补杀。记录 `desktopSession`、`stopReason=desktop-session`、原命令退出码和中断结果；等待清理时收到的晚到中断也会纳入最终结果。即使进入 `cleanup-pending` 仍保留已知退出/中断事实；清理是否完成仍按实际证据独立判断。

P5 外层 `s6/gate_helpers.py` 复用该探针和原有信号升级；会话失效时固定记录 `needs-attention`，后续 `run-gate.py` 拒绝直接开始下一轮。首次拒绝发生在命令启动前时，原命令退出码为 `null`；不得伪造一次已执行测试。内外层各自监测自己的进程，并不以外层还活着为内层前提。正式后续输入须重新绑定修改后的包装摘要，不复用旧门禁证明。

2 秒是采样间隔，不是硬实时停止保证；查询、调度和原有退出等待会影响延迟。普通锁屏、空闲与真实 Safari 前置检查继续由原规则处理。本保护只能减少桌面失效后的连锁测试，不预防首次 IOSurface 耗尽，也不能在监测器被强制终止后继续运行；异常残留沿下一次启动的归属检查恢复。磁盘/RSS 正常或本保护的模拟通过均不能证明长测安全。

小型回归：`python3 tools/test-resources/run.py unit -- python3 -m unittest discover -s tools/test-resources -p 'test_desktop_session*.py'`；完整资源机制仍用 `pnpm test:cleanup:check`。只创建 KiB 级样本与短命 Python 子进程，不启动真实浏览器、数据库或 VM。

## 报告配置与凭据边界

Playwright 的 webServer 默认继承父进程环境。不要把 `process.env` 展开到公开配置的 `webServer.env`：JSON reporter 会保存显式环境对象。正常子进程环境传递继续使用原入口，禁止以删除数据库/资源参数代替修正报告配置。`tools/src/verify/report-environment.test.ts` 用隔离的虚构 canary、真实配置列举和微型 HTTP 服务核对继承及真实 JSON/HTML 字节，不使用 Agent 或 CI 凭据。

`run.py publish` 持有既有发布/run 锁，在搬迁任一叶目录前检查两份真实报告；中断接续也检查已发布叶。`check_ci_resources.py` 在上传前独立核对稳定导出和实际报告内容，不信任旧 publisher 的通过字段。`pack_ci_profiles.py` 沿用此检查。`report_safety.py` 只读核验 `test-results/results.json` 及 `playwright-report/index.html` 的内嵌 base64/ZIP；拒绝非空环境对象、损坏/歧义 JSON、不可信链接和越界内容。单份 JSON/HTML 及单个 ZIP 成员上限均为 64 MiB，ZIP 最多 4,096 个 JSON 成员、展开合计 256 MiB。累计上限约束顺序扫描的总工作量，逐成员读取、解析、配置检查与释放，不一次载入全部展开内容。该值按既有 P4/P5 完整报告约 156/159 MiB 校准；普通报告保留容量和原环境预算不因此改变。异常仅输出固定错误码，不输出报告正文或变量值。

检查通过只证明这个已知配置边界，不是对任意正文、trace、日志和附件的通用秘密扫描。拒绝时记录 `reportSafety.status=rejected` 和有界原因，保留原证据，产品 `passed/failed/interrupted` 与清理结果保持独立；不得为了上传删除未知字段或把损坏报告伪装成空报告。可独立只读检查：`python3 tools/test-resources/report_safety.py --results /已核实的/test-results --html /已核实的/playwright-report`。

历史含凭据报告先登记原路径与 SHA-256，在归属、写入者退出、文件锁和打开句柄核验后隔离到本地受限目录（目录 0700、原件 0600），不上传、不改写原摘要。安全派生件另名并记录删改路径及新摘要；不能作为原件冒用。P5 I-01 的具体处置见 `docs/v0.1/M5-表格能力与资源/reviews/P5-S5-测试报告环境凭据调查.md`，手工历史材料不由普通 prune 自动认领。

## 创建、终止与恢复

`tools/test-resources/run.py` 在 `.test-resources/runs/<UUID>/run.json` 落盘归属，再创建 scratch、临时目录和子进程。子进程先等待管道握手，进程组登记完成后才允许执行测试。清理先落盘 reports-collected 阶段再删除 scratch，断电发生在删除后也能恢复终态与保留期。持久浏览器目录在启动浏览器前写 `resource-owner.json`；完整 VM 位于已经登记的 scratch；SSH mux 因 Unix socket 长度限制使用 `/tmp/nerve-vm-<UUID>`，由同一运行器创建前登记、核对身份和句柄后回收，不认领其他短目录。

普通受管命令还创建 `/tmp/nerve-t-<UUID>`（macOS 实际为 `/private/tmp/…`），独占权限为 0700，只有本轮 owner 与 `t` 别名。真实临时内容仍在原 `scratch/tmp`，`TMPDIR/TMP/TEMP` 使用短根下的 `t`，以满足 Linux branded 浏览器 SingletonSocket 的路径限制；不会把临时数据搬到容量盘点之外。VM 复用自己的 `nerve-vm` 短根与同轮别名，旧 owner 格式保留。目录和别名先登记后创建，再记录实际 inode/device，恢复时逐字核对目标及身份，不接管已有目录。创建未完成、标记缺失或目录/别名被替换时保留并报告。

清理和恢复证据快照在任何精简、移动、复制之前，先核对真实 scratch 与短根两处；活动 UNIX socket 可能被 lsof 显示为短别名，不能只检查真实目录。嵌套运行的别名还须解析回其实际目标核对。lsof 的返回码、标准错误（最多 4 KiB）、超时或启动错误留下有界诊断；无法完成检查仍拒绝清理，不忽略警告或把未知当空闲。容器 E2E 保留外层短临时目录，不在变量文件目录下再次覆盖 TMPDIR。

查询明确请求 `-nP -F pfnt`，先校验整份 PID/FD/name/type 记录，再匹配受管路径。Linux 权限失败可能位于 stdout 的 `NOFD` 或 `/proc/PID/fd/N (readlink: …)` 等记录，即使退出 0、stderr 为空也不表示完整。`readlink/opendir/stat/lstat` 失败、未能识别的套接字（含仅有 `protocol:` 的记录）、映射的 path dev/inode 身份不一致及格式不完整均保留资源；不按 ENOENT 文本豁免退出竞争。唯一 Linux 匿名映射例外是 `mem`/`REG` 且名称精确为 `anon_inode:[io_uring] (stat: No such file or directory)`：内核创建的是匿名对象，lsof 4.95 把它当路径 stat 才产生该注解。路径前缀、其他描述符/类型、其他错误及其他平台均不适用。只保存不完整记录总数及最多 16 种异常样本，不保存全局 stdout。异常样本包含 PID/FD/type/reason/operation、最多 512 字节的 name 摘要、原名字节数与 SHA-256、脱敏/截断标记及重复次数；绝对路径正文脱敏，只保留区分匿名映射和错误类别所需的标志；尾注仅输出精确的 ENOENT/EACCES/EPERM/ESTALE C locale 文本或纯数字 dev/inode，并锚定行尾。文件名伪注解和未知错误正文不能进入摘要，仍由 operation、原字节数与 hash 留下关联。样本按完整记录身份聚合，截断由总异常数与已保存样本的重复次数之和判断；重复本身不等于截断。类型/名称诊断不改变原拒绝条件，失败后观察到的 PID 身份不能冒认原查询身份。实际 macOS 的 PIPE、NPOLICY、NEXUS 是非文件路径对象，可有显式的空 name 字段；仅在 Darwin 且类型精确相符时接受这种协议记录，整行 name 缺失仍拒绝。REG、DIR、UNIX socket、未知或相似拼写类型缺名仍保留，错误注解优先拒绝。

普通运行使用直接查询。现有 GitHub Ubuntu 24.04 job 显式设置 `NERVE_TEST_LSOF_MODE=github-ubuntu-sudo`；运行器同时要求 Linux、`CI=true`、`GITHUB_ACTIONS=true`、`RUNNER_ENVIRONMENT=github-hosted`、`RUNNER_OS=Linux` 及 `/etc/os-release` 的 Ubuntu 24.04，才调用固定 `/usr/bin/sudo -n -- /usr/bin/lsof -nP -F pfnt`。没有自定义命令或自动提权回退，测试和清理程序仍为普通用户；提权失败、超时或输出不完整继续拒绝。GitHub 的[默认变量](https://docs.github.com/en/actions/reference/workflows-and-actions/variables)及[托管 VM 权限](https://docs.github.com/en/actions/reference/runners/github-hosted-runners#administrative-privileges)说明这一明确 CI 上下文；这些环境检查并非宿主身份的密码学证明。隔离容器中的 root 可能仍缺少检查其他进程的能力，不能仅因 UID 为 0 就认定完整；PID/网络命名空间及实际可见性仍须由运行环境保证。

原严格策略保留 `NERVE_TEST_CI_POSTGRES_SERVICE_ID` 的 service scope 实现；新托管 VM 策略不再注入此变量，也不以服务 PID 例外解释宿主未知记录。严格服务 scope 在 scratch 创建前登记服务 epoch、UUID/repo、GitHub run/attempt/job 与固定根，再记录实际目录身份。服务必须是 pinned 镜像的标准启动、精确 `HostConfig.Runtime=runc`、独立 GitHub bridge 网络、无 Options 的 local 匿名卷；privileged、增加 capability、设备、宿主 bind、VolumesFrom 或共享 namespace 不成立。卷来源与真实根、短根/别名双向相交时拒绝。没有这一创建证明的旧台账不能补签。

`service_scope.py` 只用固定 `/usr/bin/docker --host unix:///var/run/docker.sock` 选择必要 inspect/volume inspect/top 字段，不读取 Config.Env；namespace 身份用固定的非交互 sudo/readlink 系统命令读取；卷 Source 经本服务 inspect/volume inspect 验证后，再用固定 `/usr/bin/sudo -n -- /usr/bin/readlink -e -- <Source>` 取得唯一绝对规范路径，不把普通调用者遇到 EACCES 后的词法结果当作 canonical，不读目录内容。每个辅助命令最多 5 秒、stdout/stderr 合计 64 KiB，最多 128 个服务进程；查询前后的完整证明共用 30 秒预算，最多取 3 轮快照。只有已确认的 PID 消失/复用或快照成员变化可重新采样，权限、格式、Docker 错误立即保留；这些重采样不重跑测试用例。错误只保存固定枚举、errno/返回码，不保存全局 lsof stdout 或任意第三方正文。

`open_paths(root, owner=None)` 默认严格。只有持有原运行锁、重新核对台账及根 inode/标记/报告原子搬迁链的 owner 才可使用 service scope；台账用 `O_NOFOLLOW|O_NONBLOCK` 打开并经 fstat 限定普通文件，拒绝叶子或父目录链接，FIFO 不得阻塞扫描。当前 Run 即使没有 service scope，也必须先核对租约和台账；查询前后服务 epoch、top 成员、starttime、cgroup 和 mount/net/PID namespace 必须一致。scope 只处理已核实服务 PID 的绝对路径 `mem/REG` stat ENOENT 或明确 path dev/inode 不一致，以及数字 FD、`sock` 类型且整行精确为 `protocol: UNIX`、`protocol: UNIX-STREAM`、`protocol: TCP`、`protocol: UDP`、`protocol: TCPv6` 或 `protocol: UDPv6` 的记录。UNIX-STREAM/TCP/UDP 来自本轮自有 PID 的实际跨 namespace 输出；TCPv6/UDPv6 来自固定 [lsof 4.95.0](https://github.com/lsof-org/lsof/blob/4.95.0/dialects/linux/dsock.c#L4992) 与 Linux v6.8 的 [TCPv6](https://github.com/torvalds/linux/blob/v6.8/net/ipv6/tcp_ipv6.c#L2315)、[UDPv6](https://github.com/torvalds/linux/blob/v6.8/net/ipv6/udp.c#L1757) 和 [sockfs 名称返回链](https://github.com/torvalds/linux/blob/v6.8/net/socket.c#L370) 的源码推导，未称 IPv6 fallback 实测或实际 CI 内核字节一致。全流仍保留，真实文件、短别名 socket、deleted 或带注解的路径命中继续阻止清理；NOFD/readlink/lstat、其它 errno、未知协议、缺失/重复字段、stderr 和异常返回码不放行。报告轮转和过期清理在原 Run 锁内核对；archive 不传 owner。标准拓扑的实际 Linux/CI 验收仍是独立门禁，本机制不声称证明宿主 root 没有额外执行 nsenter/SCM_RIGHTS 注入。

启动命令前，运行器在资源登记完成后先执行同一套句柄与归属核对；查询警告、超时或启动失败时，子命令不会启动，错误与待回收状态会保存。查询期间收到 SIGINT/SIGTERM 也不再启动子命令。此预检避免清理能力已失效时仍运行长测，不能取代测试结束后的再次检查。

相同 worktree 的报告发布口持锁，第二轮不会覆盖第一轮。不同 worktree 分别拥有管理根。测试程序继承独立 `TMPDIR/TMP/TEMP`；非 VM 子运行不继承父 VM 的短根授权；不改宿主机全局设置。开始前及运行中检查可用磁盘，低于 12 GiB 时停止本轮，不继续写满磁盘。控制台日志上限 32 MiB。

SIGINT/SIGTERM 只转交本轮仍存活的子进程组，等待后才回收。根进程已退出却仍有子进程、打开句柄或查询失败时，标记 `cleanup-pending` 并保留；不凭可能重用的进程组号码继续杀进程。强制终止、崩溃之后，下一次运行或 `test:cleanup` 通过文件锁、原进程组与句柄复核接续回收。资源归属或父目录链接不合法时失败关闭。未解决的同类待清理运行会阻止继续堆积新环境。

数据库有独立生命周期：E2E/集成测试以主机标识、PID、随机后缀登记隔离库；正常退出按原夹具回收。下一次启动只挑本主机已失活 PID 的库，再确认数据库没有连接，以不带 FORCE 的 DROP 清理；连接竞争或占锁时跳过。仍有依赖的测试角色保留。业务库、其他主机的测试库与活跃库不动。容器按下一节的创建前 UUID 台账及实际归属清理；Docker 不可用时保留其数据，不直接删除 Docker 磁盘。

## 容器资源归属与闭合（2026-10-30）

两端读取先拒绝每层重复 JSON 键、无效数值和类型；文件读取与解析不超过 64 KiB。正常收尾在报告搬迁、stable-export/checksums 前，把同一次严格白名单验证的台账原字节封存为 `container-resource-ledger.json`，`container-resource-receipt.json` 绑定其 SHA-256，保留 run/repo/scratch、daemon、命名空间/标签、实际对象与镜像身份、生产者/清理结果及末态查询。重复清理保留已有观测，不用空集合抹去身份。有效 pending 只增加这份小原件到既有 diagnostic-only 包；含额外/秘密字段、缺件、错身份或损坏输入只生成固定错误摘要、保留原环境，不导出未知原文。不得把第二次读到的新台账给第一次摘要补签闭合。

`run.py container` 在 child bootstrap 放行前，将 `containerResources` 协议标记和 `container-resources.json` 初始 `unclaimed` 台账持久化，导出 `NERVE_TEST_RUN_DIR`。`tools/src/deploy/container-e2e-resources.ts` 核对父目录、UUID、真实源码根、scratch 和初始台账，确认当前 daemon 中本轮命名空间为空，再以文件及父目录 fsync 登记 `reserved`。项目和镜像使用 UUID，PID 只用于进程控制；旧 PID 目录、旧 Compose 项目和其他 worktree 的资源从不自动接管，取消启动前无条件 `down`。

Compose 的四个服务、默认网络、两个卷，以及构建镜像和镜像体积测量容器使用 `org.nerve-office.test.run` / `org.nerve-office.test.repo` 标签；后者为真实源码根 SHA-256。手工 Compose 默认标签是 `manual`，不可被自动清理认领。长命令启动前先记录待退出意向，spawn 后立即登记进程组；只有全组和输出真正退出才撤销。主进程退出不等于 quiescent；原组等待 10 秒、强制结束后 2 秒仍未确认退出时，结果失败且保留环境。

正常、失败及可捕获中断均在生产者已退出后收集报告，再逐项重新核对相同 daemon 与完整归属。合法的应用重建通过新观测到的 ID 处理；一次性容器 stop 后自动移除须由成功列表查询确认。只 stop/rm 本轮容器、网络、卷和本轮镜像标签，不用 force、全局 prune 或 Docker 重启；外部引用使删除失败时保留对应资源。独立删除失败不跳过其他已验证资源，任何失败都使本轮非零，只有最后重新查询四类资源均不存在才登记 `closed`。

`test.env` 保持 0600，只位于本轮 scratch 的临时目录；CLI 不自行沿短别名再次删除它。父运行器读取有界普通文件台账，只接受精确未使用的 `unclaimed` 或带实际不存在证明的 `closed`，再按原锁、根/别名/完整句柄规则处理文件。缺失、链接、损坏、待退出生产者或未闭合台账都保留为 `cleanup-pending`，下一轮同类启动停止，不能反复堆积。新协议的 hosted 验收与 sweep 快路径同样核验台账；不能仅修改为 `host-disposal-pending` 绕过它。

父侧把白名单 `container-resource-receipt.json` 随正常报告导出，含台账摘要、命名空间、状态和闭合/待处理事实，不包含密码、env 正文或完整 `Config.Env`。子 CLI 被强杀来不及生成报告时，在原生产者/导出及发布锁条件成立后，只沿既有归属搬迁链发布三个固定 JSON 的 diagnostic-only 包；保留原台账与环境，`cleanup-pending`、`cleanupComplete=false`、`publicationComplete=false`，不获得产品通过或 hosted 完成资格。无法核验时只留本地证据。台账和回执单文件不超过 64 KiB，报告沿原 14 天/5 GiB 策略。

旧 run 不补签新协议。严格策略下，旧 container 曾启动且 scratch 仍在时登记 `legacy-container-ownership-unverified`，保留其 env/证明；未启动的旧 prepared 样本与已完成且无 scratch 的历史记录保持兼容。已经按旧方案 B 合法登记、稳定导出的 `host-disposal-pending` 历史记录继续保留原环境，原验收与冻结字节不因新字段改变。

主密钥拒绝启动的两个原探针在正常路径都执行。任一达到原 60 秒时限，本轮已经失败，停止下一项；先通过原信号升级与有界组等待确认生产者退出，再交本轮归属清理，不在生产者还在创建容器时直接 `rm -f`。

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

**纳入门禁**（M5-P7，D-10；2026-11-06 修订）：Python 回归（`pnpm test:cleanup:check` 的同一组用例）经 `pnpm test:verify` 纳入**本机**完整 verify。它在覆盖率的同一轮受管运行（`run.py integration`）里、覆盖率结束之后执行（`tools/src/verify/coverage-resources.ts`）：两段都执行、任一失败即整步失败，不新增运行；pre-push 快速门禁不含它。本机实测约 3 分钟（S14 时 499 项）。

CI 的 verify job 只跑覆盖率（`pnpm verify --ci` 的 tests 一步是 `pnpm test:coverage`）。这组用例是严格策略下的工具单测，会对临时管理根做真实的全宿主 lsof 核验；GitHub 托管 VM 上全宿主 lsof 必有无法解释的 socket 与内核对象记录（见下文“固定托管 VM 的回收责任”与 ADR-024），严格核验在那里必然判不完整，用例也还没在 Linux 上兼容运行过。按需求方决定不进 CI，Linux 兼容运行与 CI 子集另行设计（DEF-080）。

**M5-P7 的四处行为调整**（S14 独立审查之后补全）：

- 管理根路径（仓库或 worktree 的路径）含非 ASCII、控制字符或反斜杠时，`Store` 初始化即失败关闭（M5R-M-17）：lsof 在 C locale 下把这些字节写成转义序列，按前缀比较会把仍被打开的文件当成不在管理根里。同一校验也在每次句柄查询（`open_paths`）里做，所以不经过 `Store` 的根（handoff 归档 `Archives`、嵌套夹具）同样按核对不完整处理；
- 运行期间 scratch 被外部删除时，running/prepared 按中断收尾（`stopReason=scratch-missing`，清理阶段 complete），短根随之退役；运行器不再以子进程的退出码冒充本轮成功（M5R-M-19）。运行器本身被强杀、之后 scratch 又被删时，`run.py cleanup`（`sweep`）也接手停在 running 的运行；仍在活动的运行持有运行锁或进程组存活，不会被误收；
- 收尾 GC 的单个候选出错只跳过它：统计大小出错记 `collection-failed`，核验没有通过（句柄查询不完整等）记 `verification-failed` 并原样保留，已决定删除之后的删除或记账出错记 `removal-failed`（下一轮重新核验后接着删），其余候选照常回收。`finish` 与运行器结束时的收尾 GC 共用 `prune_isolated`：出错只告警，不改变本轮结论与退出码、不挡住发布；`sweep` 的报告里列出跳过的候选（M5R-M-20）；
- lsof 全量列举只接受退出码 0 且 stderr 为空；退出码 1（即便 stderr 为空）或有警告都判不完整、保留资源（Q-10，2026-11-06 需求方决定收紧：三轮 CI 51 次与本机采样都没出现过“退出码 1 且 stderr 为空”，M5-P8 S2 实施，单测钉住）。CI 资源核对之后照旧按运行器同款固定命令采样 3 次，只记退出码与 stderr 字节数，写成 notice 注解，作为新环境（例如托管 Mac）的观测；整段采样最多 20 秒，超时只记下，不让核对步骤超时。

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

现有 verify、四浏览器分片及 container job 在检出代码后、安装 Node/pnpm/依赖/浏览器之前，运行 `python3 -B tools/test-resources/run.py ci-preflight -- /usr/bin/true`。只创建本轮预登记的 KiB 级目录，使用下面明确批准的托管 VM 策略，不再注入服务 ID。预检只能说明当前登记、查询、稳定导出及预算路径可用，不替代真实测试结束时的核验，也不独立证明所有外部引用均可识别。

紧接的 `ci_preflight_receipt.py` 步骤使用 `if: always()`，无需 pnpm，向原 job 日志输出最多 64 KiB 的安全 JSON 摘要，最多读取 128 个登记目录、输出 4 个 `ci-preflight` 运行。只读核对 owner/台账与锁，拒绝链接、FIFO、活跃或不可信记录；单台账最多 64 KiB。仅包含运行身份、状态、有限错误与 scratch/短根是否仍存在，不输出 command/env、不读取或上传 scratch 内容。收集成功不等于预检通过或资源已回收；缺失和拒绝必须显式记录。预检失败仍令 job 失败，后续重型步骤不会启动；日志经既有 CI 原件收集路径保存。

## 固定托管 VM 的回收责任（2026-10-28 用户批准方案 B）

本节是上述本机立即删除规则的显式窄例外。只有三个 job 定义（verify、四浏览器 e2e、container）设置 `NERVE_TEST_RESOURCE_POLICY=github-hosted-vm`；`hosted.py` 核对 GitHub-hosted/Linux/X64/Ubuntu 24.04、固定 main CI 工作流、真实 workspace、仓库/SHA/run/attempt/job/runner 和 kernel boot ID。默认及显式 strict 不启用，错误或不完整环境拒绝。此为平台执行契约，不是密码学证明；本地模拟测试不构成实际 GitHub 验证。

2026-11-02 用户批准的 P6 预验收另允许一个精确入口：`open-nerve/NerveOffice` 的 `GITHUB_REF=refs/heads/codex/m5-p6-closeout`、`GITHUB_EVENT_NAME=workflow_dispatch` 与 `GITHUB_WORKFLOW_REF=open-nerve/NerveOffice/.github/workflows/ci.yml@refs/heads/codex/m5-p6-closeout` 必须同时成立。main 原契约保持；其他事件、分支、仓库或 runner 不因此获得此例外。见 ADR-026 附录。此入口沿用所有下述身份、根、退出、稳定导出、预算与平台处置条件，不授权手动删除托管原环境。

Run 在 scratch 创建前落盘 `hostedScope`，并登记四个固定根、实际 inode 与短别名。持锁核验原台账后，启动及结束都检查原 scratch 和短根。本轮进程组须退出，输出线程须结束。全流 lsof 的语义未知对象保留有界诊断，只允许非破坏报告导出；格式损坏、stderr/命令失败、已知本轮路径及别名命中仍拒绝。未知原目录不精简、不移动、不删除，不能把未知写成已证明无引用。

绝对路径的别名解析也遵循此边界：原文和去附注路径分别核对，已知词法命中及可解析前缀指向本轮目录时仍拒绝导出；一条外部路径无法解析不能跳过其他候选或后续记录。仅托管导出把文件系统解析异常记为语义未知，默认严格查询仍拒绝；根自身及归属验证不属于此例外。异常样本与既有记录共用最多16项的摘要预算，只输出异常类型、errno和脱敏的记录身份、字节数、SHA-256，不输出外部私有路径或异常正文。没有无引用证明，也没有原环境删除授权。

`stable_reports.py` 在受管 reports 根内建立独立 `portable/`，先写 `test-results/snapshot-owner.json`，最后写 `stable-export.json`。报告流式复制并重查来源身份、字节数与 SHA-256；有效 OPFS 文件和空目录按清单保存，完整 profile/VM/数据库排除，失败只取限额日志/配置/崩溃记录。稳定清单覆盖两片报告树，发布只移动这些导出副本；归属标记随 test-results 搬迁。两片发布之间不可捕获中断时保留分散原件；恢复只沿同 run 已登记的 staging/固定发布口搬迁链，按原 inode 确定 test-results/playwright-report 每叶唯一实际位置，再以同一稳定清单完整复核字节、OPFS 和预算。已登记但尚未 rename 的源叶也核原身份；源目标双份、缺失、跨轮标记、替换、链接或篡改均拒绝，不能用任意备用路径或 publicationComplete 布尔值绕过验证。

容器 Docker ledger 已闭合且 hosted 稳定导出完成时，恢复只继续上述发布，不重新以 interrupted 执行 finish，不重建 stableExport，不改写原 passed/failed/interrupted、退出码或已记录结束时间。ledger、生产者退出、根/别名与打开句柄及完整导出证明仍须核验；未完成或不闭合只留有界诊断。小型恢复矩阵与双叶反例见 `test_hosted_lifecycle.py`、`test_stable_reports.py` 及[整体审查补正复核](../v0.1/M5-表格能力与资源/reviews/P4-S6-整体审查接口补正复核.md)。方案 B 的 cleanupComplete=false 与平台处置边界保持。

单快照最多 100,000 个文件/目录/省略项（包含 owner 和 manifest 自身两项），manifest 最多 16 MiB。枚举有界，复制前核对元数据及原 5 GiB 总额，完成时再校验。必要报告不能静默截断；失败诊断达到扫描上限时显式记录省略。导出目的持有原目录 FD，路径被替换时不得向替代目录写入报告或最终清单。

扫描过的来源目录仍全部在内存登记并于导出后复核身份，包含未选中的原始浏览器资料分支。manifest只逐项持久化必要报告目录、profile根、OPFS（含空目录）和所选诊断的已观察祖先；纯未选分支不写入这份索引，避免缓存目录数单独撑大必要报告的清单。任何被观察目录的替换仍拒绝导出。容量错误区分`manifest-json-limit`与`report-total-limit`，只附固定数值计数，不含路径；`encodedBytesAtStop`是拒绝时已编码的前缀字节数，不是完整清单总长。两个阈值及复制前拒绝时机不变。

托管 integration 的覆盖率目录由运行器设为本轮 output 下的 coverage，连同 command.log 和资源回执进入便携报告。其他运行清除旧的覆盖率目标继承值，本机保持原 coverage 路径。verify 只上传 `.test-resources/runs/*/reports/portable/test-results/`，明确启用隐藏目录并要求有文件；checker 核验同一 UUID 的覆盖率摘要与非空 HTML，不以资源回执替代实际覆盖率。

E2E 的 `pack_ci_profiles.py` 只对原清单中的便携 profile 建立独立 `reports/transport/`。计划先登记、目录独占、inode先于子进程登记；压缩输出有容量/磁盘余量保护，tar 解码逐项核对文件/目录集合、类型、大小和 SHA-256，拒绝链接、稀疏、重复、越界、额外成员及超限元数据。运输收据绑定原 manifest 与 archive，不改写稳定清单；没有 profile 时明确登记空运输。原 artifact 增加精确 transport 路径，展开的 profile 不上传，归档失败不回退 raw。只清理确认属于本次创建的 partial，未知或被替换的目录保持。运输和最终清理回执都计入报告预算，最终写入后再检查容量。

正常退出保留产品 `passed/failed/interrupted` 和原退出码，资源状态独立为 `cleanupStage=host-disposal-pending`、`cleanupComplete=false`。写入者未退出、无完整稳定清单、日志或容量触发仍返回失败。后续 sweep 验证已结束委托项，不重复 finish 或改写产品结果；prune 不手工删这些原环境。只有 job VM 的平台生命周期负责最终销毁，本项目没有独立观测最终删除。可捕获中断停止本轮生产者并处理归属；强制终止无完整收据时不得虚报完成。

容器成功结果另外要求完整的 Playwright JSON 结构及非空 HTML，JSON 读取上限 64 MiB，超过则明确拒绝而不截断。构建先于 Playwright 失败时，可以只发布已经通过稳定清单核验的 test-results 诊断叶；失败退出码与产品状态保持，不能补造 HTML 或结果。仅这一失败诊断分支允许缺少 playwright-report 叶，其他发布路径仍拒绝。

启动、结束和运行中每两秒计量同 job 所有已登记 scratch，包括上一轮等待宿主回收的内容，硬链接按 inode 去重，短别名不重复计量。16 GiB 是观察后停止的阈值，不是文件系统配额；采样及终止等待可能超调。每 0.1 秒的 12 GiB 磁盘余量检查独立覆盖报告、构建与镜像占盘，不能因为原环境低于 16 GiB 就忽略磁盘不足。报告合计 5 GiB，便携诊断维持 4 MiB/文件、16 MiB/用例、64 MiB/轮；artifact 14 天。身份、容量或清理条件不成立时停止，不创建反复重试的完整环境。

活动目录的容量采样通过父目录 FD 核验子项。列举后 stat、子目录打开前、已打开子目录结束复核这三处，只有确认子项 ENOENT 时才继续扫描；已累计字节保留，稳定兄弟和累计超限仍照常核验。本次计量已确认存在的根固定身份，不能在重试时把根消失当成尚未创建的零用量，或认领同名替换目录。权限、未知错误、祖先/根及子目录身份替换仍失败；无法完成的扫描最多三次尝试，并以固定操作名、errno 和尝试次数记录有界诊断，不输出私有路径。该采样规则不授权任何删除，也不适用于稳定报告内容校验。

`check_ci_resources.py` 在当前 job 上持 publication/run 锁，核验唯一预检和该 job 主测试的身份、退出、实际稳定报告哈希、历史及当前预算，写入 `cleanup-receipt.json` 的 `ciResources`。产品失败的合格诊断报告可以上传，原产品步骤仍失败；checker 拒绝则不上传。E2E 额外要求原监督器退出、JSON/HTML 合格及便携 profile 归档成功，归档失败不会回退上传 raw。预检收据只读收集有界摘要，明确 diagnostic-only，不能替代这一完整核验。三个 job 的既有报告 artifact 同时携带精确 `.test-resources/runs/*/reports/portable/test-results/` 路径下的预检原件，启用隐藏目录，不上传 scratch；因此远端可重新核对预检与主测试两份清单，而非只相信合同声明。最终远端接受还须绑定实际同 SHA 六项 CI 及下载后的便携证据，旧本地 v2 关闭证明继续只接受实际 cleanup complete。

## P6 Linux 固定校准与自检

`pnpm test:e2e:linux` 使用 `tools/src/deploy/linux-browser-cli.ts`，外层仍是 `run.py container`。只接受固定范围；校准 1 条通过才运行其余 13 条，Chromium、单 worker、原断言/超时/重试/trace/截图不变。Node 24.21.0、pnpm 12.6.0、Playwright 1.63.0、Ubuntu 24.04 和 Linux arm64 固定。独立提交源码副本与数据库，安装 SDK 的 16 组补丁字节前后核对，未提交源码拒绝运行。

2026-11-02 用户批准的 `pnpm test:e2e:linux:selftest` 通过同一入口选择固定 `selftest` 配置：`editor/selftest.spec.ts` 与 `editor/selftest-next.spec.ts`，共 29 条、Chromium、单 worker、默认自动保存，仅加 `--max-failures=1` 使首错后停止。原重试、trace、截图、超时、容量和断言保持。受跟踪 `tools/test-resources/linux-browser-profiles.json` 是宿主计划、guest 执行及收集的同一来源；命令行拒绝任意范围与额外参数。guest 原始执行证明中的配置名和完整命令必须与宿主选择相符，29 条均须首过，无重试/flaky/跳过；额外组不能忽略，保留原件并阻止环境释放。不自动重跑，不扩大到其他平台或完整 Gate。

runner 限 4 GiB RAM/3 CPU，数据库限 512 MiB/1 CPU；私有 1 GiB shm，不挂 Docker socket 或宿主 IPC/PID/network。每 2 秒尝试采样 scratch、容器可写层、内部工作卷、数据库卷与镜像；16 GiB 为停止阈值，采样和退出等待可能超调，12 GiB 磁盘保留独立执行。查询失败、OOM、会话变化、任一产品失败均停止，不自动创建下一轮。

第一处采样失败另存 `linux-browser/measurement-failure.json`：只含固定阶段/原因、白名单错误码/信号、数值退出码、输出字节数和最多 64 KiB 前缀摘要，以及缺失项/权限拒绝布尔线索；不保存命令参数、原异常正文、输出正文或环境变量。后续收尾异常不覆盖原件，`summary.json` 的 `measurementFailureSaved` 表示是否实际保存。诊断失败也停止，不能因为记录缺失继续运行、忽略 stderr 或改变清理权限。该记录帮助定位失败，不证明原问题已解决。

复用父 UUID 容器/卷/网络台账，先登记后创建；工作文件使用本轮 `_assets` 内部卷，Node 子目录另作只读挂载，源码和清单通过 Docker cp 传入；不把数万个依赖文件 bind 到宿主。先结束生产者、核对本轮全部容器完整 ID 并停止，再提取报告，安全导出后才实际删除容器/卷。容器内 tini 替代 Docker 注入 init；安装前和 pnpm 就绪后先通过原完整 lsof 预检。内层 `run.py e2e` 的真实回执与父回执分别保留，不改写为同一轮。停止的容器经 `linux_browser_transport.py` 流式导出至父 scratch：两流总 payload 5 GiB，每流元数据 64 MiB/10 万项（整轮最多 128 MiB/20 万项），扩展 tar 头限 64 KiB；拒绝越界、链接、特殊文件、重复项与未知证据，内层提取原 run.json、根层或 reports/command.log 与临时清单，每件限 4 MiB、发布合计 16 MiB；scratch（含空目录）及未知残留会保留存在性拒绝信号，不能因过滤消失。导出后先检查 JSON/HTML 的环境变量边界，再以稳定字节清单复制；完整 profile、node_modules、数据库不导出。两组报告合计不超过 5 GiB，沿普通 14 天/5 GiB 策略；失败和中断走同一清理路径。

基础镜像缓存另记父运行目录 `linux-browser-image.json`，拉取前 fsync，固定 Playwright digest 上限 5 GiB/14 天；既有 Node/PostgreSQL/Playwright 镜像只借用。新增镜像确认 daemon、ID、digest、所有容器使用和额外引用后，仅非强制 `docker image rm <digest>`。与固定 digest 完全相同的 tag 仅视为本轮别名；其他 tag/digest 或其他容器引用仍视为共享。Docker inspect 的压缩 Size 不代替总体积：核对显示容量的保守上界，整轮维持 5 GiB 预留。共享时保留明确状态和到期时间；未闭合拉取、查询异常、身份变化或到期共享缓存阻止新拉取，保留待核对，不删除未知或其他项目资源。元数据不按报告垃圾回收，不清全局 image/builder cache。

小型验证：受管 Python `test_linux_browser*.py` 及受管 Vitest `tools/src/deploy/linux-browser*.test.ts`，并核对既有容器归属/生产者回归。真实入口只用于已批准的 S4 校准或 S5 自检清单，不隐式恢复 Mac 浏览器或完整 Gate。

Linux guest 启动前还会持久写 `linux-browser-evidence-hold.json`。父 `finish` 与重启 sweep 在该标记存在时保留原件并登记 `cleanup-pending`；内层报告安全拒绝、未发布、清理未闭合或证据归属不明时不会解除。普通产品失败的安全报告全部导出后可解除，不把产品失败当成证据丢失。缺证明时不得计为通过；成功还须核对 guest 已停止且退出码为零、无 OOM，以及版本/源码/SDK 前后证明全部一致。

## 2026-11-03 资源回归接续

用户批准整体进度中的下一步后，真实子运行夹具继续接入 `ManagedFixture`，详见 [接续计划](../v0.1/M5-表格能力与资源/plans/P6-S5-资源夹具接续与整组回归.md)。`pnpm test:cleanup:check` 保留全部 `test_*.py`，增加 unittest `-f`，遇到首个异常停止；不删除测试或降低原断言。

接入范围：DesktopSessionRunnerTests 全部真实/屏障子运行，RunnerTests 的报告轮转、CI settle/恢复和退出码/中断链，Node 协议三个实际父子入口，正常短路径/受控预检失败后恢复/管道关闭，VM 短路径恢复（只创建 KiB 文件），Linux 证据 hold 的拒绝与恢复。创建前有外层 hold，内层异常先导出，无法证明闭合时保留原件，外层 finish/sweep 均不能删除。

Node `killed` 用例始终通过自制 `owned-protocol.mjs` 的内存 capture 函数模拟全部 Docker API，未调用 Docker daemon。该固定模型在创建前登记 `node-docker-stub-v1`；原来的 pending、诊断导出、未发布、env 保留以及 sweep 不修改协议台账断言全部保留。断言成立后，测试辅助核对固定模型字段、租约、真实生产者退出、目录/短根身份及完整句柄查询，保存有界原始台账和 `test-model-only` 处置说明，仅退役自己的真实短根，本地模型文件仍由外层严格回收。原 run.json 不改成 complete/passed，`realDockerClosureObserved=false`；没有预登记、真实服务/托管记录、活跃组、句柄或身份问题一律保留。不能将此测试辅助用于产品资源回收。

`HostedLifecycleTests.command()` 的七个真实子进程入口同样在启动前使用独立 `ManagedFixture`，登记 `hosted-command-observation-v1`。纯模型初始化目录不被认领；已存在其他模型 run 时拒绝切入该入口。收尾先释放本例租约、解除 lsof/平台/环境模拟，再执行真实组、完整句柄及短根身份核验。固定的假 runner/run/attempt/SHA/boot/job 与严格 hosted scope 必须匹配，拒绝容器和 service scope；保存原 `host-disposal-pending` 台账与有界命令日志，处置记录为 `test-model-only`、`hostDisposalObserved=false`。不把本机测试模型退役称为实测 GitHub VM 销毁。

Node 模型在导出协议原字节前复用 `container_resources.read` 的严格 JSON、全字段和命名空间校验，再拒绝不属于 killed 时点的附加观测/异常/闭合字段。两个模型都在取得子锁前核对整个夹具的实际句柄，持锁后继续核对 scratch 和短根；不忽略查询结果或豁免整个 PID。

其余纯内存/文件协议测试、不调用真实 command 的 hosted/service-scope 观察模型与故意破坏短根身份的模型继续保留测试控制的样本处置；它们不代表实测平台销毁或未知资源被安全清理。未将本轮接入表述为所有旧模拟夹具已做统一迁移。

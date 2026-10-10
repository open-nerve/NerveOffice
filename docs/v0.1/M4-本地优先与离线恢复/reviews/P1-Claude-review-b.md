claude-opus-5-5

# M4-P1 本机发件箱：独立审查 B（测试、测试设施、门禁与文档）

- 审查者：独立审查者 B（模型 `claude-opus-5-5`），没有参与实现；只审查、不修复。
- 副本：`scratchpad/m4-p1-review-b`（clone 主仓库，分支 `m4-p1-review-b` = `origin/m4-p1-outbox`，头 `afae6422`）；审查之后工作区干净（两处变异、一处路径探针都已还原，测试构建按干净的源码重建过）。
- 范围：`fc4868ff..afae6422` 里 P1 的改动（即 `git diff 6702e982 afae6422`，main 的 `6702e982` 不在内）：浏览器层用例与探针、崩溃工具与崩溃项目、测试库的命名与清理、页面自检与测量、门禁与 lint、文档。

## 〇、跑过的

| 跑了什么 | 结果 |
|---|---|
| `pnpm lint`、`pnpm typecheck`、`pnpm test` | 全过；单元 356 个文件、7201 条 |
| 本机 `specs/outbox`（chromium、chrome） | 92/92，36 秒 |
| 本机 `specs/outbox` 压力（chromium、chrome，`--repeat-each=3 --workers=12`） | 276/276，87 秒，没有不稳定 |
| 本机崩溃项目 `crash-chromium`、`crash-chrome`（`--no-deps`） | 22 过、8 跳过（按设计），76 秒；最长一条 18 秒（时限 300 秒） |
| 生产构建 + `pnpm gate artifacts budgets` | 通过；平台页面 175.8 KiB、编辑器页 2059.8 KiB、公式 Worker 677.6 KiB |
| **Linux 容器**（本机已有的 `mcr.microsoft.com/playwright:v1.63.0-noble`，arm64；我自己的临时网络与临时 PostgreSQL，跑完删；依赖从丁的卷只读拷出、不改它）：`specs/outbox` + 校准里 M4-P1 的几步，chromium、webkit | chromium 全过；webkit 14 条失败（B1），其余全过 |
| Linux 容器：资料目录换成不带中文的路径（临时改动，没提交）后再跑 webkit 的 `mirror.spec.ts` 与校准 `storage-quota` | 12 过、1 跳过（WebKit 的写满，按设计） |
| 变异 M1：去掉生产发件箱 Worker 的 100 ms 空定时器 | **存活**（B3） |
| 变异 M2：`mirror-directory.ts` 拿到一个槽位、另一个拿不到时不放开已拿到的 | **存活**（B4） |
| 抽查复核报告的数（真实 Safari 结果文件 + measure:probe 三个浏览器的 JSON） | 第 2、3、9、9-production、10、11、12 项的数与报告一致；冷热的标注有误（B5） |

没碰真实 Safari；没在本机跑 crash-webkit（代码自丁的 `1d464219` 以来只改了文档——`git diff 1d464219 afae6422` 只有 7 个文档——丁在本机与 Linux 容器里已跑过多轮，我不再占用 WebKit 的独占时段）；没拉镜像；我建的容器、网络与卷都已删除。

## 一、问题

### B1 【必须修】Linux 上 WebKit 的持久上下文起不来：`persistent-profile.ts` 用 `testInfo.outputPath(name)`（带中文的用例标题），CI 的 webkit 分片会红 14 条

- **位置**：`tests/e2e/support/persistent-profile.ts:20`（`launchPersistentProfile`）；用到它的 `specs/outbox/mirror.spec.ts`（`profile` 夹具）、`specs/editor/selftest.spec.ts` 的 `storage-quota`、`measure/probe.spec.ts`。
- **问题**：资料目录在用例的输出目录里，目录名含中文标题。Linux 上 Playwright 的 WebKit（WPE 的 MiniBrowser）解析命令行时报 `Cannot parse arguments: Invalid byte sequence in conversion input`，`launchPersistentContext` 立即失败。崩溃工具早就因为同一个原因改用了 `crash-profiles/<testId>-<重复>-<重试>`（`browser-crash.ts:406-416` 的 `profileDirFor`），这里没有跟上。
- **依据与复现**：
  - Linux 容器里跑 `specs/outbox` + 校准：webkit 的 `mirror.spec.ts` 13 条（含按设计应跳过的写满那条——跳过写在用例体里，夹具先起持久上下文就失败了）与校准的 `storage-quota` 1 条，共 14 条失败，错误都是上面那一句（`scratchpad/m4-p1-review-b-linux/out/outbox-calib.log`）。
  - 这与区域设置无关（崩溃工具的注释说"非 UTF-8 的区域设置下起不来"，不准确）：镜像里本来就是 `LANG=LC_ALL=C.UTF-8`，我用最小的探针（`scratchpad/m4-p1-review-b-linux/probe/webkit-path.mjs`）在 `LC_ALL=C.UTF-8` 与只设 `LANG=C.UTF-8` 两种下都试了：ASCII 的资料目录起得来，`中文-资料目录` 都报同一个错。所以 CI 的 ubuntu-24.04（同一份 WPE 构建）一样会失败。
  - 资料目录换成不带中文的路径（`scratchpad/m4-p1-review-b-linux/probe/persistent-profile-ascii.patch`）之后，同一套 webkit 用例 12 过、1 跳过——后面没有别的 Linux 问题。
  - 后果：CI 的 webkit 分片失败；而且崩溃项目依赖浏览器项目，Playwright 在依赖的项目有失败时**不跑**依赖它的项目，crash-webkit 在 CI 上也就跑不到。`mirror.spec.ts` 与校准的新几步此前只在 macOS 上跑过（甲、乙、丙的报告里都没有 Linux 的运行），这是第一次在 Linux 上跑。
- **建议的修法**：持久上下文的资料目录统一用一处不带用例标题的命名（例如在 `persistent-profile.ts` 里放 `profileDirFor(testInfo, name)` = `<project.outputDir>/persistent-profiles/<testId>-<repeatEachIndex>-<retry>-<name>`，`browser-crash.ts` 也改用它）；`storage-status.spec.ts:25` 一并用它（那里只跑 Chromium 系，眼下不出错）。崩溃工具注释里的原因改成"WPE 的 MiniBrowser 以 C 区域设置解析参数，任何非 ASCII 的路径都不行"。修完在 Linux 容器里把 `specs/outbox`、校准与崩溃项目的 webkit 各跑一遍（我的脚本 `scratchpad/m4-p1-review-b-linux/run.sh` 可以直接用）。

### B2 【建议】CI 风险：Linux 上的 Google Chrome 与 Edge 从没跑过崩溃项目（以及 `specs/outbox`、校准的新几步）

本机只在 arm64 容器里跑过 Linux 的 chromium 与 webkit，chrome、msedge 只能等 CI。逐条看过工具在 Linux Chrome/Edge 上的认定，结论是**认进程这一侧误报的可能很小**，真正要盯的是下面的 (c)(d)：

- (a) 根：`/opt/google/chrome/chrome`、`/opt/microsoft/msedge/msedge` 是 ELF 本体（不是包装脚本），由工作进程直接 spawn、detached（新的会话与进程组），`launchRootIn` 认得出。zygote 与它 fork 的渲染进程都在进程树、进程组里；渲染进程的命令行被 Chromium 改写成带 `--type=renderer`。没问题。
- (b) crashpad：两次 fork、另起会话。命令行里的 `--database` 在资料目录下就按 `profile-arg` 认出、一并冻住与结束；不在资料目录下就认不出——既不结束、也不算幸存者，不会误报。要求的角色 `browser/renderer/network` 在 Linux 桌面版上网络服务默认在进程外，没问题。
- (c) **`specs/crash/indexeddb-log.spec.ts:90,121` 与两个恢复用例**断言 `report.indexedDbLogs` 整个列表是 `['clean']`/`['corrupt']`——假定资料目录里只有被测来源一个 IndexedDB。macOS 的 Chrome 154 成立；Edge 在新资料目录里会不会给内建的来源建 IndexedDB 没验证过，有就是误报。建议按 `indexedDbDirName(baseURL)` 只看被测来源那一条。
- (d) **CI 装的是当时最新的稳定版 Chrome 与 Edge（不锁版本）**，而这几条用例依赖 Chromium 的缺陷与 LevelDB 的后端本身（文件头注释承认"修好时会失败"）：IndexedDB 一旦换后端（Chromium 在做 SQLite 后端）或缺陷修好，`tearIndexedDbLog` 会报"这个来源还没有 IndexedDB"或删库不发生，CI 无代码改动地变红。建议在前提处给出明确的说明（例如"没有 LevelDB 的 IndexedDB 目录：浏览器换了后端，UR-034 的前提不在了"），并在交接单里写清到时的处理。
- (e) 时限与时长：本机两个崩溃项目并行 76 秒，最长一条 18 秒，300 秒的时限余量足；等退出 3 秒对 SIGKILL 足够（僵尸算退出）。CI 每片多出几分钟，45 分钟的 job 时限要盯一下第一次运行。
- 建议：合并之后第一次 CI 重点看 chrome、msedge 两片的 `crash-*` 附件 `crash-tool.json`（认出的角色、via、late、notes），出问题时按上面几条定位。

### B3 【建议】测试缺口：生产发件箱 Worker 的 100 ms 空定时器去掉了没有任何测试失败（变异 M1 存活）

- **位置**：`apps/web/src/features/sheet-editor/outbox/outbox.worker.ts:26`（被覆盖率排除的"薄入口"）。
- **依据**：把 `setInterval(() => {}, 100)` 换成一次性的 `setTimeout(() => {}, 0)`，重建测试构建之后：发件箱的单元测试 17 个文件 326 条全过；`pipeline.spec.ts` 与校准 `outbox-stall`、`outbox-pipeline`（chromium）11 条全过（`scratchpad/m4-p1-review-b-logs/m1-*.log`）。处理器的单元测试只测了注入的 `stopKeepAlive`，没人核对入口真的开了定时器；校准在 CI 上不判停顿。
- **为什么要紧**：DEF-011 的定论（ADR-020"空定时器不能去掉"）是 P1 最主要的放置结论之一，现在没有回归的防线。
- **建议的修法**：加一条单元测试：桩出 Worker 的全局（`postMessage`、`addEventListener`），`vi.spyOn(globalThis, 'setInterval')` 之后动态引入入口，核对以 100 ms 开了定时器、握手 `keepAlive: true` 时不清；或者在测试构建里记事务的 Worker 旁边报一次"空定时器在"。

### B4 【建议】测试缺口与覆盖率排除：`mirror-directory.ts` 里的逻辑没有任何测试（变异 M2 存活），排除的理由不成立

- **位置**：`vitest.config.ts` 排除 `apps/web/src/shared/outbox/mirror-directory.ts`（理由"jsdom 与 Node 都没有 OPFS"）；`mirror-directory.ts:217-220`。
- **依据**：去掉 `openSlots` 出错时"放开已拿到的句柄"那一行，`mirror.spec.ts` + `pipeline.spec.ts` 在 chromium、chrome 上 44 条全过（`m2-*.log`）。这一行正是两个标签页同时开同一份文档时（一个拿到 a、另一个拿到 b）不互相锁死的关键。
- 排除的理由不成立：`opfsMirrorDirectory(root)` 本来就注入了根目录，换成内存里的假句柄树就能在单元测试里测——部分打开之后放开、`problemOf` 的归类（NoModificationAllowedError/InvalidStateError → busy、QuotaExceededError → quota、SecurityError → unsupported）、`removeEntry` 找不到算已删、先不带 create 找。浏览器层只覆盖了"两个都被占"的那一条。
- **建议的修法**：给 `opfsMirrorDirectory` 加单元测试（假的目录与文件句柄），从覆盖率排除里拿掉它；ADR-020、架构总览的排除清单随之核对（见 B10）。

### B5 【建议】复核报告的冷热标注有误，F5 与 DEF-072 的归因没有数据支撑

- **位置**：`reviews/P1-真实浏览器复核.md` 第 12 项的表、F5、§五；`02-延期事项登记.md` 的 DEF-072；计划书 r22 §12.2 的相应一句。
- **问题**：Playwright 里一路由页面就关掉 HTTP 缓存（Playwright 的文档："Enabling routing disables http cache"），`support/selftest-run.ts:43-57` 的 `runSelftestStep` 每一步都 `page.route` 收集端——所以 measure:probe 里标成"热"的两步其实是冷的：
  - WebKit、Chromium、Chrome 的 `perf-main`、`perf-worker-warm` 都把脚本整个重传了（`perf.script-transfer-bytes` 8,388,564 / 14,093,760 字节，与冷的那一步相同）；真实 Safari 的热两步才是 3,300 字节。
  - 于是报告第 12 项"热（主线程、Worker）"一列对三个 Playwright 浏览器的数都是冷的；F5 说"Playwright 的 WebKit 冷、热两次都是约 1760 ms"，实际是两次冷。
- **对结论的影响**：三次 WebKit 的冷加载（Safari 冷 1615、Playwright WebKit 两次 1761/1762 ms）第一次增量计算都慢约 1 秒，**唯一一次真正热的（Safari `perf-worker-warm`）第一次是 633 ms，没有慢**。若是 DEF-011 那种"Worker 空闲之后第一次异步操作多等约 1 秒"，热的那一次（同样是新起的公式 Worker、同样等过 steady 的 3 秒）也该出现。数据更像与冷加载（脚本没进缓存、编译）有关。DEF-072 写的"与 DEF-011 同一个现象"、"做法：公式 Worker 同样开一个空定时器"是没验证的假设。
- **建议的修法**：报告第 12 项注明 Playwright 的运行缓存是关的、冷热不可比；F5 补上 Safari 热的那一次（633 ms）；DEF-072 与 r22 §12.2 把归因改成待查的假设，P5 先在真实 Safari 上对照冷/热与有无空定时器再定做法。想在 measure:probe 里得到真正热的数，收集结果要换一种不经 `page.route` 的办法（例如收集端起在别的源上、或页面经绑定交回）。

### B6 【记录】"空定时器有效"的说法强于数据

- 报告的结论与 F6、ADR-020 写"空定时器有效，不能去掉"。真实 Safari 上：不带空定时器 75 次里 1 次停顿（3 秒那一档 10 次里 1 次），带空定时器的探针 Worker 75 次与生产 Worker 55 次都是 0。1/75 对 0/130 在统计上分不出（单侧 Fisher 检验 p ≈ 0.37）。保留空定时器作为保守的决定没问题，主要的依据仍是 M0（60 次里 8 次 对 40 次 0 次）；建议措辞改成"Safari 上不带空定时器仍出现停顿；这一轮的次数不足以单独证明空定时器有效，与 M0 一致，保留"。

### B7 【建议】P1 设计没跟上 S9 的订正与实现

- `01-P1-本机发件箱.md`：
  - §1 范围第 4 条、§3.1 的 `database.ts`、§3.3 都写"两个对象仓库"，实际（与 ADR-020、总设计）是三个，`notices` 存恢复的提示；
  - §3.8 写"留下……事件""P1 交出事件的种类与键"，S9 的订正（`661bed4b`）已改成提示存进库、与写回同一个事务，读出、清除；§3.4.7 的清理没有镜像，合一的清理 `local-cleanup.ts` 没写；§3.1 的模块清单没有 `mirror-slot.ts`、`mirror-directory.ts`、`draft-mirror.ts`、`recovery-notice.ts`、`local-cleanup.ts`、`local-key-import.ts`；
  - §3.7 写"资料目录在 `testInfo.outputPath('profile')`"，崩溃工具实际不用它（理由正是 B1）；
  - §9 的变更记录只有两行，没记 `12e8022c`（§3.8 dataLoss 的订正）、`e138df6e`（补写镜像、原子性按生产的配置跑）与 S9 的订正。
- 计划的"涉及文件"同样没有 S9 的文件。
- 建议：收尾时把这几处与实现对齐，变更记录补上（任务说的"两处订正"在正文里有，变更记录里没有）。

### B8 【建议】UR-034 与设计 §3.8 的数对不上

- UR-034 的中文摘要与英文的表列的是 Google Chrome 1400 次 5 次、Chrome for Testing（macOS）800 次 7 次、Linux 300 次 1 次，合计 **13** 次删库；同一段与英文正文却说"15 次前兆对 15 次删库""Before every one of the 15 wipes"。多出的 2 次来自丁报告 §8.3 里 Chrome for Testing 的另一组（"开始写之后 0–6 ms"的 300 次，删库 2 次），表里没列。给上游的 issue 里数字自相矛盾会削弱可信度。
- P1 设计 §3.8 写"chrome-headless-shell 153 约 1/145"：按调查的数是 7/800 ≈ 1/114（或生产写入 9/1100 ≈ 1/122），1/145 像是早期 290 次里 2 次的旧数。
- 建议：UR-034 的表加上那一组（或写明 13 + 2 的来历），设计里的比例按最终的数改。英文部分没有我们的代码（只有通用的复现脚本与命令），这一点没问题。

### B9 【记录】命令表与说明里的小出入

- `CLAUDE.md` 的 `safari:selftest` 一行没列新加的 `--runs`（复核的运行次数，默认 40）（`--timeout` 本来就没列）。
- `measure/probe.spec.ts` 文件头与复核报告 §八说每个浏览器"约 15 分钟"，§2.1 的实测是每个浏览器约 8.7 分钟。
- `CLAUDE.md` 崩溃项目一行的"串行"指每个项目一个工作进程；三个崩溃项目之间是并行的（本机实测 chromium 与 chrome 交错执行），可以写明。

### B10 【记录】lint 没有"不依赖 DOM"的规则，文档却这样说；覆盖率排除的清单不全

- 设计 §3.1、计划 S8 第 2 项与架构总览（`shared/outbox/` 那一行"Worker 会用到的文件不引用 zod、请求层与 DOM，lint 的区域规则"）都说 lint 拦 DOM；`eslint.config.ts` 的 `nerve/web-outbox-*` 只拦 zod、带 zod 的契约与请求层。现有的 Worker 文件里没有用 `window`、`document`、`localStorage`（我查过），只是没有防线。要么加 `no-restricted-globals`，要么把文档改成实际的样子。
- `vitest.config.ts` 另排除了 `mirror-directory.ts`，ADR-020"覆盖率"一条与架构总览的覆盖率一句都没列它（B4 建议拿掉这条排除）。

### B11 【记录】M4 总设计 §6.1 留着被取代的说法

- 回写是在后面加了"M4-P1 实施中定下的"一条，但前面的原文没改：草稿的元数据里"在途的请求（请求标识、客户端实例、序号、'公式待更新'、客户端构建版本与数据格式）"、写入者"代次与令牌"、发件箱 Worker"在真实 Safari 上无效时，WebKit 改为主线程放置"（已定论：有效，保留 Worker）。计划书 r22 是就地改的；总设计建议同样就地改或标明已被取代，免得前后矛盾。

### B12 【记录】判定标准的文字与代码不一致（第 10 项）

- 复核报告 §三第 10 项写"……≤ 10 ms；5 MiB 只记录"，`probe-verdicts.ts` 的 `captureCost` 对约 5 MiB 那一步同样按"异步段主线程最长阻塞的中位数 ≤ 10 ms"判，超了就不通过。Safari 上 5 MiB 是 9 ms，离界只差 1 ms，这一处的口径要定下来、文字与代码一致。

### B13 【记录】复核报告没有记 Worker 的体积

- 计划 S5 第 4 项、设计 §6 的 S5 验收要求"在测试构建里量出 Worker 的体积，记进复核报告"；报告里没有，ADR-020 的影响一节有"含镜像之后 gzip 约 12 KB"。我量了测试构建里的 `outbox.worker-*.js`：39,719 字节、gzip 11,999 字节，与 ADR 一致。补进报告或改计划的说法即可。

### B14 【记录】测试设施的几处小问题

- `mirror.spec.ts` 的几条在 `dispose` 之后立即起新的 Worker 读镜像（"IndexedDB 被删之后"等）：句柄在 Worker 终止之后是异步放开的，放开之前读到 busy 时管道按"没有镜像"交回 absent。本机压力跑（276 条）与 Linux 容器都过了，只是潜在的竞争；慢机器上若出现，就在读之前等句柄放开（崩溃用例已经这样做了）。
- `mirror.spec.ts` 的"合一的清理·保留期"以 `Date.now() + 15 天` 清，会回收这个来源下**所有用户**的镜像目录；macOS 上 Playwright 的 WebKit 把持久上下文的 OPFS 放在共用的目录里，现在同一文件的用例串行、别的文件不在持久上下文里碰 OPFS，所以不互相影响；若以后开 `fullyParallel` 就会误删别的用例的目录，值得在文件里写一句。共用目录里每次运行（端口不同）会留下空的来源目录，只是积累。
- `support/outbox-probe.ts:342-343` 两段文档注释挤在一起（"本机密钥一侧"的注释挂在 `probeStorage` 上，`probeLocalKey` 没有注释）。
- `draft-store.ts` 的"没有 `crypto.subtle` → unsupported"一路没有测试（文件被排除，浏览器里造不出非安全上下文）。
- `write-atomicity.spec.ts` 的"写入之前"那一组：信号要经 BroadcastChannel 与绑定函数才到测试进程，慢机器上这段延迟可能比提交本身还长，十次都落在提交之后、全是"新的"；用例不断言结局的分布（按设计），覆盖会悄悄变弱。可以在附件之外至少记一行"这次有几次冻在提交之前"，或接受。

## 二、结论

**修复后通过。** B1 必须在合并之前修（否则 CI 的 webkit 分片红、crash-webkit 也跑不到），修完在 Linux 容器里把 webkit 的 `specs/outbox`、校准与崩溃项目复验一遍。B2–B5、B7、B8 建议一并处理（B3、B4 是存活的变异，补测试的工作量小；B5 影响 DEF-072 的方向）；其余记录在案即可。

## 三、核实为没问题的要点

- **断言对设计 §3 的覆盖**：§3.4.1 的四种不可用（unsupported、denied、newer-version、blocked）、versionchange 让开、断开重开一次、连着两次如实失败；§3.4.2 登记与 superseded（含 sameEpoch）、force；§3.4.3 ok/duplicate/not-writer/stale-seq/foreign-draft/adoptSeq、去重；§3.4.4 三种重封；§3.4.5 delete/rebase/absent/not-writer/needs-rebase；§3.4.6 revoked/corrupted/newer-format/malformed（含"在途序号大于草稿序号读成 malformed"）；§3.4.7 放弃带 expectedSeq、按用户清理、保留期按读得出的时间、列表索引不建库；§3.4.8 load-failed、写入途中终止不挂住、strict；§3.8 写读、句柄独占与退避、删库之后写回连同写入者、lost、不复活、补写镜像、写满、合一的清理——都有浏览器层用例钉住，断言的是结果本身（不是"跑完了"）。
- **确定的交错**：`writer-fence.spec.ts` 用第三个标签页撑着两个仓库上的读写事务，轮询到写入/登记的事务确实建好再发起另一个——靠的是 IndexedDB 按建事务的先后调度重叠范围的读写事务，确定。
- **压力下稳定**：`specs/outbox` 两个 Chromium 系 ×3 次、12 个工作进程 276/276；Linux 容器（比本机慢）里 chromium 全过。
- **崩溃工具**：只从这次启动的根往下认（树 ∪ 进程组 ∪ 命令行提到资料目录 ∪ macOS 安装目录下的 XPC），名字只用来分角色；需求方的 Chrome（同一个可执行文件）、系统 WebKit 与 Safari 的进程都认不进来（Safari 的 XPC 在 `/System/Library/...`，不在 Playwright 的安装目录）；冻住之后现取进程表、同一循环结束；号被复用的立即 SIGCONT；结束之后再认一遍、按"进程号 + 启动时刻"核对没有幸存者，僵尸算退出；3 秒的时限对 SIGKILL 够、又不掩盖漏结束 XPC（丁的 E2E 变异验证）。
- **项目配置**：`workers: 1` 是 Playwright 1.63 支持的项目级选项；崩溃项目依赖全部浏览器项目、restart 依赖崩溃项目；Playwright 每个阶段结束都 `await dispatcher.stop()`（我读了 1.63 的 runner 源码），所以 crash-webkit 开始时浏览器项目的 WebKit 都已关掉，不会被"另有实例"误伤；外部模式不定义崩溃项目；跳过的条件（进程内放置只在 WebKit、删库与日志只在 Chromium 系）与设计一致，`browserName` 对 chrome、msedge 也是 chromium。
- **LevelDB 日志的读法**与 LevelDB 的 `log::Reader` 一致：块尾不足 7 字节的跳过（文件末尾非零才算写了一半的头）、类型与长度都为 0 跳过这一块、最后一块里内容不够算写了一半（EOF）而中间的块算 bad record length、校验不符算损坏；补的只有头的记录在块尾放不下时先补零；当前日志按编号的数值取最大。丁的 18 处变异都被拦下。
- **测试库的命名与清理**：库名带主机标识与进程号，只清本主机建的、创建它的进程已不在的；别的主机与旧写法一律不动；模板库只删没人连着的、不用 FORCE、等锁 1 秒，删的一刻有人用就跳过；建模板与复制都在同一把 advisory lock 下（所有运行都连同一个维护库，锁对它们都有效）。同一主机上没有删掉在用的库的路径；CI 每个 job 一台机器、一个库服务。
- **门禁与 lint**：测试专用的来源（`features/sheet-editor/outbox/testing/`）、产物名与禁用关键字（`__nerveOutboxProbe`、`__nerveCrashProbe`）登记齐全，生产构建上 artifacts、budgets 通过，平台首屏仍是 175.8 KiB；lint 的区域规则与已有规则的覆盖关系我逐块核对过（同名规则后者整体覆盖前者）：新的几块都是在原有限制上加，没有丢掉更严的那几块（应用入口、弹窗、编辑器、页面自检入口各有自己的、排在后面或被排除），自测覆盖了静态/类型/副作用/再导出/动态与放行。
- **判定与数据**：`probe-verdicts.ts` 的标准与报告 §三一致（第 10 项的文字见 B12）；真实 Safari 结果文件与三个浏览器的 measure 结果里，报告第 2、3、9、9-production、10、11、12 项的数逐个对得上；ADR-020、计划书 r22、总设计、延期登记引用的关键数字（0/55、p95 88 ms、strict +1 ms、写入 p95、镜像 1–3 ms、同步段 11/51 ms、gzip 阻塞 50 ms）与报告一致。
- **OPFS 在默认上下文**：Linux 的 WebKit 默认上下文同样没有 OPFS（`pipeline.spec.ts` 期望的 `not-mirrored:unsupported` 在容器里成立），Chromium 系默认上下文有（在内存里）。

## 四、证据

- 日志：`scratchpad/m4-p1-review-b-logs/`（`lint.log`、`typecheck.log`、`unit.log`、`e2e-outbox-1.log`、`e2e-outbox-stress.log`、`e2e-crash-1.log`、`gate.log`、`m1-*`、`m2-*`）。
- Linux 容器：`scratchpad/m4-p1-review-b-linux/`（`run.sh`、`inside.sh`；`out/outbox-calib.log`——B1 的 14 条失败；`out/mirror-webkit-ascii.log`——不带中文的资料目录之后全过；`probe/webkit-path.mjs` 与 `probe/persistent-profile-ascii.patch`）。
- 冷热的数据（B5）：`scratchpad/m4-p1-probe-measure-40/*.json` 的 `perf.script-transfer-bytes` 与 `perf.incremental#1`；`scratchpad/m4-p1-probe-safari-results/2026-10-09T16-45-18Z.json`。

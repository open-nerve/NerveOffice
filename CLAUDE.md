# NerveOffice 协作约定

**2026-10-29 最新断点：已批准的 CSRF 跨模块修复完成局部验证与独审，准备 r06 完整门禁。** main/origin/main 仍为 `323b957b`，唯一 P4 分支与 worktree 保持。13 文件 / 1,005 项关联单元、web/E2E 类型、19 文件 lint、新生产构建与原产物/体积预算均通过；三浏览器真实存储 39/39、原交接/图片 60/60 均首次通过，零重试、跳过、flaky。独审发现的在途新失效和 IDB 决策前两处窗口均先复现后修复，复审无未决问题，原 fence、故事断言与门槛保持。各轮临时根、短目录/别名、进程与锁已实际回收，完整报告已归档。旧 full15 的 395 项通过、1 项失败及未完成状态保留，不作为新源码验收。接续 r06/full16/container05、正常合并推送与同最终 SHA CI；P4 未关闭，P5 未开始。详见[协调复核](docs/v0.1/M5-表格能力与资源/reviews/P4-S6-CSRF停写与确认协调复核.md)。

自部署、单租户的团队在线文档平台（在线表格 + 文字文档），基于 Univer 开源 SDK 构建。

**full15 启动前的局部修复记录**：M0–M3 已完成并打标；M4 工程交接及 M5-P1/P2/P3 工程交付已完成。唯一 P4 分支/worktree 为 `codex/m5-p4-history-gc`，主目录保持 main；main/origin/main 为 `323b957b`，Phase 已正常提交数据库修复 `50ba1c8d` 与 WebKit 有界诊断 `1deac003`，尚未再次合并/推送。Chrome 图片修复仍在该工作副本验证；**P4 尚未关闭，P5 尚未开始**。

最终 CI `40787715273` 的 verify 中，七万资源关系替换 15,162 ms 后收到 PostgreSQL `57014` / statement timeout，现场为逐行活动触发器 INSERT；16,967 项通过、1 项失败。完整 coverage 因失败缺失，资源核验随之拒绝，不能接受。最终结果为verify、Chrome、WebKit失败，Chromium、Edge、容器成功。两项浏览器均为首次失败、重试通过的flaky，原件已保留并独立调查；不把其余成功替代失败。旧 CI `40718430340` 的 SQLSTATE/cause 仍未知，本次事实不回填旧故障。

新增向前迁移 0038 将当前/检查点的 INSERT 活动改成同事务集合写入，UPDATE 原逻辑、FK、GC/升级屏障及原时限/七万规模保持。真实小样例 RED→GREEN、旧库迁移及 schema-parity 20 项、既有协议回归 99 项、原七万定向用例已通过；独立代码审查未发现阻断。完整静态与默认 coverage（708文件、16,987项）均已通过并正常提交，源码前后不变，详见[局部复核](docs/v0.1/M5-表格能力与资源/reviews/P4-S6-引用活动批量写入复核.md)。该coverage尚不覆盖后续浏览器改动。

Chrome 图片401已完成局部复验：失败来源独立保留，原始请求取消先到也不丢失；页面匹配本机stopped后沿原流程补一次真实确认。原544次循环在中间失败轮 `chrome-images-local01` 的trace降为1次；中间一轮编辑失败保留，两个页面交错RED复现后局部补修通过505项关联回归、lint/全仓typecheck，原六种图片失败场景最新6/6首次通过，零重试/跳过/flaky，原产物和体积预算通过。`beginRestore`、共享会话/恢复协议及原时限均未改，见[当前计划](docs/v0.1/M5-表格能力与资源/plans/P4-S6-图片401恢复边界.md)。WebKit原Linux导航故障仍未知；macOS原故事首次通过但诊断incomplete，下一轮真实Linux CI仅新增有界诊断，原时限/重试/flaky门禁保持，见[诊断交付](docs/v0.1/M5-表格能力与资源/reviews/P4-S6-WebKit登录导航诊断.md)。当前完成局部独审/提交后，继续准备r05的新来源完整本机/容器门禁、正常合并推送及同最终SHA CI；不把局部通过当作P4关闭。

full14/container04 对干净 `6de31f16` 的原有同源接受继续有效：706 文件 / 16,968 项单元集成、2,421 E2E 通过及16既有跳过，容器339/339；4,589项源码与16份SDK一致且临时资源实际回收。但它们不覆盖新增0038。诊断 CI `40742680031` 的六项/十原件能力证明也不替代新最终 CI；旧轮次工具、证明及失败原件均保留。

用户已批准[方案 B](docs/v0.1/M5-表格能力与资源/reviews/P4-S6-CI清理边界复核与调整建议.md)：本机严格删除；固定一次性 GitHub VM 只在显式身份绑定、生产者退出、无已知本轮引用和稳定报告核验后登记 `host-disposal-pending`，原环境留待宿主销毁。该状态不等于删除完成、全局无引用或测试通过；实际托管 VM 最终销毁未作已观测声明。上一轮 r04 的 14 份工具、7 份 wrapper 已在 full14 前冻结，before/after 已采集，不改动旧证据或补签起点。

当前详情与历史失败统一见 [P4 最终验收记录](docs/v0.1/M5-表格能力与资源/reviews/P4-S6-最终CI与关闭复核.md)、[P4 交接单](docs/v0.1/M5-表格能力与资源/handoffs/P4-交接单.md) 及主目录 `.codex/handoffs/m5-p4-20261022/progress.json`。重型测试串行、每轮结束及时处理残留。Linux 安装探针共享 Docker 虚拟机约 345 MB 已删除文件旧句柄仍挂账，不重启其他项目使用中的 Docker；Excel、Safari/Finder，以及 M4 DEF-073/UR-035、完整验收和标签继续挂账。

## 先读

- `docs/v0.1/00-项目计划书.md`：范围、架构、评审决策与里程碑 M0–M8，是所有设计的上层约束。
- 当前 M 的 `00-M{n}-总设计.md`，以及正在进行的 Phase 文档。
- `docs/v0.1/02-延期事项登记.md`：已经延期的事项。

## 质量底线

- v0.1 是生产级 MVP，不是演示项目：**范围可以延期，质量门槛不能降**。
- 凡是本版要做的功能：模块边界清晰、符合 SOLID、测试完整（单元、集成、E2E），并且 E2E 覆盖每个模块的核心用户故事链路。
- 具体规范见《工程规范与完成定义》（`docs/v0.1/01-工程规范与完成定义.md`，已随 M1 总设计定稿）。

## 文档流程（JIT 滚动）

1. 以版本总纲为上层约束。
   - 每个 M 开始时，编写 `docs/v0.1/M{n}-<短名>/00-M{n}-总设计.md`。
   - 每个 Phase 开始时，基于最新代码编写 `NN-P{k}-<短名>.md`（架构设计与实施规划，拆到 Step 为止）。
   - Step 按需先写 spec，再写 plan；需求边界已经清楚的 Step 可以跳过 spec。
2. 不提前编写后续 M 或 Phase 的详细设计。
3. 审批与审查：
   - M 总设计必须经用户讨论并审批通过。审批后，用户会设定 goal，由 Claude 按下文"推进节奏与决策边界"自主逐个推进 Phase。
   - Phase 设计文档由 Claude 编写并自审后直接实施，不需要停下来等待确认。
   - 每个 Phase 完成后，必须做代码审查（优先由独立的审查者进行）→ 修复 → 复验，报告写入 `reviews/`。
4. Phase 收尾：
   - 更新 `docs/architecture/overview.md` 与 ADR；
   - 编写交接单，放入 `handoffs/`；
   - 把延期项登记到延期事项登记表。
5. 只能延期功能，不能延期质量门槛。触及 00 号计划书范围或上线门槛（A01–A20）的延期，必须走范围变更，并更新 00 号计划书的修订记录。
6. 各类文档的模板在 `docs/templates/`；文档与提交信息都使用中文。

## 推进节奏与决策边界

- **自主推进**：Step 之间、Phase 之间都不需要停下来。局部的问题调整、优化与加固，自行决策。
- **2026-10-18 接续决定**：用户批准将 M4-P6 已证实的 WebKit 导航依赖问题登记为 DEF-073/UR-035，完成其他收尾后继续 M5 规划。该项不再阻断无关开发，原浏览器支持范围与门禁保持；M4 完整验收和 `v0.1-m4` 仍挂账。只适用于此已登记问题，不能豁免其他失败。执行边界见 `docs/v0.1/M4-本地优先与离线恢复/handoffs/P6-WebKit导航阻断交接.md`。
- **2026-10-19 环境缺口接续决定**：用户明确要求 Excel 等环境不满足的项目先记账，不阻碍正常开发。M5-P2 的 Excel、Safari 与剩余 Finder 原生证据移入 `handoffs/P2-原生环境待验登记.md`；允许继续 S5、通过工程检查后合并 P2 并推进后续 Phase。未验证状态、补验条件与最终验收缺口必须保留；不能把产品缺陷、自动化失败或数据/权限问题归为环境后放行。遇到确实无法隔离的依赖才说明并暂停。
- **决策原则**：符合 SOLID；从根因解决问题；不打补丁，不乱接线。
- **必须停下来请示的情况**：
  - 架构回归；
  - 跨模块的协同调整；
  - 意料之外的高风险发现，例如 M0 中某个阻断项的结论为"不通过"。
- **停下来时**：先提交当前工作，再用大白话汇总问题和建议方案，等用户决策。
- **子 Agent 模型**：拉起子 Agent（实现、代码审查、探索分析）时，必须显式指定与主会话相同的模型，不得降级到更小的模型。插件 Agent 定义里写死的模型、技能中"选用更便宜模型"的建议，都以本条为准；`code-review` 插件命令的流程会拉起 haiku 和 sonnet Agent，不用于本项目的审查。

## 目录与命名

- 每个 M 一个目录：`docs/v0.1/M{n}-<短名>/`。目录里包含：
  - `00-M{n}-总设计.md`，以及各 Phase 的 `NN-P{k}-<短名>.md`；
  - `specs/`、`plans/`、`reviews/`、`handoffs/` 四个子目录；M0 另有 `reports/`，存放验证报告。
- 子目录内的文件统一加前缀，写成 `P{k}-S{m}-<短名>.md`；Phase 级的文件省略 S 段。Step 子目录只在某个 Step 有多份文件时才建。
- 编号只增不改。中途插入的 Phase 使用下一个可用编号，执行顺序以 M 的总设计为准。
- 文件名里不使用 `&`、空格等需要转义的字符。
- 跨阶段生效的决策，写成 `docs/adr/ADR-{nnn}-<短名>.md`。架构总览放在 `docs/architecture/overview.md`。这两个目录在第一次需要时再创建。

## 代码与依赖约束

- `refer/univer/`：Univer 的只读参考源码。不修改、不入库、不参与构建。
- `spikes/`：M0 的验证代码，不进入生产构建。生产代码从 M1 开始按正式流程编写，不从 spikes 直接搬运。
- Univer 依赖：
  - 所有 `@univerjs/*` 使用完全相同的精确版本；
  - 禁止引入 `@univerjs-pro/*`；
  - 优先使用公开的稳定 API；使用内部 API 时，必须在编辑器适配层集中封装并登记。

## Git

- 主目录始终停在 `main` 分支；需要分支时一律使用 worktree。Claude 路径为 `.claude/worktrees/<分支名>/`；Codex 路径为 `.codex/worktress/<分支名>/`（沿用 `worktress` 拼写）。
- **一个 Phase 只用一个开发分支和 worktree**，从完成上一 Phase 合并后的 `main` 建立。Phase 内各 Step、Task 的实现、修复与审查都在该分支内提交，不再拆小分支；Phase 的提交不直接平铺在 `main` 上。（用户 2026-10-10 明确约定）
- 设计文档和代码提交在同一个分支上。
- 提交节奏：每完成一个 Step（测试全绿）提交一次；每次停下来之前，都要提交当前的工作。
- 合并：整个 Phase 完成、验证与审查通过后，在主目录执行 `git merge --no-ff <分支名>` 合并到 `main`，保留分支提交线；清理已合并的 worktree 和分支后，再从 `main` 建立下一 Phase 的分支。
- 推送：只在合并到 `main` 之后推送 `main`；进行中的分支只保留在本地。
- 每个 M 结束时打 tag，例如 `v0.1-m1`。
- 提交信息使用中文，不添加 Co-Authored-By 等 AI 署名。

## 常用命令

环境：Node 与 pnpm 的版本见 `.node-version` 与根 `package.json` 的 `packageManager`（本机用 nvm 安装 Node，`npm i -g pnpm@<版本>` 安装 pnpm）；Docker 用于开发数据库。

全仓库类型感知 lint 会在同一进程保留多个 TypeScript 工程。M5-P1 实测已超过 Node 默认约 4 GiB 旧生代上限；`pnpm lint` 为 ESLint 单独设置 6 GiB 上限，`lint:fix` 复用该入口。开发机和 CI 运行 lint 时须预留相应内存；所有规则、文件范围与零告警要求保持。生产服务及图片子进程仍使用各自既定预算，禁止为此设置全局 `NODE_OPTIONS`。

`pnpm patch` 的解包编辑目录及生成的验证材料放在主目录 `.codex/handoffs/` 的任务目录中，不放入开发 worktree 的扫描树。嵌套 `.gitignore` 排除文件不代表 ESLint 也会排除：M5-P2-S3 曾误扫 `.superpowers/sdd` 的 SDK 副本而耗尽 6 GiB；逐文件核对后迁移原件，原始 lint 即通过，无需改规则或检查命令。迁移时保留原路径、摘要与 pnpm 编辑会话映射；之后重新启动外部 patch 编辑目录，不建立旧路径回指。

| 命令 | 作用 |
|---|---|
| `pnpm install` | 安装依赖，同时安装 git 钩子 |
| `pnpm verify` | 合并前的完整门禁：lint、类型检查、静态检查、单元与集成测试及覆盖率、构建、依赖与产物检查、E2E（本机的 Chromium、Chrome、WebKit；CI 另加 Edge） |
| `pnpm verify --fast` | 快速门禁（pre-push 使用；不需要数据库） |
| `pnpm dev:api` | 以监听模式启动后端（读取 `apps/api/.env.development`，先 `pnpm db:up` 与 `pnpm db:migrate`） |
| `pnpm dev:web` | 启动前端的开发服务器（`http://127.0.0.1:5173`，`/api` 代理到 `pnpm dev:api`） |
| `pnpm admin:init --username <用户名>` | 在开发库上初始化首个系统管理员（密码在终端里输入两次；非交互环境加 `--password-stdin`） |
| `pnpm admin:reset-link --username <用户名>` | 运维命令：为这个账户签发重置密码的一次性链接（标准输出只有链接，日志在标准错误；这个人的当前密码与全部登录随即失效；唯一的管理员忘记密码时用；容器里用 `docker compose exec`，见 `deploy/README.md`） |
| `pnpm lint` / `pnpm lint:fix` | 检查 / 修正代码规范与格式 |
| `pnpm typecheck` | 类型检查 |
| `pnpm test` / `pnpm test:coverage` | 单元测试 / 单元与集成测试合计的覆盖率（需要数据库） |
| `pnpm db:up` / `pnpm db:down` | 启动 / 停止开发用的 PostgreSQL |
| `pnpm db:migrate` | 构建后端并对开发库执行迁移 |
| `pnpm db:generate --name <名称>` | 按表定义生成迁移（人工审阅后入库；合并后的迁移不再修改） |
| `pnpm --filter @nerve-office/e2e run update:sheet-template` | 经编辑器页重新生成新建表格用的模板快照（SDK 升级或插件档案变更之后；需要 `pnpm db:up` 与构建，同 `pnpm test:e2e`） |
| `pnpm --filter @nerve-office/e2e run update:read-only-sample` | 同上，重新生成只读 E2E 用的样本（`tests/e2e/support/read-only-sample.json`：打开与画完每张表之后逐字节不变的形式） |
| `pnpm --filter @nerve-office/e2e run safari:selftest [--front] [--steps <步骤,…>] [--idle <秒>] [--idle-wait <秒>] [--timeout <秒>] [--runs <次数>]` | 在本机真实 Safari 上跑编辑器的页面自检（测试构建的 `selftest.html`：只读入口、公式、进入与退出编辑，M3-P4 起另有捕获时机——变更检测、公式时序的两种模式、自动行高、大表复制、组合输入、环境与隐藏之后存下，都观察真实的自动保存、核对服务器上的内容；M3-P5 起另有交接——两个标签页的本人接管（另一页照常回应、收不到交接消息）与刷新时在途的保存；M3-P6 起另有请求编辑的两条路 `request-waiter`、`paused-holder`，另一方由驱动脚本经接口扮演；M4-P1 起另有本机发件箱的复核——存储的事实、密钥交给 Worker、Worker 的停顿（探针 Worker 与生产的发件箱 Worker）、写入管道与 OPFS 镜像各段、捕获成本、首屏与公式冻结；共 29 步，一次约 20 分钟，`--steps` 只跑其中几步，整次运行默认限时 1800 秒（`--timeout`），`--runs` 是发件箱复核的运行次数（默认 40）；不进 CI）。Playwright 里的校准是 `specs/editor/selftest.spec.ts`，两种打开状态（暂停与 `E2E_AUTOSAVE=running`）都要通过。开头等用户空闲满 `--idle` 秒（默认 120，最多等 `--idle-wait` 秒，默认 1800），屏幕锁着不跑；跑的时候用户一动这一次就作废（退出码 4）；`paused-holder` 用一个写明用途的窗口盖住屏幕约 3 分钟，按 Esc 或点它中止。Safari 会暂停一开始就在后台打开的页面：窗口要露在外面，`--front` 把 Safari 带到前台；结果在 `tests/e2e/safari-results/`（不在 `test-results/` 里，Playwright 运行不会清掉） |
| `pnpm --filter @nerve-office/e2e run measure:switch` / `measure:memory` / `measure:probe` | 实测阅读与编辑之间切换的耗时（三个浏览器、三份文档）/ 反复切换的内存（Chromium，CDP 回收之后的堆与 DOM 计数）/ 本机发件箱的复核在三个浏览器的持久上下文（会落盘）里跑足次数（`MEASURE_PROBE_RUNS`，默认 40，每个浏览器约 9 分钟；M4-P1）；`measure:probe -- -g 冷热` 只跑首屏与公式冻结的冷热对照（`MEASURE_WARMUP_ROUNDS` 轮，默认 4，每个浏览器约 3 分钟；`MEASURE_WARMUP_FORMULA=main-thread` 换成主线程公式作对照，DEF-072）；不进常规 E2E 与 CI，机器空闲时跑；结果在 `tests/e2e/measure/test-results/` |
| `pnpm --filter @nerve-office/e2e run measure:local-save` | M4-P2 的真实本机保存端到端测量：三浏览器、约 1 MiB/5 MiB/perf-50k、在线与离线，默认每组 20 次（`MEASURE_LOCAL_SAVE_ROUNDS`）；使用持久浏览器目录、真实自动保存和 Worker，逐轮解密核对；不进常规 E2E/CI，不与其他检查并行；结果在 `tests/e2e/measure/test-results/local-save/` |
| 崩溃项目（M4-P1）：在 `tests/e2e` 下 `npx playwright test --project=crash-chromium --project=crash-chrome --project=crash-webkit --no-deps` | 写入中途结束整棵浏览器进程、以同一个持久目录重开（`support/browser-crash.ts`），核对本机发件箱读回旧的或新的一份、Chromium 删库之后从 OPFS 恢复；每个浏览器一个项目、项目里一个工作进程（三个项目之间并行）；macOS 上 crash-webkit 要求机器上没有别的 Playwright WebKit（工具认出时报错）；`pnpm test:e2e` 里也跑（重启后端的项目依赖它） |
| `node --expose-gc apps/api/scripts/measure-snapshot-inspection.ts` | 实测快照检查的子进程池（耗时、事件循环延迟、内存，DEF-018；先 `pnpm --filter "@nerve-office/api..." run build`；可以在生产镜像里跑，见脚本开头；不进 CI） |
| `pnpm test:integration` | 集成测试（需要数据库；先构建后端，进程测试用构建产物） |
| `pnpm test:e2e` | 构建后端与前端的测试构建后跑 E2E（真实后端与数据库，需要 `pnpm db:up`；端口每次自动挑选，后端日志在 `tests/e2e/test-results/e2e-server.log`） |
| `E2E_AUTOSAVE=running`（环境变量） | E2E 的夹具不暂停定时的自动保存（默认暂停，M3-P4），按生产镜像的样子跑；在 `tests/e2e` 下与 `--project=chromium --project=chrome --project=webkit --grep-invert @test-build` 一起直接 `npx playwright test`（要列出浏览器的项目：配置里的重启项目依赖所有浏览器的项目，命令行的 grep 不作用于被依赖的项目，不列就把 `@test-build` 的也跑了；写成 `--project=名字`，要跑的文件路径放在前面、后面都行——写成 `--project 名字` 时紧跟在后面的文件路径会被当成项目名，报 "Project(s) … not found"），核对容器 E2E 会跑的用例在自动保存照常运行时也成立 |
| `pnpm test:e2e:container` | 构建生产镜像，起一套测试环境（应用 + PostgreSQL + Caddy 的 HTTPS，见 `deploy/README.md`），对它跑 E2E（默认只跑 Chromium，`--browsers` 可多选）、公开生产流程的持久浏览器崩溃恢复和重启用例，跑完删除；生产 crash 仅选择 `production-recovery.spec.ts`，后端重启排在所有浏览器与 crash 项目之后；部署核对里另有本机密钥的主密钥（每次随机生成）缺失、写法不对时应用拒绝启动的两项，跑完扫各容器的日志里有没有主密钥；需要 Docker，各容器的日志在 `tests/e2e/test-results/container/`；放到后台跑用 tmux 或 `setsid`，不用 `nohup` |
| `pnpm build` / `pnpm clean` | 构建 / 删除构建产物 |
| `pnpm gate [名称…]` | A01 等检查：pins、config、stories、migrations、schema、deps、licenses、artifacts、budgets、audit |

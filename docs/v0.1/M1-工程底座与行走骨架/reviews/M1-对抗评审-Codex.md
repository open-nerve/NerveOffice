# M1 工程底座与行走骨架：对抗评审报告（Codex）

> 审查者：Codex（GPT-6）｜日期：2026-09-28｜审查范围：v0.1-m0..71ca6da｜结论：不通过｜处理：13 项全部修复并复验，见文末"处理与复验"（主会话，2026-09-28）

## 结论摘要

**不建议以当前状态合并并宣告 M1 验收完成。** 发现了编辑器加载阶段真实丢失输入的路径，以及保存重试、管理员初始化、认证时序和门禁的缺口。常规测试全部通过，不能覆盖这些组合边界。

正式发现共 **13 项：阻断 1、重要 9、一般 3、建议 0**。13 项均有本轮实测，纯状态机、输入变异和 CLI 替身的验证范围在各条明确标注，不混称为生产全链路。

本次仅写本报告，未修复生产代码。审查位置为指定 worktree `/Users/xiaoruan/project/nerve-office/.claude/worktrees/m1-p5-deploy`，分支 `m1-p5-deploy`，实际 HEAD 为 `71ca6da6da075396952f446299a7d2bf011238e8`，与指定版本一致；范围内 107 个提交。

最需要优先处理的事项：

1. **CX1：编辑器在 Worker 就绪前已经接受输入，但保存与离开保护尚未接上。** 20 秒后加载失败会直接销毁这些输入，关闭页面也没有提示。
2. **CX2：未知保存的请求身份不能跨重试稳定保留。** 编辑后撤销、再丢一次回包，或遇到认证拒绝后继续编辑，会把本页自己的提交误判成外部版本冲突，阻止继续保存。
3. **CX3、CX4：认证路径缺少两类真实边界。** UTF-8 标准输入分块能静默改写初始管理员密码；调整 Argon2 参数后，失败登录耗时可区分旧账户和不存在的账户。
4. **CX5、CX6：下层设计与上层承诺不一致。** `unit_id` 唯一约束阻止已批准的原样复制方案；有未提交输入时仍显示无条件的“已保存到云端”。
5. **门禁和部署工具还需要负向验证。** 本报告后续各项给出合法语法漏检、分发文件缺失及失败清理的实测证据。没有把这些结论扩大为“当前生产产物已含违规依赖”或“CI 必然失败”。

现有检查的正向证据也很充分：`verify --fast` 通过；覆盖率任务的 142 个文件、1835 个测试通过；本机 Chromium、Chrome、WebKit 加重启项目共 204 个 E2E 通过；生产容器 HTTPS 环境共 68 个 E2E 通过。API 在写入中被 SIGKILL、数据库连接被终止、事务尾部审计失败时，均未观察到半提交或已确认数据丢失。**本次没有执行远程 CI，也没有执行 amd64 容器；不能据本机通过宣称首次 CI container job 已验证。**

## 检查项

以下勾选表示已做审查，不表示所有检查均通过；缺口见对应 CX 条目和覆盖边界。

- [x] 正确性与边界条件：跟踪新建、读取、保存、会话和错误路径，并做并发、响应丢失、进程终止与编码实验。
- [x] 模块边界、依赖方向与 SOLID：核对 ESLint 边界、contracts、仓储/事务职责、编辑器适配层和内部 API 登记；发现模型假设与许可图遍历问题。
- [x] 测试是否充分：单元、真实 PostgreSQL 集成、三浏览器 E2E、生产容器 E2E 均执行；逐故事核对，指出现有用例未覆盖的组合时序。
- [x] 安全：认证、Origin、CSRF、代理头、输入上限、审计只追加、日志脱敏、CSP、数据库角色分离；发现参数升级时的用户名耗时侧信道。
- [x] 性能与资源使用：核对哈希队列、连接池/退出路径、产物预算；记录容器内存并测试 runner 信号及清理错误。未做磁盘耗尽、长时间压力、真实断电或 amd64 内存实测。
- [x] 文档：对照总设计、Phase 设计、ADR、架构总览、交接、既有审查及延期登记；明确区分文档存在与验收结论成立。

## 证据口径与复现环境

- “已实测”指实际运行了相应实验，不一概等于生产全链路。各项注明真实 HTTP/数据库/浏览器、纯状态机或隔离工具探针的边界。
- 报告内源码位置均相对上述 worktree，行号对应 `71ca6da`；不存在对后续修复版本的验证。
- 所列命令均在该 worktree 执行，实际使用前缀：`PATH=/Users/xiaoruan/.nvm/versions/node/v24.21.0/bin:/usr/local/bin:/opt/homebrew/bin:$PATH`。下文省略这个重复前缀。
- 独立探针放在 `/tmp`，不是仓库交付物。每项保留关键步骤、输入及实际输出，便于不依赖临时文件重建实验；其中生成的 UUID、端口和时间戳每次会不同。
- 自建数据库以 `codex_` 开头。整套集成/E2E 另使用审查专属 PostgreSQL 容器，避免测试框架的遗留库清理扫描影响共享开发库；容器及其全部库已删除。没有停共享 PostgreSQL、执行 `db:down`、清理他人的卷或操作 stash。

## 问题清单

| 编号 | 等级 | 类别 | 位置 | 问题 | 证据等级 | 处理 | 复验证据 |
|---|---|---|---|---|---|---|---|
| CX1 | 阻断 | BUG、逻辑链 | `sheet-editor.ts:122`；`editor-page.ts:367,398` | Worker 就绪前可输入，加载超时销毁内容，关闭无提示 | 已实测（真实浏览器/API/PG） | 已修复：载入期间编辑器页在窗口的捕获阶段拦下页头之外的一切用户输入（点击、悬停、键入、输入法、粘贴与拖放），包括 Univer 挂在 body 下的浮层（`interaction-barrier.ts`）；刷新（F5、Ctrl+F5、Ctrl/Cmd+R）与 Tab 由浏览器照常处理，但不传给 SDK；保存状态机建好之后才撤掉。第一版另在创建工作簿后 `setEditable(false)`、屏障只拦编辑器的容器，独立复验发现前者被 SDK 的权限初始化改回可编辑、后者挡不住批注浮层（N1）；放行按键的第一版没有停止传播，被 SDK 的快捷键接住（第二轮复验）；都已改正。先试的 `inert` 让 Univer 的聚焦失败，没有采用；ADR-010、P4 设计同步 | 单元测试：交互屏障 36 项，编辑器页 4 项（撤掉屏障之前保存状态机已订阅修改；失败、卸载时撤掉；能编辑时不调用 setEditable）；E2E（本机三个浏览器）"编辑器就绪之前不能输入"（画布上双击、键入、回车都进不去）、"重开时就绪之前改不了批注"（悬停不弹出浮层、键入无效；就绪后悬停照常弹出、内容没变）与"重开时就绪之前按 Tab 与 Ctrl/Cmd+R"（内容不变，就绪后照常键入）；后两条换回各自之前的实现时都失败；Codex 浏览器探针复跑：载入期间的截图里 A1 为空、选区没动 |
| CX2 | 重要 | BUG、逻辑链 | `save-coordinator.ts:173,189,226` | 未知保存身份在重试中丢失，误判自己的提交为外部冲突 | 已实测（浏览器及状态机） | 已修复：同一个 requestId 的请求不可变，重试原样再发（序号、快照都不变）；成功后按这次捕获的序号确认；结果未知的记录另存"内容相同的最近一次捕获"，被后来的明确拒绝（401、403 等）不删，requestId 被占用时例外（下次换新的）；ADR-011、P4 设计 §3.7.2 同步 | 单元测试 5 项，旧实现上其中 4 项失败；Codex 状态机探针的复验版（同样的调用序列）：四次请求依次为 id-1/序号 1/基准 1、id-1/1/1、id-2/2/1（409，认出自己追自己）、id-3/2/2，最后"已保存到云端"；Codex 浏览器探针复跑：两次重发的 requestId 与序号都相同（都是 1），最后"已保存到云端"，没有冲突提示 |
| CX3 | 重要 | BUG、测试 | `password-input.ts:14` | UTF-8 跨块解码静默改写初始管理员密码 | 已实测（CLI/登录） | 已修复（分叉实施，主会话审阅）：标准输入按 UTF-8 流式、严格解码，不合法的 UTF-8（含结尾只有半个字符）以 REQUEST_INVALID 失败，不替换成 U+FFFD；开头的 BOM 去掉 | 单元测试：中文与 emoji 在每个字节位置切成两块、三块、逐字节送入都能还原，6 种不合法写法报错；集成测试：真实进程分两段写入（段间停 1.5 秒）之后按原密码验证通过，不合法的 UTF-8 退出码 1、不建账户；Codex 探针：original_login=200、corrupted_login=401 |
| CX4 | 重要 | 安全、逻辑链 | `users.service.ts:45,70` | Argon2 参数升级时失败登录泄露旧账户存在性 | 已实测（本机 HTTP 耗时） | 已修复（分叉实施，独立复验之后主会话改）：验证失败时，在同一个哈希名额里等到"各组参数实测耗时的中位数里最慢的 × 1.2"；各组参数的耗时由验证、哈希与启动时的校准（库里现存的参数组各算 3 次，只读参数段）记下。第一版按"内存 × 迭代次数"补计算量，独立复验测出改内存时仍可分辨（N2：256 MiB 调到 19 MiB 时比值 1.54），改为按耗时；ADR-007 同步 | 单元测试（假时钟与假计算）：只有当前参数、调高、调低、改内存、中位数不受偶然的慢影响、补齐在同一个名额里；集成测试（真实 Argon2 与数据库）：迭代次数与内存调高、调低四种情形，耗时之比都在 0.8–1.25；五种情形的实测比值 0.99–1.02（256 MiB 调到 19 MiB：219.0 对 218.5 ms），按计算量补齐时该情形是 1.54、收紧后的测试失败；Codex 探针（第一版时）：84.0 对 83.4 ms（修复前 16.5 对 85） |
| CX5 | 重要 | 设计、逻辑链 | `schema/documents/index.ts:42`；迁移 `0006:48` | unit_id 唯一约束与原样复制方案冲突 | 已实测（数据库约束） | 已修复（分叉实施，主会话审阅）：新迁移 `0007_document_unit_id_not_unique` 去掉 `documents_unit_id_key`（已合并的 0006 不改）；schema、ADR-011、P4 设计与架构总览同步 | 集成测试：两份 unitId 相同的文档各自保存、读取互不影响，别的 unitId 的快照仍返回 422；`migrations`、`schema` 门禁通过；Codex 探针：保留 unitId 的复制插入成功 |
| CX6 | 重要 | 设计、逻辑链 | `save-coordinator.ts:147`；P4 设计 `:283` | 有未提交输入仍无条件显示已保存，与 A14 不符 | 已实测（浏览器/API） | 已修复：适配层用 Facade 的 SheetEditStarted、SheetEditChanging、SheetEditEnded 跟踪单元格里还没提交的输入（`cell-editing-watch.ts`：键入字符或退格开始编辑、内容改动之后算，只是打开不算，按 Esc 放弃即消失；回车提交之后等这次的写入再清掉，值没变时最多等 500 毫秒，独立复验 S1），保存状态据此显示"有未保存的修改"；保存先提交单元格时也等这次的写入完成再捕获（跨工作表的提交，第二轮复验）；离开提示仍按编辑器开着判断；P4 设计 §3.7.2、ADR-010 同步 | 单元测试：编辑跟踪 18 项（含同一张表与跨工作表的提交、值没变、等写入）、保存状态 5 项（旧实现上其中 4 项失败）；E2E（本机三个浏览器与容器）"单元格里键入、还没回车"：键入即是未保存、Esc 回到已保存、双击只打开仍是已保存而离开会提示、键入之后是未保存、保存后服务器上是键入的内容；"编辑中的公式引用了另一张表时按保存"：服务器上有这次的公式，换回之前的实现时失败；Codex 浏览器探针复跑：CELL_EDITING 为"有未保存的修改" |
| CX7 | 一般 | BUG、逻辑链 | `document-revisions.repository.ts:73` | 等价 UUID 大小写的并发新建错误 409 | 已实测（HTTP/PG 并发） | 已修复（分叉实施，主会话审阅）：新建的 advisory lock 锁键改为 `requestId::uuid::text`，与唯一列用同一个相等定义；ADR-011 同步 | 集成测试：10 组、每组小写与大写各两个请求并发，全部 201、同一份文档、一条修订与一条创建审计，换回旧锁键时第 1 组就出现 409；Codex 探针：10 组全部是两个 201、同一个 id |
| CX8 | 重要 | 门禁 | `container-images.ts:33,43` | 合法 YAML/JSON RUN 可绕过版本锁定检查 | 已实测（门禁/Compose） | 已修复（分叉实施，主会话审阅）：YAML 用 `yaml` 包按语法解析全部文档，认任何层级的 image、工作流的 jobs.<id>.container 简写与 uses: docker://，展开锚点与别名；解析失败报 `pins/yaml-parse`，image 的值不是字符串报 `pins/image-unrecognized`；Dockerfile 的 exec 形式先解析成命令再检查 pnpm（顺带修掉 `pnpm@12.6.0"]` 被算成版本的误报）；P5 设计同步 | 单元测试：Codex 的三个样例，另有 flow 写法、带引号的键、锚点与别名、多文档、工作流的 container 与 services、解析失败、JSON 形式的 RUN（不写版本、版本对、版本不对）；仓库现有 4 个文件认出的引用与改动前相同；Codex 门禁探针：flow 写法与带引号的键报 `pins/image-digest`，JSON 形式的 RUN 报 `pins/pnpm-image`（原来都是空） |
| CX9 | 重要 | 门禁、逻辑链 | `gates/run.ts:203` | 删除实际许可正文后产物门禁仍通过 | 已实测（真实 dist 副本） | 已修复（分叉实施，主会话审阅）：产物门禁核对随部署分发的 `THIRD-PARTY-LICENSES.md`：文件在、不为空，清单里每个包都有一节、许可一致、说有正文的确有正文、没有清单之外的包（`license-bundle/missing-text-file`、`text-mismatch`）；主会话另在容器 E2E 的部署核对里量镜像里的三个许可文件（同一个道理，分叉提出）；P1、P5 设计同步 | 单元测试（临时目录）；真实的前端产物（108 个包）通过；按 Codex 的做法复验：删掉正文报 `missing-text-file`，删掉一节报 `text-mismatch`；容器 E2E 的镜像许可文件核对通过 |
| CX10 | 重要 | 设计、门禁 | `dependency-graph.ts:33` | 服务端许可闭包跳过 workspace 独有依赖 | 已实测（真实 ls 输出变异） | 已修复（分叉实施，主会话审阅）：`collectInstalled` 遇到 `link:` 的工作区包，本身不计入，照常展开它的依赖，按路径防止成环；P5 设计同步 | 单元测试：只在 link 子树里的外部包被收集、成环、原有结果不变；生产依赖图 320 个、服务端 146 个，与改动前相同；Codex 探针：`server-workspace-only-zod` 为 `graphHasZod:true` |
| CX11 | 一般 | 门禁 | `artifacts.ts:95,433` | 静态字符串 timer 的间接取法未被扫描拦截 | 已实测（真实 Vite 压缩） | 已修复（分叉实施，主会话审阅）：JS 文件按语法树认"调用对象静态可知是定时器、代码参数是字符串"的调用（标识符、静态可知的属性名含计算的字符串下标、逗号表达式、`Reflect.get(…, "定时器名")` 的结果、`.call`、`.apply`、`Reflect.apply`），非 JS 的文本与解析不了的 JS 仍按写法匹配；静态判断不了的边界写进注释与 P1 设计，由没有 `unsafe-eval` 的 CSP 兜底 | 单元测试：各种写法与不应误报的样例；真实产物扫描零误报；Codex 定时器探针：压缩之后的 ``Reflect.get(globalThis,`setTimeout`)(…)`` 报 `artifacts/dynamic-code`（原来是空） |
| CX12 | 重要 | BUG、部署 | `container-e2e-cli.ts:142,357` | 同步 Docker 阶段阻塞取消，SIGTERM 后仍 up | 已实测（原 CLI 副本/替身） | 已修复（分叉实施，主会话审阅并实测）：长命令（构建、compose up、compose run、Playwright）异步执行、各在自己的进程组里，收到信号时转给正在运行的那一个（docker 第一次的 SIGINT 发给整个进程组，Playwright 只发给主进程），每一步之后先看有没有收到信号；同步的短命令带 120 秒超时；可测的部分抽到 `container-e2e-process.ts`；P5 设计、P5 交接单同步 | 单元测试：信号转发的规则（假时钟）、进程组与强制结束（真实子进程）；Codex 信号探针（加上新模块）：SIGTERM 之后约 0.5 秒退出、没有再 `compose up`（原来 6.2 秒后照样起环境）；主会话实测：真实构建期间发 SIGINT，1 秒内停下，buildx 报 `CANCELED`，没有残留的编排项目、镜像标签、临时目录与 buildx 进程；完整的容器 E2E 70 项通过 |
| CX13 | 一般 | BUG、部署 | `container-e2e-cli.ts:334,386` | 写日志失败导致 finally 后续资源清理不执行 | 已实测（原 CLI 副本/文件错误） | 已修复（分叉实施，主会话审阅）：清理的四步（收集日志、`down -v`、去掉镜像标签、删除临时目录）各自执行，前一步出错不跳过后面的；检查 down 的退出码；有一步失败就以非零退出 | 单元测试（`runCleanup`）；Codex 日志失败探针（加上新模块）：先记下"收集日志失败：EEXIST…"，之后 `down -v` 与去标签照常执行，临时目录没有残留，退出码 1（原来留下临时目录、没有执行 down） |

完整路径及行号链见逐条详情。“处理”“复验证据”两列由主会话在修复与复验之后填写，汇总见文末的“处理与复验”。

## 逐条详情

### CX1：Worker 就绪屏障之前已可编辑，加载失败会销毁输入

**等级：阻断。类别：BUG、逻辑链。证据：已实测，真实浏览器、生产前端、API 和 PostgreSQL。**

位置：`apps/web/src/editor/sheet-editor.ts:104`、`:122`、`:123`、`:141`；`apps/web/src/features/sheet-editor/editor-page.ts:295`、`:367`、`:378`、`:381`、`:398`。

创建 workbook 后界面已经渲染并接受鼠标/键盘；工厂仍等待主线程与 Worker 的 IMAGE 策略安装回报。`editor-page` 要等工厂 Promise 完成才创建保存状态机。在这段窗口内，保存是空操作，`hasUnsavedWork()` 返回 false。20 秒期限到达后，工厂直接 `cleanup.run()` 销毁已能编辑的 workbook。

这违反 M1 总设计 §6.6“没有回报或安装失败时，不允许编辑”和 P4 §3.6.7，也切断 US-M1-04/05 的输入、保存、离开保护链。此处是初始加载窗口，不是延期到 M4 的已就绪 Worker 崩溃恢复。

复现：用 Playwright 仅延迟 `**/*formula.worker*.js` 下载，保持真实主线程与编辑器；打开新建表格，在“正在打开表格…”期间向 A1 输入文字并按 Enter。分别测试关闭页面和继续等待超时。脚本 `/tmp/codex-m1-browser-probe.mjs`，执行 `node /tmp/codex-m1-browser-probe.mjs`；脚本使用真实 API 创建自己的库并在最后删除。

```text
WORKER_LOADING {"surface":"loading","status":"正在打开表格…","canvasVisible":true}
WORKER_LOADING_BEFOREUNLOAD {"prevented":false}
WORKER_LOADING_CLOSED {"closed":true,"dialogs":[]}
WORKER_TIMEOUT {"surface":"failed","hidden":true,"canvasCount":0,"alert":"编辑器加载失败，请刷新页面重试","serverA1":null}
```

截图额外确认 A1 已出现输入、选区已移到 A2，排除了“只是还未提交的编辑缓冲”。关闭使用真实 `page.close({runBeforeUnload:true})`，不是仅凭合成事件下结论。网络延迟探针没有替换 SDK 或启用编辑器测试接口；实际 Worker 文件未缓存、请求卡住等也会形成该窗口。

**影响：** 用户已经输入并提交到单元格的内容既不能保存，又可能自动消失或关闭时无提示丢失。没有额外声称此实验证明了 IMAGE 安全策略可被绕过。

**根因修法：** 从创建开始建立不可交互的就绪屏障，直到 Worker 策略成功、保存状态机及离开保护均绑定后再开放输入；覆盖键盘、鼠标及菜单入口。只提前挂 `beforeunload` 不足以解决超时自动销毁。补真实浏览器的慢 Worker、Worker 失败、期限内恢复三个路径，检查就绪前不能接受修改。现有工厂 mock 的成功/失败测试及等待 ready 后才输入的 E2E 没有覆盖中间态。

### CX2：同一保存的请求身份被重试覆盖，历史未知提交又会被后来的拒绝删除

**等级：重要。类别：BUG、逻辑链。证据：已实测；主场景为真实浏览器全链路，认证拒绝场景为生产状态机探针。**

位置：`apps/web/src/features/sheet-editor/save-coordinator.ts:173`–`:175`、`:179`–`:191`、`:226`；后端对照 `apps/api/src/modules/documents/payload-digest.ts:16`、`document-content.service.ts:118`–`:129`。

`prepare` 在快照和基准不变时复用 requestId，却使用新的 localSeq；`unconfirmed.set` 随后覆盖原身份。服务端按相同正文/基准返回原幂等结果，保留第一次提交的 source.localSeq。之后的来源匹配只查 Map 中的 localSeq，无法认回本页自己的提交。

真实浏览器复现（同 CX1 脚本）：

1. A1 输入并提交，保存 seq=1。拦截 PUT，先 `route.fetch()` 让服务器真正提交，再 `route.abort()` 丢弃回包。
2. 修改 A1 再撤销，使快照字节完全回到原样，而本地序号变成 3；保存重试同 requestId，并再次在服务器返回 200 后丢弃回包。
3. 恢复网络，修改 A2 后保存。没有第二位写入者，却显示“别处保存了更新的版本”，保存按钮被禁用。

```text
REAL_RETRY_UNDO {"attempts":[{"requestId":"57cd9c74-98de-45f5-92ad-20d485fab81b","localSeq":"1","status":200},{"requestId":"57cd9c74-98de-45f5-92ad-20d485fab81b","localSeq":"3","status":200}],"sameRaw":true,"status":"版本冲突","alert":["别处保存了更新的版本。本页的修改没有保存；需要的话先复制出来，再重新加载查看最新版本\n\n重新加载"]}
```

另一个同根因路径：首次请求已提交而响应丢失；相同请求重试遇 401，`fail` 删除此前 unknown 记录；同一用户重新登录后**继续修改一次**再保存，会收到来源 seq=1 的 409，却只剩 seq=2 的记录，仍误判外部冲突。

命令：`node --experimental-transform-types /tmp/codex-save-rejection.mts`。此探针直接导入生产 coordinator，以受控 send 返回网络错误、401、带原来源的 409；没有声称这一分支也重新做了浏览器全链路。

```text
calls: id-1/seq1/base1 → id-1/seq1/base1 → id-2/seq2/base1
reauth: 1
view: status=conflict, source.localSeq=1, canSave=false
```

反证：登录恢复后不改内容的版本没有复现，新的在途记录恰好还是 seq=1，系统可自动重基准；因此复现明确保留“继续修改”。服务端独立 HTTP 实验还确认同 id、同正文、seq=1→99 得到同一 revision/savedAt，后续冲突 source 仍为 1；这个服务器行为本身符合现有幂等摘要设计，不另算后端 BUG。

**影响：** 合法网络恢复被误判成永久版本冲突，用户被迫复制内容或重开，无法正常继续保存。未证明数据库损坏或静默覆盖他人的版本。

**根因修法：** 区分逻辑请求、单次 HTTP 尝试与当前编辑捕获。相同 requestId 重试必须复用首次不可变信封（baseRevision、clientInstanceId、localSeq、snapshot）；另存 captureSeq/settled，处理 200 时正确确认本轮等价快照。历史未知提交不能被后一次 401/403 推翻。仅“Map 不覆盖旧 seq”不够：首次没到服务器、第二次以新 seq 提交时仍会错。补首发提交/未提交、重试丢包/401/403、撤销回原内容/继续编辑的组合回归。

### CX3：标准输入按块解码，合法中文管理员密码会被静默改写

**等级：重要。类别：BUG、测试。证据：已实测，真实 CLI → PostgreSQL → HTTP 登录。**

位置：`apps/api/src/cli/password-input.ts:11`–`:15`；调用链 `cli/admin-password.ts:19` → `cli/init-admin.ts:16`–`:17` → `modules/users/admin-initialization.service.ts`。

每个 Buffer 分别 `toString('utf8')`，没有保留跨 chunk 的多字节字符状态。管道 chunk 可以在任意字节处分开；替换产生的 U+FFFD 仍通过密码规则，从而初始化成功但使用了不同密码。

命令：`node /tmp/codex-auth-stdin-repro.mjs`。在自己的空库启动真实 `dist/cli/init-admin.js --username codex_admin --password-stdin`，用测试密码 `密码安全正确非常重要1234`，先写 UTF-8 的第一个字节，500ms 后写剩余字节；随后启动应用登录。

```text
admin_init_exit=0
admin_init_success_log=true
original_login=401 INVALID_CREDENTIALS
corrupted_login=200 OK
cleaned_database=codex_auth_stdin_15445
```

纯函数复现中返回的密码以 `���码` 开头，与输入的 `密码` 不同。现有 `apps/api/src/cli/password-input.test.ts:18`–`:26` 传入完整 JS 字符串，未覆盖 Buffer 分块。

**影响：** 运维用合法非 ASCII 密码初始化得到一个无法按原密码登录的首个管理员；再次初始化又因已有管理员而拒绝。与旧 P3 A6 的控制字符问题不同，旧修法不能阻止这里的静默改写。

**根因修法：** 使用有状态 `StringDecoder`/流式 `TextDecoder`，或在限制总长度后收齐 Buffer 一次解码；补中文及 emoji 在各字节位置切分的测试，并保留真实 stdin 进程测试。

### CX4：Argon2 参数升级期间存在失败登录的用户名耗时侧信道

**等级：重要。类别：安全、逻辑链。证据：已实测，真实 HTTP、数据库及 Argon2。**

位置：`apps/api/src/modules/users/users.service.ts:45`–`:56`、`:70`–`:73`；`password-hasher.ts:47`–`:57`；`docs/adr/ADR-007-会话CSRF与登录限流.md:54`、`:67`。

不存在的用户名验证启动时用当前参数生成的 dummy；已有用户验证数据库 PHC 自带的旧参数。项目支持修改参数并在成功登录后重哈希，因此新旧参数并存是正常升级状态。旧 P3 A13 提前生成 dummy 消除了首次生成差异，没有处理这个状态。

命令：`node /tmp/codex-auth-timing.mjs`。默认迭代 2 创建用户后，设置 `NERVE_PASSWORD_ARGON2_ITERATIONS=20` 启动；交替请求已有用户名的错误密码和不存在的用户名，均返回 401。采样时用户名/IP 阈值分别调为 100/1000，仅为取得统计样本；没有声称绕过默认限流。

```text
existing={"milliseconds":[19.4,17.9,16.4,14.5,14.4,17.6,16.5,16.5,22.3,13.8],"median":16.5,"min":13.8,"max":22.3}
missing={"milliseconds":[90.9,84.8,88.7,86.3,80.3,88,82.8,82,85,77.9],"median":85,"min":77.9,"max":90.9}
cleaned_database=codex_auth_timing_17036
```

以上各自排除前两次预热；本机十次样本完全不重叠。默认限流下允许的少量请求仍走不同成本路径，但本次没有测远程网络分类准确率。

**影响：** 未认证客户端可据耗时推断尚未升级哈希的账户存在性，违背统一失败响应的时间承诺；没有密码绕过或账户接管证据。

**根因修法：** 将失败认证工作量/响应预算统一作为参数迁移策略的一部分，覆盖允许存在的各代 PHC 参数。简单再加一次当前 dummy 仍留下旧计算的差值，不能据此宣称修复。补旧/新参数混合账户、错误密码与缺失账户的预算回归。现有 `users.service.test.ts:55,63,88,103` 和 `tests/integration/src/auth/login.test.ts:75,113` 分别测统一错误和成功重哈希，没有合并验证这两个状态。

### CX5：unit_id 全局唯一与复制保留原 ID 的批准方案冲突

**等级：重要，M2 开始前修。类别：设计、逻辑链。证据：已实测，真实数据库约束。**

位置：`apps/api/src/db/schema/documents/index.ts:42`；`apps/api/src/db/migrations/0006_document_content.sql:48`；P4 设计 `04-P4-编辑器接入与在线保存.md:61`；`docs/adr/ADR-011-文档内容与保存协议.md:13`。

`docs/v0.1/00-项目计划书.md:656` 明确复制快照不改写 unitId 和工作表 ID，`:659` 记录分标签页验证；M1 总设计 `:190` 要求建模支撑后续加法。当前设计、ADR、数据库却同时规定 `UNIQUE(unit_id)`，因此不是仅漏写复制功能，而是当前不变量直接排斥已定方案。

命令：`node /tmp/codex-save-probe.mjs`。真实 API 建文档后，在自己的临时库执行：

```sql
INSERT INTO documents
  (space_id,type,title,created_by,status,revision,unit_id,profile,format_version,sdk_version)
SELECT space_id,type,'copied document',created_by,status,1,unit_id,profile,format_version,sdk_version
FROM documents WHERE id=$1;
```

```text
copy preserving unitId: {"code":"23505","constraint":"documents_unit_id_key","message":"duplicate key value violates unique constraint \"documents_unit_id_key\""}
```

**影响：** 当前空白新建正常；M2 复制或后续恢复为副本按批准方案会失败。为迁就约束而改写快照 ID 会引入已明确否决的内部引用改写风险。`tests/integration/src/documents/create.test.ts:84` 只验证两次空白新建的 unitId 不同，不能保护复制模型。

**根因修法：** 平台身份继续用 documentId；unit_id 与本快照一致且非空即可，允许不同文档复用。新增向前迁移删除唯一约束，同步 Schema、ADR 与设计，不修改已经发布的历史迁移；补两个 documentId 保留相同 unitId 的模型测试。

### CX6：存在未提交单元格输入时，仍显示无条件“已保存到云端”

**等级：重要。类别：设计、逻辑链。证据：已实测，真实浏览器和 API。**

位置：`apps/web/src/features/sheet-editor/save-coordinator.ts:138`–`:161`、`:209`、`:273`；`apps/web/src/editor/change-tracking/change-classifier.ts:6`；P4 设计 `04-P4-编辑器接入与在线保存.md:283`；M1 总设计 `00-M1-总设计.md:52`、`:98`、`:112`。

正常就绪后在 A1 输入文字，不按 Enter：界面持续显示“已保存到云端”，服务器没有该输入；按 Enter 才改为未保存。命令同 CX1 的浏览器探针。

```text
CELL_EDITING {"status":"已保存到云端","serverA1":null}
AFTER_ENTER 有未保存的修改
```

P4 设计主动排除了编辑缓冲，但上层 A14 明确“一有修改立即改为有未保存的修改”，未见这个缩窄作为范围变更或延期登记。现有保存 E2E 的常用输入辅助函数默认提交后再断言，因此看不见这一状态。

**影响边界：** 这是展示承诺不真实；不是保存协议损坏。缓冲可用 Esc 取消；`hasUnsavedWork()` 已把正在编辑计入离开保护；显式保存也先提交单元格，这两项工作正常。没有把服务器尚无文本直接等同为数据丢失。

**根因修法：** 持久化修改序号继续表示 workbook mutation，另暴露编辑缓冲状态给 UI；实际输入后显示“正在编辑，尚未保存”或未保存状态，取消编辑则恢复之前状态。无需逐键递增数据库修订，也无需提前交付自动保存。补未 Enter、Esc 取消、保存提交缓冲、保存期间继续输入的状态测试。

### CX7：同一 UUID 的大小写形式在并发新建时被误判为幂等冲突

**等级：一般。类别：BUG、逻辑链。证据：已实测，真实 HTTP 与 PostgreSQL 并发。**

位置：`packages/contracts/src/documents/documents.ts:99`；`apps/api/src/modules/documents/document-revisions.repository.ts:73`、`:77`、`:95`；`document-creation.service.ts:56`–`:59`、`:84`–`:85`。

contracts 接受两种大小写 UUID；PostgreSQL uuid 列把它们视为同值，但排队锁 `hashtext(requestId)` 使用原字符串。两个等价请求可拿到不同锁，同时越过“是否已创建”检查，后一个 insert 唯一冲突被转成 `REQUEST_ID_CONFLICT`。

命令同 CX5：`node /tmp/codex-save-probe.mjs`。对同一用户、同一 type/title，并发 POST 一个小写 requestId 与其 `.toUpperCase()`；另外做顺序重放对照。

```text
same UUID sequential casing: 201 201 true
same UUID concurrent casing: 10 组中 9 组得到 201 + 409 REQUEST_ID_CONFLICT
```

原日志保留逐组结果；三次实验一致出现 9/10 的误冲突。正常完全相同字符串的并发测试 `tests/integration/src/documents/create.test.ts:104` 不覆盖等价形式。

**影响：** 合法请求被错误拒绝，唯一约束仍阻止重复文档。当前浏览器通常原样重发 `randomUUID()`，故定一般；没有把它描述为普遍保存失败。另测 PUT 的大写 documentId、requestId、clientInstanceId 均正常，未扩大到所有 UUID 接口。

**根因修法：** 在输入边界规范化 UUID，或锁键使用 `requestId::uuid::text`；锁与唯一列必须采用同一相等定义。补真实数据库并发测试，验证全部请求返回同一 documentId，且只有一份修订和创建审计。

### CX8：镜像与 pnpm 的版本门禁漏掉合法 YAML / Dockerfile 语法

**等级：重要。类别：门禁。证据：已实测，原门禁函数及真实 Compose 解析。**

位置：`tools/src/gates/container-images.ts:33`、`:43`、`:136`、`:198`；入口 `tools/src/gates/run.ts:83`。

门禁按行正则识别 image 和 npm 安装命令。以下合法写法能避开锁定检查：

```yaml
services: { db: { image: postgres:18 } }
```

```yaml
services:
  db:
    'image': postgres:18
```

```dockerfile
# FROM 保持正确 Node 版本；摘要为语法格式有效的 64 位占位值（未拉取）
RUN ["npm", "install", "--global", "pnpm"]
```

命令：`node /tmp/codex-m1-gate-probes.mjs`。实际结果（只列规则名）：

```text
pins-flow-yaml: []
pins-quoted-yaml-key: []
pins-json-npm: []
pins-positive-unpinned: [pins/image-digest]
```

两个 YAML 又经 `docker compose -p codex-gate-parse -f <临时文件> config --images` 实测解析成功，输出 `postgres:18`。没有启动服务，也没有执行 npm install；JSON RUN 这一分支的证据为门禁实测和标准 exec 语法的静态确认。

**影响：** 未锁定镜像/包管理器的合法变更能通过 pins；当前已有 Dockerfile/Compose 的写法都正确锁定，未发现基线本身引用浮动镜像。P5 A5、RA2、SA1、SA2、TA1/TA2 的具体补丁没有解决只识别已见表面形式的根因；本次不重报已决定不处理的 ONBUILD 等边界。

**根因修法：** YAML 用语法解析遍历 Compose/workflow 的语义字段；Dockerfile 区分 shell 与 JSON RUN。相关语法不能解析时明确失败，不能当作没有引用。增加上述真实 Compose 对照及 JSON RUN 负测。

### CX9：实际许可正文文件缺失时，产物门禁仍通过

**等级：重要。类别：门禁、逻辑链。证据：已实测，当前真实生产 dist 的隔离副本。**

位置：`tools/src/gates/run.ts:203`–`:213`；`tools/src/gates/license-bundle.ts:12`–`:17`、`:26`–`:34`。

`artifactsGate` 检查 `.vite/third-party-packages.json` 中的 `licenseTextSource`，却没有检查实际随部署分发的 `THIRD-PARTY-LICENSES.md`。声明收集过正文不等于分发文件存在。

复现：完整复制当前 `apps/web/dist` 到 `/tmp`，调用原 `artifactsGate(tempDir)` 作基线，只删除副本的 `THIRD-PARTY-LICENSES.md` 后再调用。核心操作为 `cpSync(realDist,tempDir,{recursive:true})` → gate → `rmSync(tempDir+'/THIRD-PARTY-LICENSES.md')` → gate；从 `tools/src/gates/run.ts` 直接导入该函数。实际日志 `/tmp/codex-m1-license-artifact.log`：

```text
licenseBefore true
baselineViolations []
licenseAfter false
afterDeleteViolations []
```

主审再次用以下完整命令复核，输出同样为 `baseline true []`、`deleted false []`（临时副本在 finally 删除）：

```sh
node --conditions=@nerve-office/source --input-type=module <<'JS'
import {cpSync,mkdtempSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {artifactsGate} from './tools/src/gates/run.ts';
const temp=mkdtempSync(join(tmpdir(),'codex-license-final-'));
try {
  cpSync(resolve('apps/web/dist'),temp,{recursive:true});
  console.log('baseline',existsSync(join(temp,'THIRD-PARTY-LICENSES.md')),JSON.stringify(artifactsGate(temp).violations));
  rmSync(join(temp,'THIRD-PARTY-LICENSES.md'));
  console.log('deleted',existsSync(join(temp,'THIRD-PARTY-LICENSES.md')),JSON.stringify(artifactsGate(temp).violations));
} finally {rmSync(temp,{recursive:true,force:true});}
JS
```

**影响：** 打包/后处理漏文件时门禁仍声称 A01 通过；当前基线确实有该文件，没有声称已经发布了缺许可的包。这不是纯文案问题，而是“文件缺失时不得静默跳过”的实际反例。

**根因修法：** 将正文列为必需、非空产物，并核对包/版本条目与清单一致；或记录正文路径和哈希并实际读取校验。增加真实构建后删除正文必须失败的装配测试。P1 R4 处理收集来源，未覆盖最终落地产物缺失。

### CX10：服务端许可图遇 workspace link 会跳过整个依赖子树

**等级：重要，M2 开始前修。类别：设计、门禁。证据：已实测输入链，当前触发条件明确。**

位置：`tools/src/gates/dependency-graph.ts:33`–`:34`；`tools/src/gates/run.ts:144`–`:146`；`tools/src/deploy/cli.ts:20`–`:26`；`deploy/Dockerfile:37`。

服务端清单查询 `pnpm ls --prod --json --depth Infinity --filter @nerve-office/api`，只有 API 根。原始输出中的 contracts link 自带 zod 子树，但遍历函数见到 `link:` 就 continue。全项目依赖图能从 contracts 的独立根补齐；服务端单根清单不能。

实际先执行 `pnpm ls --prod --json --depth Infinity --filter @nerve-office/api > /tmp/codex-api-ls.json`，再由 `node /tmp/codex-m1-gate-probes.mjs` 在内存中只删 API 的直接 zod 入口，保留 contracts→zod，交原收集函数和完整性检查：

```text
server-workspace-only-zod: {"linkHasZod":true,"graphHasZod":false,"violations":[]}
```

**影响边界：** 当前 API 自己也直接依赖 zod，因而基线清单未因此漏掉 zod。缺陷在于将依赖移到 contracts、或给它新增独有生产依赖这一正常演进时，运行镜像包含的包不再进入服务端许可清单，且完整性门禁无报错。没有改 manifest、锁文件或安装依赖来制造“当前已违规”的印象。

**根因修法：** 不计 workspace 包本身，但仍递归遍历其外部依赖；或以 API 的完整 workspace 传递闭包作为查询根。测试必须含“外部包只存在于 link 子树”。P5 A10/RA3 的 deduped 完整性修复不能覆盖这里主动跳过的已展开子树。

### CX11：固定属性名取得的字符串 timer 动态代码仍漏过产物扫描

**等级：一般。类别：门禁。证据：已实测，真实 Vite 生产压缩后扫描。**

位置：`tools/src/gates/artifacts.ts:95`–`:100`、`:433`；`tools/src/gates/eval-and-function.ts:54`。AST 识别只覆盖 eval/Function；字符串 timer 仍靠直接调用形式的正则。

命令：`node /tmp/codex-m1-artifact-timer.mjs`。在仓库外调用已安装的 Vite，`write:false` 构建并压缩以下代码，再交给原 `scanArtifacts`：

```js
Reflect.get(globalThis, 'setTimeout')('globalThis.codexGateProof = 1', 0)
```

```text
压缩产物仍包含：Reflect.get(globalThis,`setTimeout`)(`globalThis.codexGateProof = 1`,0);
violations []
```

同批 `eval("x");fetch("https://evil.example/test")` 阳性对照同时命中 dynamic-code/address，排除扫描器根本没运行。

**影响边界：** 这是 US-M1-11 的扫描承诺漏检；生产 CSP 没有 unsafe-eval，仍会阻止字符串执行。本次没有执行该字符串，也没有证明 CSP 绕过。固定名称和固定代码字符串与运行时未知变量、DEF-022 的嵌入 HTML/CSS/data 文档不同。

**根因修法：** 对静态可判定的 timer callee/字符串参数使用 AST 识别，包含固定字符串属性访问；清晰登记无法静态判断的边界。无需追求对任意动态程序的完备判定。

### CX12：构建阶段的同步子进程阻塞取消，收到 SIGTERM 后仍启动环境

**等级：重要。类别：BUG、部署。证据：已实测，原 CLI 隔离副本和受控 Docker 替身。**

位置：`tools/src/deploy/container-e2e-cli.ts:68`–`:80`、`:142`–`:149`、`:357`–`:363`。

`run/capture` 使用没有超时的 `spawnSync`。JS 信号回调在同步子进程运行时没有机会执行；即使 run 返回，紧接着的 `interrupted` 检查也可能仍为 false，继续 up。

命令：`node /tmp/codex-m1-signal-probe.mjs`。将原 CLI 和两个源码依赖原样复制到 `/tmp`，通过链接复用既有工具依赖，仅 PATH 中的 Docker 换成记录调用的程序；build 等 6 秒返回 0，up 返回 1 结束实验。TMPDIR 也隔离。build 开始后只给 Node runner 发一次 SIGTERM，实际输出：

```text
alive500msAfterSignal: true
durationAfterSignalMs 6203
容器 E2E：起测试环境...
```

调用记录显示信号时间 `1790561572688`，其后 `1790561578694` 仍调用 `compose ... up -d`。没有对真实 Docker 构建发终止信号；实测证明的是原编排控制流，长期网络/daemon 卡住没有上限则由无 timeout 的同步调用静态确认。

**影响：** 用户请求停止后还会启动服务，CI 取消可能只能强杀，日志与清理保证受损。旧 P5 RB1/SB1/SB2 主要修复 Playwright 阶段，未覆盖同步 build/up 阶段。

**根因修法：** 长命令采用带时限、可取消的异步子进程，统一跟踪当前进程/进程组；初始化步骤间处理取消后才继续副作用。补进程级 build/up 期间 SIGTERM 回归。`vitest.config.ts:60`–`:62` 将 `*-cli.ts` 以“参数解析与输出”为由排除，但该 CLI 还承担资源生命周期；工具覆盖率不能证明这部分已测试。

### CX13：收集日志写文件失败，会跳过全部后续清理

**等级：一般。类别：BUG、部署。证据：已实测，原 CLI 隔离副本和文件系统错误。**

位置：`tools/src/deploy/container-e2e-cli.ts:333`–`:338`、`:385`–`:391`。

`finally` 第一条调用 `collectLogs`，其 mkdir/write 一旦抛错，后面的 compose down、镜像标签删除和临时密码目录删除都不执行。

命令：`node /tmp/codex-m1-log-failure-probe.mjs`。沿用隔离 CLI/Docker 替身，在副本把 `tests/e2e/test-results/container` 建为普通文件，制造确定的 mkdir 错误。实际输出：

```text
Error: EEXIST: file already exists, mkdir '.../tests/e2e/test-results/container'
  at collectLogs (.../container-e2e-cli.ts:334:3)
  at main (.../container-e2e-cli.ts:386:5)
remainingEnvironmentFiles [ 'nerve-office-e2e-18259-56cDtz' ]
```

调用记录在 up 后结束，无收尾 down、无 image rm。开始前防 PID 重用的 down 有执行，不把它误算成收尾清理。实际没有创建真实服务或填满磁盘；ENOSPC/EACCES 从同一无捕获写入点抛出的结论是静态推导。

**影响：** 异常诊断失败会留下容器、卷、镜像和含随机密码的临时目录；目录/文件权限本身正确，没有证明密码泄露。下一次 stale 清理不能替代本次清理保证。

**根因修法：** 日志采集与关键释放用嵌套 finally/独立错误聚合；一种诊断失败不能阻止其他资源释放。对 down 失败留下可安全重试的归属信息，并明确返回失败。测试应注入日志目录/写入故障，验证所有必要清理仍被尝试。

## 逻辑链核对

“通”仅指本轮核实的 M1 子范围；“断”列出断点，不把尚未实现的 M2/M4 功能计为 M1 缺陷。测试位置的 `tests/e2e/`、`tests/integration/` 均为当前受控测试，额外探针见各 CX 与执行台账。

| 要求 | 实现位置 → 测试位置 | 通 / 断及证据边界 |
|---|---|---|
| US-M1-01 初始化管理员 | `cli/init-admin.ts` → `admin-initialization.service.ts` 同事务用户/空间/审计 → `tests/integration/src/users/{admin-initialization,init-admin-command}.test.ts`、`specs/accounts/login.spec.ts` | **部分断：CX3。** 空库、已有管理员拒绝、事务、并发及正常登录有有效测试；stdin 字节分块没有覆盖。 |
| US-M1-02 登录、退出、过期、限流 | `auth` 服务/guards、`users.service.ts`、sessions/throttle 仓储 → 集成 `auth/*.test.ts`、E2E `accounts/login.spec.ts`、`editor/session.spec.ts` | **部分断：CX4。** 正常/错误、并发限流、退出撤销、过期处理通；参数迁移时统一失败耗时未成立。 |
| US-M1-03 个人文档列表 | `documents.service.ts`/repository 按个人 space 过滤，前端 document-list → 集成 `documents/documents.test.ts:59,73,88,99,107`、E2E `documents/document-list.spec.ts` | **通。** 本人过滤、游标、加载/空/失败状态有断言；没有发现把管理员身份当跨用户读取权限。 |
| US-M1-04 创建并进入编辑 | creation service → 模板/修订1/内容/审计 → 集成 `documents/create.test.ts`、E2E `editor/create.spec.ts:10,28` | **部分断：CX1、CX7。** 常规创建、真正编辑保存及重复请求通；初始就绪屏障和等价 UUID 并发缺口。CX5 是后续复制模型冲突，不冒称空白新建失败。 |
| US-M1-05 真实保存状态及离开提示 | `editor-page`/`save-coordinator` → gzip PUT → content service/transaction → 单测、集成 `documents/content.test.ts`、E2E `editor/save.spec.ts:61,75,93,123,145,165,180,199` | **断：CX1、CX2、CX6。** 正常按钮/快捷键、回包期间继续输入、公式缓存/跨表重算及就绪后离开提示通；加载、编辑缓冲与复合重试未覆盖。 |
| US-M1-06 重开内容一致 | GET 内容/revision 联查、快照加载 → 集成 `documents/content.test.ts:109,131`、E2E `editor/reopen.spec.ts:43,54,70` | **通（正常就绪链）。** 刷新、重新登录、值/公式/格式、未保存内容不出现、打开不标脏有实测；打开时的异常丢失另见 CX1。304 在 DEF-017，未重报。 |
| US-M1-07 拒绝旧版本 | document 行锁/baseRevision + conflict UI → 集成 `documents/content.test.ts:226,238`、E2E `editor/conflict.spec.ts:8,45,71` | **部分断：CX2。** 真正两标签页不覆盖、服务端保留 A、停止再保存通；“自己追自己”只测一轮未知，未覆盖覆盖/删除身份。另有本页内容保留的断言限制，见覆盖说明。 |
| US-M1-08 无权限与不存在相同 | 全局 SessionGuard、documents policy、读取/锁下 requireAccess → 集成 auth/documents，E2E `security/access.spec.ts:10,16,22,30`、`editor/access.spec.ts:9,27` | **通（M1 个人空间）。** API 与页面一致、未登录需认证。不能由此宣称 M2 团队权限和撤权已验证。 |
| US-M1-09 CSP、安全头及公式 Worker | securityHeaders/web-hosting、formula.worker、IMAGE 安装 → HTTP/hosting 集成，E2E `security/csp.spec.ts`、`editor/csp.spec.ts` | **部分断：CX1 的未就绪禁编辑承诺。** 页面/脚本/Worker/API 安全头、阳性对照、正常公式工作本机三浏览器通过；没有证明 CSP 绕过。Edge 仅有既有交接记录，本轮未跑。 |
| US-M1-10 容器及 API 重启 | Dockerfile/Compose/roles/migrate + 原子保存 → 容器预检，E2E `deploy/restart.spec.ts:61,78,121`，独立 SIGKILL 探针 | **核心数据链通，工具异常路径有 CX12/CX13。** 本机和容器强杀/重试均通过；restart 是独立 Chromium 项目，不是三浏览器各跑一次。amd64 CI 未跑。 |
| US-M1-11 违规被门禁拦截 | `tools/src/gates` → verify plan、lefthook、CI → gate 单测与本轮十类负样例 | **部分断：CX8–CX11。** 接线有效、阳性违规能失败，但不能由全绿推断合法语法、许可实物及依赖闭包全部被检查。 |
| A01 开源依赖 | pins/config/deps/licenses/artifacts/audit → 自测、完整 verify 接线、CI | **部分断：CX8–CX11。** 本轮基线通过不能消除独立负样例的漏检。 |
| A09 API 重启部分 | TransactionRunner 等待 COMMIT、内容/修订/审计同事务 → restart E2E、审计故障、PG backend 终止、SIGKILL | **通（本轮覆盖的 API 重启范围）。** 已确认内容完整，在途无半提交，重试幂等；浏览器异常按既有范围在 M4。 |
| A14 M1 界面真实 | 加载/错误/权限/保存状态与离开保护 → UI 单测及三浏览器 E2E | **断：CX1、CX2、CX6。** 不是所有可交互阶段都被保存状态机保护；未提交输入的显示也缩窄了上层承诺。 |

### M1 总设计 §8 的八条退出条件

| 退出条件 | 实现位置 → 测试/核验位置 | 通 / 断或待完成 |
|---|---|---|
| 1. US01–11 全部通过，本机三浏览器、CI 四浏览器 | `tests/stories.json` → 本机 204 E2E、coverage 1835 测试，CI workflow 四浏览器配置 | **未满足。** 已发现故事边界反例；本轮没有 CI 四浏览器执行证据。故事登记 active 不等于逐项验收。 |
| 2. A01、A09(API)、A14 验证完成 | 上表实现 → 门禁/重启/UI 实测 | **未满足。** A09 本轮通过；A01、A14 存在反例。 |
| 3. pnpm verify 与 CI 全绿 | `tools/src/verify/plan.ts`、`.github/workflows/ci.yml` → 本轮分项检查 | **本机分项通过，完整条件待定。** 执行了 `verify --fast`、coverage、build、E2E、其余 gate；没有将其冒称一次完整 `pnpm verify`，也没有触发 CI。 |
| 4. 构建容器、测试环境部署后 E2E 通过 | `deploy/` → 原 `pnpm test:e2e:container` | **本机 arm64 通。** 68 passed，含 HTTPS、受限数据库角色及重启；CI amd64 未执行。 |
| 5. Phase 审查/交接齐全，延期复核，DEF-001 关闭 | M1 `reviews/`、`handoffs/`、延期登记 → 文档核对 | **材料齐全，结论需按本报告修订。** DEF-001 已登记关闭；本轮未重新验证旧 Edge CI，未重报已接受延期。 |
| 6. 架构 v1、ADR 及工程规范由工具执行 | `docs/architecture/overview.md`、ADR001–012、gates/lint → 静态追链和负样例 | **文档齐全，强制部分有断点。** CX5 模型矛盾，CX8–CX11 门禁缺口。 |
| 7. 计划书按 r4 更新 | `docs/v0.1/00-项目计划书.md` 变更记录 → 与总设计 §6.8 对照 | **通。** r4 及后续 r5/r6 变更已记录；其中复制不改 ID 的承诺仍有效。 |
| 8. 打 tag v0.1-m1 | Git tags → `git tag --list v0.1-m1` | **待完成，输出为空。** 按当前合并前状态，不新报为代码缺陷；本审查没有创建 tag。 |

## 对旧审查、交接和延期登记的异议

- P4 对保存状态机“每一条路径”的覆盖说法过强。现有测试确实覆盖一轮回包未知、会话变化及撤销，但没有覆盖 CX2 的交叉组合；工厂 ready 之前实际可交互的窗口也未被 CX1 相关测试观察到。
- P4 §3.7.2 对“单元格未提交不算修改”的数据建模可以成立，但不能不改上层 A14 就直接把它推广为 UI 仍应显示已保存；见 CX6。建议同步修 UI 与设计解释。
- P3 A13 的 dummy 预生成修复有效，但仅解决首次请求额外计算，不能代表参数升级期间的时间侧信道已闭合；见 CX4。P3 A6 修复的控制字符路径不覆盖 CX3 的字节解码问题。
- P4 设计/ADR-011 对 unitId 的“唯一”规定与更上层复制策略矛盾；不能以实现符合这份 ADR 为由忽略 CX5。
- P5 A5/RA2/SA1/SA2/TA1/TA2 的 pins 修补、A10/RA3 的服务端依赖图补漏，分别只证明列出的样例通过；CX8/CX10 是新反例。P1 R4 的许可收集来源检查不等于 CX9 的分发文件验证。
- P5 RB1/SB1/SB2 的 Playwright 信号处理修法没有覆盖同步 Docker 阶段（CX12）；“无论成败收日志然后清理”也没有涵盖收日志本身失败（CX13）。
- P5 B1 的修复本轮得到支持：重启用例卡在 `document_contents` UPDATE，确实已进入写事务，不再是写入前强杀。独立 PG backend 终止和 API SIGKILL 也验证了回滚；不重复报告 B1。
- M1 收尾汇报的“全部退出条件已满足”不能作为当前最终验收事实：它自身仍列出合并后 CI、指标和 tag 待办，本轮又发现 A01/A14 反例。保留待办本身是正确的；不将用户已明确的首次 CI 待跑状态另凑一个 CX。
- DEF-014 的实际代理地址核对、DEF-015 的哈希排队限制在本轮测试中获得支持。DEF-017（304）、018（并发大快照内存）、019/021（链接）、020（上游栈）、022（嵌入文档扫描）、023（代理限速）、024（多实例）、025（上游图片）按既定边界处理，未重报。本报告没有读取或引用 `docs/upstream/private/` 草稿，也未公开任何新上游安全复现。

## 覆盖说明

### 已核对且未发现新问题的重点区域

- **API 基础设施：** 配置未知键与 `_FILE`、Secret、Origin/代理解析、Argon2/线程池交叉限制；请求中间件顺序、fatal/signal、在途响应/处理器计数、池的 query/lock/关闭期限、迁移锁、readiness 缓存；日志错误序列化和敏感字段脱敏。P2 多轮修复逐链核对，未发现新的半提交或借出连接错误导致进程退出。
- **认证：** token 随机生成及数据库仅存摘要、Cookie、CSRF 派生、Origin 相等、空闲/绝对过期与撤销、预占限流和名额退还、哈希 FIFO/队列超时/503/Retry-After。真实 20 个并发错误请求在阈值 3 下只产生 3 次失败验证，其余 429；正确密码在锁定期间也为 429。
- **输入和安全响应：** 真实非法 JSON 为 400、深层 JSON 与 gzip bomb 为 413、恶意 Origin 为 403、缺 CSRF 和把会话 token 当 CSRF 为 403、退出为 204 后旧会话为 401；未信任代理的伪造 proto 被忽略。请求/错误日志未出现探针密码、会话/CSRF token 或损坏请求片段。
- **文档后端：** 行锁、基准修订比较、全局 requestId 唯一约束、跨文档重用、权限复核、ETag/内容同一联查、gzip 单成员/CRC/截断/尾随/双上限、fatal UTF-8、bytea 原样保存、元数据/内容/修订/审计同事务。审计写入故障导致 500 后原内容/ETag/revision 不变、请求记录为 0；终止本次 API 的 PG backend 后也回滚，同 requestId 重试 200。
- **编辑器：** 插件档案、身份替换、内部 API 集中登记、变更分类、公式收齐、视图变更不标脏、保存期间修改、会话换人与恢复、错误显示和资源 dispose。三浏览器真实公式/格式/重开验证通过；没有由单元 mock 推断所有 SDK 时序安全。
- **部署：** Docker 多阶段/非 root/只读根、代码归 root、生产显式复制、Compose 迁移顺序、15 秒停止宽限与 API 8 秒退出预算、应用端口不发布；bootstrap 权限、默认授权、审计保护；Caddy HTTPS、转发头不信客户端自填、探针大小写/尾斜杠屏蔽。容器预检和受限角色业务路径实际通过，角色负测包含于本轮集成测试。
- **工程接线：** pre-commit 为 lint-staged、pre-push 为 verify --fast；完整 verify 接 coverage/build/artifact gates/E2E，CI 增加 audit 并跳过本地 db:up，符合明示设计；没有把本机默认不做 audit 误报为不一致。当前构建边界没有发现把 spikes 或 refer 作为生产依赖。

### 十类门禁的独立负向样例

| 门禁 | 独立样例 | 实际结果 / 限制 |
|---|---|---|
| pins | 外部版本范围、普通未锁镜像；flow YAML、引号键、JSON RUN | 前两者正确失败；后三者 CX8 漏检。YAML 经真实 Compose 解析。 |
| config | dangerouslyAllowAllBuilds、无原因的脚本放行 | 正确失败。`allowBuilds['*']` 不是通配放行，见下方排除项。 |
| stories | active 故事没有测试；真实 Vitest fixture 只有 skipIf(true) | 正确失败。真实 list 输出空、run 为 1 skipped，未被当作覆盖。 |
| migrations | 基准 SQL 的 Map 从 SELECT 1 改为 SELECT 2 | 正确 immutable；属于纯函数输入实验，未建立/修改 Git 提交。基准 ref 解析静态核对。 |
| schema | 临时目录中注入 generate 产生 new.sql | 正确 drift；只测装配判断，不冒称独立执行了真实 drizzle-kit 的变异生成。当前真实 schema gate 已由 verify --fast 执行。 |
| deps | Pro、Univer 版本不符、react 多实例 | 正确失败；workspace 子树漏包见 CX10。 |
| licenses | 生产包映射 GPL-3.0 | 正确失败；未安装违规依赖。许可实物另由 CX9 验证。 |
| artifacts | eval + 第三方 URL、真实压缩 timer、真实 dist 缺正文 | 阳性正确失败；CX9/CX11 漏检。 |
| budgets | gzipSize=2、budget=1 | 正确 exceeded；没有独立构建超预算大包。手造不完整 manifest 的缺失 import 会被跳过，尚无真实 Vite 产物触发证据，未升为正式发现。 |
| audit | 注入 high GHSA 报告 | 正确 advisory；未模拟 registry。另执行了真实 pnpm gate audit。 |

### 明确未覆盖或不足以宣称完成的部分

1. **CI/平台：** 未触发 GitHub CI、未运行 amd64 构建、未在本机安装/运行 Edge；没有重测既有 CI Edge 结论，也没有把 WebKit 等同为真实 Safari 全部平台行为。
2. **运维故障：** 未真实填满磁盘、断电、停共享 PG 主进程、模拟永久网络半开；未做带新 schema 的双版本升级演练或独立 PG 重启演练。PG backend 终止、API 强杀、审计失败是真实实测；CLI 文件系统/信号实验是隔离副本，不冒充真实 Docker 故障注入。
3. **测试充分性：** `tests/e2e/specs/editor/conflict.spec.ts:29`–`:42` 用 beforeunload 证明“保留 B 页内容”，没有读取冲突后的 B 页单元格/快照。它证明离开仍提示，不能单独证明缓冲文字未被清空；建议补内容断言。本轮没发现实际冲突清空内容，不另计功能 BUG。未对全部测试做 mutation testing；没有证据支持“所有断言都一定能抓到相应实现错误”。
4. **覆盖率：** editor 和部分入口/CLI 排除有既定理由，editor 由真实 E2E 补；但复杂容器 CLI 的排除掩盖了 CX12/CX13 路径。96.88% 行覆盖率不是全部受控源码的覆盖率，也不能替代组合时序验证。
5. **产物：** 执行了真实前端产物扫描、许可检查和容器构建启动，但没有对最终镜像每个文件独立取证，不能据此宣称已经逐文件排除所有开发依赖。
6. **共享测试资源的条件风险：** `tests/integration/src/support/database.ts:77`–`:89`、`tests/e2e/support/serve.ts:83`–`:89`、`tools/src/deploy/container-e2e-cli.ts:205`–`:215` 都以本机 PID 判断远端资源是否遗留。两台主机/不同 PID namespace 共享 PG 或 Docker daemon 时，这个判定不能证明资源无人使用。现有文档环境是本机 Docker/独立 CI，本轮没有误删实测，故不计当前正式发现；引入共享资源前应改为服务器侧租约/归属校验，或停止自动清理非本次资源。本轮用专属 PG 避免触碰该风险。
7. **文档阅读口径：** 主审与三个分域审查覆盖了用户列出的设计、ADR、交接、旧审查、延期和测试登记的相关决策链；并非声称每份历史实施计划的每一行都重新执行过。审查以当前代码为准，没有遍历 107 个提交逐条重演。

反证排除：`allowBuilds['*']=true` 虽可过 config gate，但 [pnpm 12.6.0 的原始测试](https://raw.githubusercontent.com/pnpm/pnpm/v12.6.0/pnpm/crates/deps-restorer/src/build_modules/tests/build_policy.rs)及[实现](https://raw.githubusercontent.com/pnpm/pnpm/v12.6.0/pnpm/crates/deps-restorer/src/build_modules/allow_build_policy.rs)使用字面集合匹配，星号不代表放开全部安装脚本。因此没有将此候选误报为漏洞。`skipIf(true)` 的故事登记漏检候选同样被真实 Vitest list 反证排除。

## CI 首跑专项核对

`.github/workflows/ci.yml` 两个 job 均为 Ubuntu 24.04、45 分钟；触发为 push main、每周定时和手动，权限为 contents:read，checkout 不保留凭据。四个 Action 均固定 40 位 SHA；原始 action.yml 可获取。没有发现 `pull_request_target` 或把不可信表达式直接注入 shell 的入口。这是配置审查，不是远程 job 运行结果。

实际执行 `docker buildx imagetools inspect <当前镜像引用>`，三个 digest 都是 OCI image index，均包含 linux/amd64：

| 镜像 | 当前索引 SHA-256 | amd64 manifest SHA-256 |
|---|---|---|
| Node 24.21.0-bookworm-slim | `0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6` | `5cbc7caba8c2c0f0bca675d1b61b9f2857e1cf1853c6164ee9dd409501a936e7` |
| PostgreSQL 18.6-alpine | `77f585114c32fbca283dc835b0596f4e52b51b4c6662d7810b2f4084f60a1873` | `d8703cd7fba306b9fec9268ecedfa8a966846c053036a60e3635791957eb2f66` |
| Caddy 2.11.4-alpine | `6aeddd44c3078b0f9a35206472a11420648a79c184603ef95957d0a20044cb2b` | `040e9f7480b80b6d4a7e5013a21159b950a63dcbdb956e38abe2387fb28d9ec0` |

2026-09-28 查询的 [Ubuntu 24.04 官方 runner 清单](https://raw.githubusercontent.com/actions/runner-images/main/images/ubuntu/Ubuntu2404-Readme.md)为镜像版本 20260920.314.1，Docker 28.0.4、Compose 2.38.2、Buildx 0.37.1，含 Node 24.21.0；本机为 Docker 28.1.1、Compose 2.35.1-desktop.1。[Compose up 官方参数](https://docs.docker.com/reference/cli/docker/compose/up/)包含使用到的 `--no-deps`、`--wait`、`--wait-timeout`，未发现这些参数的 CI 兼容阻断。

[GitHub 官方 runner 规格](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)列公开仓库该 runner 为 x64、4 CPU、16 GB 内存、14 GB SSD；本机容器镜像 441 MB、测试峰值 281.7 MiB、测试约 1 分钟，静态看有余量，但冷安装/构建耗时和 amd64 实际内存仍须首跑确认。不能用本机缓存构建证明 45 分钟一定足够。

Action 原始文件核对：[checkout](https://raw.githubusercontent.com/actions/checkout/3d3c42e5aac5ba805825da76410c181273ba90b1/action.yml)、[setup-node](https://raw.githubusercontent.com/actions/setup-node/820762786026740c76f36085b0efc47a31fe5020/action.yml)、[pnpm/action-setup](https://raw.githubusercontent.com/pnpm/action-setup/ea17c68df8912ef543352723c149a84f56e3d413/action.yml)、[upload-artifact](https://raw.githubusercontent.com/actions/upload-artifact/043fb46d1a93c77aae656e7c1c64a875d1fc6a0a/action.yml)。未审计这些 Action 全部内部实现，也未将 SHA 注释版本逐一与 tag 解析对照。

失败日志有四服务日志与 workflow 的 always 上传，但取消、超时和磁盘错误不能靠 always 自动保证；CX12/CX13 是这条链的具体限制。此次没有发现“CI 必然失败”的证据，**最终 amd64 CI 绿色结果仍是待完成的退出条件**。

## 实际执行台账

下列测试/门禁任务的最终退出码均为 0；故障探针的被测子进程按预期可能返回 1/401/409/500，由探针断言区分，不混称为测试失败。

| 命令 / 实验 | 结果 | 日志或说明 |
|---|---|---|
| `git rev-parse HEAD`、`git branch --show-current`、`git rev-list --count v0.1-m0..71ca6da` | 指定 HEAD / m1-p5-deploy / 107 | 初始工作树干净 |
| `pnpm verify --fast` | lint、typecheck、122 文件 1642 单测、pins/config/stories/migrations/schema 全过 | `/tmp/codex-m1-verify-fast.log`；stories 列举 2039 条将执行的测试，不等于本命令执行了 2039 条 |
| `NERVE_TEST_DATABASE_URL=<审查专属库> pnpm test:coverage` | 142 文件、1835 测试全过；行 96.88%、分支 93.31% | `/tmp/codex-m1-coverage.log`；同时重建 contracts/API |
| `pnpm --filter @nerve-office/web run build` | 生产前端构建成功 | `/tmp/codex-m1-web-build.log`；常规大 chunk 提示，预算检查通过 |
| `NERVE_TEST_DATABASE_URL=<审查专属库> pnpm test:e2e` | 204 passed，约 1.7 分钟 | `/tmp/codex-m1-e2e.log`；三浏览器及独立 Chromium restart 项目 |
| `pnpm test:e2e:container` | 68 passed，约 1 分钟；镜像 441 MB，峰值 281.7 MiB、结束 197.0 MiB | `/tmp/codex-m1-container.log`；四服务日志另存 `/tmp/codex-m1-container-logs` |
| `pnpm gate deps licenses artifacts budgets audit` | 全部通过；真实 audit 无 high/critical、1 moderate | `/tmp/codex-m1-artifact-gates.log`；当前不需据 moderate 调整已定阈值 |
| `node /tmp/codex-auth-stdin-repro.mjs`、`node /tmp/codex-auth-timing.mjs` | 坐实 CX3/CX4 | 自建库均清理；密码为非秘密测试输入 |
| `node /tmp/codex-auth-matrix.mjs` | 恶意输入、Origin/CSRF、撤销、并发限流、审计删除、日志脱敏符合预期 | 不改共享业务库 |
| `node /tmp/codex-save-probe.mjs` | 坐实 CX5/CX7；审计失败/PG backend 终止回滚、重试正确 | `/tmp/codex-save-probe.out` |
| `node /tmp/codex-save-restart.mjs` | 确认数据重启保留、在途强杀无半提交、重复 requestId 幂等 | `/tmp/codex-save-restart.out`；确认被杀时正在内容 UPDATE 且已有事务号 |
| `node /tmp/codex-m1-browser-probe.mjs` | 坐实 CX1、CX2 主场景、CX6 | `/tmp/codex-m1-browser-probe.log`；真实编辑输入截图已人工查看 |
| `node --experimental-transform-types /tmp/codex-save-rejection.mts` | 坐实 CX2 的未知→401→继续编辑分支 | `/tmp/codex-save-rejection.out`；纯 coordinator 时序探针 |
| `node /tmp/codex-m1-gate-probes.mjs`、`node /tmp/codex-m1-story-probe.mjs` | 十门禁负例与 skip 对照，见矩阵 | 同名前缀 `.log`，不修改仓库 fixtures |
| `node /tmp/codex-m1-artifact-timer.mjs`、真实 dist 副本删正文 | CX11/CX9 | `/tmp/codex-m1-artifact-timer.log`、`/tmp/codex-m1-license-artifact.log` |
| `node /tmp/codex-m1-signal-probe.mjs`、`node /tmp/codex-m1-log-failure-probe.mjs` | CX12/CX13 | 同名前缀 `.log`；隔离替身，没有对他人 Docker 资源操作 |
| 三个 `docker buildx imagetools inspect`、Docker/Compose version | 多架构摘要与本机版本确认 | CI 专项表给出实际 digest |

数据库隔离细节：整套测试使用自行创建的 `codex-m1-review-db`，绑定 `127.0.0.1:58823`，维护库 `codex_maintenance`，PostgreSQL 镜像与仓库锁定摘要相同，使用容器内临时存储；任务结束已删除该容器。认证/保存分域自己的 `codex_auth_*`、`codex_save_*`、`codex_restart_*` 库分别清理。原容器 E2E 的 `nerve-office-e2e-15474` 项目、卷、镜像标签均查空。

本轮执行的是 **fast 检查加独立完整覆盖率、构建、E2E、其余门禁**；没有运行单条完整 `pnpm verify` 的 clean 编排，也没有以修改分支/推送方式触发 CI。未执行 `pnpm install/update`，未改锁文件，未提交、推送、建/切分支或操作 worktree。结束时 `git status --short` 仅列出本报告这一未跟踪文件，原有受控文件无改动；HEAD 和分支保持不变。修复、处理与复验证据留待维护者填写。CLI 故障夹具中故意留下的随机密码文件也已清理，复现脚本与证据日志保留在 `/tmp`。

## 处理与复验（主会话，2026-09-28）

以下由主会话在读完本报告之后填写；上文是 Codex 的原文，未改动（问题清单的"处理""复验证据"两列除外）。

**结论**：13 项（阻断 1、重要 9、一般 3）全部属实，全部在 `m1-p5-deploy` 上修复并复验，没有延期项。修复之后，M1 总设计 §8 的退出条件只剩合并之后的两条：CI 全绿（`verify` job 含 Edge，`container` job 第一次在 amd64 上运行）与打标签。

**方式**：
- 逐条对照代码核实之后动手，方案由主会话定下：前端三条（CX1、CX2、CX6）由主会话修；后端四条（CX3、CX4、CX5、CX7）与门禁、工具六条（CX8–CX13）由两个与主会话同一模型的分叉并行修，主会话逐项审阅代码。
- 每条都有新增的测试，并确认它们在修复之前的实现上会失败（CX1 的 E2E、CX2 与 CX6 的单元测试、CX4 的计时测试、CX7 的并发测试都做过这样的对照）；再用本报告留在 `/tmp` 的探针复验（复制一份，只改数据库、产物目录与输出位置，或补上新增的模块，断言改成修复后应有的结果），实际输出见问题清单的"复验证据"。
- CX1 先用 `inert` 做屏障，Chromium 与 Chrome 上的 E2E 发现就绪之后键入进不去（Univer 初始化时的聚焦被挡掉，之后点当前单元格不会再聚焦），改为在窗口的捕获阶段只拦事件。

**报告里其余几点的处理**：

| 出处 | 处理 |
|---|---|
| 覆盖说明第 3 条：冲突之后没有核对 B 页的内容 | 已补：`conflict.spec.ts` 冲突之后在 B 页用查找核对"from B"仍在（1/1） |
| 覆盖说明第 6 条：遗留资源的清理按本机进程号判断，共享数据库或 Docker 时不成立 | 写进 M1 交接单的"M2 须知"（测试资源的归属）：现在的环境都是本机独用；要共用之前先改成服务端的归属校验，或只清理本次运行自己的资源 |
| 门禁矩阵里 budgets 的候选：清单里缺失的 import 会被跳过 | 已补 `budgets/missing-chunk`：构建清单里的块引用了清单里没有的块时报违规（现实里的这种情形原本也会被 `budgets/unattributed-script` 报出，这条让清单自身不一致时直接失败） |
| 覆盖说明第 5 条：没有对最终镜像逐文件取证 | 分叉在修 CX9 时指出镜像里的许可文件同样没人核对：容器 E2E 的部署核对另量镜像里的 `/app/licenses/LICENSE`、`THIRD-PARTY-LICENSES-server.md` 与 `/app/web/THIRD-PARTY-LICENSES.md`，缺了或是空的都失败（CI 的 `container` job 同样执行）；其余逐文件的取证不在本轮范围 |
| 异议：M1 收尾汇报的"全部退出条件已满足"不能作为最终事实 | 已改：收尾汇报的结论写明合并之后的 CI 与标签仍待完成 |
| CI 首跑专项：amd64 的实际结果仍待合并后确认 | 同意，不另立问题：合并、推送之后看 CI 的两个 job，把 amd64 的镜像体积与内存补进 ADR-001 与收尾汇报 §3 |

**独立复验**（与主会话同一模型的新审查者，不带主会话的上下文，逐项核实修复并找修复带来的问题；主会话逐条核实之后处理）：

| 编号 | 等级 | 问题 | 处理 |
|---|---|---|---|
| N1 | 必须修 | CX1 修得不完整：创建工作簿之后的 `setEditable(false)` 被 SDK 在 Ready 时的权限初始化改回可编辑（编辑器身份的授权服务一律允许），屏障又只拦编辑器的容器，Univer 挂在 body 下的批注浮层绕过了它；实测载入期间悬停批注、在浮层里改内容能成功，超时会丢 | 已修复：屏障改为只放行页头（含悬停与 body 下的浮层），不再用 `setEditable` 兜底；补 E2E"重开时就绪之前改不了批注"，换回之前的实现时失败；只读分享的隐患写进 M1 交接单（M2 要让授权服务按文档权限回答） |
| N2 | 必须修 | CX4 只修好了改迭代次数：按"内存 × 迭代次数"补计算量，改内存时仍可分辨（256 MiB 调到 19 MiB，比值 1.54） | 已修复：改为按各组参数实测耗时的中位数补齐（最慢的一组 × 1.2）；计时测试加上内存调高、调低，区间收紧到 0.8–1.25，换回之前的实现时失败 |
| S1 | 建议 | CX6 回车之后只等一个宏任务：跨工作表的提交 SDK 先用 4 毫秒的定时器切表再写入，页头会先闪一下"已保存到云端" | 已修复：等这次的写入（变更检测记下的修改），值没变时最多等 500 毫秒 |
| S2 | 建议 | 屏障把浏览器的刷新快捷键也拦了，加载卡住时只能点刷新按钮 | 已修复：F5、Ctrl/Cmd+R 与 Tab 不拦 |

其余 11 项复验者核实为根因已解决、没有回归、新增的测试在旧实现上会失败（CX2、CX7 的测试与 CX8、CX10、CX11 的对照脚本都实测过）。

**第二轮复验**（又一个新的审查者，只核实 N1、N2、S1、S2 的修法）：N1 原来的路径与 N2、S1 核实为修对、修全（N2 在静止、24 个忙循环模拟的慢机器、攻击者成对并发三种情况下，耗时之比都在 0.99–1.02）。另有：

| 编号 | 等级 | 问题 | 处理 |
|---|---|---|---|
| R2-1 | 必须修 | S2 的修法放行 Tab 与 Ctrl/Cmd+R 时没有停止传播：SDK 的快捷键也挂在窗口上，Ctrl/Cmd+R 是"向右填充"、Tab 是"选区右移"，载入期间又能改内容，而且 SDK 取消了浏览器的刷新 | 已修复：放行的按键同样停止传播、只是不取消默认行为（浏览器照常刷新或移动焦点，SDK 收不到），另放行 Ctrl+F5；补 E2E"重开时就绪之前按 Tab 与 Ctrl/Cmd+R"（内容不变、就绪后照常键入），换回之前的实现时失败 |
| R2-2 | 建议 | 编辑跨表公式时直接保存：跨工作表的提交先切表（4 毫秒的定时器）再写入，保存先提交单元格之后只等一个宏任务，捕获里没有这次的提交（修复之前就有） | 已修复：`commitCellEditing` 提交之后等单元格编辑的跟踪认出写入（`settled`，最多 500 毫秒，另有兜底）再返回；补 E2E，换回之前的实现时失败 |
| R2-3 | 建议 | 文档里的测试数停留在这次修复之前 | 已更新（见下） |
| 另 | 范围之外 | 门禁的计时用例"不是平方级"在整套单元测试并行跑时偶发失败（先后分开测大小两种数量，机器忙闲在两次测量之间变化） | 已修复：大小两种数量交替测，数量乘 8、上限 24；整套单元测试连跑 6 次都通过 |

**修复之后的验证**：
- 从干净状态（`pnpm clean`）跑 `pnpm verify` 全部通过：lint、类型检查、静态门禁；单元与集成测试 146 个文件 1972 项（行覆盖率 97.06%、分支 93.49%）；构建与产物门禁；E2E 210 项（本机 Chromium、Chrome、WebKit 与重启项目）。
- `pnpm test:e2e:container`：70 项通过；部署配置的核对（含新加的镜像许可文件）通过；镜像 441 MB（arm64，解压之后），应用容器空闲 204.6 MiB、E2E 期间峰值 267.7 MiB；跑完没有残留。
- 构建期间给编排脚本发 SIGINT：1 秒内停下，buildx 报 `CANCELED`，不再起测试环境，没有残留，退出码 1。

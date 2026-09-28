# 架构总览

> 活文档：每个 Phase 结束时更新｜当前：v1（M1-P5 完成时）｜更新：2026-09-28

## 1. 目标形态与当前进度

目标形态见 00 号计划书 §9.1：浏览器里的平台页面与编辑器页（Univer），同源访问 NestJS 模块化单体，数据在 PostgreSQL 与持久化资源目录里。

| 部分 | 当前状态 |
|---|---|
| 前端 `apps/web` | 平台页面：登录页、我的空间（个人空间的文档列表、新建表格）、404 与错误页（M1-P3、P4）；表格编辑器页（M1-P4：整页加载，显式保存） |
| 后端 `apps/api` | 横切能力（M1-P2）；账户、个人空间、会话与登录、默认拒绝的认证与 CSRF 防护、文档元数据的列表与读取、命令行初始化管理员、托管前端产物（M1-P3）；新建文档、读取内容、按修订号保存（M1-P4） |
| 共享契约 `packages/contracts` | 错误响应（含可选的 `details`）与错误码、审计动作、健康检查、请求头；账户与空间的规则、登录与会话、文档的列表与元数据、新建与保存、快照的常量、收敛的模板快照、编辑器页的地址 |
| 数据库 | PostgreSQL 18；`audit_events`、`users`、`spaces`、`auth_sessions`、`auth_login_throttles`、`documents`、`document_contents`、`document_revisions`；迁移由单独的命令执行 |
| 编辑器适配层 | `apps/web/src/editor/`（M1-P4，ADR-010）：插件档案 `sheet@1`、公式 Worker、身份替换（ADR-009）、变更检测、公式收齐、`IMAGE()` 的限制、M5 之前的入口守卫、内部 API 的登记 |
| 部署 | 生产镜像（多阶段构建、非 root、健康检查）；测试环境：应用 + PostgreSQL 18 + Caddy（HTTPS）；迁移是一次性任务；数据库两个角色；容器 E2E（M1-P5，ADR-012，§8） |

## 2. 仓库结构

| 目录 | 包 | 作用 |
|---|---|---|
| `apps/web` | `@nerve-office/web` | 前端（React 19 + Vite 8；ADR-008）：两个入口页 `index.html`（平台页面）与 `editor.html`（编辑器页）；`build/` 是构建插件（第三方许可清单），`third-party-licenses/` 是发布包里缺许可文件的包的正文；`dist/` 是生产构建，`dist-e2e/` 是加上 CSP 探针的测试构建 |
| `apps/api` | `@nerve-office/api` | 后端（NestJS 12，纯 ESM，Nest CLI 构建；ADR-004） |
| `packages/contracts` | `@nerve-office/contracts` | 前后端共享的请求与响应结构（zod）、错误码、审计动作 |
| `tools` | `@nerve-office/tools` | 质量门禁、故事对照、提交钩子、`verify` |
| `tests/integration` | `@nerve-office/integration-tests` | 基于真实 PostgreSQL 的集成测试：进程内的真实应用、真实进程（构建产物）、每个测试文件独立的数据库 |
| `tests/e2e` | `@nerve-office/e2e` | Playwright：本机模式测真实后端 + 数据库 + 测试构建（本机 Chromium、Chrome、WebKit，CI 另加 Edge）；外部模式测部署好的环境（容器 E2E）；重启项目（US-M1-10） |
| `deploy` | — | `Dockerfile`（生产镜像）、`sql/bootstrap-roles.sql`（数据库两个角色）、`test/`（测试环境的编排与 Caddy）、`dev/`（开发用的 PostgreSQL）、`README.md`（部署说明） |

模块系统、contracts 的导出条件与边界的强制方式见 ADR-003；版本基线见 ADR-002。

## 3. 后端

```text
apps/api/src/
  app/            应用的组装：根模块（含全局守卫）、HTTP 管线、优雅退出、进程入口 main.ts；
                  index.ts 是命令行与集成测试共用的程序接口（含不带 HTTP 的 initializeAdmin）
  shared/         AppError、@Public() 等共用的内核
  modules/
    config/       环境变量（NERVE_*，机密可以用 _FILE），启动时校验；只有这里读 process.env
    logging/      pino 根日志、请求日志与请求标识、脱敏、请求上下文（认证后带 userId）、注入的 AppLogger、Nest 日志适配
    security/     安全响应头（M0 定稿的 CSP 等）、JSON 请求体的上限与嵌套深度、元素数量、代理未被信任的告警
    database/     连接池与超时、Drizzle、TransactionRunner、迁移执行、就绪检查
    audit/        审计事件（只追加）；启动时检查数据库角色能否关掉审计表的触发器
    health/       存活与就绪探针（公开）、应用的运行状态
    spaces/       个人空间（M2 扩展为团队空间与成员）
    users/        账户、Argon2id 的密码哈希（并发与排队都有上限）、验证凭据、初始化首个管理员
    auth/         登录、退出、会话、登录限流；会话守卫与 CSRF、Origin 守卫；@CurrentPrincipal()
    documents/    文档：元数据的列表与读取、新建（模板快照、requestId 幂等）、内容的读取与保存（ADR-011）、访问策略
    web-hosting/  托管前端产物；/api 以外的其他请求得到统一的 404
  db/
    schema/<模块>/  各模块的表定义；schema/common 是表定义共用的写法（枚举的 CHECK、bytea）
    migrations/   drizzle-kit 生成、人工审阅的迁移
  cli/            迁移命令 migrate.ts、初始化管理员 init-admin.ts
```

**请求管线**（`app/configure-http.ts`，顺序一次写定）：

| 顺序 | 环节 |
|---|---|
| 1 | 在途请求计入（优雅退出时要等它们完成） |
| 2 | 请求日志与请求标识（`X-Request-Id` 合法就沿用，否则生成 UUID） |
| 3 | 请求上下文：之后在这个请求里写的日志都带请求标识 |
| 4 | 代理未被信任的告警：公开地址是 HTTPS、经代理转发来的请求（带转发头）却不是 HTTPS 时，每个进程记一条（DEF-014） |
| 5 | 安全响应头：对所有响应生效，包括错误、404、页面、脚本与 Worker 脚本 |
| 6 | 托管前端产物（配置了 `NERVE_WEB_ROOT` 才有）：只处理 `/api` 以外的 GET、HEAD；带哈希的资源长期缓存，其他不缓存；编辑器页的地址（`/documents/<UUID>`）给 `editor.html`，其他没有扩展名的路径回退到平台页面 |
| 7 | `/api` 以外的其他请求：统一的 404 错误响应 |
| 8 | JSON 请求体：上限取自配置；解析后检查嵌套深度与元素数量。保存快照的正文（`application/gzip`）不经它，由那个路由的拦截器在守卫之后读取 |
| 9 | Nest 路由：前缀 `/api`；全局守卫（先认证，再 CSRF 与 Origin）；全局校验管道（`@Body({ schema })`，zod）；全局异常过滤器 |

**认证与会话**（ADR-007）：
- 服务端会话：令牌在 HttpOnly Cookie 里（HTTPS 时 `__Host-` 前缀与 `Secure`，`SameSite=Lax`），库里只存摘要；空闲过期（12 小时）随活动顺延，不超过绝对过期（7 天）。
- 默认拒绝：除 `@Public()`（登录、探针）外都要求有效的会话；没有会话为 `UNAUTHENTICATED`，会话失效为 `SESSION_EXPIRED`。
- 状态变更的请求：Origin 必须等于公开地址（`NERVE_PUBLIC_ORIGIN`）；需要登录的接口另要求 `X-CSRF-Token` 等于由会话令牌派生的令牌。
- 登录限流按用户名与按客户端地址（IPv6 按 /64）两个维度计数，存在数据库里：
  - 先占用名额、再验证，并发的请求也不能多验证；锁定期间不验证密码；
  - 过期的计数与会话在验证之后、事务之外顺带清理，跳过别人锁着的行；
  - 登录成功、失败与退出都写审计。
- 密码用 Argon2id（@node-rs/argon2），参数可配置，有强度下限；同时进行的哈希有上限，免得占满 libuv 的线程池；排队的长度与等待时长也有上限，超出时这次不验证，返回 503 与 `Retry-After`，退回限流的名额（DEF-015）。首个管理员用命令行初始化（`init-admin`，密码从终端或标准输入读取）。
- 契约里的响应结构是宽松的（客户端丢弃不认识的字段，接口只做加法时旧页面照常工作），请求结构是严格的；服务端只发契约里的字段，集成测试按原文核对。

**接口**（M1-P3、P4）：

| 接口 | 说明 |
|---|---|
| `POST /api/auth/login`、`POST /api/auth/logout`、`GET /api/auth/session` | 登录、退出、当前会话（账户、个人空间、CSRF 令牌） |
| `GET /api/documents?limit=&cursor=` | 个人空间的文档，按更新时间从新到旧，keyset 分页 |
| `POST /api/documents` | 新建（`{ type, title?, requestId }`）：内容是收敛的模板换上新的 `unitId`，修订号 1；同一个 `requestId` 的重放同样 201，返回同一份文档 |
| `GET /api/documents/{id}` | 文档元数据（含修订号、档案、格式版本）与调用者的权限；别人的与不存在的文档都是 404 |
| `GET /api/documents/{id}/content` | 当前快照：gzip 字节原样下发（`Content-Encoding: gzip`），修订号作 ETag |
| `PUT /api/documents/{id}/content?baseRevision&requestId&clientInstanceId&localSeq` | 保存（正文是 gzip 压缩的快照）：压缩前后都限 5 MiB、基本校验、锁文档行、按 `requestId` 幂等、按基准修订号条件写入；冲突时 409，`details` 带当前修订号及其来源 |
| `GET /api/health/live`、`GET /api/health/ready` | 存活与就绪探针（公开） |

**错误**（ADR-006）：
- 响应统一为 `{ "error": { "code", "message", "requestId", "details"? } }`；错误码登记在 contracts，每个错误码对应固定的 HTTP 状态；`details` 按错误码约定结构（例如修订号冲突）。
- 业务代码只抛 `AppError`；意外错误对外只回通用说明，异常与堆栈写进这个请求的日志。

**日志**：
- JSON，每行一条；请求结束时一条，含方法、路由模板、路径、状态码、耗时。
- 不记请求头、请求体与查询串；敏感的键名统一脱敏。
- 异常用自己的序列化：数据库错误只留类型、带占位符的 SQL、SQLSTATE 与约束、表、列名，不带绑定参数与行里的值；只传异常不给消息时的 `msg`、Nest 的内部日志同样处理。
- 应用代码经依赖注入使用 `AppLogger`，不用 Nest 的静态 `Logger`。

**数据库与迁移**（ADR-005）：
- 连接池的语句、等锁与事务中空闲的超时取自配置；TCP keepalive 与客户端侧的查询时限兜住静默断开的连接；连接断开只记日志，不让进程退出。
- 迁移由单独的命令执行，带 advisory lock；执行前比较已执行的迁移，库里不一致就拒绝。
- 应用启动时不迁移，只检查库结构版本，不一致时就绪探针失败。
- 表只由所属模块的仓储读写；服务用 `TransactionRunner` 开启事务，把不透明的 `Transaction` 显式传给仓储。`TransactionRunner` 自己借出、归还连接：除业务错误外，失败的事务丢弃它的连接；work 吞掉失败的语句时不报告成功。

**文档的访问策略**：服务只经 `DocumentAccessPolicy` 判断权限（在事务里判断时，查询走事务的连接）；M1 只有"个人空间的所有者"一条规则，M2 在同一个接口后面扩展为有效权限。没有任何权限与不存在都是 `NOT_FOUND`；能访问却不能编辑时保存得到 `PERMISSION_DENIED`。

**文档的内容与保存**（ADR-011）：
- 快照用 `bytea` 存 gzip 压缩的原始 JSON 字节；修订号是整数，新建为 1，每次保存加一；`unitId` 由服务端生成，终身不变。
- 保存：与文档无关的基本校验在事务之前；事务里锁住文档行并判断权限 → 按 `requestId` 幂等（负载摘要按基准修订号与解压后的字节算）→ 核对快照的 `id` → 按基准修订号条件写入 → 写内容、修订记录与审计（`documents.content_saved`）。
- 完整的快照校验、内容哈希、编辑租约、`If-None-Match` 与拦截旧客户端在 M3。

**运行与退出**：
- 就绪探针检查接收请求、数据库可达与库结构版本，整体限时 2 秒。
- 收到 SIGTERM 或 SIGINT 后：标记退出；在途与之后的响应带 `Connection: close`；停止接收新连接；等在途请求完成（超时就强制断开）；最后关闭应用与连接池。
- 退出码：正常 0，强制或失败 1；退出过程中再次收到信号就立即退出。

## 4. 前端

```text
apps/web/src/
  entries/platform/   平台页面的入口：只写副作用导入，按顺序关掉 zod 的 JIT（CSP）→ 样式 → 挂载（建运行时，从往返缓存恢复时重新加载）
  entries/editor/     编辑器页的入口：同样先关掉 zod 的 JIT → 样式（不含 Tailwind 的基础重置）→ 挂载
  entries/csp-probe/  CSP 阳性对照（只在测试构建里）
  app/                运行时（路由、请求缓存、会话的全局处理：整页跳转、多标签页）、布局、404 与错误页
  features/auth/      登录页、会话、需要登录的外层路由、退出
  features/documents/ 我的空间的文档列表、新建表格
  features/sheet-editor/ 编辑器页：载入、保存的状态机、页头与提示、快捷键与离开提示、会话
  editor/             编辑器适配层（Univer 的一切，ADR-010）：档案、公式 Worker、身份、变更检测、公式收齐、IMAGE()、入口守卫、internal-api/
  shared/             请求层（api）、界面组件（ui，改写后的 shadcn/ui）与主题变量、界面文字（i18n）、小工具（lib：登录页的地址、整页跳转等）
```

- React Router 8（数据路由的库模式）、TanStack Query 5、Tailwind CSS 4 与 shadcn/ui 的 Radix 版本（ADR-008）。
- 请求层：同源请求，状态变更的请求带 CSRF 令牌；错误分为 `ApiError`、`NetworkError`、`ResponseFormatError`；成功的响应按 contracts 校验。
- 会话结束（任何请求得到未登录或登录已过期、退出）：清掉 CSRF 令牌，整页回到登录页，登录后回到原来的地址；不在单页里清空缓存。
- 多个标签页：登录与退出经 BroadcastChannel 通知；收到消息或得到 `CSRF_TOKEN_INVALID` 时重新确认会话，换了人整页重新加载。
- 查询与变更不按浏览器的在线状态挂起，断网时照常失败并提示。
- 平台页面与编辑器页之间整页跳转（两个入口）：列表的条目是普通链接，新建之后 `location.assign`，登录后要回到编辑器页时 `location.replace`。
- **编辑器页**（P4 设计 §3.7）：
  - 编辑器在 React 之外创建（一页一份文档）；容器是 `editor.html` 里静态的 `#sheet-editor`，页面的状态写在它的 `data-editor-state` 上（loading、ready、steady、failed）；页头挂在 `#editor-chrome`；
  - 载入：确认会话 → 并行读取元数据与内容 → 核对档案与格式版本 → 创建编辑器；别人的与不存在的显示相同；
  - 保存：显式保存（按钮、Ctrl/Cmd+S），状态机见 ADR-011；有未保存的修改时离开由浏览器提示；
  - 会话：载入之后一律不整页跳转、不自动重新加载（本页可能有未保存的修改）。登录已过期或在别处退出：暂停保存，提示在新标签页中登录，本人登录回来之后恢复；别的标签页登录了另一个人：不能再保存，原来的人回来之后恢复。
- 首屏 JS 预算（gzip，门禁 `budgets` 检查）：平台页面 180 KiB；编辑器页 2350 KiB；公式 Worker 800 KiB。

## 5. 模块边界

- `@univerjs/*` 只能在 `apps/web/src/editor/` 下引用（静态导入、再导出、动态导入都算），任何位置都不能引用 `@univerjs-pro/*`。
- **web** 分层：
  - 入口（`src/entries/*`）→ 应用（`src/app`）→ 功能（`src/features/*`）→ 共享（`src/shared`）；
  - 编辑器适配层（`src/editor`）只依赖共享与 contracts；只有编辑器页的入口与 `features/sheet-editor` 能引用它（经 `index.ts`）；
  - `features/sheet-editor` 只由编辑器页的入口引用：平台的应用层、其他入口与其他功能都不引用它（Univer 不进平台页面的包）；
  - Univer 的内部符号与 `Univer.__getInjector()` 只能在 `src/editor/internal-api/` 引用，逐项登记；`@univerjs/*` 只引用包入口、`/facade`、`/locale/<语言>` 与样式（ADR-010）。
- **api**：
  - 模块之间只经对方的 `index.ts`，模块不引用应用的组装；
  - 一个模块只能引用自己的表定义，表定义之间可以互相引用（外键）；
  - 只有仓储访问数据库：
    - `drizzle-orm`、`pg`（包本身、子路径与 `pg-*`）只在 database 模块、各模块的仓储与表定义里引用；
    - `DATABASE`、`executorOf` 与数据库类型只在仓储与 database 模块里引用（app 层的程序接口为集成测试转出）；
    - 表定义只在仓储里引用；
    - 服务开事务用 `TransactionRunner`，拿到不透明的 `Transaction`；控制器不引用仓储与 `TransactionRunner`；
  - 只有 config 模块读取环境变量（`process.env`、`import { env }`、解构、`globalThis.process.env`；引用 `process` 不改名）；
  - 输入必须带 schema（`@Body`、`@Query`、`@Param`，对所有后端文件）；不用 `@Req`、`@Res`、`@Headers`、`@UploadedFile` 等不经校验的装饰器（改名、命名空间引用、深层路径都拦得住）；`@Controller` 只写在 `*.controller.ts` 里；
  - SQL 只用参数：不用 `.raw`（表定义的 CHECK 常量除外），`query()`、`execute()` 的第一个参数（SQL 文本）不直接拼接；
  - 不用 Nest 的静态 `Logger`；
  - 引用的写法唯一：不用动态导入，相对引用写 `.ts`，Nest 只从包的入口引用，按路径与包名的限制才可靠。
  - 自动检查覆盖不到的写法由审查保证：先拼成变量再传入的 SQL、先赋给别的变量再读的环境变量、在仓储里转出数据库句柄、自己写的参数装饰器、路径里夹 `./` 等刻意绕过的引用。
- 跨元素时，contracts、功能模块、编辑器与后端模块只经公开入口（`index.ts`）引用；元素目录里没有"无主"文件。
- contracts 不依赖任何内部包；tools 不依赖业务包；集成测试只经 contracts 与 `@nerve-office/api` 的入口引用。
- 没有循环依赖。
- 测试代码只在测试里用：测试代码之外只引用本包 `dependencies` 里的包；测试与测试辅助（`*.test.*`、`*.test-support.*`）只被测试静态引用，任何地方都不动态导入它们。`import.meta.glob` 这类按模式成批引用的写法一律不用（lint 报错）。
- 包名一律小写：写成大写（`@UniverJS/…`）时按包名生效的限制都认不出，而不区分大小写的文件系统上类型检查与构建照常通过；静态导入、再导出、动态导入与类型里的 `import()` 都算。
- 前端应用的入口（`entries/*/main.{ts,tsx}`）只写副作用导入，第一个关掉 zod 的 JIT。

规则由 ESLint 执行，并有自测（`tools/src/lint/lint-rules.test.ts`）。

## 6. 质量门禁

| 门禁 | 时机 | 内容 |
|---|---|---|
| 提交钩子（lefthook） | 每次提交 | 暂存文件的 `eslint --fix`；去掉提交说明里的 AI 署名 |
| `pnpm verify --fast` | pre-push | lint、类型检查、单元测试、静态检查（精确版本、包管理配置、故事对照、迁移只向前、表定义与迁移同步） |
| `pnpm verify` | 合并到 main 之前 | lint、类型检查、静态检查；启动开发数据库；单元与集成测试合在一起跑并统计覆盖率；清理并构建；依赖图与许可、产物扫描与第三方许可清单、首屏体积预算；前端的测试构建；E2E（本机三个浏览器，真实后端与数据库） |
| CI（`.github/workflows/ci.yml`） | 推送 main；每周一次；手动 | 两个并行的 job：`verify`（`pnpm verify --ci`，PostgreSQL 服务容器，与依赖漏洞扫描）；`container`（`pnpm test:e2e:container`：构建生产镜像，起测试环境，跑 Chromium 的 E2E 与重启用例）。失败的步骤、汇总与失败的 E2E 用例写成 GitHub 注解，不登录也能读取 |

A01 等检查（`pnpm gate <名称>`）：

| 检查 | 内容 |
|---|---|
| `pins` | 外部依赖都经 pnpm 目录引用，目录里是精确版本；内部包 `workspace:*`；`packageManager` 精确；Dockerfile、编排文件与 CI 引用的容器镜像按摘要锁定、各处写法一致，Node 镜像与 `.node-version`、镜像里全局安装的 pnpm 写明版本并与 `packageManager` 一致。引用的来源：Dockerfile 的 `FROM`（按第一个 `FROM` 之前的 `ARG` 展开）、`COPY`/`ADD` 的 `--from` 与 `RUN --mount` 的 `from`（前面定义的阶段除外），YAML 的 `image:`、工作流的 `container:` 简写与 `uses: docker://`；带着展不开的变量的引用算违规，compose 里整个是变量、没有默认值的（本仓库构建、运行时指定的镜像）除外，带默认值的检查默认值 |
| `config` | 只有评审过的顶层设置，没有 pnpmfile；发布冷却期不少于 3 天、`trustPolicy`、`engineStrict`；安装脚本、冷却期豁免（只能写"包名@精确版本"）、`overrides`、peer 规则、补丁逐项写明原因 |
| `stories` | 当前 M 的故事登记表与总设计一致；active 的故事有会执行的测试（取自 Vitest 全部项目与 Playwright 的列举） |
| `migrations` | journal 与迁移文件一一对应、时间戳递增、迁移名的写法、快照的 prevId 链；与基准版本（本机：与 main 的分叉点；CI：推送之前的提交）相比，已合并的迁移没有变化，新迁移只追加在末尾 |
| `schema` | 表定义与迁移同步：对迁移目录的副本执行一次 drizzle-kit generate，不应生成新文件，并且要给出"没有变化"的结论（改列名等要交互确认的变更同样失败） |
| `deps` | 生产依赖图（含可选依赖，按真实包名）没有 Pro，Univer 版本一致（pnpm 目录与安装的实例都等于版本基线；文档记录的 SDK 版本由后端的单元测试与目录核对），应为单例的包只有一份（React、rxjs、NestJS、reflect-metadata、drizzle-orm、React Router、TanStack Query、Radix 等；清单支持 `@作用域/*`，含 `@univerjs/*`、`@radix-ui/*`），依赖树完整 |
| `licenses` | 生产依赖的每个安装实例的许可在白名单内（本机没装的平台专属包以 CI 为准）；开发依赖没有 GPL、AGPL、SSPL 与未声明许可；服务端的生产依赖图完整、每个包都有许可正文（镜像里的服务端许可清单要用，缺的由 `apps/api/third-party-licenses/` 补齐） |
| `artifacts` | 构建产物只有登记过的文件类型（`.json` 也扫描，只放行三个清单文件）；JS 按语法树找出 `eval` 与 `Function` 的每一处引用（任何对象上的同名属性、恰好是这两个名字的字符串也算；对象字面量的键、类成员名、`case` 的值与私有字段只是名字，不算），除已登记的动态代码（zod 的 JIT 探测与编译器，jitless 下执行不到）与全局对象探测（lodash，上限 2 处）外都违规，其他文本文件按写法匹配；JS 的地址按语法树取出的字符串值、模板字符串、正则与注释识别（转义、拼接、插值给出的协议、协议相对的本机与 IP 地址都认得），模板插值前的固定主机照样检查；字符串与模板字符串、HTML 的属性值与样式（parse5 按规范解析；树构建丢掉的开始标签也算，丢掉的是原始文本一类的元素或 svg、math 时直接报违规）、SVG 文件（按 XML 解析；带 DTD、处理指令、格式错误或编码不是 UTF-8 时直接报违规）、样式的字符串与 url（按 CSS 的分词规则）、JSON 的字符串再按浏览器的解析规则解析（反斜杠、前导空白、夹在中间的制表符、用户信息、编码过的主机、不带斜杠的 `wss:`、协议或端口是插值、单标签的主机、IPv6），比较、去重与核对允许清单都用解析出的规范写法（点段化简，同一处里规范写法不同的地址逐个核对），整个文件另按写法匹配兜底（JS 字符串里嵌的样式与 HTML、`data:` 地址里的文档不解开，由 CSP 拦下，DEF-022），自测含一条经 Vite 真实构建、压缩之后再扫描的用例；地址按具体地址登记放行，只有编辑器页的产物（编辑器入口能到达的块与它们引用的 Worker）另可按前缀登记（公式说明的文档链接），其余产物默认只按具体地址；没有禁用的关键字；没有只属于测试构建的文件（CSP 探针）；第三方许可清单（含 Worker 的产物）完整，发布包里缺许可文件的包由仓库补齐正文 |
| `budgets` | 各入口首屏 JS 的体积（入口块加上静态引用的块，gzip）不超过预算；入口创建的 Worker 另列一项（按构建清单里块的 `assets` 找到 Worker 的产物，连同它静态引用的块）；入口能加载到的块创建了没有预算的 Worker（含 `?worker` 的写法与动态加载的块）、一个预算匹配到多个同名的 Worker、构建清单里有没有预算的入口、产物里有没有归属的脚本（例如 Worker 里再创建的 Worker）、构建清单里的块引用了清单里没有的块时报违规 |
| `audit` | 生产依赖没有高危及以上的漏洞；例外有原因与到期日；没有被配置藏起来的漏洞 |

覆盖率下限（单元与集成测试合计）：contracts 90%，api 80%，web（编辑器适配层以外）70%，tools 80%。

## 7. 数据库

- PostgreSQL 18.6，镜像按摘要锁定；新库使用内置的 `C.UTF-8` 排序规则，开启数据页校验和；主键用 `uuidv7()`。
- 开发：`pnpm db:up`（只监听 `127.0.0.1:54318`），`pnpm db:migrate` 执行迁移，`pnpm db:generate --name <名称>` 按表定义生成迁移。CI 使用同一个镜像的服务容器。
- 集成测试：每个测试文件从模板库复制一份独立的数据库；模板按迁移的名称、哈希与时间戳命名，迁移不变时复用。
- E2E 的本机模式：每次运行建一个专用的库（名称带 Playwright 主进程的进程号），由服务脚本迁移、初始化管理员，结束时删除；遗留的库下次清理。端口每次由操作系统分配；后端单独一个进程组，只由服务脚本发一次 SIGTERM，服务脚本被强制结束时后端自行退出；收到 SIGUSR2 时强制结束后端并按原来的参数重启（重启用例）；后端日志写进 `tests/e2e/test-results/e2e-server.log`。
- E2E 的外部模式（容器 E2E）：测试数据用管理员连接写进被测环境的库（`E2E_DATABASE_URL`）；E2E 的管理员由全局准备经编排的初始化命令创建。
- 生产与测试环境用两个角色（ADR-012）：所有者执行迁移、拥有全部表；应用只能增删改查业务表、读取迁移记录，关不掉审计表的触发器。本机开发、集成测试与本机 E2E 用超级用户，启动自检照常告警。

| 表 | 模块 | 说明 |
|---|---|---|
| `audit_events` | audit | 审计事件：动作、操作者、对象、来源（请求标识、客户端地址）、补充信息；CHECK 约束兜底；触发器拒绝更新、删除与清空（前提：应用的数据库角色不是表的所有者或超级用户，P5 用两个角色落实，应用启动时自检） |
| `users` | users | 账户：用户名（小写的规范写法，唯一）、显示名、Argon2id 哈希（CHECK 只接受 `$argon2id$`）、系统角色、状态 |
| `spaces` | spaces | 空间：M1 只有个人空间，每人一个（部分唯一索引），不能全员可见 |
| `auth_sessions` | auth | 登录会话：令牌摘要（唯一）、空闲与绝对过期、撤销的时间与原因 |
| `auth_login_throttles` | auth | 登录限流的计数：键的摘要、窗口内失败与正在验证的尝试次数（成功时退回，可以是 0）、锁定到期 |
| `documents` | documents | 文档的元数据：所属空间、类型、标题、创建者、状态、当前修订号、`unit_id`（不唯一：复制文档时不改写 unitId，迁移 0007）、插件档案、平台格式版本、写入时的 SDK 版本；按空间与更新时间的索引 |
| `document_contents` | documents | 每份文档一份当前快照：gzip 的 `bytea`、解压前后的字节数（CHECK 核对压缩后的字节数与上限） |
| `document_revisions` | documents | 每次新建或保存一行：修订号（与文档联合唯一）、种类（新建即修订号 1）、`request_id`（唯一，幂等的依据）、负载摘要、保存的来源（`clientInstanceId`、`localSeq`）、保存人；不存正文 |

## 8. 部署

```text
浏览器 ──HTTPS──▶ Caddy（TLS 与转发）──HTTP──▶ app（前端页面与 /api，同源）──▶ PostgreSQL 18
                                        migrate（一次性任务，所有者角色）──────▶
```

- **镜像**（`deploy/Dockerfile`）：`node:24.21.0-bookworm-slim`（按摘要）；构建阶段按锁文件安装、构建全部包，单独一次只装 api 的生产依赖；运行镜像只有 Node、生产依赖与构建产物（不带 pnpm、npm 与源码），非 root，健康检查请求就绪探针；服务端的第三方许可清单随镜像生成。
- **应用**：同源托管前端页面与 `/api`，安全头、Cookie 与缓存策略都由应用下发。`NERVE_TRUST_PROXY` 按代理的跳数配置（测试环境是 1），应用的端口只对代理可达。
- **迁移**：同一个镜像的一次性任务（`node dist/cli/migrate.js`），用所有者角色，成功结束之后才启动应用；应用启动时只检查库结构版本。
- **数据库角色**：`deploy/sql/bootstrap-roles.sql` 建所有者与应用两个角色与数据库，默认权限让所有者以后建的对象自动授权给应用；应用启动时自检。
- **反向代理**：只做 TLS 与转发：不压缩、请求体上限 6 MB、就绪探针对外 404、到应用的空闲连接早于应用的 5 秒回收、去掉 `Server` 与 `Via`；不采信客户端带来的转发头。换用别的代理时满足同样的要求（`deploy/README.md`）。
- **测试环境**（`deploy/test/`）：compose 的 `db`、`migrate`、`app`、`caddy`；应用容器只读根文件系统、去掉全部 capabilities、`no-new-privileges`、不发布端口；Caddy 以 nobody 运行、只保留 `NET_BIND_SERVICE`；数据库与 HTTPS 只发布到本机回环。
- **容器 E2E**（`pnpm test:e2e:container`，CI 的 `container` job）：构建镜像（标签带进程号）、随机密码与端口起一套测试环境 → 核对部署配置（经代理的探针、两个客户端地址与伪造的转发头、应用的端口不发布，DEF-014；随镜像分发的许可文件）→ 以外部模式跑 E2E（只依赖测试构建的 `@test-build` 用例按标签排除）与重启用例 → 打印镜像体积与应用容器的内存 → 收集日志、清理（每一步都执行，有一步失败就以非零退出）。长命令异步执行，收到信号时转给正在运行的那一个，之后不再开始新的步骤（Codex 评审 CX12、CX13）。
- **没有做的**（M7）：部署包与运维手册、备份与恢复、升级与回滚演练、滚动发布与多实例（DEF-024）、代理上按地址限速（DEF-023）、镜像的发布与签名。

## 9. 变更记录

| 日期 | Phase | 变更 |
|---|---|---|
| 2026-09-26 | M1-P1 | 初版：仓库结构、工具链、模块边界、质量门禁、开发数据库 |
| 2026-09-26 | M1-P2 | 后端骨架与横切能力；后端的模块边界；错误码；数据库与迁移、`migrations` 与 `schema` 检查；审计；覆盖率改为单元与集成测试合计 |
| 2026-09-26 | M1-P3 | 账户、个人空间、会话与登录、默认拒绝的认证与 CSRF、文档元数据；前端骨架；托管前端产物；E2E 改测真实后端；`budgets` 检查 |
| 2026-09-27 | M1-P4 | 文档内容与保存协议（ADR-011）、错误响应的 `details`；编辑器适配层与内部 API 登记（ADR-010）、编辑器身份（ADR-009）；编辑器页与新建表格；托管映射编辑器页；门禁：Worker 预算、地址的前缀登记与按语法树识别（DEF-016）、缺失的许可正文补齐 |
| 2026-09-28 | M1 对抗评审（Codex）与独立复验 | 编辑器就绪之前页头之外的输入一律拦下（交互屏障，含 body 下的浮层）；单元格里还没提交的输入算有未保存的修改；保存重试原样再发；命令行按 UTF-8 流式读密码；调整 Argon2 参数期间失败的验证按实测的耗时补到最慢的一组；`unit_id` 不唯一（迁移 0007）；新建的锁键按规范化的 UUID；门禁：YAML 按语法解析、exec 形式的 RUN、分发的许可正文、服务端依赖图展开工作区包、字符串定时器按语法树认、构建清单的一致性；容器 E2E 的取消、清理与镜像里的许可文件 |
| 2026-09-28 | M1-P5 | v1：部署形态（ADR-012，§8）：生产镜像、测试环境（应用 + PostgreSQL 18 + Caddy）、迁移是一次性任务、数据库两个角色与启动自检、代理未被信任的告警、哈希排队的上限；E2E 的外部模式与重启项目、容器 E2E 与 CI 的 `container` job；门禁：镜像按摘要锁定、服务端的许可正文 |

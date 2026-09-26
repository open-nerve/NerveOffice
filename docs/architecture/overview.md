# 架构总览

> 活文档：每个 Phase 结束时更新，M1-P5 形成 v1｜当前：M1-P3 完成时｜更新：2026-09-26

## 1. 目标形态与当前进度

目标形态见 00 号计划书 §9.1：浏览器里的平台页面与编辑器页（Univer），同源访问 NestJS 模块化单体，数据在 PostgreSQL 与持久化资源目录里。

| 部分 | 当前状态 |
|---|---|
| 前端 `apps/web` | 平台页面：登录页、我的空间（个人空间的文档列表）、404 与错误页（M1-P3）。编辑器页在 M1-P4 |
| 后端 `apps/api` | 横切能力（M1-P2）；账户、个人空间、会话与登录、默认拒绝的认证与 CSRF 防护、文档元数据的列表与读取、命令行初始化管理员、托管前端产物（M1-P3）。新建、读取内容与保存文档在 M1-P4 |
| 共享契约 `packages/contracts` | 错误响应与错误码、审计动作、健康检查、请求头；账户与空间的规则、登录与会话、文档的列表与元数据 |
| 数据库 | PostgreSQL 18；`audit_events`、`users`、`spaces`、`auth_sessions`、`auth_login_throttles`、`documents`（元数据）；迁移由单独的命令执行 |
| 编辑器适配层 | 未建立（M1-P4） |

## 2. 仓库结构

| 目录 | 包 | 作用 |
|---|---|---|
| `apps/web` | `@nerve-office/web` | 前端（React 19 + Vite 8；ADR-008）；`build/` 是构建插件（第三方许可清单）；`dist/` 是生产构建，`dist-e2e/` 是加上 CSP 探针的测试构建 |
| `apps/api` | `@nerve-office/api` | 后端（NestJS 12，纯 ESM，Nest CLI 构建；ADR-004） |
| `packages/contracts` | `@nerve-office/contracts` | 前后端共享的请求与响应结构（zod）、错误码、审计动作 |
| `tools` | `@nerve-office/tools` | 质量门禁、故事对照、提交钩子、`verify` |
| `tests/integration` | `@nerve-office/integration-tests` | 基于真实 PostgreSQL 的集成测试：进程内的真实应用、真实进程（构建产物）、每个测试文件独立的数据库 |
| `tests/e2e` | `@nerve-office/e2e` | Playwright：真实后端 + 数据库 + 测试构建；本机 Chromium、Chrome、WebKit，CI 另加 Edge |
| `deploy/dev` | — | 开发用的 PostgreSQL 编排 |

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
    security/     安全响应头（M0 定稿的 CSP 等）、JSON 请求体的上限与嵌套深度、元素数量
    database/     连接池与超时、Drizzle、TransactionRunner、迁移执行、就绪检查
    audit/        审计事件（只追加）
    health/       存活与就绪探针（公开）、应用的运行状态
    spaces/       个人空间（M2 扩展为团队空间与成员）
    users/        账户、Argon2id 的密码哈希、验证凭据、初始化首个管理员
    auth/         登录、退出、会话、登录限流；会话守卫与 CSRF、Origin 守卫；@CurrentPrincipal()
    documents/    文档元数据的列表与读取、访问策略（P4 加上内容与修订）
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
| 4 | 安全响应头：对所有响应生效，包括错误、404、页面、脚本与 Worker 脚本 |
| 5 | 托管前端产物（配置了 `NERVE_WEB_ROOT` 才有）：只处理 `/api` 以外的 GET、HEAD；带哈希的资源长期缓存，其他不缓存；没有扩展名的路径回退到入口页 |
| 6 | `/api` 以外的其他请求：统一的 404 错误响应 |
| 7 | JSON 请求体：上限取自配置；解析后检查嵌套深度与元素数量 |
| 8 | Nest 路由：前缀 `/api`；全局守卫（先认证，再 CSRF 与 Origin）；全局校验管道（`@Body({ schema })`，zod）；全局异常过滤器 |

**认证与会话**（ADR-007）：
- 服务端会话：令牌在 HttpOnly Cookie 里（HTTPS 时 `__Host-` 前缀与 `Secure`，`SameSite=Lax`），库里只存摘要；空闲过期（12 小时）随活动顺延，不超过绝对过期（7 天）。
- 默认拒绝：除 `@Public()`（登录、探针）外都要求有效的会话；没有会话为 `UNAUTHENTICATED`，会话失效为 `SESSION_EXPIRED`。
- 状态变更的请求：Origin 必须等于公开地址（`NERVE_PUBLIC_ORIGIN`）；需要登录的接口另要求 `X-CSRF-Token` 等于由会话令牌派生的令牌。
- 登录限流按用户名与按客户端地址两个维度计数（存在数据库里），锁定期间不验证密码；登录成功、失败与退出都写审计。
- 密码用 Argon2id（@node-rs/argon2），参数可配置；首个管理员用命令行初始化（`init-admin`，密码从终端或标准输入读取）。

**接口**（M1-P3）：

| 接口 | 说明 |
|---|---|
| `POST /api/auth/login`、`POST /api/auth/logout`、`GET /api/auth/session` | 登录、退出、当前会话（账户、个人空间、CSRF 令牌） |
| `GET /api/documents?limit=&cursor=` | 个人空间的文档，按更新时间从新到旧，keyset 分页 |
| `GET /api/documents/{id}` | 文档元数据与调用者的权限；别人的与不存在的文档都是 404 |
| `GET /api/health/live`、`GET /api/health/ready` | 存活与就绪探针（公开） |

**错误**（ADR-006）：
- 响应统一为 `{ "error": { "code", "message", "requestId" } }`；错误码登记在 contracts，每个错误码对应固定的 HTTP 状态。
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

**文档的访问策略**：服务只经 `DocumentAccessPolicy` 判断权限；M1 只有"个人空间的所有者"一条规则，M2 在同一个接口后面扩展为有效权限。

**运行与退出**：
- 就绪探针检查接收请求、数据库可达与库结构版本，整体限时 2 秒。
- 收到 SIGTERM 或 SIGINT 后：标记退出；在途与之后的响应带 `Connection: close`；停止接收新连接；等在途请求完成（超时就强制断开）；最后关闭应用与连接池。
- 退出码：正常 0，强制或失败 1；退出过程中再次收到信号就立即退出。

## 4. 前端

```text
apps/web/src/
  entries/platform/   平台页面的入口：挂载应用、关闭 zod 的 JIT（CSP）、从往返缓存恢复时重新加载
  entries/csp-probe/  CSP 阳性对照（只在测试构建里）
  app/                路由表、请求缓存（全局的未登录处理）、布局、404 与错误页
  features/auth/      登录页、会话、需要登录的外层路由、退出
  features/documents/ 我的空间的文档列表
  shared/             请求层（api）、界面组件（ui，改写后的 shadcn/ui）、界面文字（i18n）、小工具（lib）
```

- React Router 8（数据路由的库模式）、TanStack Query 5、Tailwind CSS 4 与 shadcn/ui 的 Radix 版本（ADR-008）。
- 请求层：同源请求，状态变更的请求带 CSRF 令牌；错误分为 `ApiError`、`NetworkError`、`ResponseFormatError`；成功的响应按 contracts 校验。
- 任何请求得到未登录或登录已过期：清空缓存，回到登录页，登录后回到原来的地址。
- 首屏 JS 预算：平台页面 180 KiB（gzip），门禁 `budgets` 检查。

## 5. 模块边界

- `@univerjs/*` 只能在 `apps/web/src/editor/` 下引用（静态导入、再导出、动态导入都算），任何位置都不能引用 `@univerjs-pro/*`。
- **web** 分层：
  - 入口（`src/entries/*`）→ 应用（`src/app`）→ 功能（`src/features/*`）→ 共享（`src/shared`）；
  - 编辑器（`src/editor`）只依赖共享与 contracts；
  - 平台页面的入口不引用编辑器。
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

规则由 ESLint 执行，并有自测（`tools/src/lint/lint-rules.test.ts`）。

## 6. 质量门禁

| 门禁 | 时机 | 内容 |
|---|---|---|
| 提交钩子（lefthook） | 每次提交 | 暂存文件的 `eslint --fix`；去掉提交说明里的 AI 署名 |
| `pnpm verify --fast` | pre-push | lint、类型检查、单元测试、静态检查（精确版本、包管理配置、故事对照、迁移只向前、表定义与迁移同步） |
| `pnpm verify` | 合并到 main 之前 | lint、类型检查、静态检查；启动开发数据库；单元与集成测试合在一起跑并统计覆盖率；清理并构建；依赖图与许可、产物扫描与第三方许可清单、首屏体积预算；前端的测试构建；E2E（本机三个浏览器，真实后端与数据库） |
| CI（`.github/workflows/ci.yml`） | 推送 main；每周一次；手动 | `pnpm verify --ci`（PostgreSQL 服务容器）与依赖漏洞扫描；失败的步骤、汇总与失败的 E2E 用例写成 GitHub 注解，不登录也能读取 |

A01 等检查（`pnpm gate <名称>`）：

| 检查 | 内容 |
|---|---|
| `pins` | 外部依赖都经 pnpm 目录引用，目录里是精确版本；内部包 `workspace:*`；`packageManager` 精确 |
| `config` | 只有评审过的顶层设置，没有 pnpmfile；发布冷却期不少于 3 天、`trustPolicy`、`engineStrict`；安装脚本、冷却期豁免（只能写"包名@精确版本"）、`overrides`、peer 规则、补丁逐项写明原因 |
| `stories` | 当前 M 的故事登记表与总设计一致；active 的故事有会执行的测试（取自 Vitest 全部项目与 Playwright 的列举） |
| `migrations` | journal 与迁移文件一一对应、时间戳递增、迁移名的写法、快照的 prevId 链；与基准版本（本机：与 main 的分叉点；CI：推送之前的提交）相比，已合并的迁移没有变化，新迁移只追加在末尾 |
| `schema` | 表定义与迁移同步：对迁移目录的副本执行一次 drizzle-kit generate，不应生成新文件，并且要给出"没有变化"的结论（改列名等要交互确认的变更同样失败） |
| `deps` | 生产依赖图（含可选依赖，按真实包名）没有 Pro，Univer 版本一致，应为单例的包（React、rxjs、NestJS、reflect-metadata、drizzle-orm 等）只有一份，依赖树完整 |
| `licenses` | 生产依赖的每个安装实例的许可在白名单内（本机没装的平台专属包以 CI 为准）；开发依赖没有 GPL、AGPL、SSPL 与未声明许可 |
| `artifacts` | 构建产物只有登记过的文件类型（`.json` 也扫描，只放行三个清单文件）；没有动态代码（登记过的能力探测除外）、没有未登记的外部主机与关键字；没有只属于测试构建的文件（CSP 探针）；第三方许可清单（含 Worker 的产物）完整 |
| `budgets` | 各入口首屏 JS 的体积（入口块加上静态引用的块，gzip）不超过预算 |
| `audit` | 生产依赖没有高危及以上的漏洞；例外有原因与到期日；没有被配置藏起来的漏洞 |

覆盖率下限（单元与集成测试合计）：contracts 90%，api 80%，web（编辑器适配层以外）70%，tools 80%。

## 7. 数据库

- PostgreSQL 18.6，镜像按摘要锁定；新库使用内置的 `C.UTF-8` 排序规则，开启数据页校验和；主键用 `uuidv7()`。
- 开发：`pnpm db:up`（只监听 `127.0.0.1:54318`），`pnpm db:migrate` 执行迁移，`pnpm db:generate --name <名称>` 按表定义生成迁移。CI 使用同一个镜像的服务容器。
- 集成测试：每个测试文件从模板库复制一份独立的数据库；模板按迁移的名称、哈希与时间戳命名，迁移不变时复用。
- E2E：每次运行建一个专用的库（名称带 Playwright 主进程的进程号），由服务脚本迁移、初始化管理员，结束时删除；遗留的库下次清理。

| 表 | 模块 | 说明 |
|---|---|---|
| `audit_events` | audit | 审计事件：动作、操作者、对象、来源（请求标识、客户端地址）、补充信息；CHECK 约束兜底；触发器拒绝更新、删除与清空（前提：应用的数据库角色不是表的所有者或超级用户，P5 落实） |
| `users` | users | 账户：用户名（小写的规范写法，唯一）、显示名、Argon2id 哈希（CHECK 只接受 `$argon2id$`）、系统角色、状态 |
| `spaces` | spaces | 空间：M1 只有个人空间，每人一个（部分唯一索引），不能全员可见 |
| `auth_sessions` | auth | 登录会话：令牌摘要（唯一）、空闲与绝对过期、撤销的时间与原因 |
| `auth_login_throttles` | auth | 登录限流的计数：键的摘要、窗口内的失败次数、锁定到期 |
| `documents` | documents | 文档的元数据：所属空间、类型、标题、创建者、状态；按空间与更新时间的索引。P4 加上修订号、`unitId`、插件档案与内容表 |

## 8. 变更记录

| 日期 | Phase | 变更 |
|---|---|---|
| 2026-09-26 | M1-P1 | 初版：仓库结构、工具链、模块边界、质量门禁、开发数据库 |
| 2026-09-26 | M1-P2 | 后端骨架与横切能力；后端的模块边界；错误码；数据库与迁移、`migrations` 与 `schema` 检查；审计；覆盖率改为单元与集成测试合计 |
| 2026-09-26 | M1-P3 | 账户、个人空间、会话与登录、默认拒绝的认证与 CSRF、文档元数据；前端骨架；托管前端产物；E2E 改测真实后端；`budgets` 检查 |

# 架构总览

> 活文档：每个 Phase 结束时更新，M1-P5 形成 v1｜当前：M1-P2 完成时｜更新：2026-09-26

## 1. 目标形态与当前进度

目标形态见 00 号计划书 §9.1：浏览器里的平台页面与编辑器页（Univer），同源访问 NestJS 模块化单体，数据在 PostgreSQL 与持久化资源目录里。

| 部分 | 当前状态 |
|---|---|
| 前端 `apps/web` | 占位页面（M1-P3 换成登录页与个人空间） |
| 后端 `apps/api` | 骨架与横切能力：配置、日志与请求标识、错误码与统一错误响应、安全响应头与请求体上限、数据库与迁移、审计、存活与就绪探针、优雅退出（M1-P2）。还没有业务接口（M1-P3 起） |
| 共享契约 `packages/contracts` | 错误响应结构与错误码登记表、审计动作、健康检查的响应、请求标识的请求头 |
| 数据库 | PostgreSQL 18；第一张表 `audit_events`（只追加）；迁移由单独的命令执行 |
| 编辑器适配层 | 未建立（M1-P4） |

## 2. 仓库结构

| 目录 | 包 | 作用 |
|---|---|---|
| `apps/web` | `@nerve-office/web` | 前端（React 19 + Vite 8）；`build/` 是构建插件（第三方许可清单） |
| `apps/api` | `@nerve-office/api` | 后端（NestJS 12，纯 ESM，Nest CLI 构建；ADR-004） |
| `packages/contracts` | `@nerve-office/contracts` | 前后端共享的请求与响应结构（zod）、错误码、审计动作 |
| `tools` | `@nerve-office/tools` | 质量门禁、故事对照、提交钩子、`verify` |
| `tests/integration` | `@nerve-office/integration-tests` | 基于真实 PostgreSQL 的集成测试：进程内的真实应用、真实进程（构建产物）、每个测试文件独立的数据库 |
| `tests/e2e` | `@nerve-office/e2e` | Playwright：本机 Chromium、Chrome、WebKit，CI 另加 Edge |
| `deploy/dev` | — | 开发用的 PostgreSQL 编排 |

模块系统、contracts 的导出条件与边界的强制方式见 ADR-003；版本基线见 ADR-002。

## 3. 后端

```text
apps/api/src/
  app/            应用的组装：根模块、HTTP 管线、优雅退出、进程入口 main.ts；index.ts 是命令行与集成测试共用的程序接口
  shared/         AppError 等共用的内核
  modules/
    config/       环境变量（NERVE_*，机密可以用 _FILE），启动时校验；只有这里读 process.env
    logging/      pino 根日志、请求日志与请求标识、脱敏、请求上下文、注入的 AppLogger、Nest 日志适配
    security/     安全响应头（M0 定稿的 CSP 等）、JSON 请求体的上限与嵌套深度、元素数量
    database/     连接池与超时、Drizzle、迁移执行、就绪检查
    audit/        审计事件（只追加）
    health/       存活与就绪探针、应用的运行状态
  db/
    schema/<模块>/  各模块的表定义
    migrations/   drizzle-kit 生成、人工审阅的迁移
  cli/migrate.ts  迁移命令
```

**请求管线**（`app/configure-http.ts`，顺序一次写定）：

| 顺序 | 环节 |
|---|---|
| 1 | 在途请求计入（优雅退出时要等它们完成） |
| 2 | 请求日志与请求标识（`X-Request-Id` 合法就沿用，否则生成 UUID） |
| 3 | 请求上下文：之后在这个请求里写的日志都带请求标识 |
| 4 | 安全响应头：对所有响应生效，包括错误与 404 |
| 5 | JSON 请求体：上限取自配置；解析后检查嵌套深度与元素数量 |
| 6 | Nest 路由：前缀 `/api`；全局校验管道（`@Body({ schema })`，zod）；全局异常过滤器 |

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
- 表只由所属模块的仓储读写；服务用 `TransactionRunner` 开启事务，把不透明的 `Transaction` 显式传给仓储。`TransactionRunner` 自己借出、归还连接：除业务错误外，失败的事务丢弃它的连接。

**运行与退出**：
- 就绪探针检查接收请求、数据库可达与库结构版本，整体限时 2 秒。
- 收到 SIGTERM 或 SIGINT 后：标记退出；在途与之后的响应带 `Connection: close`；停止接收新连接；等在途请求完成（超时就强制断开）；最后关闭应用与连接池。
- 退出码：正常 0，强制或失败 1；退出过程中再次收到信号就立即退出。

## 4. 模块边界

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

## 5. 质量门禁

| 门禁 | 时机 | 内容 |
|---|---|---|
| 提交钩子（lefthook） | 每次提交 | 暂存文件的 `eslint --fix`；去掉提交说明里的 AI 署名 |
| `pnpm verify --fast` | pre-push | lint、类型检查、单元测试、静态检查（精确版本、包管理配置、故事对照、迁移只向前、表定义与迁移同步） |
| `pnpm verify` | 合并到 main 之前 | lint、类型检查、静态检查；启动开发数据库；单元与集成测试合在一起跑并统计覆盖率；清理并构建；依赖图与许可、产物扫描与第三方许可清单；E2E（本机三个浏览器） |
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
| `artifacts` | 构建产物只有登记过的文件类型（`.json` 也扫描，只放行三个清单文件）；没有动态代码、没有未登记的外部主机与关键字；第三方许可清单（含 Worker 的产物）完整 |
| `audit` | 生产依赖没有高危及以上的漏洞；例外有原因与到期日；没有被配置藏起来的漏洞 |

覆盖率下限（单元与集成测试合计）：contracts 90%，api 80%，web（编辑器适配层以外）70%，tools 80%。

## 6. 数据库

- PostgreSQL 18.6，镜像按摘要锁定；新库使用内置的 `C.UTF-8` 排序规则，开启数据页校验和；主键用 `uuidv7()`。
- 开发：`pnpm db:up`（只监听 `127.0.0.1:54318`），`pnpm db:migrate` 执行迁移，`pnpm db:generate --name <名称>` 按表定义生成迁移。CI 使用同一个镜像的服务容器。
- 集成测试：每个测试文件从模板库复制一份独立的数据库；模板按迁移的名称、哈希与时间戳命名，迁移不变时复用。

| 表 | 模块 | 说明 |
|---|---|---|
| `audit_events` | audit | 审计事件：动作、操作者、对象、来源（请求标识、客户端地址）、补充信息；CHECK 约束兜底；触发器拒绝更新、删除与清空（前提：应用的数据库角色不是表的所有者或超级用户，P5 落实） |

## 7. 变更记录

| 日期 | Phase | 变更 |
|---|---|---|
| 2026-09-26 | M1-P1 | 初版：仓库结构、工具链、模块边界、质量门禁、开发数据库 |
| 2026-09-26 | M1-P2 | 后端骨架与横切能力；后端的模块边界；错误码；数据库与迁移、`migrations` 与 `schema` 检查；审计；覆盖率改为单元与集成测试合计 |

# 架构总览

> **2026-10-27 最新断点**：M5-P1/P2/P3 已实际关闭。唯一 P4 分支 `codex/m5-p4-history-gc` 的历史与资源回收实现、六组容量实测、阶段审查及修复完成；同源码 full11 默认完整门禁与 container01 完整生产容器均通过，原件和资源清理分别经独立接受。P4 尚待正常提交/no-ff main、同 SHA 六项 CI、最终证据冻结及唯一分支/worktree 清理。详见 [P4 最终验收记录](../v0.1/M5-表格能力与资源/reviews/P4-S6-最终CI与关闭复核.md) 与 [P4 设计](../v0.1/M5-表格能力与资源/04-P4-历史与资源回收.md)。

CI 的 E2E 分片由独占进程监督器直接运行原 Playwright CLI，按随机 UUID 与内核进程身份确认全部写入者退出后再归档；CI 专用 fork preload 仅传递非秘密归属标记。正常本机/容器入口、原用例范围、单例时限与覆盖率要求保持，详细预算和验证边界见 [P3-S6 局部修复与收尾复核](../v0.1/M5-表格能力与资源/reviews/P3-S6-链接修复与CI收尾复核.md)。

> 活文档：每个 Phase 结束时更新｜当前：v0.1（M4 工程交接、M5-P1/P2/P3 工程交付已完成；M5-P4 本机完整门禁/生产容器及审查通过，合并与 CI 收尾待执行）｜更新：2026-10-27

**接续状态**：M4 工程交接已合入 `main@609574d3`；DEF-073/UR-035、完整验收和标签继续挂账。M5-P1/P2/P3 均已完成工程交付，最终 P3 main 为 `3f498f7b`。Excel、Safari 和剩余 Finder 原生矩阵仍按原交接记账；这些待验项不表示产品缺陷或自动化失败可放行。当前完成 P4 文档与正常提交、合并后同 SHA CI、冻结和清理；P4 实际关闭后进入 P5。

## 1. 目标形态与当前进度

M5-P3 已完成的实现保持既有边界：contracts 的 `canonicalLink` 统一表单、命令、粘贴和明确点击导航；documents 的快照检查沿原子进程/保存协议返回有界 `linkLocations`，页面用当前实例名称显示位置，不回显正文或地址。正式工具栏、右键和快捷键支持普通/富文本与内部目标，查看者防火墙独立执行。没有新增后端接口、数据库迁移、快照版本或第二条保存通道。

固定 Univer 1.0.1 的适配登记集中在 ADR-010：异步数据验证属于原 Workbook/Worksheet 与同格代次，退役不写新实例；规则面板按顺序保留字段增量和范围历史；条件格式使用当前输入验证；编辑栏、单元格与表名维护逻辑/原生选区及定时任务归属。补丁保持 ES/CJS 对称和可移除条件，当前累计 16 个固定包，未升级 SDK。S4 的逐项 UI、历史、保存重开/查看者和 S5 的六类公式、两次上传、恢复/Worker 退路已验证；详见 [P3 能力报告](../v0.1/M5-表格能力与资源/reviews/P3-能力验收报告.md)。P3 完整 Phase 审查、本机完整门禁、容器及最终同 SHA 六项 CI 均已通过，原件冻结和清理见 [P3 交接](../v0.1/M5-表格能力与资源/handoffs/P3-交接单.md)。

目标形态见 00 号计划书 §9.1：浏览器里的平台页面与编辑器页（Univer），同源访问 NestJS 模块化单体，数据在 PostgreSQL 与持久化资源目录里。

| 部分 | 当前状态 |
|---|---|
| 前端 `apps/web` | 平台页面：登录页、我的空间（个人空间的文档列表、新建表格）、404 与错误页（M1-P3、P4）；修改密码、接受邀请与重置密码的公开页面、管理界面（账户、邀请、审计，按需加载）（M2-P1）；左侧导航与空间页、成员页（按需加载）、管理界面的团队空间与停用者文档的转移（M2-P2）；空间页里的文件夹导航与行内操作（新建、改名、移动、复制、删除）、回收站页与顶栏搜索（各自按需加载）（M2-P4）；表格编辑器页（M1-P4：整页加载，显式保存；M2-P2 起返回文档所在的空间；M2-P3 起查看者的只读加固；M3-P1 起编辑租约，M3-P2 起阅读与编辑、另存为副本，M3-P4 起自动保存与打开自检，M3-P5 起交接规则）；管理界面账户页的吊销本机密钥与状态列的版本（M3-P6）；本机发件箱的底座（M4-P1，ADR-020：`shared/outbox/` 的 IndexedDB 存储与写入栅栏、加密、写入管道、OPFS 的冗余、本机密钥的客户端、本机存储的状态与合一的清理，`features/sheet-editor/outbox/` 的发件箱 Worker；P2 已接入编辑器页：唯一工作草稿来源、双层保存事实、重连编辑权许可、换钥与部署开关；P3 已接入判定表、原子接手/条件清理、冲突副本、明确恢复与固定时限接手；P4 已完成本机草稿页、三处列表标记、会话资格、启动维护与完整本机清理；P5 已接入公式 Worker 故障后的同会话主线程重建，该 Phase 的 S6 累计验收及 main 同 SHA 六项 CI 已通过）；M5-P2：正式 PNG/JPEG/WebP/GIF 浮图与单元格图片、受管复制/粘贴/拖放、图片失败反馈和每实例退役清理 |
| 后端 `apps/api` | 横切能力（M1-P2）；账户、个人空间、会话与登录、默认拒绝的认证与 CSRF 防护、文档元数据的列表与读取、命令行初始化管理员、托管前端产物（M1-P3）；新建文档、读取内容、按修订号保存（M1-P4）；修改密码、邀请注册与重置密码的一次性令牌、停用与启用、系统管理员的授予与取消、同事目录、系统管理的接口与审计查询、运维的重置链接命令（M2-P1）；团队空间与成员、有效权限与"可访问文档"、按空间列出与新建、收回写入权的入口、停用者文档的转移（M2-P2，ADR-014）；文件夹、改名移动复制、回收站与恢复、永久删除与 jobs 模块的 30 天自动清理、按标题搜索（M2-P4，ADR-016）；复核之后的加固（M2-P6：登录限流的三个维度与解除锁定、签发人离任作废链接、团队空间名称的判重键、复制在锁下重新判断、数据库繁忙的回答等，见各节）；编辑租约（M3-P1）、另存为副本与条件读取（M3-P2）、保存协议加固（M3-P3）、打开自检失败的上报（M3-P4）、交接规则（M3-P5）、本机密钥（M3-P6：取用、吊销与审计、心跳带版本、主密钥只给应用进程与启动自检）；本机草稿的批量文档事实、携带原会话失效原因的认证响应（M4-P4，无 PostgreSQL 迁移）；M5-P1：图片处理子进程与硬预算、私有对象/持久预留/配额、按文档权限读取，以及保存和副本中的完整资源引用关系 |
| 共享契约 `packages/contracts` | 错误响应（含可选的 `details`）与错误码、审计动作、健康检查、请求头；账户与空间的规则、登录与会话、文档的列表与元数据、新建与保存、快照的常量、收敛的模板快照、编辑器页的地址；文件夹、文档的整理、回收站与搜索（M2-P4）；名称的空白与判重规则（M2-P6）；编辑租约、编辑状态与交接（M3-P1、P2、P5）、保存协议的信封与链接判定（M3-P3）、本机密钥（M3-P6）；本机草稿的保留期（M4-P1）、批量文档事实与会话失效原因（M4-P4）；M5-P1/P2：图片格式/字节/像素边界、上传响应及固定错误、有界保存拒绝位置与规范资源 URL |
| 数据库 | PostgreSQL 18；`audit_events`、`users`、`spaces`、`auth_sessions`、`auth_login_throttles`、`auth_invitations`、`auth_password_resets`、`space_members`、`folders`、`trash_entries`、`documents`、`document_contents`、`document_revisions`、`document_grants`、`document_edit_leases`、`document_save_receipts`、`user_local_keys`、`assets`、`asset_objects`、`asset_object_claims`、`asset_quota`、`document_asset_links`、`document_checkpoints`、`document_history_buckets`、`document_checkpoint_assets`、`document_upgrade_batches`、`document_upgrade_sources`、`document_upgrade_barrier`、`asset_reference_activity`、`asset_object_deletions`（§7 的表清单；P4 尚未整阶段交付）；迁移由单独的命令执行 |
| 编辑器适配层 | `apps/web/src/editor/`（M1-P4，ADR-010）：插件档案 `sheet@1`、公式 Worker、身份替换（ADR-009）、变更检测、公式收齐、`IMAGE()` 的限制、按阶段开放的入口守卫（P2 开放表格图片，P3 开放正式链接，背景/文档图片仍关闭）、内部 API 的登记；销毁之后不抛错的语言服务、打开自检的资源守卫与判定、主线程公式模式的档案变体（M3-P4 起存在；M4-P5 起用于生产故障退路，`formula=main` 仍只属于测试构建）、组合输入与面板防抖的观察（`composition-watch`、`panel-debounce-watch`，M3-P4）、还没写进模型的输入合成一个状态（`uncommitted-input`：单元格编辑器与面板的防抖，保存的状态机据此算未保存与离开提示，M3 合并前评审 CX4）、主线程模式下销毁之前停下正在算的一轮（`formula-round-stop`，M3-P4）；能不能编辑在创建时决定，只读守卫与只读的界面（M2-P3，ADR-015）；SDK 偏好服务在 UniverUIPlugin 注入点替换为每编辑器实例的内存实现（M4-P4）；M5-P2：`images/` 统一实例资源、系统输入与 SDK IO，IMAGE 在名称展开前与运行期双重核对来源，九份固定 1.0.1 补丁覆盖实际 ES 入口（ADR-022） |
| 部署 | 生产镜像（多阶段构建、非 root、健康检查）；测试环境：应用 + PostgreSQL 18 + Caddy（HTTPS）；迁移是一次性任务；数据库两个角色；容器 E2E（M1-P5，ADR-012，§8）；共享依赖输入包含 `patches/`，完整安装与 API 生产依赖安装均按固定补丁执行 |

## 2. 仓库结构

| 目录 | 包 | 作用 |
|---|---|---|
| `apps/web` | `@nerve-office/web` | 前端（React 19 + Vite 8；ADR-008）：三个入口页 `index.html`（平台页面）、`editor.html`（编辑器页）与 `history-preview.html`（独立历史只读预览）；`build/` 是构建插件（第三方许可清单），`third-party-licenses/` 是发布包里缺许可文件的包的正文；`dist/` 是生产构建，`dist-e2e/` 是加上 CSP 探针与编辑器的 E2E 探针（M2-P3）的测试构建 |
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
  shared/         AppError、@Public()、@SystemAdminOnly()、按时间排序的游标、LIKE 的"包含关键词"等共用的内核；子进程池 process-pool（M3-P3）、按键限份数的 keyed-quota（M3-P3 审查之后）
  modules/
    config/       环境变量（NERVE_*，机密可以用 _FILE），启动时校验；只有这里读 process.env
    logging/      pino 根日志、请求日志与请求标识、脱敏、请求上下文（认证后带 userId）、注入的 AppLogger、Nest 日志适配
    security/     安全响应头（M0 定稿的 CSP 等）、JSON 请求体的上限与嵌套深度、元素数量、代理未被信任的告警
    database/     连接池与超时、Drizzle、TransactionRunner（写事务 run——可带限时 limit：第一条语句里按数据依赖先把 transaction_timeout 设成 0 再设成 timeoutMs、读 BEGIN 至今的时长，超过 startWithinMs 就 LateTransactionStartError，M3-P5——与读请求的只读快照 readSnapshot，ADR-017）、迁移执行、就绪检查；
                  请求级的提交记录 CommitLedger（M2-P6）
    audit/        审计事件（只追加）；启动时检查数据库角色能否关掉审计表的触发器
    health/       存活与就绪探针（公开）、应用的运行状态
    assets/       图片完整处理、进程准入与硬预算、私有文件、元数据/持久预留/组织配额；向上提供上传、已授权读取及引用事实，不反向依赖 documents（M5-P1，ADR-021）
    spaces/       空间与成员的数据与不变量：个人空间、团队空间（创建、改名、全员可见、归档与恢复）、成员与空间角色（至少保留一个空间管理员）、
                  权限用的空间事实（M2-P2）；没有控制器，不判断谁能做什么（users、auth、documents 都依赖它）
    users/        账户、Argon2id 的密码哈希（并发与排队都有上限）、验证凭据、初始化首个管理员；停用与启用、系统角色（至少保留一个有效的管理员）、
                  建账户与个人空间（初始化与接受邀请共用）、同事目录与账户列表（M2-P1）
    auth/         登录、退出、会话、登录限流；会话守卫（含系统管理员接口的检查；标了 @BackgroundRequest() 的接口不顺延登录，M3-P2）与 CSRF、Origin 守卫；@CurrentPrincipal()；
                  修改密码、按人撤销会话、邀请注册与重置密码的一次性令牌与尝试限流（M2-P1，ADR-013）
    admin/        系统管理的接口与跨模块的编排：账户、邀请、重置链接、审计查询（M2-P1）；团队空间的创建、全员可见、归档与恢复，
                  停用接上收回写入权，停用者文档的转移（M2-P2）；只给系统管理员
    workspace/    面向成员的空间接口与编排（M2-P2）：我能看到的空间、空间页头、成员的查看与管理、改名；
                  文件夹、文档的整理与复制、回收站、按标题搜索（M2-P4）；分享的写入编排与授权列表、"与我共享"、搜索结果与"与我共享"里个人空间的所有者人名（M2-P5）；授权经 documents 的访问策略；
                  编辑权的接口（申请、心跳、释放、编辑状态，补持有者的人名，M3-P1，ADR-018；编辑状态带 canEdit、编辑状态与心跳是后台请求，M3-P2）
    documents/    文档：按空间列出与读取、新建到指定空间（模板快照、requestId 幂等）、内容的读取与保存（ADR-011）；有效权限的唯一入口与
                  "可访问文档"的条件（范围与状态两维）、writeEpoch 与收回写入权的入口、转移（M2-P2，ADR-014）；
                  文件夹（层数存列、最多 10 层）、改名与移动与复制、回收站的删除单元与恢复、永久删除、按标题搜索（M2-P4，ADR-016）；
                  同一个空间里的结构性改动由空间树的 advisory lock 串行，保存内容不取这把锁；
                  单独授权（M2-P5：`document_grants` 与仓储、有效权限并上授权、分享在事务里的锁下复核与写入、收回写入权的 userDocuments）；
                  编辑租约（M3-P1，ADR-018：`document_edit_leases`、有效条件的纯函数、申请与心跳与释放与编辑状态、保存时核对租约、收回写入权接入租约；为判断别人的租约绑定的登录引入 auth）；
                  交接规则（M3-P5，ADR-018 的补充：迁移 0025 的请求、保留与接管标记；占用判断 `occupancyOf`、申请怎样对待占着的那一代 `claimOf`、请求与保留的规则 `edit-request-rules.ts`；请求编辑与交出 `EditRequestService`；两个服务共用的事实 `edit-lease-facts.ts`；强制接管的权限位 `canTakeOver` 与操作 `takeOver`、审计 `documents.edit_taken_over`；收回写入权只收回按时间还活着的租约，刚死不久的仍锁文档行等在途的保存——保存的事务从 BEGIN 到提交至多 70 秒——`SAVE_TRANSACTION_START_WITHIN_MS` 10 秒加 `SAVE_TRANSACTION_TIMEOUT_MS` 60 秒，这个前提因此成立）；
                  另存为副本与读取内容的条件请求（M3-P2，ADR-011、ADR-014 的补充：DocumentConflictCopyService、@IfNoneMatch()）；
                  保存协议加固（M3-P3，ADR-011 的修订）：重放预检与回执（save-outcomes、document-save-receipts）、拦截旧客户端（ClientFormatGate）、
                  快照的检查（SnapshotInspector：子进程池，每个账户至多 2 份；snapshot-checks、snapshot-inspection）、requestId 的锁与两张表的记录（RequestLedger）、不缩水（legacy-resources）、保留期清理的入口（RevisionPurgeService）；
                  打开自检失败的上报（M3-P4，ADR-011 的补充：OpenCheckReportsController、OpenCheckReportService，进程内去重与按账户限量的 OpenCheckReportGate）
    local-keys/   本机密钥（M3-P6，ADR-019）：表 `user_local_keys` 与仓储、主密钥环（HKDF 派生、AES-256-GCM 包装）、取用 `POST /api/local-key`、吊销的入口 `LocalKeyRevocation`（只给 admin）、
                  版本的读取 `LocalKeyVersions`（admin 的账户视图、workspace 的心跳）、启动自检 `MasterKeyCheck`；主密钥只经 `LOCAL_KEYS_CONFIG` 注入
    jobs/         应用内的定时任务（M2-P4，ADR-016）：回收站到期的自动清理、修订记录与回执的保留期清理（M3-P3，事务级 advisory lock）；共用的调度器 JobScheduler。
                  只做"按时触发 + 防重复执行"（回收站清理用会话级 advisory lock），
                  删除的语义在 documents；时钟可注入，测试不必等 30 天
    web-hosting/  托管前端产物；/api 以外的其他请求得到统一的 404
  db/
    schema/<模块>/  各模块的表定义；schema/common 是表定义共用的写法（枚举的 CHECK、bytea）
    migrations/   drizzle-kit 生成、人工审阅的迁移
  cli/            迁移命令 migrate.ts、初始化管理员 init-admin.ts、运维的重置链接 reset-link.ts（M2-P1）
```

**请求管线**（`app/configure-http.ts`，顺序一次写定）。管线之前的应用设置：信任代理的跳数取自配置；不发 `X-Powered-By`；不要 Express 按响应体自动算的 ETag（M3-P6 审查 A8：接口的响应都是 `no-store`，ETag 没有用处；响应体里有原始密钥、租约令牌、一次性链接时，它就是这些机密的稳定指纹）——读取内容的 ETag 是修订号，由那个接口自己写，静态文件的由 `express.static` 自己管，都不受影响：

| 顺序 | 环节 |
|---|---|
| 1 | 在途请求计入（优雅退出时要等它们完成） |
| 2 | 请求日志与请求标识（一律生成 UUID；客户端带来的 `X-Request-Id` 合法时只作为 `clientRequestId` 记进日志，M2-P6） |
| 3 | 请求上下文：之后在这个请求里写的日志都带请求标识 |
| 3b | 提交记录（`CommitLedger`，M2-P6）：每个请求一份"有没有事务已经提交"，数据库繁忙时据此回 503 还是 500（ADR-006） |
| 3c | 请求的身份（`RequestIdentities`，auth 模块，M2 Codex 评审）：每个请求一份"会话守卫判断过的身份"，只读快照的开场核对据此在快照里再查一次会话、账户与系统角色（ADR-017） |
| 4 | 代理未被信任的告警：公开地址是 HTTPS、经代理转发来的请求（带转发头）却不是 HTTPS 时，每个进程记一条（DEF-014） |
| 5 | 安全响应头：对所有响应生效，包括错误、404、页面、脚本与 Worker 脚本 |
| 6 | 托管前端产物（配置了 `NERVE_WEB_ROOT` 才有）：只处理 `/api` 以外的 GET、HEAD；带哈希的资源长期缓存，其他不缓存；编辑器页的地址（`/documents/<UUID>`）给 `editor.html`，历史预览（`/documents/<UUID>/history/<UUID>/preview`）给 `history-preview.html`，其他没有扩展名的路径回退到平台页面 |
| 7 | `/api` 以外的其他请求：统一的 404 错误响应 |
| 8 | JSON 请求体：上限取自配置；解析后检查嵌套深度与元素数量。保存快照的正文（`application/gzip`）不经它，由那个路由的拦截器在守卫之后读取 |
| 9 | Nest 路由：前缀 `/api`；全局守卫（先认证，再 CSRF 与 Origin）；全局校验管道（`@Body({ schema })`，zod）；全局异常过滤器 |

**认证与会话**（ADR-007）：
- 服务端会话：令牌在 HttpOnly Cookie 里（HTTPS 时 `__Host-` 前缀与 `Secure`，`SameSite=Lax`），库里只存摘要；空闲过期（12 小时）随活动顺延，不超过绝对过期（7 天）。
- 默认拒绝：除 `@Public()`（登录、探针）外都要求有效的会话；没有会话为 `UNAUTHENTICATED`，会话失效为 `SESSION_EXPIRED`（并清除 Cookie；因换令牌而撤销的——同一个浏览器重新登录、在这个浏览器里修改密码，原因 `replaced`——不清除，免得晚到的响应删掉新的 Cookie，M2-P6 复验 N3）。
- 状态变更的请求：Origin 必须等于公开地址（`NERVE_PUBLIC_ORIGIN`）；需要登录的接口另要求 `X-CSRF-Token` 等于由会话令牌派生的令牌。
- 登录限流按三个维度计数，存在数据库里（M2-P6 复核 A1 起，ADR-007）："用户名 + 来源"（默认 5 次，只锁这个组合；来源的 IPv6 按 /48，M2-P6 复验 N4）、只按用户名（宽得多，默认 50 次，挡住从很多来源猜同一个账户）、只按客户端地址（IPv6 按 /64）：
  - 两个账户相关的维度的计数行记着所属账户：完成重置、接受邀请时清掉这个账户的全部计数；系统管理员可以在账户页解除锁定（记审计）；
  - 先占用名额、再验证，并发的请求也不能多验证；锁定期间不验证密码；
  - 过期的计数与会话在验证之后、事务之外顺带清理，跳过别人锁着的行；
  - 数据库繁忙时，还没得出对不对的结论或已经确认是对的尝试退回名额，猜错之后照样计数（M2-P6 第 3 片复验）；
  - 登录成功、失败与退出都写审计。
- 新建会话的写操作（登录、修改密码、接受邀请、完成重置）在业务事务里拼好响应（`SessionResponses`），全部成功之后才写 Cookie（M2-P6 第 3 片复验）。
- 修改密码（M2-P1）：要输入旧密码，经登录限流（与猜登录密码同一套计数），改完撤销本人的全部会话，为当前页面新建一个（换掉令牌，M2-P6 复核 B1）；停用账户、签发与完成重置时撤销这个人的全部会话。
- 验证在事务之外，事务里先锁账户行复核（M2-P1 审查，ADR-007 的补充）：登录用 `FOR SHARE` 复核账户有效、凭据的版本（`password_version`：换凭据时加一，按新参数重新哈希不变）还是验证时的那个；修改密码、签发与完成重置、停用、启用、系统角色用 `FOR NO KEY UPDATE`。锁的顺序统一为 system-admins 的 advisory lock（停用与系统角色排他，其他管理操作共享，都在锁里复核操作者）→ 按登录名的 advisory lock（邀请）→ 账户行 → 重置行或邀请行 → 限流计数 → 会话行 → 空间树的 advisory lock（按空间 id，M2-P4）→ 空间行 → 成员行 → 文件夹行、文档行、回收站行 → 租约行（申请、释放、交出与收回写入权先锁文档行、再锁租约行，心跳与请求编辑只锁租约行；明确结束在类型上凭先锁文档行、再锁住的租约行 `LockedEditLease`，M3-P1，M3 合并前评审 CX1，ADR-018）（M2-P2、P4，ADR-014；M2-P6 复核订正：树锁之下文件夹行、文档行、回收站行的先后因操作而异（删除文件夹、恢复、永久删除是"文档行 → 回收站行 → 文件夹行"），不成环靠的是"文件夹行与回收站行只被持有所在空间树锁的事务改动"；转移是唯一不取树锁的跨空间操作（只搬正常状态的文档到根目录）。见 ADR-014）。会话守卫发现账户不可用时撤销这条会话、不顺延。
- 系统管理员的接口（M2-P1）：`@SystemAdminOnly()`，会话守卫在认证之后检查系统角色（每个请求重新读取）；取消与停用系统管理员时至少保留一个有效的管理员（advisory lock 串行）。
- 一次性令牌（M2-P1，ADR-013）：邀请与重置的令牌只存摘要，链接的令牌在 `#` 之后；邀请的签发与接受按登录名取 advisory lock；签发重置时旧密码随即失效（换成不可用的哈希）；尝试限流按地址、与登录的计数分开，只有"没有这个令牌"计入失败；"找到了但不能用"另按链接的记录计数，到上限之后只记日志、不再写审计（M2-P6）；事务里复核不通过与查令牌时就不能用的一样处理、记审计。签发人被停用或取消系统管理员时，他签发的未用链接在同一事务里作废（M2-P6 复核 A2）。
- 密码用 Argon2id（@node-rs/argon2），参数可配置，有强度下限；同时进行的哈希有上限，免得占满 libuv 的线程池；排队的长度与等待时长也有上限，超出时这次不验证，返回 503 与 `Retry-After`，退回限流的名额（DEF-015）。首个管理员用命令行初始化（`init-admin`，密码从终端或标准输入读取）。
- 契约里的响应结构是宽松的（客户端丢弃不认识的字段，接口只做加法时旧页面照常工作），请求结构是严格的；服务端只发契约里的字段，集成测试按原文核对。请求里的 UUID 大小写都接受，契约统一转成小写（`uuidSchema`，M2-P2）：服务端按字符串比较 id 的地方只见到小写。

**接口**（M1-P3、P4）：

| 接口 | 说明 |
|---|---|
| `POST /api/auth/login`、`POST /api/auth/logout`、`GET /api/auth/session` | 登录、退出、当前会话（账户、个人空间、CSRF 令牌） |
| `GET /api/documents?spaceId=&limit=&cursor=` | 一个空间的文档（看不到与不存在的空间都是 404），按更新时间从新到旧，keyset 分页；没有 `spaceId` 时是个人空间（M2-P2） |
| `POST /api/documents` | 新建（`{ type, title?, requestId, spaceId? }`）：建在指定空间（要有新建权限；没有指定时是个人空间），内容是收敛的模板换上新的 `unitId`，修订号 1；同一个 `requestId` 的重放同样 201，返回同一份文档 |
| `GET /api/documents/{id}` | 文档元数据（含修订号、档案、格式版本、所在的空间）与调用者的权限；看不到的与不存在的文档都是 404 |
| `GET /api/documents/{id}/content` | 当前快照：gzip 字节原样下发（`Content-Encoding: gzip`），修订号作 ETag；带 `If-None-Match` 而修订号对得上时 304，只带 ETag（M3-P2，DEF-017） |
| `PUT /api/documents/{id}/content?baseRevision&requestId&clientInstanceId&localSeq&writeEpoch` | 保存（正文是 gzip 压缩的快照，请求头 `X-Edit-Lease` 带编辑租约的令牌）：压缩前后都限 5 MiB、基本校验、锁文档行、按 `requestId` 幂等、锁下核对登录、要求有效的编辑租约（M3-P1）、按基准修订号条件写入；冲突时 409，`details` 带当前修订号及其来源。M3-P3 起另带客户端的构建与数据格式（`clientBuild`、`univerVersion`、`profile`、`formatVersion`）与 `formulasPending`，内容与当前相同时不递增（`unchanged: true`，留回执），见 ADR-011 的修订 |
| `GET/POST/PUT/DELETE /api/documents/{id}/edit-lease` | 编辑租约（M3-P1，ADR-018）：编辑状态（能读就能看）、申请（要能编辑；别人持有时 409 `EDIT_LEASE_HELD`；成功时给令牌、代次、修订号与当前修订的来源）、心跳续租（失效时 409 `EDIT_LEASE_LOST`）、释放（持有者本人、令牌是当前这一行的才结束，一律 204；释放与交出先锁文档行、再锁租约行，与在途的保存互斥，释放不了的不取锁，M3 合并前评审 CX1）；M3-P2 起编辑状态带调用者能否编辑（`canEdit`），编辑状态与心跳不顺延登录（`@BackgroundRequest()`）；M3-P5 起申请带 `takeover`（`self` 本人接管、`force` 强制接管，记审计）与 `idleSeconds`，编辑状态与被占用的详情带 `sameSession`、`canTakeOver`、请求、保留与异常中断的提醒，心跳带待回应的请求，保留期内 409 `EDIT_LEASE_RESERVED`，被接管的旧令牌得到 `taken_over`；M3-P6 起心跳带调用者自己当前的本机密钥的版本（`localKeyVersion`，从没取过为 null；M3 的页面不消费，ADR-019） |
| `POST/PUT/DELETE /api/documents/{id}/edit-lease/request`、`POST …/edit-lease/request/decline`、`POST …/edit-lease/handover` | 请求编辑与交出（M3-P5，ADR-018 的补充）：发出（要能编辑，先拦旧页面）、续期（后台请求，等待中每 5 秒）、取消（能读就行，一律 204，清掉自己的请求与留给自己的保留）、谢绝（持有者，带令牌，对不上也 204）、交出（持有者，带令牌：结束租约、留给请求方 2 分钟；请求已不在时 409 `EDIT_REQUEST_GONE`、租约不动）；结果按 `kind` 区分（`pending`、`declined`、`reserved`、`free`、`self`、`occupied`、`reservedForOther`、`gone`） |
| `POST /api/documents/{id}/open-check-failures` | 打开自检失败的上报（M3-P4，ADR-011 的补充）：只带失败的种类、资源名、异常的构造器名、修订号、打开方式与版本四项，不带内容；能读就能报、看不到与不存在一致；后台请求；进程内去重与按账户限量，记 warn（`event: open-check-failed`），不记审计；204 |
| `POST /api/documents/{id}/conflict-copies?requestId&title` | 另存为副本（M3-P2，ADR-011、ADR-014 的补充）：正文是 gzip 压缩的快照（与保存同一个读取方式），`unitId` 要等于原文档的；只要求能读原文档；本人在原文档所在的空间能新建就放进原文档的文件夹，否则本人个人空间的根目录；不继承授权；`requestId` 幂等；响应同复制 |
| `POST /api/local-key` | 本机密钥（M3-P6，ADR-019）：调用者自己当前的那一把（`{ version, key }`，`no-store`）；第一次取时生成第 1 版；写事务里按主键再核对这次登录；不是后台请求 |
| `POST /api/admin/users/{id}/local-key/revoke` | 吊销某人的本机密钥（M3-P6，只给系统管理员）：擦掉当前那一版的材料、生成下一版、审计 `users.local_key_revoked`，返回这一次的结果（吊销了哪一版、换成了哪一版，没有可吊销的为 null）与账户的现状（带本机密钥的版本与生成时刻，不带密钥材料；M3 合并前评审 CX3） |
| `GET /api/health/live`、`GET /api/health/ready` | 存活与就绪探针（公开） |
| `PUT /api/auth/password` | 修改密码（M2-P1）：本人其他地方的登录全部退出；M2-P6 起连当前会话的令牌一起换掉，响应与登录相同（新的会话与 CSRF 令牌，写回 Cookie） |
| `POST /api/auth/invitations/inspect`、`…/accept`、`POST /api/auth/password-resets/inspect`、`…/complete` | 一次性链接（公开，M2-P1）：令牌在请求体里；接受或完成之后已登录，响应同登录；不能用时 410 `LINK_INVALID` 与原因 |
| `GET /api/users?query=` | 同事目录（M2-P1）：有效账户，显示名或登录名包含关键词，最多 20 条 |
| `/api/admin/users`、`/api/admin/invitations`、`/api/admin/audit-events` | 系统管理（M2-P1，只给系统管理员）：账户列表、停用与启用、系统角色、签发重置链接；邀请的列表、签发、作废、重发；审计查询。M2-P6 加 `POST /api/admin/users/{id}/unlock-login`（解除登录锁定），账户带着登录的锁定（`loginLock`） |
| `GET /api/spaces`、`GET /api/spaces/{id}`、`PUT /api/spaces/{id}/name` | 空间（M2-P2）：我能看到的空间（导航）、空间页头（有效角色与能做的操作）、改名（空间管理员、系统管理员） |
| `/api/spaces/{id}/members`（GET、POST）、`/api/spaces/{id}/members/{userId}`（PUT、DELETE） | 成员（M2-P2）：查看（有空间角色的人、系统管理员）、添加、调整角色、移出（空间管理员、系统管理员）；至少保留一个空间管理员 |
| `/api/admin/spaces`、`/api/admin/spaces/{id}/{visibility,archive,restore}` | 系统管理（M2-P2）：团队空间的列表、创建（连同首个空间管理员）、全员可见、归档与恢复 |
| `GET /api/admin/users/{id}`、`GET /api/admin/users/{id}/documents`、`POST …/documents/transfer` | 系统管理（M2-P2）：一个账户；停用者个人空间里的文档（只有标题）与整批转移 |
| `GET /api/folders?spaceId=&parentId=`、`POST /api/folders`、`PATCH /api/folders/{id}`、`POST /api/folders/{id}/move` | 文件夹（M2-P4）：列出一层（上限 500，超出给 `truncated`）、新建（`requestId` 幂等）、改名与同空间移动、跨空间移动（源空间的空间管理员 + 目标空间的新建权限）。最多 10 层，层数存在列里；同一个文件夹里允许同名 |
| `PATCH /api/documents/{id}`、`POST /api/documents/{id}/move`、`POST /api/documents/{id}/copy` | 文档的整理（M2-P4）：改名与同空间移动（不动写入代次与更新时间）、跨空间移动（代次加一、收回写入权）、复制（直接复制压缩字节，`unitId` 不变，副本是一份新文档） |
| `DELETE /api/documents/{id}`、`DELETE /api/folders/{id}` | 删除（M2-P4）：进所在空间的回收站，生成一个删除单元；编辑者只能删本人创建的文档，以及里面只有本人创建的文档的文件夹 |
| `GET /api/trash?spaceId=&cursor=`、`POST /api/trash/{id}/restore`、`DELETE /api/trash/{id}` | 回收站（M2-P4，ADR-016）：按空间列出删除单元、整单恢复（原位置不在时回到空间根目录并带标志）、永久删除（连带处理子树里别的单元） |
| `GET /api/search?query=&cursor=` | 按标题搜索我能访问的文档（M2-P4）：不区分大小写，通配符按字面量匹配；不含回收站里的；结果带所在空间与文件夹路径 |

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
- 表只由所属模块的仓储读写；服务用 `TransactionRunner` 开启事务，把不透明的 `Transaction` 显式传给仓储。`TransactionRunner` 自己借出、归还连接：除业务错误外，失败的事务丢弃它的连接；work 吞掉失败的语句时不报告成功；回滚也失败时，work 的错误是数据库繁忙就照样交出它（超过事务的时限时数据库结束了会话，M3-P5）。
- 登录之后的读请求（全部 GET 接口）在一个只读快照里判断权限、读数据（`TransactionRunner.readSnapshot`，REPEATABLE READ、READ ONLY，ADR-017）：快照在最外层的服务里开、不嵌套；开场核对由 auth 登记，在最前（会话仍然有效、账户仍然有效、守卫读到是系统管理员的仍是）；快照进行中连接池上的查询与借连接一律报错（共用的标记 `SnapshotScope`，`pool.ts`）。同一个事务或快照上的语句逐条执行（集成测试核对应用的连接上没有并发查询）。

**有效权限**（M2-P2，ADR-014）：服务只经 `DocumentAccessPolicy` 判断权限，目标是文档或空间（在事务里判断时，查询走事务的连接）。
- 空间的部分按 spaces 的空间事实（一条语句）与纯函数的规则计算：个人空间只看所有者；团队空间取成员的角色，全员可见至少是查看者，归档至多是查看者；系统角色只带来团队空间的管理面，不带来内容权限；P5 并上单独授权。
- 同一套操作规则既给界面（`SpaceView.permissions`），也给服务端的检查（`requireSpaceContent`、`requireSpaceManagement`）。
- 看不到与不存在都是 `NOT_FOUND`，执行同样的查询；看得到却不能做是 `PERMISSION_DENIED`。需要锁的操作先判断、再加锁、锁下再判断。
- "可访问文档"的条件只在 documents 的仓储里拼一处，范围（空间 id 的集合）由访问策略给出。
- 收回写入权的入口：停用、移出、调整角色、归档、转移（M2-P6 起）、删除与跨空间移动在同一个事务里调用；M3-P1 起接入编辑租约：失去编辑权的持有者的租约记 `revoked`、文档的代次加一（ADR-014 的补充、ADR-018）。转移与（P4 起的）删除、跨空间移动递增 `documents.write_epoch`。
- 数据库繁忙（等锁超时、语句超时、超过事务的时限或开始得太晚、取不到连接）在请求里还没有事务提交时回 503 带 `Retry-After`、记 warn，已经提交过时回 500（结果未知）（M2-P6，ADR-006）；写入代次只增不减由触发器兜底；集成测试核对迁移与表定义整体一致、有数据的库能迁到最新，删库之前扫一遍不变量；永久删除前核对要删的都在回收站里；定时清理暂缓一直失败的条目、按数据库时间判断到期（ADR-016）。
- 团队空间的名称按判重键唯一（数据库的生成列 `name_key`，M2-P6，ADR-014）；复制在锁下对源文档重新判断；搜索的范围检查是不变量；不判断权限的永久删除本体（`TrashEntryPurger`）只在 documents 内部。按名称搜索（同事目录、团队空间的列表）时空白的种类与个数不算区别：名称与关键词两边的每一段空白都合成一个普通空格再比较，算作空白的字符与判重键共用 contracts 的一份清单（M2-P6）。集成测试专用的出口（`DATABASE`、`DocumentsRepository`、`spaces` 的表定义，仓储级的范围核对与"迁移与表定义一致"的核对等用）在单独的入口 `@nerve-office/api/testing`（`app/integration.test-support.ts`）：只在源码条件下可解析、不进构建产物，lint 只许 `tests/integration` 引用；应用的公开入口不再转出它们（M2-P6 复验 R-S4）。

**文档的内容与保存**（ADR-011）：
- 快照用 `bytea` 存 gzip 压缩的原始 JSON 字节；修订号是整数，新建为 1，每次保存加一；`unitId` 由服务端生成，终身不变。
- 保存：与文档无关的基本校验在事务之前；事务里锁住文档行并判断权限 → 按 `requestId` 幂等（负载摘要按基准修订号与解压后的字节算；重放先于登录的再核对与租约）→ 锁下核对登录 → 要求有效的编辑租约（M3-P1）→ 核对快照的 `id` → 按基准修订号条件写入 → 写内容、修订记录与审计（`documents.content_saved`）。
- **编辑租约**（M3-P1，ADR-018）：每份文档至多一行；有效条件按顺序判断（有这一行、没有明确结束、代次是文档当前的、没有到期、没有空闲 12 分钟、绑定的登录有效、持有者仍能编辑），第一条不满足的就是失效的原因；有效期 90 秒、心跳 10 秒，时间取数据库的 `now()`；申请产生新的一代（代次加一，不动 `updated_at`）；令牌只存 SHA-256 摘要，经请求头传递。
- 读取内容支持 `If-None-Match`（M3-P2）：读快照里先判断权限，修订号对得上回 304、不读内容。
- **另存为副本**（M3-P2）：失去编辑权、还读得到原文档的人把本页的内容存成新文档（修订号 1、`unitId` 与原文档相同、不继承授权）；锁与复制同一套顺序（`requestId` 的 advisory lock → 原文档所在空间的树锁（只在放进那里时）→ 两个空间行 → 原文档行），锁下重新判断能读、重新决定位置。
- **保存协议加固**（M3-P3，ADR-011 的修订）：写入（保存与另存为副本）的顺序是重放预检（事务外、不提前回答）→ 客户端的数据格式（`CLIENT_OUTDATED`）→ 快照的检查（子进程池：解析之前先数嵌套与元素，规则见 contracts 的 `SNAPSHOT_RULES`，`SNAPSHOT_INVALID` 带规则）→ 事务（`requestId` 的锁、访问、锁文档行、再查重放（修订记录与回执）、登录、文档过新 `DOCUMENT_TOO_NEW`、能编辑、租约、基准修订号、`unitId`、不缩水、内容相同只写回执、"公式待更新"只清不设）；规范化的内容哈希（规格在 contracts 的 `content-canonical.ts`，空值等价只在资源 `data` 的第一层）；平台信封（内容哈希、客户端构建、SDK 版本取上报并核对过的）；"公式待更新"；申请编辑权与心跳同样拦截旧客户端；修订记录与回执保留 30 天。

**运行与退出**：
- 就绪探针检查接收请求、数据库可达与库结构版本，整体限时 2 秒。
- 监听成功后先注册退出信号，再输出“HTTP 服务已启动”；外部刚看到启动日志就发信号时也能优雅退出。
- 收到 SIGTERM 或 SIGINT 后：标记退出；在途与之后的响应带 `Connection: close`；停止接收新连接；等在途请求完成（超时就强制断开）；最后关闭应用与连接池。
- 退出码：正常 0，强制或失败 1；退出过程中再次收到信号就立即退出。

### 图片资源、当前引用与正式输入（M5-P1/P2）

- `workspace` 的图片控制器沿用身份、CSRF 与 Origin 管线；上传在读取正文之前取得准入资格。`assets` 使用独立子进程完整解码 PNG/JPEG/WebP/GIF、重新编码并移除原始元数据。Sharp 仅进入处理子进程；Linux 以 prlimit 限制地址空间，执行/排队/账户、字节/像素/帧/时间预算固定在 [ADR-021](../adr/ADR-021-图片处理与资源边界.md)。
- 存储目录与 Web 根互不包含。新对象键由服务端摘要和独立代次生成，存量固定 hash 路径保持可读；文件排他写入、同步、原子发布，数据库先持久预留字节再按原代次回执确认对象与独立 assetId。相同字节复用存活代次，每次上传仍有独立记录；文件或事务失败保留可解释的预留，不回滚成错误的空闲配额。P4-S5 的回收按 [ADR-023](../adr/ADR-023-资源回收与备份水位.md) 执行，S5 的 Step 验证已完成，整 Phase 结果见 P4 最终验收记录。
- 读取由 `workspace/AssetReadingService` 组合资源元数据与文档域的统一可读判断：同一只读一致性快照内决定当前引用/有资格读取的有效用户历史/上传者严格 24 小时资格，事务结束后才读文件。未登录维持认证错误；无权、未知或已不引用的地址统一为可解码占位，不泄露存在性。真实图片为 private/no-store，失败占位也不缓存，不提供 ETag/304/Range 绕过复核。
- `documents/DocumentAssetReferences` 负责保存与副本的引用规则。快照检查子进程返回完整去重 assetId 集合，不截断；正文实写与当前引用替换处于同一事务。内容不变和幂等重放保留原 gzip 与原引用；未知地址可留在正文，但不自动取得关系或读取资格。
- 新增引用必须由已有目标关系、本人有效上传窗口或当前可读来源证明。来源候选在加锁前固定，沿请求记录→需要的树锁→排序空间→排序文档→排序资源加锁并在锁下复核；保存一次取得文档写锁，不从共享锁升级，不在持锁后发现新来源。SQL 数组处理避免 65,535 绑定参数上限；已有 70,000 图片引用的数据库与完整 HTTP 保存回归。
- 普通复制保留原 gzip/unitId，只复制当前合法引用；本机副本从上传快照提取全量地址，原文档可作为明确来源。两个流程均不复制物理文件或继承原文档授权，正文/修订/引用/审计原子提交。
- M5-P2 S4 的图片输入沿实际书/表/选区、宿主焦点和实例许可固定目标；右键菜单须在同一运行 scope 内同步恢复编辑器焦点后再执行命令（固定 ui 1.0.1 的 pnpm 修复，ADR-022）。不能通过允许外部菜单或宿主输入框绕过焦点保护；异步结果仍核对原目标。
- M5-P2 S5 把已实现的图片输入从测试控件迁到每个就绪编辑器的实例生命周期；正式插图命令在内部桥接按原 ID 接入平台文件任务，复制/粘贴继续原受管路径。就绪前和退役时关闭受管命令，取消任务在公式停止等待之前完成；测试控件只附着既有实例。新浮图创建时写全旋转/翻转的五个 SDK 默认值，避免重开产生无意义修订。
- 普通表格剪贴板仅按原 SDK 权限捕获目标，识别为图片后才追加联网与图片身份限制；显式选图仍从严格目标开始。普通离线复制/剪切与带预览的表格粘贴不依赖资源服务，异步目标仍受选区、书/表、权限、身份及退役检查约束。
- 普通剪切先按复制目标分类，无图片时保留原 SDK 的只读拒绝；真实图片重新绑定严格剪切目标。已同步取得正文的表格事件去掉预览文件，当场固定范围并启动原粘贴命令，由 SDK 在首个 await 前检查权限；异步剪贴板目标检查保持，权限拒绝不再被图片提示覆盖。
- 图片上传失败在适配层按可信错误实例及有限的状态/code 分类：大小、类型、不可处理内容与配额分别给固定提示，网络和未知错误保留通用失败。SDK 大小/类型错误沿用原错误枚举，取消、身份失效与进度清理不变；页面不回显服务端原始 message/details。
- 图片上传 reader 对已拒绝正文停止缓存，在既有准入槽内按累计 6 MiB / 首次拒绝起十秒的边界丢弃，EOF 后返回原错误，避免提前关连接导致代理 502；清理超界销毁请求，取消与关闭及时释放。可接受图片仍最多 5 MiB，细节见 ADR-021。
- 协议层 no-store 不能撤回浏览器已经解码的图片。P2 已在三浏览器验证 SDK 在撤权、退出和重建时主动复核并清理旧图；Chrome 原生右键已补证，Excel、Safari 与剩余 Finder 矩阵按计划书 r28 记账后继续正常开发；完整兼容性验收仍待补证，不能用协议测试替代。

P4 的历史读取/预览/恢复副本、管理员清除、历史到期及升级前运维检查点已完成 S1–S4 验证。S5 引用活动使用按资源/事务追加的记录，GC 在 quota → 有序资产排他锁下查询 Documents 的全部保留关系并消费活动，当前与历史的权限判断不代替保留判定。对象/claim 退休与文件 IO 分事务，完成回执第一次确认才释放字节；缺备份声明时不删除资源或执行已有文件任务。细节和部署代价见 [ADR-023](../adr/ADR-023-资源回收与备份水位.md)。

P1 最终 main `1f7f7d61` 已通过同 SHA 六项 CI、原生 x64 及独立原件复核，并完成证据冻结与正常分支/worktree 清理。初次材料下载失败按固定原件分发修复，未改变版本、预算或门槛；见[最终复核](../v0.1/M5-表格能力与资源/reviews/P1-S6-最终CI与关闭复核.md)。P2 从该 main 继续图片入口与可靠渲染。

### 历史正文、只读预览与活动判定（M5-P4）

Documents 在正式写入的原事务内按 UTC 小时采样不可变 gzip、信封和合法图片关系；用户历史保留 7 天，删除前和升级前运维检查点保留 30 天。历史列表、详情、正文、恢复与清除由 Workspace 编排，当前资格在各接口重新检查。恢复仅创建独立新文档，不覆盖原正文、租约或本机草稿。详情和边界见 [ADR-011](../adr/ADR-011-文档内容与保存协议.md) 与 [P4 交接](../v0.1/M5-表格能力与资源/handoffs/P4-交接单.md)。

历史预览使用第三个独立入口和只读 SDK 实例，图片复用既有授权读取。后台会话检查使用 `GET /api/auth/session/check`；定时、可见性、上线和会话消息引起的复核，以及图片和正文自动重载不延长空闲登录。打开和主动重试仍先做一次主动会话确认。后台标记不豁免认证、当前权限或过期判断；失效、换人和撤权后销毁画布及旧图。合法大小写 UUID 只在页面边界规范化，响应仍要求精确相同的历史身份。

第三入口使公式 Worker 的创建代码可以位于共享模块，安全头测试根据实际同源 Worker 响应定位资源，不依赖入口文件的打包文本。CSP/HSTS 和安全头断言保持原样。原平台、编辑器、公式与发件箱体积上限保持，历史预览另有首屏及全部可达 JS 预算，见 P4-S3 规则 §8。

## 4. 前端

```text
apps/web/src/
  entries/platform/   平台页面的入口：只写副作用导入，按顺序关掉 zod 的 JIT（CSP）→ 样式 → 挂载（建运行时，从往返缓存恢复时重新加载）
  entries/editor/     编辑器页的入口：同样先关掉 zod 的 JIT → 样式（不含 Tailwind 的基础重置）→ 挂载
  entries/history-preview/ 独立历史预览入口：只读 SDK 与权限复核，不启动租约、发件箱或自动保存（M5-P4）
  entries/csp-probe/  CSP 阳性对照（只在测试构建里）
  app/                运行时（路由、请求缓存、会话的全局处理：整页跳转、多标签页）、布局、404 与错误页
  features/auth/      登录页、会话、需要登录的外层路由
  features/document-history/ 用户历史列表、恢复副本与管理员清除；当前正文自检失败时提供真实历史入口（M5-P4）
  features/history-preview/ 独立预览控制器、身份与时效复核、只读画布和失效清理（M5-P4）
  features/local-data/ 退出预览/确认与服务端、本机分别呈现的结果，启动维护的状态说明（M4-P4）
  features/local-drafts/ 本机草稿页，逐条恢复/副本/放弃与存储状态；按需加载，不引用编辑器功能层（M4-P4）
  features/account/   修改密码；接受邀请与重置密码的公开页面（令牌从 # 读出后从地址里去掉）（M2-P1）
  features/admin/     管理界面：账户、邀请、审计（M2-P1）；团队空间、停用者文档的转移（M2-P2）；账户页的吊销本机密钥、"状态"列里本机密钥的版本与页面顶部的状态区（M3-P6）；按需加载，只被 app/routes.ts 动态引用
  features/spaces/    左侧导航（窄屏时收起）、空间页（首页是个人空间，/spaces/{id} 是任意空间；按权限显示操作、行内改名）；空间与成员的接口函数，
                      空间看不到了（404）时刷新导航、去掉它的缓存（M2-P2）
  features/members/   成员页（M2-P2）：查看、添加、调整角色（每一行各自保存）、移出；按需加载，只被 app/routes.ts 动态引用
  features/colleagues/ 按关键词选一项（M2-P2）：按名字选同事、按名称选团队空间；只由管理界面与成员页引用
  features/confirmation/ 危险操作的确认弹窗（带 Radix Dialog，M2-P2 从管理界面挪出）：只由按需加载的功能引用；做完一件事的说明由确认的操作交回，
                      等弹窗关掉、焦点交还之后再写（`shared/ui/dialog.tsx` 的 `onClosed`，M2-P5）
  features/documents/ 一个空间的文档列表、新建表格（建在这个空间）；行操作里的分享入口（按需加载分享对话框，M2-P5）；
                      一行文档与它的行内操作（DocumentRow、useOrganizePanels、OrganizeNoticeBar）由空间列表与"与我共享"共用（Codex 评审 CX3）
  features/sharing/   分享对话框（M2-P5）：授权列表、同事选择加人、调整与取消；平台的入口按需加载、编辑器页静态引用（按需加载会让平台首屏多拆出一个文件）
  features/shared-with-me/ "与我共享"页（M2-P5）：路由级按需加载；个人空间按所有者的人名呈现，不显示所在位置
  features/sheet-editor/ 编辑器页：载入、保存的状态机、页头与提示、快捷键与离开提示、会话；页头的分享入口，只凭授权打开时返回链接回"与我共享"（M2-P5）；
                      编辑租约的管理（`edit-lease.ts`，M3-P1：申请、心跳、失效、续上与释放，不依赖 Univer 与界面）；
                      阅读与编辑的状态机（`edit-mode.ts`，M3-P2：持有租约与保存的状态机，模式切换一律重建，不依赖 Univer 与界面；当前的编辑器在
                      `editor-slot.ts`（单飞重建）、阅读时的检查在 `reading-checks.ts`、失去编辑权之后的那一份在 `lost-copy.ts`）；
                      交接规则（M3-P5）：同一个浏览器里的锁与交接频道 `same-browser.ts`（先服务端、后本机锁）、这一代的本机锁 `local-lock.ts`（锁的争用以服务端的事实裁决：被占着、被抢都先经租约的 `confirm` 核对，被抢之后核对不了时等心跳的结论，M3 合并前评审 CX2；服务端说被本人接管时"在哪"按本机的证据——锁被抢就是本浏览器，锁还拿着就留着等抢至多 5 秒，`takenHere`，M3 合并之后 main 的 CI）、空闲计时 `idle-watch.ts`、刷新时在途保存的记号 `pending-save-marker.ts`、本人接管的请求方一侧 `self-takeover.ts`、请求方的请求 `edit-request.ts`（P3 起只保留当前 Document 内存中的请求；旧 `issued-request` 与 reload 身份记号已退役，新 Document 必须明确操作）、持有者一侧的请求 `holder-requests.ts`、交接频道的回应与"在此编辑"的编排 `tab-handover.ts`（审查之后从 `edit-mode.ts` 拆出，状态机只留各条转移与作废）、交接的观察事件 `handover-trace.ts`（测试构建的记录器在 `editor/testing/handover-log.ts`）；`edit-mode.ts` 的离开编辑 `leaveEditing(cause)`（退出、空闲释放、交给请求方、交给本浏览器的另一个标签页）与持有者一侧请求的入口（提示的状态、2 分钟计时、交出与谢绝的结果在 `holder-requests.ts`）
                      自动保存（M3-P4，不依赖 Univer 与界面，时钟注入）：调度 `autosave.ts`（两级的节奏、立即上传、去重、退避、离线与会话、连按保存的合并）、捕获的规则 `capture-policy.ts`、捕获 `snapshot-capture.ts`（同步取快照；立即上传按下时提交单元格、轮到时等公式）、页头保存状态的全集 `save-indicator.ts`；保存的状态机 `save-coordinator.ts` 向来源取捕获（未保存只看修改序号与适配层的 `uncommittedInput`，CX4）；打开自检失败的上报 `open-check-report.ts`
                      发件箱 Worker（M4-P1，ADR-020）：`outbox/` 下的协议（手写守卫）、Worker 里的处理、薄入口 `outbox.worker.ts`（100 ms 空定时器）、主线程的客户端（实现 DraftWriter，看门狗）；`outbox/testing/` 是测试构建的探针（编辑器页的 e2e 分支按地址参数动态引入）
  editor/             编辑器适配层（Univer 的一切，ADR-010）：档案、公式 Worker、身份、变更检测、公式收齐、IMAGE()、入口守卫、internal-api/；
                      只读守卫 read-only/（M2-P3，ADR-015）；视图状态 view-state.ts（M3-P2）；testing/ 是 E2E 的探针与真实 Safari 的页面自检（M3-P2；M3-P4 加自动保存的控制、捕获时机与自动保存的自检、主线程公式模式与档案故障的开关；M3-P5 加交接日志 `handover-log.ts`（含页面关闭时的处理 `page-hide`）与交接的自检 `selftest-handover.ts`——两个标签页的本人接管、收不到交接消息（挂接的 `deafenHandoverChannel`）、刷新时在途的保存，编排与判定在 `tests/e2e/support/selftest-handover.ts`；M3-P6 加请求编辑的自检 `selftest-request.ts`——请求方在后台停在"交给了我"、回到前台才进入，被盖住的持有者两条都认（被暂停走到到期、空闲满 2 分钟自动交出），交接与请求编辑共用的观察 `selftest-timeline.ts`、持有者的前半段 `selftest-holder.ts`，挂接的 `host.subscribe` 与请求方、持有者两侧的进展，编排与判定在 `tests/e2e/support/selftest-request.ts`（另一方经接口扮演），驱动脚本的空闲、锁屏与盖屏在 `tests/e2e/safari/desktop.ts`），只在测试构建里（只能动态引入，lint，M2-P6）
  shared/             请求层（api；M2-P6 加带 requestId 的新建共用的请求标识记账 request-ids）、界面组件（ui，改写后的 shadcn/ui：M2-P1 加弹窗、表格、标签、原生选择框；M2-P6 加人名 PersonName、句子里嵌元素的 Phrase、说明条 Notice、输入的文字说明 FieldProblem；M2-P5 加读屏的状态区 StatusRegion（M3-P6 加可选的 keepFocusInView：长列表上方的状态区变高之后把排在它后面、有焦点的元素滚回可视区域，用 lib 的 use-keep-focus-in-view；账户页、成员页、转移页接上）、空间的呈现 SpaceLabel、按需加载失败的说明 ChunkLoadNotice；Codex 评审之后加列表没能刷新的说明 RefreshProblem（M3-P2 加详情的变体 DetailRefreshProblem 与 fallbackFocus）、M3-P2 加第一次就没取到时的重试按钮 RetryButton、说明里"列表还在刷新"的 StillRefreshing）与主题变量、界面文字（i18n：M2-P6 起按范围分文件，只在按需加载的页面用到的不进首屏）、
                      小工具（lib：登录页与管理界面的地址、整页跳转、延时取值、会话复核、渲染之后移焦点等；M2-P6 加焦点兜底 useFocusRescue（M3-P2 加焦点交接 use-focus-hand-off、第一次就没取到时的重试 use-first-load-retry）、页面标题 useDocumentTitle、输入校验的说明 validation、先取消在路上的请求再刷新、可以要求刷新失败时抛出的 refresh-queries，时限之后后台刷新成功时改回说法的 use-outcome-refresh；Codex 评审之后加成功之后的刷新还在后台的 use-still-refreshing、按确定的写入结果改分页列表缓存的 paged-cache；写操作成功之后的有时限的刷新在 api 的 write-outcome（refreshAfterSuccess）；M3-P6 加有焦点的元素上方的内容变高之后把它滚回可视区域的 use-keep-focus-in-view（ResizeObserver 盯一直在的容器，只在变高时滚；状态区的 keepFocusInView 与转移页"有文档已经不在了"的说明用它））
  shared/local-drafts/ 共享恢复判定、只读目录/原件、逐条副本与清理、退出协调和启动维护；无 Univer/React，不反向引用 features（M4-P4）
  shared/outbox/      本机发件箱的底座（M4-P1，ADR-020；不建桶文件，按文件引用；Worker 一侧的文件只许引用 Worker 一侧的文件与不带 zod 的契约常量、不许引用只在主线程用的模块与页面里才有的全局，lint 的区域规则 `OUTBOX_WORKER_SIDE`、`OUTBOX_MAIN_THREAD_ONLY`）：记录与 AAD、编解码、写入者的判定（纯函数）、IndexedDB v2 的库与存储（草稿、写入者、恢复提示和持久会话代次）、列表的索引 draft-index.ts（平台页面只许按需引用它）、与放置无关的写入管道 draft-writer.ts（DraftWriter）、OPFS 的镜像（mirror-slot.ts 的槽位格式、mirror-directory.ts、draft-mirror.ts）与比对 draft-recovery.ts（谁胜出按库里写入者的高水位与代次，清理删不掉镜像目录时立墓碑）、恢复的提示、本机密钥的客户端 local-key.ts 与不带 zod 的导入 local-key-import.ts、本机存储的状态 storage-status.ts、库与镜像合一的清理 local-cleanup.ts
```

- React Router 8（数据路由的库模式）、TanStack Query 5、Tailwind CSS 4 与 shadcn/ui 的 Radix 版本（ADR-008）。
- 请求层：同源请求，状态变更的请求带 CSRF 令牌；错误分为 `ApiError`、`NetworkError`、`ResponseFormatError`；成功的响应按 contracts 校验。
- 普通认证失效：清掉 CSRF 令牌，整页回到登录页，登录后回到原来的地址；不在单页里清空缓存。M4-P4 的明确退出由专门页面记录服务器与本机两项结果，未清完可停留重试或明确前往登录。得到"登录已过期"时先向服务端确认会话：还是同一个人（请求带的是换令牌之前的旧 Cookie）就换上新的令牌、页面不动；本页的登录、修改密码进行中时先等它结束（上限 40 秒）；M4-P4 的明确退出固定确认时的用户、CSRF 来源与本机许可，同人重登或换人后旧操作失效，不再采纳新令牌代为退出（既有普通会话复核见 ADR-008；`shared/lib/renewed-session.ts`）。会话复核可以带原因（M2-P6 第 5 片）：给自己生成重置链接、修改密码、停用自己的结果未知时立即带原因复核，登录页按原因说明（密码可能已经失效、新密码可能已经生效、账户可能已经被停用）；没有结论时等下一个请求成功再确认。
- 多个标签页：登录与退出经 BroadcastChannel 通知；收到消息或得到 `CSRF_TOKEN_INVALID` 时重新确认会话，换了人整页重新加载。
- 查询与变更不按浏览器的在线状态挂起，断网时照常失败并提示。
- 平台页面与编辑器页之间整页跳转（两个入口）：列表的条目是普通链接，新建之后 `location.assign`，登录后要回到编辑器页时 `location.replace`。
- **编辑器页**（P4 设计 §3.7）：
  - 编辑器在 React 之外创建（一页一份文档）；容器是 `editor.html` 里静态的 `#sheet-editor`，页面的状态写在它的 `data-editor-state` 上（loading、ready、steady、failed），能不能编辑写在 `data-editor-access` 上（M3-P2）；页头挂在 `#editor-chrome`；
  - 载入：确认会话 → 并行读取元数据与内容 → 核对档案与格式版本 → 以只读创建编辑器，进入阅读（M3-P2 起打开即阅读；地址带 `?edit=new`、而且能编辑时直接申请编辑权、以可编辑创建）；别人的与不存在的显示相同；
  - 阅读与编辑（M3-P2，ADR-018 的补充）：`edit-mode.ts` 编排。点"编辑"申请编辑权，取得了就重建为可编辑（修订号等于本页的用本页载入的内容，否则按 `If-None-Match` 取）；"退出编辑"先保存、再释放、重建为只读；失去编辑权（续上没有成功）时捕获本页的内容、重建为只读，还读得到就给"另存为副本"与"放弃本页的修改"，读不到了只说明。**模式切换一律重建**（ADR-015 的修订、计划书 r15）：取出视图状态 → 销毁编辑器（Univer 实例与公式 Worker）→ 以目标的 `access` 新建（交互屏障挡住期间的输入）→ 恢复视图状态。阅读时每 30 秒读一次编辑状态（页面隐藏、会话不是本人时暂停）：有新版本提示"有更新，点击刷新"，显示谁在编辑，"编辑"随能否编辑出现或消失；
  - 交接（M3-P5，ADR-018 的补充）：10 分钟没有操作先保存再释放编辑权；别人在编辑时"编辑"换成"请求编辑"，持有者空闲满 2 分钟自动交出，否则页头出现不打断输入的提示"交出 / 继续编辑"，交出之后编辑权留给请求方 2 分钟、请求方的页面看得见时自动进入；自己在别处编辑时是"在此编辑"——本浏览器的另一个标签页经交接频道先保存再交出（3 秒没有回应就接手并抢锁），别处与关掉的页面立即接手，刷新时在途或结果未知的保存最多等 30 秒；空间管理员与个人空间的所有者"强制接管"（确认、记审计）；异常中断的说明只在用户发起的申请里出现；
  - 只读（M2-P3，ADR-015）：查看者与归档空间里的文档一开始就以只读创建。授权服务只允许查看与复制；只读守卫分三步装上（创建工作簿之前：防火墙与撤销拦截；工作簿创建之后：工作表的权限点与图片；渲染完成时 `applyRenderedGuards`：冻结线与编辑栏，这两处的控制器那时才注册），取消本文档的修改（与变更检测同一个判定）、撤销与重做，关掉工作表的权限点，图片与冻结线拖不动，替换、"搜索功能"面板与快速求和不开放（后两个 M2-P6），批注浮层与编辑栏不能输入；全部已注册的快捷键有只读的回归用例（M2-P6）；界面没有工具栏、右键菜单、底栏菜单与新增工作表按钮，权限提示是只读的说法；页头显示"只能查看"，没有保存。写入的边界仍在服务端；
  - 保存：显式保存（按钮、Ctrl/Cmd+S），状态机见 ADR-011，只在编辑时有；有未保存的修改时离开由浏览器提示（失去编辑权、另存为副本之前同样提示）；M3-P4 起自动保存（P4 设计 §3.1–§3.10）：修改停 1 秒（持续编辑至多 3 秒）捕获进内存里的最近一次捕获，停 2 秒（至多 15 秒）上传，同时一个在途；保存按钮与快捷键是立即上传（不去重，按下的那一刻提交单元格），退出编辑、切到后台立即上传；公式没收齐的带"公式待更新"，收齐之后补存，下一个进入编辑的人强制重算；会话内去重、退避与 `Retry-After`、离线与会话暂停；页头的保存状态 11 种，读屏只播有意义的变化；页面关闭时有在途的保存不释放编辑权（ADR-018 的补充）；
  - 打开自检（M3-P4，计划书 §8.2，ADR-010）：创建时以资源守卫换掉资源管理服务，认出解析抛错、非空被吞成空值、加载抛错与序列化抛错，创建工作簿刚返回时比较资源、就绪之后复核 hook 集合；失败的文档只能阅读（说明"文档数据不完整"），以编辑方式打开时先取得编辑权、失败立即释放，失败的编辑器绝不保存；失败上报给服务端（只带种类与资源名）；
  - 本机发件箱（M4-P1/P2，ADR-020；已接入编辑器页）：IndexedDB 的库 `nerve-office-outbox`（P4 已升级 v2：草稿、写入者、恢复提示的键为 `[userId, documentId]`，另有 `sessions` 仓库的 `current` 会话行），写入栅栏按服务端的代次排先后（写入者存代次与每次登记的随机 `writerId`，不存租约令牌）、草稿序号与只删到已确认的序号、AES-GCM 加密与覆盖全部明文元数据的 AAD、存字节不存 Blob；写入管道 `DraftWriter` 一个接口两种宿主（进程内、发件箱 Worker）；Chromium 崩溃重开时可能删掉整个来源的 IndexedDB（UR-034），所以 Worker 里把同一份记录镜像进 OPFS（同步访问句柄改写两个槽位），读时取最新、删库之后写回并留下提示；14 天保留期按读得出的更新时间。`outbox-lock.ts` 的同源短期 Web Lock 串行化完整写入、恢复、登记与清理；锁不可用明确失败。主线程退路也先做只读镜像恢复。按用户清理先对三个仓库的文档并集立墓碑，再删镜像、最后清库。更新格式的镜像不覆盖、不截断、不误报 lost。
  - 会话：载入之后一律不整页跳转、不自动重新加载（本页可能有未保存的修改）。登录已过期或在别处退出：暂停保存，提示在新标签页中登录，本人登录回来之后恢复；别的标签页登录了另一个人：不能再保存，原来的人回来之后恢复。M3-P4：确认会话失败（网络等）时页面在恢复联网、回到前台时与定时再确认，暂停按原因说；保存与续租遇到连着的会话类失败（服务端一直拒绝而确认照常成功）只有第一次在确认之后立即重试，之后按退避或心跳（ADR-018 的补充）。
- 首屏 JS 预算（gzip，门禁 `budgets` 检查）：平台页面 180 KiB；编辑器页 2350 KiB；公式 Worker 800 KiB。管理界面与成员页是单独的动态分块，不计入平台页面的首屏；弹窗不经 shared/ui 的桶文件导出，确认弹窗与弹窗文件本身（`shared/ui/dialog.tsx`）只由按需加载的功能引用（M2-P1：首屏 156.4 KiB；M2-P2：161.6 KiB；M2-P4：168.3 KiB；M2-P6 第 5 片之后 170.6 KiB、2 个文件：只给按需加载页面用的文案按功能拆出首屏；门禁同时限定平台页面的首屏文件数不超过 2 个；M2-P5 之后 172.0 KiB、2 个文件，编辑器页 2020.4 KiB；Codex 评审之后 173.0 KiB、2 个文件——首屏的列表接上刷新失败与还在刷新的共用做法，编辑器页 2021.0 KiB；M3-P2 之后 174.7 KiB、2 个文件，编辑器页 2032.3 KiB；M3-P4 之后 175.6 KiB、2 个文件，编辑器页 2045.6 KiB，公式 Worker 677.6 KiB；M3-P5 之后 175.8 KiB、2 个文件，编辑器页 2057.6 KiB，公式 Worker 677.6 KiB）。

### M4-P2：编辑会话与本地优先保存

`EditingSession` 管租约、本机锁、保存调度与写入资格的生命周期；`WorkingDraft` 管当前正文与固定上传的所有权；`edit-mode` 编排阅读/编辑/失效副本，页头只消费事实。自动捕获、上传、副本共用一个来源，持久来源写成后可放掉页面中的正文。内存实现与持久实现保持同一接口，关闭本机草稿也不另建保存流程。

- 本机 `draftSeq` 从写入者的高水位继续，编辑器 `editorSeq` 用于覆盖范围；上传、确认取实际 `contentSeq`。unknown 固定原请求与 gzip，先核对旧请求再上传新内容；A 的确认不删除更新的 B。
- 来源区分 writing、persisted、memory、confirmed；正文已存但 mark/confirm 元数据失败另报 metadataIssue。页头分别说明本机、云端与当前未提交输入，不把较早的记录当作最新输入的保障；存储授权、OPFS 镜像、同步元数据的降级均可见。
- 真实请求的完整结果与浏览器信号维护连接状态；迟到结果有代次/顺序保护。连接恢复后，当前登录、租约、本机锁与会话代次复核通过，实际发送前再检查，才恢复上传。通用请求 30 秒、保存/副本 60 秒、租约/取钥 10 秒，覆盖成功和错误正文；离开等释放仍至多 5 秒。
- 部署能力经会话入口下发。进入编辑且启用时按需取钥、创建宿主；有效心跳换钥，退出或换人时先保留仍需使用的当前内容再关闭旧宿主，迟到准备不能复活。Worker 起不来可退主线程，但没有同步 OPFS 镜像，页面说明差别。
- 平台与编辑页的联网操作在入口和实际提交两处守卫，已打开表单保留输入、阻止离线提交。本机未同步草稿的恢复/接手已在 P3 接入，列表/全局清理已在 P4 S1–S5 接入，公式 Worker 的生产退路仍属于 P5；P2 保留旧 writer 的记录，不自动覆盖。

正式测量三浏览器、三样本、在线/离线 18 组 × 20 轮通过；各组完整样本本机保存 p95 1.04–1.16 秒，1 MiB 同步捕获 p95 最高 24 ms。背景负载、公式条件外样本与真实 Safari 的未覆盖部分见 `docs/v0.1/M4-本地优先与离线恢复/reviews/P2-S6-端到端测量.md`。首次合并 CI 发现重连先判定 replaced 时遗漏持有者说明；页面现以只读查询补当前持有者，不重新申请、不阻塞保留内容，迟到回包受本次失效与重载状态约束。修复后的第六轮完整本机门禁通过 12,672 项单元/集成、1,472 项 E2E（16 项既有平台限定跳过），生产容器 241/241 通过；新合并 SHA 的 CI 状态见同目录 `P2-审查报告.md`。

M4-P6 S4 已补真实 Safari 27 六组 × 20 轮：本机保存 p95 1044–1136 ms、1 MiB 捕获 p95 20 ms，公式均 ≤900 ms，逐轮核对真实 Worker、独立解密、应用 API 和数据库。正常窗口的 OPFS/IndexedDB 标记经同源关闭重开后仍在；私密窗口 OPFS 根目录返回 UnknownError，IndexedDB 在窗口关闭后消失，四轮持久授权均未授予。官方七个 Safari 使用日政策与固定上游实现另行核对，未做七日等待或永久保证。直接证据及失败原件见 `docs/v0.1/M4-本地优先与离线恢复/reviews/P6-S4-真实Safari保存与存储边界.md`；P6 整阶段审查和完整验收仍在 S6。


### M4-P3：本机恢复与标签页接手

P3 最初由 `features/sheet-editor/recovery` 拥有纯判定表、独立 Reader、恢复编排及提示；P4 已将 SDK 无关的判定、Reader、WorkingDraft 与副本能力提取到 `shared/local-drafts`，编辑器功能层保留编辑资格、重建与界面编排；`shared/outbox` 拥有认证读回、完整观察凭证与原子接手/条件清理。页面只传当前用户、权限、连接与修订事实，编辑会话继续统一租约、本机锁和 WorkingDraft。没有新增后端接口或数据库迁移。

- 阅读发现不取得编辑资格。原样旧保存明确不带租约；有回执才成功，未知结果保留原件。回执成功重读服务器当前内容，不能把旧快照覆盖后来修订；其他修订差异按真冲突提供副本。
- 每个新 Document 新身份，先阅读并提示，用户明确恢复后才申请编辑；退役 reload 会话身份与可复制的编辑请求意图，当前请求只存内存。`?edit=new` 是既有新建入口例外。真实 Safari 与副本实验的范围修订见计划书 r23，不宣称已可靠自动识别原页。
- 一次点击在异步等待前绑定认证原件来源及会话代次。取得服务端资格与本机锁后重新观察，只接续同来源；完整观察比较守住接手和删除竞争，不能只认相同 seq。持久原件变化、换人或暂停会阻止旧闭包继续。
- 待更新公式先强制重算、打开自检通过后才开放保存；恢复初值、保存和副本共用唯一来源。关闭新本机写入时仍可处理既有记录。恢复提示如实区分镜像找回、丢失、保留与待清理。
- 本人接管从首次请求起固定 20 秒，回应/busy 不续期；到期由服务端裁决后接续原页草稿，旧页上传受租约栅栏拒绝（DEF-064）。

本机草稿页、列表标记与全站清理由 P4 接入，现等待整阶段验收；公式 Worker 的生产退路和 DEF-072 属 P5；虚拟机断电、真实 Safari 暂停后的行为属 P6。S5 的真实 Safari 一次明确恢复已验证，整阶段默认门禁、生产容器与合并/CI 收据见 `docs/v0.1/M4-本地优先与离线恢复/reviews/P3-审查报告.md`。

### M4-P4：本机草稿目录、会话资格与完整清理

`shared/local-drafts` 提供无界面的目录和恢复判定，草稿页、列表标记、编辑器及启动维护共享这些规则。正文只在当前记录的检查/动作中借用，不留在 React 状态或查询缓存；标题只取有权限的服务器事实。`GET /api/documents/draft-facts` 每次最多 100 个原始 id，同一只读快照核对权限、修订来源及占用，不取正文、不申请租约。

- IDB v2 增加 `sessions/current`。真实会话请求在联网前取得票据，成功响应只绑定那次票据接受的许可；CSRF 只存用途隔离后的摘要，Cookie/CSRF 原值、密钥和正文不进入会话行。Worker 初始化固定许可，登记、读写、镜像恢复和条件清理均核对持久代次；广播只催促复核，不授予权限。
- 账户菜单提供本机草稿页，部署关闭新本机写入后仍能处理既有记录。预览、恢复、另存为副本和放弃绑定原许可与完整原件；只读者仅能按既定规则另存副本，无法确认权限时保留原件。空间列表、与我共享及搜索按需读取本人标记。
- 任意入口启动共享维护。公开页只处理无身份的保留期和已有清理许可；后台目录避开前台草稿页及正在打开的文档，不与前台争用接手/条件删除。14 天回收同时检查主库与独有镜像；较新格式、未来/未知时间及读取不确定均保留，当前用户的说明只在复核读取权限后显示标题。
- 明确退出先列未同步草稿；确认后撤销原写入资格、清理，再结束原服务器会话。确证停用绑定失败请求原来源后清理；普通过期、重置或未知失败保留草稿。退出服务器结果与本机结果分开，pending 可重试，来源变化立即作废旧操作。
- 完整清单包括主库/镜像、本人 pending-save、退役意图及旧 SDK 库/键。SDK 偏好经 UI 插件实际注入点改为每编辑器内存实例。SDK 模块仍可打开空的 `UniverLocalStorage`，该私有连接阻塞删库时如实 pending，关闭本站编辑器后可重试；不将空库描述为偏好仍持久化，也不承诺可读取别的标签页的私有 sessionStorage。

P4 已关闭：main `c6c0d5ac` 的 CI `38897083387` 六项和原件验收通过，唯一 P4 worktree/分支已清理。最终本机 14,025 单元/集成、2,042 浏览器通过及 16 个既有平台跳过，生产容器 268 通过。审查入口为 `docs/v0.1/M4-本地优先与离线恢复/reviews/P4-审查报告.md`，完整关闭回执在外部 `.codex/handoffs/m4-p4-20261014/p4-completion-receipt.json`；后文旧执行记录保留当时状态。

### M4-P5：公式 Worker 故障后的同会话重建

`editor/formula-worker-failure.ts` 与 Worker 生命周期监听报告有限事实，页面的 `formula-fallback.ts` / `formula-recovery.ts` 决定重建。创建或启动失败只重试同档案主线程变体一次；运行期先完成输入准备并固定完整快照，再替换整个实例，强制重算，既有打开自检通过后接纳。

- `saving-editor.ts` 维持原会话稳定的捕获/订阅入口和逻辑修改序号。`editing-session.ts` 的租约、锁、WorkingDraft、保存协调器和自动保存器不变；旧在途请求字节不改，旧 ACK 不确认新的恢复捕获，公式收齐后可无新用户修改而补存。
- 恢复流程先等待 IME；结束事件排入的任务每次开始前都复核当前组字状态，仍在组字就重新等待，结束后再挂输入屏障、等旧保存输入准备、提交单元格和面板防抖。每次异步续行核对页面代次、权限、原编辑器及保存来源；迟到实例回收，自检失败保留原稿供重试。阅读只重算，不申请编辑权或保存。
- 页头明确公式改在本页计算及大表可能卡顿；恢复、失败、暂停与重试各有状态和操作守卫。诊断复用 `open-check-failures`，与打开自检失败以严格判别结构区分，保留原权限、去重/限量，只带有限故障枚举和创建上下文，不带正文或任意错误字符串。
- 两种公式模式均保留 IMAGE 限制；主线程仍先停止正在计算的一轮再销毁（UR-032）。Worker `intervalCount: 20`；100 ms 空计时器随 Worker 终止而结束，用于已复现的 WebKit 空闲后首次增量停顿。完整性能取舍与 Safari 基线未复现的限制见 ADR-010 与 P5-S5 自审。

S1–S5 已验收；S6 独立审查的唯一 Important（连续两轮组字竞态）已通过反例修复，默认完整门禁、完整容器与合并后同 SHA 六项 CI 仍待验收。主目录 main 不切分支；P5 仅使用一个 worktree，本机和容器验收后 no-ff 合并，随后验收同 SHA CI 并清理。

## 5. 模块边界

- `@univerjs/*` 只能在 `apps/web/src/editor/` 下引用（静态导入、再导出、动态导入都算），任何位置都不能引用 `@univerjs-pro/*`。
- **web** 分层：
  - 入口（`src/entries/*`）→ 应用（`src/app`）→ 功能（`src/features/*`）→ 共享（`src/shared`）；
  - 编辑器适配层（`src/editor`）只依赖共享与 contracts；只有编辑器页的入口与 `features/sheet-editor` 能引用它（经 `index.ts`）；
  - `features/sheet-editor` 只由编辑器页的入口引用：平台的应用层、其他入口与其他功能都不引用它（Univer 不进平台页面的包）；
  - `features/admin` 与 `features/members` 只由 `app/routes.ts` 动态引用它们的公开入口；在平台页面里，`features/confirmation`、`features/colleagues` 只由这两个功能引用，弹窗文件 `shared/ui/dialog.tsx` 只由这两个功能与 `features/confirmation` 引用（编辑器页是另一个包，不受这几条限制）；弹窗类的 Radix 原语只在 `shared/ui/dialog.tsx` 里引入，对 web 的全部文件生效（M2-P1、M2-P2）；
  - Univer 的内部符号与 `Univer.__getInjector()` 只能在 `src/editor/internal-api/` 引用，逐项登记（M2-P6 起：internal-api 之外只经它的两个出口引用，`@univerjs/*` 的值引用只许公开符号的白名单，登记表扫描 internal-api 的全部文件，清单与目录由 tools 的测试核对）；`@univerjs/*` 只引用包入口、`/facade`、`/locale/<语言>` 与样式（ADR-010）。internal-api 有两个出口：数据的包在 `index.ts`，界面的包（docs-ui、engine-render、sheets-ui 等）只在 `ui.ts`，只由主线程引用——公式 Worker 也引用 `index.ts`，界面的包从那里再导出会整包打进 Worker（门禁 `budgets` 兜底）。
- **api**：
  - 模块之间只经对方的 `index.ts`，模块不引用应用的组装；
  - admin 与 workspace 是最上层的编排，只由 app 层组装，别的模块都不引用它们；停用者文档的转移（`DocumentTransferService`，不经内容权限）只由 admin 模块引用（M2-P2）；
  - 契约的请求结构与路径里的 id 用 `uuidSchema`（统一成小写），不直接用 `z.uuid()`（M2-P2）；
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

规则由 ESLint 执行，并有自测（`tools/src/lint/lint-rules-{common,web,api,editor-internal,editor-public}.test.ts`（M2-P6 按领域拆成五个文件并行跑，共用的准备在 `lint-harness.test-support.ts`））。

## 6. 质量门禁

| 门禁 | 时机 | 内容 |
|---|---|---|
| 提交钩子（lefthook） | 每次提交 | 暂存文件的 `eslint --fix`；去掉提交说明里的 AI 署名 |
| `pnpm verify --fast` | pre-push | lint、类型检查、单元测试、静态检查（精确版本、包管理配置、故事对照、迁移只向前、表定义与迁移同步） |
| `pnpm verify` | 合并到 main 之前 | lint、类型检查、静态检查；启动开发数据库；单元与集成测试合在一起跑并统计覆盖率；清理并构建；依赖图与许可、产物扫描与第三方许可清单、首屏体积预算；前端的测试构建；E2E（本机三个浏览器，真实后端与数据库） |
| CI（`.github/workflows/ci.yml`） | 推送 main；每周一次；手动 | 三个 job 并行：`verify`（`pnpm verify --ci --scope=no-e2e`：PostgreSQL 服务容器，E2E 之外的全部门禁，含依赖漏洞扫描）；`e2e`（`pnpm verify --ci --scope=e2e`，按浏览器分成 Chromium、Chrome、WebKit、Edge 四个并行的任务）；`container`（`pnpm test:e2e:container`：构建生产镜像，起测试环境，跑 Chromium 的 E2E 与重启用例）。失败的步骤、汇总与失败的 E2E 用例写成 GitHub 注解，不登录也能读取 |

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
| `artifacts` | 构建产物只有登记过的文件类型（`.json` 也扫描，只放行三个清单文件）；JS 按语法树找出 `eval` 与 `Function` 的每一处引用（任何对象上的同名属性、恰好是这两个名字的字符串也算；对象字面量的键、类成员名、`case` 的值与私有字段只是名字，不算），除已登记的动态代码（zod 的 JIT 探测与编译器，jitless 下执行不到）与全局对象探测（lodash，上限 2 处）外都违规，其他文本文件按写法匹配；JS 的地址按语法树取出的字符串值、模板字符串、正则与注释识别（转义、拼接、插值给出的协议、协议相对的本机与 IP 地址都认得），模板插值前的固定主机照样检查；字符串与模板字符串、HTML 的属性值与样式（parse5 按规范解析；树构建丢掉的开始标签也算，丢掉的是原始文本一类的元素或 svg、math 时直接报违规）、SVG 文件（按 XML 解析；带 DTD、处理指令、格式错误或编码不是 UTF-8 时直接报违规）、样式的字符串与 url（按 CSS 的分词规则）、JSON 的字符串再按浏览器的解析规则解析（反斜杠、前导空白、夹在中间的制表符、用户信息、编码过的主机、不带斜杠的 `wss:`、协议或端口是插值、单标签的主机、IPv6），比较、去重与核对允许清单都用解析出的规范写法（点段化简，同一处里规范写法不同的地址逐个核对），整个文件另按写法匹配兜底（JS 字符串里嵌的样式与 HTML、`data:` 地址里的文档不解开，由 CSP 拦下，DEF-022），自测含一条经 Vite 真实构建、压缩之后再扫描的用例；地址按具体地址登记放行，只有编辑器页的产物（编辑器入口能到达的块与它们引用的 Worker）另可按前缀登记（公式说明的文档链接），其余产物默认只按具体地址；没有禁用的关键字（含编辑器 E2E 探针的名字，M2-P3）；没有只属于测试构建的文件（CSP 探针、编辑器的 E2E 探针、真实 Safari 的页面自检；M3-P2 起按构建插件写出的 `.vite/module-sources.json` 认每个脚本的来源模块，来源在测试专用的位置即违规，产物里有清单没记下的脚本也违规，分块名与关键字兜底）；第三方许可清单（含 Worker 的产物）完整，发布包里缺许可文件的包由仓库补齐正文 |
| `budgets` | 各入口首屏 JS 的体积（入口块加上静态引用的块，gzip）不超过预算；入口创建的 Worker 另列一项（按构建清单里块的 `assets` 找到 Worker 的产物，连同它静态引用的块）；入口能加载到的块创建了没有预算的 Worker（含 `?worker` 的写法与动态加载的块）、一个预算匹配到多个同名的 Worker、构建清单里有没有预算的入口、产物里有没有归属的脚本（例如 Worker 里再创建的 Worker）、构建清单里的块引用了清单里没有的块时报违规；平台页面的首屏文件数超过上限（2 个）时报 `budgets/too-many-files`（M2-P6） |
| `audit` | 生产依赖没有高危及以上的漏洞；例外有原因与到期日；没有被配置藏起来的漏洞 |

覆盖率下限（单元与集成测试合计）：contracts 90%，api 80%，web（编辑器适配层以外）70%，tools 80%。本机发件箱里只能在真实浏览器里测的 IndexedDB 接线与测试构建的探针不计入单元覆盖率（理由同编辑器适配层），由三个浏览器的浏览器层用例覆盖（M4-P1）；Worker 的薄入口计入单元覆盖率，同时保留真实 Worker 的浏览器层验证。

崩溃项目（M4-P1）：持久化的浏览器目录、按角色认出并结束这次启动的整棵浏览器进程（Linux 读 /proc；macOS 上 WebKit 的 XPC 服务另认，要求机器上只有这一个 Playwright WebKit）、以同一个目录重开（`tests/e2e/support/browser-crash.ts`）；每个浏览器一个项目、`workers: 1`，重启后端的项目依赖它；另能读、补 Chromium 的 IndexedDB 日志结尾（`leveldb-log.ts`，确定地造出删库）。E2E 与集成测试的测试库按主机标识命名、只清理本主机建的（`tests/shared/test-databases.ts`），集成测试建模板时只删没人在用的旧模板。

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
| `users` | users | 账户：用户名（小写的规范写法，唯一）、显示名、Argon2id 哈希（CHECK 只接受 `$argon2id$`）、凭据的版本（M2-P1）、系统角色、状态（有效、停用，M2-P1） |
| `spaces` | spaces | 空间：个人空间（每人一个，部分唯一索引；有所有者，不能全员可见、不能归档）与团队空间（M2-P2：有创建人、没有所有者，名称按判重键唯一（生成列 `name_key`，M2-P6，ADR-014），可以全员可见、归档） |
| `space_members` | spaces | 团队空间的成员（M2-P2）：空间、账户、空间角色（管理员、编辑者、查看者）；主键（空间，账户）；按账户的索引 |
| `auth_sessions` | auth | 登录会话：令牌摘要（唯一）、空闲与绝对过期、撤销的时间与原因 |
| `auth_login_throttles` | auth | 限流的计数（登录，M2-P1 起另有一次性链接的键，M2-P6 起另有按链接记录的键）：键的摘要、窗口内失败与正在验证的尝试次数（成功时退回，可以是 0）、锁定到期、所属账户的摘要（登录的两个账户相关的维度才有，M2-P6） |
| `auth_invitations` | auth | 邀请（M2-P1）：登录名、显示名、令牌摘要（唯一）、签发人、到期时间、接受或作废；同一个登录名最多一条未接受、未作废的（部分唯一索引） |
| `auth_password_resets` | auth | 重置密码（M2-P1）：账户、令牌摘要（唯一）、签发人（运维命令签发的为空）、到期时间、使用或作废；同一个账户最多一条未使用、未作废的 |
| `folders` | documents | 文件夹（M2-P4，迁移 0010）：空间、父文件夹（可空即根目录，RESTRICT）、名称、创建人、状态（正常、在回收站）、删除单元、层数（存列，CHECK 1–10、根目录即第 1 层）、新建的 `requestId`；CHECK "在回收站 ⇔ 有删除单元"；"与父文件夹同一空间""层数 = 父 + 1""回收站的文件夹下没有正常的东西"由服务在空间树锁下保证，集成测试删库之前扫一遍 |
| `trash_entries` | documents | 回收站的删除单元（M2-P4，迁移 0010）：空间、种类（文档、文件夹）、删除人、删除与到期时间（CHECK 到期晚于删除）、原来的父文件夹（不做外键）、删除时的标题；按空间与删除时间、按到期时间的索引。原来另有 `origin_space_id`，总是等于 `space_id`，M2-P6 删掉（迁移 0018） |
| `documents` | documents | 文档的元数据：所属空间、所在文件夹（M2-P4，可空即根目录）、类型、标题、创建者、状态（正常、在回收站，M2-P4 起有删除单元，CHECK 两者一致）、当前修订号、`unit_id`（不唯一：复制文档时不改写 unitId，迁移 0007）、插件档案、平台格式版本、写入时的 SDK 版本、写入代次 `write_epoch`（M2-P2；只增不减由触发器兜底，M2-P6 迁移 0019）；按空间与更新时间、按空间与文件夹的索引 |
| `document_contents` | documents | 每份文档一份当前快照：gzip 的 `bytea`、解压前后的字节数（CHECK 核对压缩后的字节数与上限）；规范化的内容哈希（32 字节）与非空资源的名称（M3-P3，迁移 0024，同空同有；存量为空） |
| `document_revisions` | documents | 每次新建或保存一行：修订号（与文档联合唯一）、种类（新建即修订号 1）、`request_id`（唯一，幂等的依据）、负载摘要、保存的来源（`clientInstanceId`、`localSeq`）、保存人；不存正文。M3-P3 加内容哈希、客户端构建与 `created_at` 的索引；保留 30 天（当前修订那一行一直保留） |
| `document_save_receipts` | documents | 内容相同、修订号没变的保存的回执（M3-P3，迁移 0024）：`request_id`（主键）、文档、修订号、负载摘要、保存人、保存的时间、写下的时间；重放时与修订记录一起查；保留 30 天 |
| `document_edit_leases` | documents | 编辑租约（M3-P1，迁移 0022，ADR-018）：每份文档一行（主键，外键级联删除）、持有者（按它的索引）、绑定的登录与标签页、令牌摘要（CHECK 32 字节）、这一代的代次（CHECK 至少 1）、申请/续租/到期/最后活动的时间（CHECK 到期晚于续租、最后活动不晚于续租）、明确结束的时间与原因（`released`、`revoked`，M3-P5 加 `handed_over`；CHECK 同空同有）；M3-P5 加请求（标识、请求方、绑定的登录、发出与到期、谢绝）、保留（留给谁、到何时）与接管标记（被接管那一代的令牌摘要与方式）三组列，各自同空同有，有保留时结束原因是交出（迁移 0025） |
| `document_grants` | documents | 单独授权（M2-P5，迁移 0020）：文档（外键级联删除）、被授权人、角色（查看者、编辑者）、最后设置它的人（CHECK 不是被授权人）、建立与最后设置的时间；主键（文档，被授权人），按被授权人的索引（"与我共享"与"可访问文档"的授权那一半） |
| `user_local_keys` | local-keys | 本机密钥（M3-P6，迁移 0026，ADR-019）：主键（账户，版本）；当前的那一把带主密钥标识（16 字节）与包装结果（60 字节），吊销的那一版两列擦成空（CHECK"当前 ⇔ 有材料"）；每人至多一把当前的（部分唯一索引）；外键账户 RESTRICT；吊销的时刻取执行时的 `clock_timestamp()`，下一版生成于这一刻（审查 A1）；不变量 I19、I20、I21 |

M5-P1 新增迁移 `0027_m5_asset_quota` 与 `0028_m5_document_asset_links`，完整迁移数为 29；只新增迁移，不修改已合并版本。

| 表 | 模块 | 说明 |
|---|---|---|
| `assets` | assets | 每次上传的独立 UUID、上传人、数据库时间与不可变对象摘要 |
| `asset_objects` | assets | 已完整发布对象的摘要/键/类型/大小/尺寸/帧数；同字节去重 |
| `asset_object_claims` | assets | 文件发布之前的持久字节预留；失败不静默释放配额 |
| `asset_quota` | assets | 组织唯一配额统计行，事务串行核对；默认 10 GiB/100,000 记录 |
| `document_asset_links` | documents | 当前文档与资源的复合主键；文档物理删除级联移除关系，资源外键 RESTRICT；不等同于未来历史/备份保留引用 |

## 8. 部署

```text
浏览器 ──HTTPS──▶ Caddy（TLS 与转发）──HTTP──▶ app（前端页面与 /api，同源）──▶ PostgreSQL 18
                                        migrate（一次性任务，所有者角色）──────▶
```

- **镜像**（`deploy/Dockerfile`）：`node:24.21.0-bookworm-slim`（按摘要）；共享 manifests 层包含锁文件、包清单与固定补丁目录；构建阶段按锁文件安装、构建全部包，单独一次只装 api 的生产依赖；运行镜像包含 Node、生产依赖、构建产物及非 Web 的原生组件对应源码/许可材料，不带 pnpm/npm。非 root，健康检查请求就绪探针；完整材料在构建和部署时逐文件离线核对，实际加载版本与分发版本必须一致。
- **应用**：同源托管前端页面与 `/api`，安全头、Cookie 与缓存策略都由应用下发。`NERVE_TRUST_PROXY` 按代理的跳数配置（测试环境是 1），应用的端口只对代理可达。
- **私有图片卷**：仅应用挂载 `/var/lib/nerve-office/assets`，目录 0700/文件 0600，与 `/app/web` 分离；迁移、数据库与 Caddy 无此卷。应用容器默认 4 GiB，覆盖快照池与图片预算，增加并发须重新测量。数据库与图片卷必须配套备份/恢复。
- **迁移**：同一个镜像的一次性任务（`node dist/cli/migrate.js`），用所有者角色，成功结束之后才启动应用；应用启动时只检查库结构版本。
- **数据库角色**：`deploy/sql/bootstrap-roles.sql` 建所有者与应用两个角色与数据库，默认权限让所有者以后建的对象自动授权给应用；应用启动时自检。
- **反向代理**：只做 TLS 与转发：不压缩、请求体上限 6 MB、就绪探针对外 404、到应用的空闲连接早于应用的 5 秒回收、去掉 `Server` 与 `Via`；不采信客户端带来的转发头。换用别的代理时满足同样的要求（`deploy/README.md`）。
- **测试环境**（`deploy/test/`）：compose 的 `db`、`migrate`、`app`、`caddy`；应用容器只读根文件系统、去掉全部 capabilities、`no-new-privileges`、不发布端口；Caddy 以 nobody 运行、只保留 `NET_BIND_SERVICE`；数据库与 HTTPS 只发布到本机回环。
- **容器 E2E**（`pnpm test:e2e:container`，CI 的 `container` job）：构建镜像（标签带进程号）、随机密码与端口起一套测试环境 → 核对部署配置（经代理的探针、两个客户端地址与伪造的转发头、应用的端口不发布，DEF-014；随镜像分发的许可文件；M3-P6 起：本机密钥的主密钥每次随机生成，缺失与写法不对时应用拒绝启动且输出里没有取值，收完日志之后扫一遍主密钥）→ 以外部模式跑 E2E（只依赖测试构建的 `@test-build` 用例按标签排除；M3-P4 起生产镜像里没有自动保存的控制，会跑的用例要在自动保存照常运行时成立，P4 设计 §3.14）与重启用例 → 打印镜像体积与应用容器的内存（空闲取部署核对之后等 10 秒、5 次取样的中位数，峰值取 E2E 期间每 2 秒取样的最大值，ADR-001）→ 收集日志、清理（每一步都执行，有一步失败就以非零退出）。长命令异步执行，收到信号时转给正在运行的那一个，之后不再开始新的步骤（Codex 评审 CX12、CX13）。
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
| 2026-09-28 | M2-P1 | 账户与系统管理：admin 模块与 `@SystemAdminOnly()`；修改密码、按人撤销会话；邀请注册与重置密码的一次性令牌（ADR-013，迁移 0008）；停用与启用、系统管理员的授予与取消；同事目录；审计查询；运维的重置链接命令；前端的公开页面与管理界面（按需加载）；`stories` 门禁累计各 M 的故事 |
| 2026-09-29 | M2-P2 | 团队空间与有效权限（ADR-014，迁移 0009）：spaces 只管数据与不变量，新增 workspace 模块（空间的接口与成员），有效权限的唯一入口与"可访问文档"的条件在 documents，writeEpoch 与收回写入权的入口，停用者文档的转移；锁的顺序延伸到空间、成员与文档；前端的左侧导航、空间页、成员页与管理界面的团队空间、转移页 |
| 2026-09-29 | M2-P3 | 查看者的只读加固（ADR-015；ADR-009、ADR-010 的补充）：编辑器能不能编辑在创建时决定，授权服务按它回答，只读守卫（防火墙与变更检测同一个判定、撤销与重做、工作表权限点），只读的界面；内部 API 加 17 项（含 SDK 的 2 个 DOM 标记），界面的包拆到第二个出口 `internal-api/ui.ts`（经 `index.ts` 再导出会整包打进公式 Worker）；E2E 与审查发现的体验问题一并处理（编辑栏点不进去、冻结线与图片拖不动、替换不开放、批注浮层只读、权限提示改成只读的说法）；测试构建的 E2E 探针，门禁核对生产产物里没有它 |
| 2026-09-30 | M2-P4（M2-P6 复核时补记） | 文件夹、文档管理与搜索（ADR-016，迁移 0010–0013）：documents 的文件夹（层数存列、最多 10 层）、改名移动复制、删除单元与回收站、恢复与永久删除、按标题搜索；空间树的 advisory lock 串行化结构性改动；jobs 模块与回收站 30 天的自动清理（会话级 advisory lock 防重复执行）；前端的文件夹导航与行内操作、回收站页、顶栏搜索；CI 的门禁分片。P4 收尾时这一行与表清单漏记，M2-P6 第 3 片补上 |
| 2026-10-02 | M2-P6（M2 复核） | 六片复核之后的改动（`reviews/P6-总结.md`）：登录限流的三个维度与解除锁定、签发人离任作废链接、修改密码换令牌（ADR-007、ADR-013）；团队空间名称的判重键（迁移 0016、0017）、复制在锁下重新判断、看不到与不存在的语句序列核对（ADR-014）；空间树锁下 8 处核对的确定交错用例、永久删除前的核对、数据库繁忙回 503 与请求级的提交记录、迁移与表定义的整体核对、写入代次的触发器（迁移 0018、0019）、定时清理按数据库时间（ADR-005、ADR-006、ADR-016）；编辑器只读的全部快捷键回归、SDK 值引用的白名单与 internal-api 的出口（ADR-010、ADR-015）；前端的请求标识记账、人名组件、写操作结果未知的共用做法、焦点与读屏、按需加载失败的边界、文案按范围拆出首屏（ADR-008）；门禁限定平台页面首屏的文件数、CI 上 E2E 出现重试即失败、门禁各步与 `ci.yml` 接线的核对、全部路由的未登录与"看不到/不存在"核对（01 号规范）；容器 E2E 的空闲内存取中位数（ADR-001）；第 6 片合并之后的 CI 修复：失败登录的哈希计算两条路径相同，取代按耗时补齐（ADR-007） |
| 2026-10-02 | M2-P5 | 分享（US-M2-10）与越权访问的全面验证（US-M2-14）：`document_grants`（迁移 0020）；有效权限分开带空间角色、内容权限与访问途径，结构性的操作只看空间角色；"可访问文档"的两半；分享的写入由 workspace 编排（账户行 → 空间行 → 文档行，锁下核对仍在持住的空间）、"与我共享"、搜索并上授权；个人空间存的名称不对别人给出（`spaceIdentitySchema`）；前端的分享对话框、"与我共享"页；权限矩阵 8 个角色、看不到与不存在 108 个探测（ADR-014、ADR-016） |
| 2026-10-03 | M2 收尾（Codex 评审） | 合并之前 Codex 的 M 级对抗评审的修复：登录之后的读请求在一个只读快照里判断权限与读数据（`TransactionRunner.readSnapshot`，开场核对由 auth 登记，请求级的身份记录 `RequestIdentities`，ADR-017），按路由表核对；同一个连接上不并发查询（集成测试核对）；现存哈希的参数没读全之前不进入验证（ADR-007）；新建文件夹存下请求摘要（迁移 0021）；"与我共享"的复制与改名（一行文档与行内操作两处共用）；写操作成功之后的刷新有时限、列表刷新失败看得见 |
| 2026-10-04 | M3-P1 | 编辑租约（ADR-018，迁移 0022）：documents 的租约表、有效条件、申请/心跳/释放/编辑状态（接口在 workspace）、保存要求租约（重放先于租约）、收回写入权接入租约（ADR-014 的补充：锁的顺序加租约行，M2-P2 审查 A3 的窗口收口）、持有者的请求在锁下另核对登录（ADR-017 的补充）；编辑器页的租约管理（申请、心跳、续上、失效、释放）；新错误码 `EDIT_LEASE_HELD`、`EDIT_LEASE_LOST` |
| 2026-10-04 | M3-P2 | 阅读模式与编辑权的界面：打开即阅读、进入与退出编辑一律重建编辑器（需求方决定；ADR-015 修订、计划书 r15）、视图状态；编辑器页的阅读与编辑的状态机 `edit-mode.ts`；阅读时 30 秒的编辑状态检查与"有更新"；失去编辑权时另存为副本（新接口，ADR-011、ADR-014 的补充，迁移 0023 重列审计动作）或放弃，结果未知的保存先重发；读取内容的条件请求（304，DEF-017）；编辑状态带 `canEdit`；后台请求不顺延登录（`@BackgroundRequest()`，ADR-007 的补充，DEF-043）；只读的行列分隔线（DEF-027）、"高级查找"（DEF-028）、带图片的粘贴（DEF-035 的旁支）；真实 Safari 的页面自检（测试构建）；ADR-010、017、018 的补充 |
| 2026-10-05 | M3-P3 | 保存协议加固（ADR-011 修订，迁移 0024）：重放预检先于一切检查、拦截旧客户端（保存、副本、申请、心跳；`CLIENT_OUTDATED`、`DOCUMENT_TOO_NEW`）、完整的快照检查放进子进程池（需求方决定；ADR-001 的内存上界，DEF-018 关闭）、规范化的内容哈希与"内容相同不递增"（回执表）、平台信封、"公式待更新"、修订记录与回执保留 30 天（ADR-016：第二个定时任务与共用的调度器）；contracts 的资源规则、链接判定、平台图片地址与规范化；页面在写入之前改写链接（ADR-010，DEF-021）、上报构建与数据格式、"需要刷新"与"文档太新"、80% 提示；DEF-046、DEF-047 |
| 2026-10-06 | M3-P4 | 自动保存与打开自检（ADR-010 修订，ADR-011、ADR-018 的补充，计划书 r17）：两级的自动保存（捕获与上传的节奏、立即上传、会话内去重、退避与 `Retry-After`、离线、会话暂停、"公式待更新"的补存与进入编辑时的强制重算、阅读页的说明）、页头保存状态的全集与读屏（DEF-045 关闭）；组合输入与面板防抖的观察；打开自检（资源守卫、四类失败、资源比较、hook 集合的复核）、只能阅读的失败页面与"先取后放"、上报接口；主线程公式模式的档案变体与计算中销毁的规避；`pagehide` 有在途的保存不释放；测试构建的自动保存控制，真实 Safari 的页面自检改为观察真实的自动保存（DEF-003 关闭）；DEF-020 不影响；审查之后：立即上传在按下的那一刻提交单元格、连按保存只记一次账、会话类失败的退避、确认会话失败之后再确认 |
| 2026-10-07 | M3-P5 | 交接规则（ADR-018、ADR-014、ADR-017、ADR-007 的补充，计划书 r18，迁移 0025）：请求编辑与交出（单槽、请求方停止续期 10 分钟后失效、交出之后保留 2 分钟）、本人接管（先服务端后本机锁、同一浏览器的交接频道、刷新时在途保存的记号）、强制接管（`canTakeOver`、审计）、空闲释放、异常中断按事实判断与收回写入权只收回按时间还活着的租约（DEF-044；刚死不久的仍锁文档行，等在途的保存）、跨空间移动之后只让持有者本人续上；审查之后：同一浏览器交给另一个标签页时不释放、由新标签页本人接管换代，请求只在发出过的标签页恢复等待，请求方续期的会话类失败有界，`edit-mode.ts` 拆出持有者一侧的请求与交接频道的编排，刷新之后的说法；真实 Safari 的两个标签页复核；DEF-042、DEF-044 关闭，登记 DEF-062–064 |
| 2026-10-08 | M3-P6 | 本机密钥（ADR-019；ADR-007、012、014、017、018 的补充，计划书 r19，迁移 0026）：local-keys 模块——主密钥环（HKDF 派生、AES-256-GCM 包装、KAT）、取用 `POST /api/local-key`（第一次取用时生成）、吊销（擦掉被吊销那一版的材料、同一个事务里生成下一版，吊销的时刻取执行时）与审计、心跳带版本、启动自检；主密钥只给应用进程（`ConfigModule.forServer`、`LOCAL_KEYS_CONFIG` 与 lint，严格格式、HTTPS 时拒绝可读的主密钥）；应用全局关掉 Express 自动算的 ETag；账户页的吊销（自己、别人、停用的三版确认框）与状态列的版本；容器 E2E 的拒绝启动核对与日志扫描；登录页的说明与错误分开（DEF-048）、选目标位置之后的焦点（DEF-049）、编辑器页阅读时的说明（A14）；真实 Safari 的请求编辑两条路（DEF-062 关闭，DEF-069）；登记 DEF-065–070 |
| 2026-10-09 | M3 合并前评审（Codex） | 释放与交出先锁文档行、明确结束在类型上凭锁下的租约行（CX1）；本机锁的争用以服务端的事实裁决（`local-lock.ts`、租约的 `confirm`，CX2）；吊销的响应分成结果与现状（CX3）；还没写进模型的输入合成一个状态（`uncommitted-input`，CX4）；页头与 CI 一节订正 |
| 2026-10-09 | M3 合并之后 main 的 CI | 被本人接管"在哪"按本机的证据定，与服务端的回答、本机锁被抢谁先到无关（`local-lock.ts` 的 `takenHere`、`edit-mode.ts` 的 `locateTakeover`；ADR-018 的补充） |
| 2026-10-10 | M4-P1 | 本机发件箱的底座（ADR-020）：`shared/outbox/`（存储与写入栅栏、加密、写入管道、OPFS 的冗余与恢复的提示、本机密钥的客户端、本机存储的状态、合一的清理）与发件箱 Worker；lint 的区域规则；崩溃项目与工具；测试库按主机标识命名；Chromium 的 IndexedDB 删库（UR-034） |
| 2026-10-10 | M4-P1 接续收尾 | D1–D3 恢复/清理并发修复、关页等待、探针校准和启动信号顺序经本机门禁及独立审查；最终 main `a8d2e0d6` 的六项 [CI](https://github.com/open-nerve/NerveOffice/actions/runs/38026702701) 全绿，P1 关闭。P2 仍在实施 |
| 2026-10-11 | M4-P2 | 本地优先唯一 WorkingDraft、编辑会话/副本拆分、完整请求时限、重连后的上传许可、本机保护范围与同步元数据限制、换钥/部署开关、真实端到端测量；Phase 验收记录见 P2 审查报告 |
| 2026-10-14 | M4-P3 关闭 | 明确恢复、完整原件条件接手/删除与固定时限接管；自动身份范围已按用户选择修订。main `d9fa57f1` 同 SHA 六项 CI 及原件通过，见 P3 审查报告与交接单 |
| 2026-10-14 | M4-P4 S1–S5 / S6 验收中 | 批量文档事实、失效原因、共享目录与 IDB v2 会话栅栏、本机草稿页/标记、启动维护与完整退出/停用清理、SDK 内存偏好；累计验收未完成，见 P4 审查报告 |
| 2026-10-20 | M5-P2 S6 | 同步正式图片实例/输入、九份 SDK 固定修复和部署补丁目录；本机 full03 与 container02 完整验证按精确输入范围复用，full04 系统启动失败保留，最终发布/CI/清理以操作后回执为准 |

P4 S6 修复补充（2026-10-14，整阶段验收中）：成功会话响应的取消覆盖到最终采纳；普通失效暂停记录仅供同一原代次确证停用使用的 suspendedFrom，重登/成功复核切断关系；同一清理被后台完成后前台仍退出原服务端会话；OPFS 根读取失败保留原件与墓碑，不当作 unsupported 或已清空。同 Document 会话通知共享原生端点，避免本页广播回声触发额外网络复核；新增草稿入口后页头在 md 以下为账户保留独立行。首轮完整门禁失败已保存，修复后默认定向 179 通过/1 既有跳过、running 84 通过，完整验收仍待重跑。详见 ADR-007/020 与 P4 审查报告。

P4 S6 重启续验（2026-10-15）：第二轮完整门禁在 13,971 项单元/集成通过后因重启中断。独立探针与纯 IndexedDB 日志测试已纠正启动前提，三浏览器取钥 6 项及原生崩溃 47 项通过（13 个既有跳过、156 轮崩溃归属核对）。纯存储夹具仅返回同源空白 HTML，真实存储及进程未替换；应用启动维护保持原行为。完整门禁准备第三轮，容器和 CI 尚待完成，详见 P4 审查报告。

P4 S6 第三轮收尾（2026-10-15）：第三轮完整门禁的五项 WebKit 失败已归因并修正测试前提；同源 Blob 取消通知的分类保持严格边界，原生 keepalive 故事完全绕开功能路由，清理交错在真实事务提交点取证。默认21/running18/重复10项及原件核对通过；应用清理、恢复和存储语义未因这些测试调整改变，第四轮完整门禁及容器/CI 仍待验收。

- 2026-10-15 S6 第四轮收尾：完整 verify 13,974 单元/集成通过，浏览器 1,983 通过/3 失败/3 既有跳过，另63 crash/restart未运行，74,141份原件冻结。R7 保存/阅读原停用原因遗漏已由3个确定反例修复，真实新登录/换人清掉旧原因；导航响应取证与接管前真实落盘前提一并修正。4,964 前端单元、类型/lint/构建/原预算和默认27/running27/重复27均通过及核对，准备第五轮完整 verify，再同源码容器与同SHA CI；P4未关闭。

| 2026-10-15 | M4-P4 S6 | 第五轮完整 verify 13,981 单元/集成通过，浏览器1,984通过/2失败/3既有跳过，另63 crash/restart未运行，原件已冻结。结果页导航竞态经3 RED→4 GREEN修复；纯原生对照复现macOS WebKit共享OPFS根的跨进程删除/配额遍历SIGABRT，WebKit独立用例改按共享资源排队，用例内多设备竞争及全局默认6 workers保持。默认6/running6/重复18及全局6 workers的87项回归均通过并核对原件；准备第六轮完整verify，再同源码容器及同SHA六项CI，P4未关闭。 |

- 2026-10-15 S6 生产取证修正：第六轮默认完整 verify 通过：556文件/13,985单元集成，2,036浏览器PASS/16与P3身份及理由一致的平台跳过，零失败/重试/未运行；77,273原件和3,858份未变源码已冻结并审计。随后同源码首轮生产容器为262PASS/1FAIL、3restart未运行，原件4,319份已冻结。唯一失败是开放离线编辑页误用仅测试构建提供的shownCell探针；改为既有公开查找观察本页内容，仍核对停用提示、真实落盘清除和云端revision不变，不加@test-build、不改产品代码。默认21/running21三浏览器均通过并核对原件，准备第七轮完整verify与同源码完整容器；P4尚未提交/合并/关闭。

- 2026-10-16 S6 R8清理结果生命周期：第七轮完整verify通过13,985项单元/集成，浏览器1,985 PASS/1 FAIL/3既有跳过，63 crash/restart因依赖失败未运行；70,870原件和3,858份未变源码已冻结。WebKit平台启动损坏清理实际已删除原件，但后续空扫描会丢失原因，列表也未订阅维护完成。R8已用确定性反例修复：完成原因以当前原许可下的有限枚举保存，当前目录仍反映真实内容；身份失效/新代次/存储未知清空结果，列表在维护结束后重读本人轻量索引。退回旧实现8 RED/10 PASS，恢复后18直接回归、232文件/4,976前端单元通过，精确lint、全项目类型、生产/测试构建与原预算通过；默认57/running57/重点WebKit重复10均通过并核对原件。准备第八轮默认完整verify及同源码完整生产容器，随后才合并和同SHA六项CI；P4未关闭。

S6 最终本机验收（2026-10-16）：默认完整 `pnpm verify --ci` 已通过：557 文件/13,997 项单元与集成；全部 lint、类型、静态、覆盖率、构建、依赖/产物/原预算及漏洞扫描通过。浏览器共 2,052 项，2,036 PASS、16 个与 P3 基线身份和理由一致的平台跳过，零失败/重试/未运行；含 47 份崩溃附件、156 轮崩溃和 827 个被终止进程的归属核对，无遗留、迟到、角色缺失或工具错误，三浏览器 ACK 的 2 秒/20 秒边界均核对通过。同一份源码的默认生产容器为 266 PASS、零跳过/重试，含 3 项后端重启，缺主密钥/格式错误的实际拒绝启动、四份容器日志扫描与正常清理均通过。 本机原件分别为 `s6-gates/s6-verify-8-20261015T165743219704Z`、`s6-gates/s6-container-2-20261015T184001893282Z`；回执为 `s6-verify-8-audit.json`、`s6-container-2-audit.json`。两轮 3,859 份源码摘要完全相同，每轮前后未变；JSON/HTML 案例、原件摘要与 OPFS 归档/清理均已核对。先前失败和重启中断原件独立保留，不参与本轮通过计数。 尚未合并/推送，待六项同 SHA CI 及最终证据核对；P4 未关闭。

- 2026-10-16 S6首次CI与R9：P4 初版 42b9406c 已正常 no-ff 合入并推送 main 21d7ab6e；首次 CI 38789124988 五项成功、WebKit 失败，六份原件全部收集。WebKit 为658 PASS/1 flaky/1 FAIL/3基线跳过，另20个崩溃用例因依赖失败未运行。三份失败 trace 一致显示后台取钥先收到 account_disabled 并清 Cookie，指定入口随后收到 UNAUTHENTICATED；平台未消费本页已确证的停用事件，登录说明因此丢失。R9 通过现有按需维护入口将匹配当前原响应 userId/generation 的停用事实交给平台既有复核；新代次、换人、无关联来源、普通停止和已释放页面均不借用原因。旧订阅遗漏反例3 RED、去掉代次守卫1 RED，恢复后58直接回归与4985前端单元通过；lint、全类型、生产/测试构建与原预算通过。默认27/running27/重点WebKit重复25全部通过，JSON/HTML、源码及OPFS原件核对完成。R9 的新完整 verify 及同源码生产容器已通过，结果见本文件最新验收记录；随后 R9 已正常提交并合并、推送为 main d81e70bb；第二轮 CI 与 R10 的当前状态另列，P4 未关闭。

S6 首次 CI 修复本机验收（2026-10-16）：默认完整 `pnpm verify --ci` 已通过：557 文件/14,006 项单元与集成；全部 lint、类型、静态、覆盖率、构建、依赖/产物/原预算及漏洞扫描通过。浏览器共 2,058 项，2,042 PASS、16 个与 P3 基线身份和理由一致的平台跳过，零失败/重试/未运行；含 47 份崩溃附件、156 轮崩溃和 827 个被终止进程的归属核对，无遗留、迟到、角色缺失或工具错误，三浏览器 ACK 的 2 秒/20 秒边界均核对通过。同一份源码的默认生产容器为 268 PASS、零跳过/重试，含 3 项后端重启，缺主密钥/格式错误的实际拒绝启动、四份容器日志扫描与正常清理均通过。 本机原件分别为 `s6-gates/s6-verify-9-20261015T201625869563Z`、`s6-gates/s6-container-3-20261015T215611681895Z`；回执为 `s6-verify-9-audit.json`、`s6-container-3-audit.json`。两轮 3,859 份源码摘要完全相同，每轮前后未变；JSON/HTML 案例、原件摘要与 OPFS 归档/清理均已核对。先前失败和重启中断原件独立保留，不参与本轮通过计数。 R9 已合并、推送为 main d81e70bb；第二轮 CI 未接受，R10 当前状态另列，P4 未关闭。

- 2026-10-16 第二轮 CI 与导航取证修正：R9 已以 34e8a50f 正常提交并 no-ff 合入、推送 main d81e70bb；第二轮 CI 38814948919 五项通过，WebKit 有两条 flaky，六份报告完整归档，不能接受该轮 CI。R9 的九条账号清理故事均首次通过。R10 仅修正两条测试的导航取证方式，产品代码未变；默认三浏览器 6 PASS、自动保存 running 6 PASS、WebKit 连续 10 轮共 20 PASS，零跳过/重试。Linux 四个独立容器各限 0.5 CPU 的离页对照 40/40 通过。随后第十轮完整 verify 因 R11 自检时序失败终止；新的验收与 CI 状态见 R11 记录，P4 未关闭。 根因与证据见 P4 审查报告 R10。

- 2026-10-16 第十轮完整验证与自检时序修正：第十轮完整 verify 的 14,006 项单元/集成通过，浏览器 1,991 PASS、1 FAIL、3 个既有平台跳过；63 项依赖 crash/restart 未运行，audit 未执行，因此本轮不接受。唯一失败是 WebKit paused-holder 自检把首笔数据库提交误当作浏览器已处理确认：驱动先隐藏页面，第二笔保存已开始，自检仍要求 dirty。R11 只修测试构建的阶段判定与校准，生产逻辑未变。两个受控反例先失败后通过；19 个新增边界及相关既有单元共 56 项、三浏览器默认 15 项、running 15 项、WebKit 三轮 6 项均通过，零重试/跳过。R10/R11 定向校准及新的默认完整 verify、同源码生产容器已通过，详见最新本机验收记录；该轮合并 SHA e21554bd 的第三轮 CI 未被接受，R12/R13 的后续状态见本文件开头。 证据和边界见 P4 审查报告 R11。

S6 第二轮 CI 修复本机验收（2026-10-16）：默认完整 `pnpm verify --ci` 已通过：558 文件/14,025 项单元与集成；全部 lint、类型、静态、覆盖率、构建、依赖/产物/原预算及漏洞扫描通过。浏览器共 2,058 项，2,042 PASS、16 个与 P3 基线身份和理由一致的平台跳过，零失败/重试/未运行；含 47 份崩溃附件、156 轮崩溃和 828 个被终止进程的归属核对，无遗留、角色缺失或工具错误；准备之后出现的 1 个进程均在冻结时补识别并结束，身份与归属逐条匹配 killed 记录。三浏览器 ACK 的 2 秒/20 秒边界均核对通过。同一份源码的默认生产容器为 268 PASS、零跳过/重试，含 3 项后端重启，缺主密钥/格式错误的实际拒绝启动、四份容器日志扫描与正常清理均通过。 本机原件分别为 `s6-gates/s6-verify-11-20261016T020619994830Z`、`s6-gates/s6-container-4-20261016T035204231010Z`；回执为 `s6-verify-11-audit.json`、`s6-container-4-audit.json`。两轮 3,860 份源码摘要完全相同，每轮前后未变；JSON/HTML 案例、原件摘要与 OPFS 归档/清理均已核对。先前失败和重启中断原件独立保留，不参与本轮通过计数。外部核对脚本曾误把 late 诊断当作幸存者；按原崩溃工具契约修正，以真实记录先复现误报，再通过 14 项正反例及全部冻结原件复核。项目源码与门禁配置未因此变更，原始失败日志和修正证据见 late-process-audit-correction-20261016/。 该记录保存当时本机验收；之后已合并并推送 e21554bd，第三轮 CI 和 R12 状态见最新记录。

- 2026-10-16 第三轮 CI 与完整清单认证前提修正：R10/R11 已正常提交为 9d0422ac，no-ff 合入并推送 main e21554bd。第三轮 CI 38848546622 四项通过，WebKit 测试通过但报告上传期间超出 job 时限被取消，生产容器为 267 PASS、1 flaky；六份日志和完整报告已收齐并核对，容器 flaky 与 WebKit job 超时均保留，不能接受该轮 CI。R12 修正完整旧数据清单故事的认证前提，仅涉及三个 E2E 文件，生产代码未变。受控反例确认旧页先清 Cookie、响应正文未交回时，新页只能得到未登录事实。修正后的三浏览器默认 30 项、自动保存运行模式 30 项及 Chromium 连续 10 次全部通过，零重试/跳过。R13 已完成无损资料归档的全量内容对照、Linux 实际命令正反例与现有 CI 接线检查。R12/R13 新一轮默认完整 verify 与同源码生产容器已通过，详见最新本机验收记录；待新合并 SHA 六项 CI，P4 未关闭。 证据与边界见 P4 审查报告 R12。

S6 第三轮 CI 修复本机验收（2026-10-16）：默认完整 pnpm verify --ci 已通过：558 文件、14,025 项单元与集成，全部 lint、类型、静态、覆盖率、构建、依赖、产物、原预算与漏洞扫描通过。2,042 项浏览器通过、16 个与既有基线身份和理由一致的平台跳过，零失败、重试或未运行；47 份崩溃附件、156 轮及 827 个进程的归属已核对，准备后新出现的 0 个进程均包含在实际终止记录中，无幸存者、缺失角色或工具错误。三浏览器 ACK 的 2 秒/20 秒边界通过。同源码完整生产容器 268 项通过，含 3 项后端重启；配置负例、四份日志扫描和正常清理通过。 原件为 s6-gates/s6-verify-12-20261016T053645093794Z、s6-gates/s6-container-5-20261016T071632581418Z；回执 s6-verify-12-audit.json 与 s6-container-5-audit.json。两轮 3,861 份源码摘要相同且每轮前后未变；JSON/HTML 精确案例、原件摘要与 OPFS 归档/清理均已核对。此前失败原件独立保留，不参与本轮通过计数。 R12/R13 已提交并合入、推送 main faf942dd；第四轮 CI 未接受，当前 R14 状态见最新记录。

第四轮 CI 与请求拦截生命周期（R14，2026-10-16）：R12/R13 已正常提交 4c7e8685，no-ff 合入并推送 main faf942dd。第四轮 CI 38875448736 五项通过，Chromium 为 683 PASS、1 flaky、4 个既有跳过；六份报告和日志已收齐并核对，该轮 CI 不接受。R14 修正单条页面错误测试的请求拦截生命周期：真实项目 Linux 受限 CPU 对照原写法 44 PASS/4 FAIL，修正后 80 PASS；正式三浏览器默认 30、自动保存运行模式 30 项通过，零重试或跳过。R14 新完整门禁已通过，新合并 SHA 六项 CI 仍待完成；P4 未关闭。

S6 第四轮 CI 修复本机验收（2026-10-16）：默认完整 pnpm verify --ci 已通过：558 文件、14,025 项单元与集成，全部 lint、类型、静态、覆盖率、构建、依赖、产物、原预算与漏洞扫描通过。2,042 项浏览器通过、16 个与既有基线身份和理由一致的平台跳过，零失败、重试或未运行；47 份崩溃附件、156 轮及 827 个进程的归属已核对，准备后新出现的 0 个进程均包含在实际终止记录中，无幸存者、缺失角色或工具错误。三浏览器 ACK 的 2 秒/20 秒边界通过。同源码完整生产容器 268 项通过，含 3 项后端重启；配置负例、四份日志扫描和正常清理通过。 原件为 s6-gates/s6-verify-13-20261016T100159011000Z、s6-gates/s6-container-6-20261016T114443493828Z；回执 s6-verify-13-audit.json 与 s6-container-6-audit.json。两轮 3,861 份源码摘要相同且每轮前后未变；JSON/HTML 精确案例、原件摘要与 OPFS 归档/清理均已核对。此前失败原件独立保留，不参与本轮通过计数。 R14 正常提交、no-ff 合并、推送和新 SHA 六项 CI 尚待完成；P4 未关闭。

- 2026-10-17 M4-P5：补齐公式 Worker 生命周期、稳定保存入口、同会话受控重建、页头与有限诊断；真实故障/生产验证及间隔/计时器实测见 P5 文档，整 Phase 验收仍待 S6 完成。同步 P4 已关闭事实，旧执行记录不作为当前状态。

## M4-P5 验收闭合与 P6 起点（2026-10-17）

P5 已合并为 main `aad47e8d`，本机完整门禁、生产容器及六项 CI 原件审计通过，分支/worktree 已清理。状态依据见 [P5 交接单](../v0.1/M4-本地优先与离线恢复/handoffs/P5-交接单.md)。P6 补齐真实 Safari、虚拟机断电和生产 HTTPS 崩溃的组合证据；M4 仍未完成。

## M4-P6 交付与实测边界（2026-10-17）

产品维持 strict 加密发件箱、OPFS 冗余、写入者栅栏、新 Document 明确恢复和条件删除；P6 修正失权后另存副本遗漏清理，仍逐项验证原件与后来 writer。生产 HTTPS 默认加入公开恢复的四项真实进程树中断故事，restart 在其后；不将测试探针编入生产。

客体 OS 突停 strict30轮和产品9轮、真实 Safari 受控暂停及请求方变体、120轮保存与四存储窗口均有直接原件。strict 结果不覆盖物理宿主掉电；自然持有者自主挂起未复现；实际十分钟取消发生在回前台之后；隐私 OPFS 不可建立，临时 IDB 关窗后消失；七使用日、persist 和永久保存不作强保证。版本计划书 r25 与 ADR-020 记载边界，旧实现历史段不代表当前发布状态。

独立审查的唯一 Important 为 VM 启动资格失败丢失句柄，已用启动者所持有的本次子进程正常清理并有界等待，保留失败/资源身份；实验 SIGKILL 和成功时序不变。最终完整验收、合并、同 SHA 六项 CI、tag与清理统一见 [P6 交接单](../v0.1/M4-本地优先与离线恢复/handoffs/P6-交接单.md)；发布事实在操作后写完成回执，不由静态设计段推定。


2026-10-22 M5-P3 实际工程关闭：最终 main `3f498f7b`、六项同 SHA CI 和独立复核通过，17:58 关闭回执的验收、冻结、清理及关闭四项均成立，唯一 P3 分支/worktree 正常移除。链接旧菜单覆盖正文的生命周期修复保持原门禁，SDK 仍为 1.0.1；开始唯一 P4 分支的历史与资源回收设计。历史/GC 尚未实现，原生环境与 M4 挂账保持。详见 [P3 最终复核](../v0.1/M5-表格能力与资源/reviews/P3-S6-最终CI与关闭复核.md)。

2026-10-22 M5-P4-S1：Documents 新增不可变 gzip 检查点、独立 UTC 小时占位和检查点图片关系；原事务内复制正文/信封/合法引用，数据库触发器禁止覆盖，7/30 天分别保留。检查点源身份不跟随文档级联删除。只注册内部采样服务，尚未接入保存和删除、历史 API/预览/恢复/过期/GC；对应 S2–S5 完成前不宣称这些流程可用。详见 [P4 设计](../v0.1/M5-表格能力与资源/04-P4-历史与资源回收.md)。

2026-10-22 M5-P4-S2：四个正式正文写入入口已在原事务内接入小时历史，unchanged/重放不采样；删除文档和文件夹在既有锁下先建 30 天检查点，失败整单回滚。批量捕获共用一次数据库时刻，永久删除保留运维正文及图片关系。相关 4,553 项集成和 11,101 项单元通过；用户历史入口及 GC 仍待 S3–S5。

2026-10-22 M5-P4-S3：已接入受当前编辑资格约束的小时历史列表/详情/原 gzip 正文、历史图片授权和恢复新副本。恢复在有限准入内验证原材料，锁下重查资格/身份/过期，原子创建独立文档；结果未知可沿原 requestId 重放。独立 history-preview.html 只创建 read SDK 实例，无租约/发件箱/自动保存，身份变化和撤权后清屏；当前自检失败也可从有效历史恢复（DEF-061）。全仓 11,170 项单元、5,402 项集成及三浏览器默认/running 共 30 项通过。独立入口使平台首屏文件上限从 2 调整为 3，原体积上限保持，预览新增完整闭包预算；详见 [S3 复核](../v0.1/M5-表格能力与资源/reviews/P4-S3-历史读取预览与恢复复核.md)。S4 清除/过期/升级前检查点和 S5 物理 GC 尚未开放，P4 尚未整阶段交付。

2026-10-23 M5-P4-S4：管理员清除仅删除 hourly，保留原件/租约/桶/回执/ops，未知结果须核对后新确认；history-purge 按数据库时钟分批释放到期历史及保留关系。独立运维 CLI 以数据库语句屏障冻结完整源清单，短批复制原 gzip/信封/图片，进程中断可接续，ready 保持冻结，release/abort 明确控制解除；过期、原子回滚、旧 RR 和 CP→回执锁序均有真实库/进程验证。全仓 11,210 项单元、5,530 项集成及三浏览器默认/running 42 项通过，原预算保持。当前尚未开放图片物理 GC；详见 [S4 复核](../v0.1/M5-表格能力与资源/reviews/P4-S4-清除过期与升级检查点复核.md)，继续 S5，整阶段门禁与独立审查仍在 S6。

2026-10-23 M5-P4-S5：Assets 以存储代次、永久退休标记和持久回执隔离旧上传/新文件；引用事务活动与双层宽限保护当前、全部历史及备份。文件 IO 事务外完成，首次确认后释放配额；缺有效备份声明时全部删除暂停。全仓 11,278 单元、5,602 集成、三浏览器默认/running 102 项及生产私有卷/4 条图片部署故事通过，真实 SIGKILL/SIGTERM 与重复接续已验证。详见 [S5 复核](../v0.1/M5-表格能力与资源/reviews/P4-S5-资源回收与备份水位复核.md) 和 [ADR-023](../adr/ADR-023-资源回收与备份水位.md)。下一步 S6 容量与完整阶段验收，原保留期、预算与环境挂账保持。

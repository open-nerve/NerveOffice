# 架构总览

> 活文档：每个 Phase 结束时更新，M1-P5 形成 v1｜当前：M1-P1 完成时｜更新：2026-09-26

## 1. 目标形态与当前进度

目标形态见 00 号计划书 §9.1：浏览器里的平台页面与编辑器页（Univer），同源访问 NestJS 模块化单体，数据在 PostgreSQL 与持久化资源目录里。

| 部分 | 当前状态 |
|---|---|
| 前端 `apps/web` | 占位页面（M1-P3 换成登录页与个人空间） |
| 后端 `apps/api` | 未建立（M1-P2） |
| 共享契约 `packages/contracts` | 统一的错误响应结构 |
| 数据库 | 开发与 CI 用 PostgreSQL 18；还没有业务表（M1-P2 起） |
| 编辑器适配层 | 未建立（M1-P4） |

## 2. 仓库结构

| 目录 | 包 | 作用 |
|---|---|---|
| `apps/web` | `@nerve-office/web` | 前端（React 19 + Vite 8）；`build/` 是构建插件（第三方许可清单） |
| `packages/contracts` | `@nerve-office/contracts` | 前后端共享的请求与响应结构（zod）、错误码 |
| `tools` | `@nerve-office/tools` | 质量门禁、故事对照、提交钩子、`verify` |
| `tests/integration` | `@nerve-office/integration-tests` | 基于真实 PostgreSQL 的集成测试 |
| `tests/e2e` | `@nerve-office/e2e` | Playwright，四个浏览器 |
| `deploy/dev` | — | 开发用的 PostgreSQL 编排 |

模块系统、contracts 的导出条件与边界的强制方式见 ADR-003；版本基线见 ADR-002。

## 3. 模块边界

- `@univerjs/*` 只能在 `apps/web/src/editor/` 下引用（静态导入、再导出、动态导入都算），任何位置都不能引用 `@univerjs-pro/*`。
- web 分层：入口（`src/entries/*`）→ 应用（`src/app`）→ 功能（`src/features/*`）→ 共享（`src/shared`）；编辑器（`src/editor`）只依赖共享与 contracts；平台页面的入口不引用编辑器。
- 跨元素时，contracts、功能模块与编辑器只经公开入口（`index.ts`）引用；元素目录里没有"无主"文件。
- contracts 不依赖任何内部包；tools 不依赖业务包；测试只经 contracts 的公开入口引用它。
- 没有循环依赖。

规则由 ESLint 执行，并有自测（`tools/src/lint/lint-rules.test.ts`）。

## 4. 质量门禁

| 门禁 | 时机 | 内容 |
|---|---|---|
| 提交钩子（lefthook） | 每次提交 | 暂存文件的 `eslint --fix`；去掉提交说明里的 AI 署名 |
| `pnpm verify --fast` | pre-push | lint、类型检查、单元测试与覆盖率、精确版本、包管理配置、故事对照 |
| `pnpm verify` | 合并到 main 之前 | 上一行，加上：启动开发数据库、集成测试、清理并构建、依赖图与许可、产物扫描与第三方许可清单、E2E（四个浏览器） |
| CI（`.github/workflows/ci.yml`） | 推送 main；每周一次；手动 | `pnpm verify --ci`（PostgreSQL 服务容器）与依赖漏洞扫描 |

A01 的检查（`pnpm gate <名称>`）：

| 检查 | 内容 |
|---|---|
| `pins` | 外部依赖都经 pnpm 目录引用，目录里是精确版本；内部包 `workspace:*`；`packageManager` 精确 |
| `config` | 只有评审过的顶层设置；发布冷却期不少于 3 天、`trustPolicy`、`engineStrict`；安装脚本、冷却期豁免、`overrides`、peer 规则、补丁逐项写明原因 |
| `stories` | 当前 M 的故事登记表与总设计一致；active 的故事有会执行的测试（取自 Vitest 与 Playwright 的列举） |
| `deps` | 生产依赖图（含可选依赖，按真实包名）没有 Pro，Univer 版本一致，应为单例的包只有一份，依赖树完整 |
| `licenses` | 生产依赖的每个安装实例的许可在白名单内；开发依赖没有 GPL、AGPL、SSPL 与未声明许可 |
| `artifacts` | 构建产物只有登记过的文件类型；没有动态代码、没有未登记的外部主机与关键字；第三方许可清单（含 Worker 的产物）完整 |
| `audit` | 生产依赖没有高危及以上的漏洞；例外有原因与到期日；没有被配置藏起来的漏洞 |

## 5. 数据库

- PostgreSQL 18.6，镜像按摘要锁定；新库使用内置的 `C.UTF-8` 排序规则，开启数据页校验和。
- 开发：`pnpm db:up`，只监听 `127.0.0.1:54318`。CI 使用同一个镜像的服务容器。
- 集成测试先检查数据库的版本与排序规则（`tests/integration/src/database-environment.test.ts`）。

## 6. 变更记录

| 日期 | Phase | 变更 |
|---|---|---|
| 2026-09-26 | M1-P1 | 初版：仓库结构、工具链、模块边界、质量门禁、开发数据库 |

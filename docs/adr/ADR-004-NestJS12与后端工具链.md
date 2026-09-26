# ADR-004：NestJS 12（纯 ESM）的验证结论与后端工具链

> 状态：已接受｜日期：2026-09-26｜来源：M1-P2（M1 总设计 §2.2、§7）

## 背景

- NestJS 12 在 2026-08-27 发布，改为纯 ESM；11 已转为 legacy。M1 总设计的决定：直接用 12，P2 开头先验证 ESM 下的构建、监听、测试与装饰器元数据，不通过就退回 11.2。
- 仓库的模块约定（ADR-003）：
  - 所有包都是 ESM；
  - 相对导入写 `.ts`，构建时由 `rewriteRelativeImportExtensions` 改写；
  - 工作区的包经自定义条件 `@nerve-office/source` 读源码。
- NestJS 的依赖注入靠 `emitDecoratorMetadata` 输出的构造参数类型。Vite 8 用 Oxc 转译，不再用 esbuild；esbuild 不支持装饰器元数据。

## 决策

**采用 NestJS 12.1.0。** 验证分两轮：
- 探针：scratchpad 里的一次性工程；
- 真实骨架：`apps/api`，P2-S1。

| 验证项 | 结果 | 证据 |
|---|---|---|
| 构建 | `nest build`（Nest CLI 12.0.5，tsc 构建器）：相对导入改写为 `.js`，产物输出 `design:paramtypes`，`node dist/app/main.js` 正常启动 | 进程测试 `tests/integration/src/api/process.test.ts` |
| 监听 | `nest start --watch --env-file .env.development`：改动源码后增量编译，以新进程重启，改动生效 | 2026-09-26 手工验证：改动控制器约 1 秒后生效，恢复后同样生效 |
| 单元测试与装饰器元数据 | Vite 8 的 Oxc 按文件所属的 tsconfig 读取 `experimentalDecorators`、`emitDecoratorMetadata`，输出装饰器元数据；不需要 SWC，也不需要自定义的转译插件 | `audit.service.test.ts` 经依赖注入取得服务。反向对照：关掉 `emitDecoratorMetadata`，依赖注入失败 |
| 集成测试 | 集成测试经源码条件引用 `@nerve-office/api`，在测试进程里启动真实的应用与管线 | `tests/integration/src/api/health.test.ts` |
| 真实进程 | 配置缺失时退出码 1；收到 SIGTERM 后退出码 0 | 进程测试 |
| lint | 开启 `emitDecoratorMetadata` 时，typescript-eslint 的 `consistent-type-imports` 不要求把依赖注入要用的类改成 `import type`（否则元数据会变成 `Object`）。它的做法是：带装饰器的文件整份跳过这条规则（审查 B 的探针确认） | lint 自测 |

**后端工具链的约定**：
- **TypeScript**：
  - api 的 tsconfig 开启 `experimentalDecorators` 与 `emitDecoratorMetadata`；集成测试经源码条件对 api 做类型检查，它的 tsconfig 同样开启。
  - api 不开 `erasableSyntaxOnly`：构造函数的参数属性是 NestJS 的惯用写法，不是可擦除的语法。
  - 因此 api 不能用 Node 的类型剥离直接运行，一律运行构建产物。
- **构建与监听**：Nest CLI（tsc 构建器），入口 `src/app/main.ts`。进程入口放在 `app/` 里，是因为 eslint-plugin-boundaries 7 的元素只能是目录，单个文件不能单独成为元素。
- **单元测试**：api 的测试放在 Vitest 的 `unit` 项目里，由 Oxc 直接转译。
- **reflect-metadata**：`@nestjs/common` 与 `@nestjs/core` 的入口都会先加载它；我们的类要用装饰器，必须先导入 `@nestjs/common`，所以加载顺序天然有保证，不需要单独的 setup 文件。它列为 api 的直接依赖，并进入单例清单。
- **Vitest 的解析条件**：node 环境的项目把 `@nerve-office/source` 写在 `ssr.resolve.conditions` 里。在 Vite 8 里，顶层的 `resolve.conditions` 只作用于浏览器环境；P1 的 node 测试没有按包名引用过工作区的包，所以当时没有暴露。
- **输入校验**：NestJS 12 自带 `StandardSchemaValidationPipe`，参数装饰器接受 `{ schema }`；zod 4 实现了 Standard Schema。控制器写 `@Body({ schema })`，没写 `schema` 的参数由 lint 拦下。
- **日志**：不用 nestjs-pino，直接用 pino 与 pino-http，另写一层很薄的 Nest 日志适配（P2 设计 §3.4）。原因有两条：
  - nestjs-pino 5 在进程里保留唯一的 pino-http 实例，同一个进程里建多个应用（集成测试）时会串用；
  - 它的中间件经 Nest 注册，排在自己挂的中间件之后，请求体解析失败的响应记不到请求日志。
- **优雅退出**：NestJS 12 关闭应用时，先调用各模块的 `onModuleDestroy`，再关闭 HTTP 服务。所以退出由 `ApplicationRuntime` 编排：先排空在途请求，再关闭应用；连接池在 `onApplicationShutdown` 里关闭（P2 设计 §3.9）。
- **版本**：
  - `@nestjs/common`、`core`、`platform-express`、`testing` 12.1.0；
  - Nest CLI 12.0.5（12.0.7 在 2026-09-25 发布，还不满 3 天）；
  - express 5.2.1，与 platform-express 12.1.0 依赖的版本相同。

## 备选方案与取舍

| 方案 | 结论 | 原因 |
|---|---|---|
| A. NestJS 12 + Nest CLI（tsc）+ Vitest（Oxc） | 采用 | 验证全部通过，没有额外的转译器 |
| B. 退回 NestJS 11.2 | 否决 | 11 已转为 legacy；12 的验证没有发现阻断问题。现在不用 12，以后还要整体迁移到 ESM |
| C. 用 SWC（unplugin-swc）处理测试里的装饰器元数据（NestJS 官方文档的做法） | 否决 | Oxc 已经支持；多一个带原生二进制的依赖 |
| D. 用 `ts.transpileModule` 写一个 Vite 插件输出元数据（opennerve 的做法） | 否决 | 那是 Vite 7（esbuild）时代的办法；Oxc 已经原生支持 |
| E. nestjs-pino | 否决 | 见上 |
| F. 自己写 zod 校验管道 | 否决 | NestJS 12 自带基于 Standard Schema 的管道 |

## 影响

- ADR-002 的后端一行按本 ADR 更新；M1 总设计 §2.2 的版本表修订两处（不用 nestjs-pino；Nest CLI 用 12.0.5），写进变更记录。
- 后端的目录、元素与写法限制见 P2 设计 §3.1；新增模块时按 ADR-003 的约定，在 `eslint.config.ts` 里声明，并补 lint 自测。
- 本机开发：`pnpm dev:api` 在监听模式下启动 api，读取 `apps/api/.env.development`。
- 升级 NestJS：同一主次版本线内的补丁可以随时升级；跨主次版本时，重跑本 ADR 的验证项（S1 的测试已经覆盖大部分，监听要手工确认）。

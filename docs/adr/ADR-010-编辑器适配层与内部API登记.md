# ADR-010：编辑器适配层与内部 API 登记

> 状态：已接受｜日期：2026-09-27｜来源：M1-P4

## 背景

- 00 号计划书 §10：Univer 集中在编辑器适配层；插件档案是数据；优先用公开的稳定 API，用到内部 API 时集中封装并登记（`CLAUDE.md` 的代码与依赖约束）。
- M0 验证了几处只能靠内部约定的能力：公式收齐（mutation 的 id、执行选项、脏区服务）、`IMAGE()` 的限制（函数服务、函数基类与错误值）、取服务用的注入器（`Univer.__getInjector()`）、身份替换（ADR-009）。
- ADR-003：模块只经公开入口引用；平台页面的包里不能有 Univer。

## 决策

**适配层**（`apps/web/src/editor/`）回答"这份快照在 Univer 里怎么编辑、怎么捕获"，对外只有一个小接口：

```ts
createSheetEditor({ container, snapshot }): Promise<SheetEditor>
// SheetEditor：unitId、changeSeq、onChange、lifecycle、onLifecycle、isCellEditing、commitCellEditing、
//             settleFormulas、capture、setEditable、dispose
```

- `createSheetEditor` 在工作簿创建、渲染完成、主线程与公式 Worker 的 `IMAGE()` 限制都装好之后才返回；任何一步失败都销毁已经创建的一切并抛出（`SheetEditorLoadError`，带原因），页面显示"编辑器加载失败"。
- 结构：`profile/`（插件档案 `sheet@1`：插件、顺序、影响数据的配置、声明的资源、语言包、样式、菜单配置、入口守卫）、`identity/`（ADR-009）、`change-tracking/`（变更检测与公式收齐）、`image-function/`（`IMAGE()` 的限制与 Worker 的回报）、`workers/`（公式 Worker 的入口）、`internal-api/`。
- 公式 Worker 由适配层用静态的 `new Worker(new URL(…), { type: 'module' })` 创建（同源脚本，不内联成 blob），由适配层终止。
- 请求、保存状态与界面属于编辑器页（`features/sheet-editor`），不在适配层里；保存的状态机不依赖 Univer，用假的编辑器做单元测试。

**内部 API 的登记**：
- Facade 之外的 SDK 符号只能经 `internal-api/` 引用；`internal-api/registry.ts` 逐项写明用途、M0 的证据与回归用例，单元测试核对"导出的每一项都已登记"。本期 10 项：注入器、公式协议（mutation id 与执行选项）、`IAuthzIoService`、`LifecycleService`、`BaseFunction`、`BaseValueObject`、`ErrorType`、`ErrorValueObject`、`IFunctionService`、`IActiveDirtyManagerService`。
- lint：受限符号清单（按包与导入名，含命名空间导入、再导出与 `import type`）与 `__getInjector` 的调用（含计算属性与解构），在 `internal-api/` 之外一律报错；`@univerjs/*` 只引用包入口、`/facade`、`/locale/<语言>` 与 `/lib/index.css`（深层路径绕得过按导入名的限制）；编辑器里的 `@univerjs/*` 只用静态导入。lint 有自测。

**模块边界**：只有编辑器页的入口与 `features/sheet-editor` 能引用适配层（只经 `index.ts`）；`features/sheet-editor` 只由编辑器页的入口引用；平台的应用层、其他入口与其他功能都不引用它。门禁 `budgets` 另外兜底（平台页面的预算没有因为编辑器变大）。

## 备选方案与取舍

| 方案 | 结论 | 原因 |
|---|---|---|
| A. 适配层加内部 API 的唯一出口与登记表，lint 强制 | 采用 | 升级 SDK 时知道要回归哪些内部约定；平台代码不会悄悄依赖 SDK 的内部 |
| B. 需要时各处直接引用内部符号 | 否决 | 散落各处，升级时找不全；违反计划书 §10 |
| C. 只用 Facade，放弃公式收齐与 `IMAGE()` 的限制 | 否决 | 显式保存的快照里公式结果不一致（US-M1-05），外链的 `IMAGE()` 会发请求（被 CSP 拦下但出现违规，计划书 §11.3） |

## 影响

- 升级 SDK 或调整档案时：先跑登记表里的回归用例与 E2E（模板收敛、公式收齐、`IMAGE()`、入口守卫），再用 `pnpm --filter @nerve-office/e2e run update:sheet-template` 更新模板（ADR-011）。
- 新增内部依赖：先在 `internal-api/` 封装并登记，补上 lint 的受限符号与自测。
- M3（捕获时机、打开自检）、M4（Worker 重建、发件箱）、M5（图片与超链接的入口）都在适配层内扩展，对外的接口按需加法。

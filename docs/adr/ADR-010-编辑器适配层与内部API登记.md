# ADR-010：编辑器适配层与内部 API 登记

> 状态：已接受｜日期：2026-09-27｜来源：M1-P4｜修订：2026-09-28，M1 对抗评审（Codex CX1、CX6）与独立复验（N1、S1）之后，就绪之前的输入由编辑器页的交互屏障拦下，另外跟踪单元格里还没提交的输入；2026-09-29，M2-P3 能不能编辑在创建时决定（`access`），只读守卫与只读的界面，内部 API 加 17 项、拆出界面包的第二个出口 `ui.ts`，测试构建的探针（ADR-015）；2026-10-01，M2-P6 第 4 片复核：`@univerjs/*` 的值引用改为白名单，探针只能动态引入，内部 API 加 `IShortcutService`（只给测试构建的探针）；internal-api 之外只能经两个出口引用，登记表扫描 internal-api 的全部文件；2026-10-04，M3-P2：视图状态（`viewState`），内部 API 加 2 项（行列调整的控制器、查找面板的 DOM 标记），入口守卫按参数取消带图片的粘贴，测试构建加真实 Safari 的页面自检

## 背景

- 00 号计划书 §10：Univer 集中在编辑器适配层；插件档案是数据；优先用公开的稳定 API，用到内部 API 时集中封装并登记（`CLAUDE.md` 的代码与依赖约束）。
- M0 验证了几处只能靠内部约定的能力：公式收齐（mutation 的 id、执行选项、脏区服务）、`IMAGE()` 的限制（函数服务、函数基类与错误值）、取服务用的注入器（`Univer.__getInjector()`）、身份替换（ADR-009）。
- ADR-003：模块只经公开入口引用；平台页面的包里不能有 Univer。

## 决策

**适配层**（`apps/web/src/editor/`）回答"这份快照在 Univer 里怎么编辑、怎么捕获"，对外只有一个小接口：

```ts
createSheetEditor({ container, snapshot, access, viewState? }): Promise<SheetEditor>   // access：'edit' | 'read'（M2-P3）；viewState（M3-P2）
// SheetEditor：unitId、changeSeq、onChange、lifecycle、onLifecycle、isCellEditing、hasPendingCellInput、
//             onCellEditingChange、commitCellEditing、settleFormulas、capture、viewState（M3-P2）、dispose
```

- `createSheetEditor` 在工作簿创建、渲染完成、主线程与公式 Worker 的 `IMAGE()` 限制都装好之后才返回；任何一步失败（包括创建 Univer、注册插件）都按相反的顺序销毁已经创建的一切并抛出（每创建一样就登记它的销毁，一项销毁出错不妨碍其余各项；加载的各个阶段失败抛 `SheetEditorLoadError`，带原因，其余意外的错误原样抛出），页面显示"编辑器加载失败"。
- 就绪之前（`createSheetEditor` 返回之前）不允许编辑，由编辑器页的交互屏障保证：载入期间，页头之外的用户输入（点击、悬停、键入、输入法、粘贴与拖放）在窗口的捕获阶段一律拦下，包括 Univer 挂在 `document.body` 下的浮层（批注、链接等）；浏览器的刷新（F5、Ctrl+F5、Ctrl/Cmd+R）与 Tab 由浏览器照常处理，但同样不传给 SDK：它的快捷键也挂在窗口上，Ctrl/Cmd+R 是"向右填充"、Tab 是"选区右移"（Codex 评审 CX1，独立复验 N1、S2，第二轮复验）。
  - 不能用 `setEditable(false)` 兜底：SDK 在 Ready 时、用户变化时按授权服务初始化权限点，能编辑时编辑器身份一律允许（ADR-009），更早设的不可编辑会被改回来。只读的文档从 M2-P3 起在创建时决定（`access`）：授权服务按它回答，只读守卫在创建工作簿之前装上防火墙与撤销拦截，就绪之前同样改不动（ADR-015）；`setEditable` 已去掉。
  - 不用 `inert`：它让 Univer 初始化时的聚焦失败，就绪之后键入进不去。
- 单元格编辑器里还没提交的输入（`hasPendingCellInput`）用 Facade 的 `SheetEditStarted`、`SheetEditChanging`、`SheetEditEnded` 跟踪（`cell-editing-watch.ts`）：键入字符或退格开始编辑、编辑中的内容改动之后算有输入，只是打开（双击、F2、点编辑栏）不算；回车提交之后等这次的写入（变更检测记下的修改）再清掉，值没变时最多等 500 毫秒；页头据此显示"有未保存的修改"（Codex 评审 CX6，独立复验 S1）。`commitCellEditing` 返回时这次的提交已经写进工作簿：跨工作表的提交在 SDK 里先切表再写入，它等单元格编辑的跟踪认出写入（`settled`）再返回，保存的捕获里才有这次的提交（第二轮复验）。离开提示仍按"单元格编辑器开着"（`isCellEditing`）判断。
- 结构：`profile/`（插件档案 `sheet@1`：插件、顺序、影响数据的配置、声明的资源、语言包、样式、菜单配置（按 `access`）、入口守卫）、`identity/`（ADR-009）、`read-only/`（只读守卫，ADR-015）、`change-tracking/`（变更检测与公式收齐）、`cell-editing-watch.ts`（单元格里还没提交的输入）、`image-function/`（`IMAGE()` 的限制与 Worker 的回报）、`workers/`（公式 Worker 的入口）、`internal-api/`、`testing/`（E2E 的探针，只在测试构建里，ADR-015）。
- 公式 Worker 由适配层用静态的 `new Worker(new URL(…), { type: 'module' })` 创建（同源脚本，不内联成 blob），由适配层终止。
- 请求、保存状态与界面属于编辑器页（`features/sheet-editor`），不在适配层里；保存的状态机不依赖 Univer，用假的编辑器做单元测试。

**内部 API 的登记**：
- Facade 之外的 SDK 符号只能经 `internal-api/` 引用；`internal-api/registry.ts` 逐项写明用途、M0 的证据与回归用例，单元测试核对"导出的每一项都已登记"。M1 登记 10 项：注入器、公式协议（mutation id 与执行选项）、`IAuthzIoService`、`LifecycleService`、`BaseFunction`、`BaseValueObject`、`ErrorType`、`ErrorValueObject`、`IFunctionService`、`IActiveDirtyManagerService`。M2-P3 加 17 项（只读，ADR-015）：`IPermissionService`、`IUndoRedoService`、`getAllWorksheetPermissionPoint`、`getAllWorksheetPermissionPointByPointPanel`、`WorksheetViewPermission`、`WorksheetCopyPermission`、`WorkbookViewPermission`、`WorkbookCopyPermission`、`IDrawingManagerService`、`IEditorService`、`IContextService`、`FOCUSING_FX_BAR_EDITOR`、`DOCS_FORMULA_BAR_EDITOR_UNIT_ID_KEY`、`IRenderManagerService`、`HeaderFreezeRenderController`，以及 SDK 的两个 DOM 标记（`NOTE_TEXTAREA_SELECTOR`、`FORMULA_BAR_INPUT_SELECTOR`，`internal-api/dom-markers.ts`：不是公开 API，由 E2E 回归）。M2-P6 第 4 片复核加 `IShortcutService`（只给测试构建的探针读快捷键清单）。登记项另有 `sdk` 字段，列出封装用到的 SDK 符号；登记表的自测扫描 internal-api 下每个文件对 `@univerjs/*` 的引用（出口之外的文件引用的符号必须列在它实现的那一项里，列了不用的报过时，从 `index.ts` 走得到的文件不许引用界面的包），新增文件要加进 `registry.test.ts` 的 `SOURCES`：tools 的测试递归列出 internal-api 下的文件、与 `SOURCES` 双向比对，扫描又与"从两个出口顺着引用走得到的文件"互相核对。internal-api 里文件之间只认 `./<文件名>` 的引用（不建子目录），不用动态 `import()`（lint）；界面的包包括它们的子路径（`/facade` 等）；从 `index.ts` 走得到的文件连只用类型也不许引界面的包（与两个出口的分工一致；只写行内 `type` 的导入实测会让公式 Worker 从 677.4 KiB 涨到 921.0 KiB）。
- lint：受限符号清单（按包与导入名，含命名空间导入、再导出与 `import type`）与取注入器的写法（`__getInjector()` 与私有字段 `_injector`：点号访问、解构，以及这两个名字的字符串与不带插值的模板字符串，即方括号访问、字符串的键、`Reflect.get`），在 `internal-api/` 之外一律报错；类型里的 `import('@univerjs/…')` 在编辑器之外与编辑器里都报错，编辑器里的类型用 `import type`；依赖一律按包名引用，`node_modules` 里的路径报错（它绕得过按包名的限制）；三斜杠引用、`import x = require()` 与 `import.meta.glob` 一律报错，`@univerjs/*` 的包名不能带查询串与片段，任何包名都不能写成大写（`@UniverJS/…` 在不区分大小写的文件系统上照常构建，按包名的限制却认不出）。lint 看不出来、由审查保证的写法：变量作键、字符串拼接、带插值的模板字符串；方括号访问其他私有字段（`_commandService`、`_workbook` 等）；按值找注入器（`Object.values(…).find(v => v instanceof Injector)`）、按键名的前后缀查找；`import.meta.resolve`。Worker 脚本若按地址指向依赖里的文件，由 `budgets` 门禁发现（没有预算的 Worker 报违规）；`@univerjs/*` 只引用包入口、`/facade`、`/locale/<语言>` 与 `/lib/index.css`（深层路径绕得过按导入名的限制）；编辑器里的 `@univerjs/*` 只用静态导入。**值引用是白名单**（M2-P6 第 4 片复核：受限符号清单是黑名单，没登记的新内部符号照样引得进来）：编辑器里 `internal-api/` 与测试代码之外，对 `@univerjs/*` 的值引用只允许 `UNIVER_PUBLIC_VALUES` 按导入源列出的公开符号（插件类、`Univer`、`FUniver`、几个枚举、`mergeLocales`、`defaultTheme`；`/locale/<语言>` 只许默认导出；没列出的导入源任何值都不许），类型引用与副作用导入照常；受限符号清单照旧，连类型一起拦。测试代码不受白名单限制（要构造拦截器、公式值对象这类 SDK 对象），受限清单照常。`editor/testing/**`（E2E 的探针）在非测试代码里只能经动态 `import()` 引入，静态导入、`import type`、再导出都报错。internal-api 之外（测试代码也一样）只能引用 `internal-api/index.ts` 与 `ui.ts`（`nerve/editor-internal-api-exits`，按解析之后的路径；目录名大小写不同的写法由类型检查的 TS1149 拦下）。lint 看不出来、由审查保证的还有：Facade 方法返回的 SDK 内部对象（例如 `FWorkbook.getWorkbook()`）之后的调用；没登记的内部类型 `import type` 之后配合类型断言调用；测试代码里不在受限清单上的内部值；探针的动态引入在哪个分支、条件对不对；路径文字以外的写法（软链接、别名，仓库目前没有）；类型里的 `import('…/internal-api/x.ts')`。lint 有自测。

**模块边界**：只有编辑器页的入口与 `features/sheet-editor` 能引用适配层（只经 `index.ts`）；`features/sheet-editor` 只由编辑器页的入口引用；平台的应用层、其他入口与其他功能都不引用它。门禁 `budgets` 另外兜底（平台页面的预算没有因为编辑器变大）。

## 备选方案与取舍

| 方案 | 结论 | 原因 |
|---|---|---|
| A. 适配层加内部 API 的出口（数据的包 `index.ts`、界面的包 `ui.ts`）与登记表，lint 强制 | 采用 | 升级 SDK 时知道要回归哪些内部约定；平台代码不会悄悄依赖 SDK 的内部 |
| B. 需要时各处直接引用内部符号 | 否决 | 散落各处，升级时找不全；违反计划书 §10 |
| C. 只用 Facade，放弃公式收齐与 `IMAGE()` 的限制 | 否决 | 显式保存的快照里公式结果不一致（US-M1-05），外链的 `IMAGE()` 会发请求（被 CSP 拦下但出现违规，计划书 §11.3） |

## 影响

- 升级 SDK 或调整档案时：先跑登记表里的回归用例与 E2E（模板收敛、公式收齐、`IMAGE()`、入口守卫），再用 `pnpm --filter @nerve-office/e2e run update:sheet-template` 更新模板（ADR-011）。
- 新增内部依赖：先在 `internal-api/` 封装并登记（`internal-api/` 之外的值引用已由白名单拦下）；要连类型一起拦，补进受限符号清单与自测。新用到公开的值，加进 `UNIVER_PUBLIC_VALUES` 并补自测。
- M3（捕获时机、打开自检）、M4（Worker 重建、发件箱）、M5（图片与超链接的入口）都在适配层内扩展，对外的接口按需加法。

## M3-P2 的补充

- **视图状态**（阅读与编辑一律重建，ADR-015 的修订）：`SheetEditor.viewState()` 取出当前工作表、主视口左上角可见的行列（含冻结的口径）与主选区；`createSheetEditor` 的可选 `viewState` 在就绪之后恢复。全部经公开的 Facade（`FWorkbook`、`FWorksheet`、`FRange` 的方法与 sheets-ui 补进的滚动方法），不用内部 API；恢复的都是操作（`SetWorksheetActiveOperation`、`SetSelectionsOperation`、滚动），只读时照常。取不出来、工作表不在了或选区超出范围就跳过那一项（回到默认视图），Facade 意外出错时上报、编辑器照常可用。编辑器的容器带 `data-editor-access`（`read`、`edit`）。
- **内部 API 加 2 项**（只读守卫，ADR-015 决策第 9 条与第 5 条）：`HeaderResizeRenderController`（DEF-027：在它的拦截点上注册总是不允许的拦截器）、`FIND_ADVANCED_LINK_SELECTOR`（DEF-028：查找面板里"高级查找"那一块的 DOM 标记）。登记表、lint 的受限符号与自测同步。
- **入口守卫按参数判断**（DEF-035 的旁支）：`isGuardedCommand(id, params)`——清单里的命令按 id 取消；`doc.command.inner-paste` 带图片（`doc.drawings` 有项，或正文有图片的锚点 `customBlocks`；看不懂的参数按带图片算）时取消：编辑栏在编辑时粘贴图片文件或带 `<img>` 的 HTML，会把图片写进单元格。整次粘贴取消（参数由 SDK 组装，改写它要依赖它的结构），M5 开放图片时重新评估。
- **测试构建**：`testing/` 加真实 Safari 的页面自检（`selftest.ts`、`selftest-dom.ts`，由编辑器页的挂接在测试构建、地址带 `selftest` 时动态引入）与四份和 E2E、驱动脚本共用的文件（`read-only-entries.ts`、`content-compare.ts`、`selftest-report.ts`、`switch-timing.ts`，不引用任何模块，lint 的 `SELFTEST_SHARED_FILES`）；入口页 `selftest.html` 只在测试构建里（自给自足，ADR-008）。**生产构建里没有它们由门禁 `artifacts` 按模块来源核对**（审查 B2）：构建插件 `apps/web/build/module-sources.ts` 写出 `.vite/module-sources.json`（每个脚本由哪些模块组成，主构建与公式 Worker 都记；作为元数据不扫描、`.vite/` 不对外托管），来源在 `src/editor/testing/`、`src/entries/selftest/`、`src/entries/csp-probe/`、`features/sheet-editor/selftest-hook.ts`、`selftest.html`、`csp-probe.html` 的模块一律算测试专用——分块改名、被并进别的分块、被生产代码直接动态引入都认得出（`artifacts/test-only-source`）；产物里有清单没记下的脚本、没有清单都报错（`artifacts/unlisted-script`、`artifacts/missing-module-sources`）；分块名与禁用关键字（`__nerveEditorProbe`、自检结果的格式标识、`__nerveSwitchTiming`）作兜底。

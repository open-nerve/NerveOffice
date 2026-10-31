# ADR-010：编辑器适配层与内部 API 登记

> 状态：已接受｜日期：2026-09-27｜来源：M1-P4｜修订：2026-09-28，M1 对抗评审（Codex CX1、CX6）与独立复验（N1、S1）之后，就绪之前的输入由编辑器页的交互屏障拦下，另外跟踪单元格里还没提交的输入；2026-09-29，M2-P3 能不能编辑在创建时决定（`access`），只读守卫与只读的界面，内部 API 加 17 项、拆出界面包的第二个出口 `ui.ts`，测试构建的探针（ADR-015）；2026-10-01，M2-P6 第 4 片复核：`@univerjs/*` 的值引用改为白名单，探针只能动态引入，内部 API 加 `IShortcutService`（只给测试构建的探针）；internal-api 之外只能经两个出口引用，登记表扫描 internal-api 的全部文件；2026-10-04，M3-P2：视图状态（`viewState`），内部 API 加 2 项（行列调整的控制器、查找面板的 DOM 标记），入口守卫按参数取消带图片的粘贴，测试构建加真实 Safari 的页面自检；2026-10-05，M3-P3：写入之前改写链接（`CELL_LINK_PROTOCOL`），档案的资源规则与平台图片地址改由 contracts 提供；2026-10-09，M3 合并前评审（Codex CX4）：还没写进模型的输入合成一个状态（`uncommittedInput`），`SheetEditor` 去掉 `hasPendingCellInput`、`onCellEditingChange`

## 背景

- 00 号计划书 §10：Univer 集中在编辑器适配层；插件档案是数据；优先用公开的稳定 API，用到内部 API 时集中封装并登记（`CLAUDE.md` 的代码与依赖约束）。
- M0 验证了几处只能靠内部约定的能力：公式收齐（mutation 的 id、执行选项、脏区服务）、`IMAGE()` 的限制（函数服务、函数基类与错误值）、取服务用的注入器（`Univer.__getInjector()`）、身份替换（ADR-009）。
- ADR-003：模块只经公开入口引用；平台页面的包里不能有 Univer。

## 决策

**适配层**（`apps/web/src/editor/`）回答"这份快照在 Univer 里怎么编辑、怎么捕获"，对外只有一个小接口：

```ts
createSheetEditor({ container, snapshot, access, viewState? }): Promise<SheetEditor>   // access：'edit' | 'read'（M2-P3）；viewState（M3-P2）
// SheetEditor：unitId、changeSeq、onChange、lifecycle、onLifecycle、isCellEditing、uncommittedInput、
//             onUncommittedInputChange（M3 合并前评审 CX4）、commitCellEditing、settleFormulas、capture、viewState（M3-P2）、dispose
```

- `createSheetEditor` 在工作簿创建、渲染完成、主线程与公式 Worker 的 `IMAGE()` 限制都装好之后才返回；任何一步失败（包括创建 Univer、注册插件）都按相反的顺序销毁已经创建的一切并抛出（每创建一样就登记它的销毁，一项销毁出错不妨碍其余各项；加载的各个阶段失败抛 `SheetEditorLoadError`，带原因，其余意外的错误原样抛出），页面显示"编辑器加载失败"。
- 就绪之前（`createSheetEditor` 返回之前）不允许编辑，由编辑器页的交互屏障保证：载入期间，页头之外的用户输入（点击、悬停、键入、输入法、粘贴与拖放）在窗口的捕获阶段一律拦下，包括 Univer 挂在 `document.body` 下的浮层（批注、链接等）；浏览器的刷新（F5、Ctrl+F5、Ctrl/Cmd+R）与 Tab 由浏览器照常处理，但同样不传给 SDK：它的快捷键也挂在窗口上，Ctrl/Cmd+R 是"向右填充"、Tab 是"选区右移"（Codex 评审 CX1，独立复验 N1、S2，第二轮复验）。
  - 不能用 `setEditable(false)` 兜底：SDK 在 Ready 时、用户变化时按授权服务初始化权限点，能编辑时编辑器身份一律允许（ADR-009），更早设的不可编辑会被改回来。只读的文档从 M2-P3 起在创建时决定（`access`）：授权服务按它回答，只读守卫在创建工作簿之前装上防火墙与撤销拦截，就绪之前同样改不动（ADR-015）；`setEditable` 已去掉。
  - 不用 `inert`：它让 Univer 初始化时的聚焦失败，就绪之后键入进不去。
- 单元格编辑器里还没提交的输入（`hasPendingCellInput`）用 Facade 的 `SheetEditStarted`、`SheetEditChanging`、`SheetEditEnded` 跟踪（`cell-editing-watch.ts`）：键入字符或退格开始编辑、编辑中的内容改动之后算有输入，只是打开（双击、F2、点编辑栏）不算；回车提交之后等这次的写入（变更检测记下的修改）再清掉，值没变时最多等 500 毫秒；页头据此显示"有未保存的修改"（Codex 评审 CX6，独立复验 S1）。`commitCellEditing` 返回时这次的提交已经写进工作簿：跨工作表的提交在 SDK 里先切表再写入，它等单元格编辑的跟踪认出写入（`settled`）再返回，保存的捕获里才有这次的提交（第二轮复验）。离开提示仍按"单元格编辑器开着"判断。M3 合并前评审（CX4）起，它与面板防抖中的输入合成一个状态 `uncommittedInput`（`uncommitted-input.ts`：`pending` 有还没写进模型的输入、`open` 单元格编辑器只是打开、`none`），保存的状态机只依赖它：`pending` 算有未保存的修改，离开提示另把 `open` 算上（原来按 `isCellEditing` 判断的保守做法照旧，改由适配层给出）；`pending` 的开始与结束各通知一次（`onUncommittedInputChange`）。`isCellEditing` 只给提交与捕获的准备用。
- 结构：`profile/`（插件档案 `sheet@1`：插件、顺序、影响数据的配置、声明的资源、语言包、样式、菜单配置（按 `access`）、入口守卫）、`identity/`（ADR-009）、`read-only/`（只读守卫，ADR-015）、`change-tracking/`（变更检测与公式收齐）、`cell-editing-watch.ts`（单元格里还没提交的输入）、`uncommitted-input.ts`（还没写进模型的输入：单元格编辑器与面板的防抖合成一个状态，M3 合并前评审 CX4）、`image-function/`（`IMAGE()` 的限制与 Worker 的回报）、`workers/`（公式 Worker 的入口）、`internal-api/`、`testing/`（E2E 的探针，只在测试构建里，ADR-015）。
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
- **测试构建**：`testing/` 加真实 Safari 的页面自检（`selftest.ts`、`selftest-dom.ts`，由编辑器页的挂接在测试构建、地址带 `selftest` 时动态引入）与四份和 E2E、驱动脚本共用的文件（`read-only-entries.ts`、`content-compare.ts`、`selftest-report.ts`、`switch-timing.ts`，不引用任何模块——静态与动态的 `import()` 都不许，lint 的 `SELFTEST_SHARED_FILES`，复验 C3）；入口页 `selftest.html` 只在测试构建里（自给自足，ADR-008）。**生产构建里没有它们由门禁 `artifacts` 按模块来源核对**（审查 B2）：构建插件 `apps/web/build/module-sources.ts` 写出 `.vite/module-sources.json`（每个脚本由哪些模块组成，主构建与公式 Worker 都记；作为元数据不扫描、`.vite/` 不对外托管），来源在 `src/editor/testing/`、`src/entries/selftest/`、`src/entries/csp-probe/`、`features/sheet-editor/selftest-hook.ts`、`selftest.html`、`csp-probe.html` 的模块一律算测试专用——分块改名、被并进别的分块、被生产代码直接动态引入都认得出（`artifacts/test-only-source`）；产物里有清单没记下的脚本、没有清单都报错（`artifacts/unlisted-script`、`artifacts/missing-module-sources`）；分块名与禁用关键字（`__nerveEditorProbe`、自检结果的格式标识、`__nerveSwitchTiming`）作兜底。

## M3-P3 的补充

- **写入之前改写链接**（DEF-021，`editor/profile/link-policy.ts`）：订阅 Facade 的 `BeforeCommandExecute`，只处理 `sheet.mutation.set-range-values`，带 `p.body.customRanges` 的单元格交给 contracts 的 `normalizeCellLinks` 就地改写（规范写法；不合法的去掉链接、保留文字；`mailto://` 修成 `mailto:`）。它覆盖键入、选中单元格粘贴纯文本、单元格编辑器里粘贴、粘贴 HTML、编辑栏里键入与粘贴纯文本，以及 `HYPERLINK()` 公式的结果——这些路径都汇合到这一条 mutation。公式结果（`fromFormula`）里 SDK 每次计算随机生成的 `rangeId` 与 `paragraphId` 换成由单元格位置与序号确定的值（`formula-<行>-<列>-<k>`、`para_formula-<行>-<列>-<j>`），重算不改变内容，"内容相同不递增"对含 `HYPERLINK()` 的表格同样成立。改写器绝不抛出（Facade 的派发没有 try/catch），装在入口守卫之后、`createWorkbook` 之前，阅读与编辑都装。
- **内部约定的登记**：`CELL_LINK_PROTOCOL`（`internal-api/cell-links.ts`：`SetRangeValuesMutation.id`、`CustomRangeType.HYPERLINK`、`fromFormula`）；"参数与处理器、撤销栈是同一个对象"的约定（M0-P5 的 C7c 与 M3-P3 的探针）；SDK 自动识别的各种写法；引用区域变化时的 `update-rich-hyper-link` 不经这条 mutation，它写的是 `#gid=…`，本来就是规范写法；链接区间的 `startIndex`、`endIndex` 都含在内（单元格编辑器里粘贴多行时 `normalizeCellLinks` 改用区间覆盖的文字修复地址，依赖这一条；SDK 改了含义时修复静默失效——链接被去掉、文字还在，回归是 `links.spec.ts` 的 G3，审查 B9）。lint 的受限符号加 `CustomRangeType`；E2E 探针暴露页面里打包的 `canonicalLink`（跨引擎用例与性质检验在三个浏览器里跑，审查 B4），E2E 的模块边界只给 contracts 的 `link-address.test-support.ts` 开口。回归：`links.spec.ts` 的六条路径与撤销重做——SDK 升级之后如果改成复制参数，改写会静默失效，这组 E2E 先失败；服务端的检查是最终防线。
- **档案的资源规则**改由 contracts 提供（`profile-resources.ts`），web 的档案引用它、类型上按名字核对；平台图片地址的判定移到 contracts（`asset-address.ts`），`IMAGE()` 的限制与服务端的图片规则共用。
- **相对地址解析用的占位源** `https://relative-link.invalid` 随改写器进编辑器的产物，登记在门禁 `artifacts` 的 `allowedAddresses`（只用来解析与比较来源，不发请求）。

## M3-P4 的补充

- **销毁之后不抛错的语言服务**（main `f755729`，P3 合并之后 CI 的修复）：sheets-formula 的 `TriggerCalculationController` 在一轮计算开始时起 1 秒的进度计时器、销毁时不清，到点调语言服务的 `t()`；SDK 的 `LocaleService` 销毁时清空语言包、之后 `t()` 一律抛错。阅读与编辑之间一律重建，旧的编辑器在这 1 秒里销毁时，到点就是一条没接住的页面异常（打开含公式的表格马上点"编辑"）。`new Univer({ override })` 换上子类 `DisposalSafeLocaleService`：销毁之后（含销毁的过程中）`t()` 交回键本身，销毁之前的行为完全不变；不依赖计时器的时长、不延迟销毁、不接管 `window` 的错误事件。登记 `disposalSafeLocaleOverride`（依赖的三条 SDK 行为与 1.0.1 的证据在 `registry.ts`），lint 的受限符号加 `LocaleService`；回归：`edit-mode.spec.ts` 的"阅读时一轮计算刚开始就点'编辑'"（修之前三个浏览器各 5 次全部失败）。同一次审计找到的、不经语言服务的晚到回调与泄漏登记 DEF-056–058，上游草稿随 P4 收尾。
- **资源守卫**（打开自检，P4 设计 §3.11）：`new Univer({ override })` 以 `useFactory`（`deps: [ILogService]`）换上 `ResourceManagerService` 的子类，只覆盖 `registerPluginResource`，显式委托地包装 `parseJson`、`onLoad`（只观察、原样抛出与返回，剩余参数原样传——sheets-drawing 的 `toJson` 有第二个参数），记下 `parse-threw`（只算非空的输入）、`parse-swallowed`、`load-threw` 与异常的构造器名（不记 message），另给出表格 hook 的名字与逐个 hook 的 `toJson`。资源管理服务在注入器创建时就被资源加载服务取走，这是唯一的注入点。登记 `createResourceLoadGuard`（七条依赖的约定与 1.0.1 的证据在 `registry.ts`）；lint 的受限符号加 `ILogService`、`IResourceHook`、`IResourceManagerService`、`ResourceManagerService`。判定在 `profile/open-check.ts`（不依赖 Univer）；`SheetEditor.openCheck` 在 `createSheetEditor` 返回时就定（`createWorkbook()` 刚返回时与就绪之后两次核对合起来）。适配层只报告，能不能编辑由编辑器页决定（ADR-015 不变）；只有资源守卫没有生效（SDK 改了创建方式）时按"编辑器加载失败"。
- **测试构建的档案故障开关**（`editor/testing/profile-fault.ts`）：地址参数 `profileFault=<组>`（可以带好几个）不注册指定的插件组，组名 `core`、`numfmt`、`formula`、`drawing`、`cf`、`filter`、`hyperlink`、`dv`、`find-replace`、`note`、`sort`，认不出的组名让编辑器加载失败；只给 US-M3-15 的"档案不全"用例（`@test-build`）。门禁 `artifacts` 按来源认出、生产构建里没有。探针加 `openCheck`。
- **测试构建的交接日志**（M3-P5 S8，`editor/testing/handover-log.ts`）：`window.__nerveHandoverLog` 记下交接的各步与时刻（事件类型在 `features/sheet-editor/handover-trace.ts`），真实 Safari 的两个标签页复核与 E2E 用；不引用任何模块（`SELFTEST_SHARED_FILES`），组装处只在测试构建里动态引入，门禁按来源、分块名与关键字认出。
- **测试构建的模块没引入成**（M3-P5 收尾 E1）：编辑器里测试构建的模块（档案故障、公式模式、探针）经 `sheet-editor.ts` 的 `importTesting` 引入，没引入成（多半是整页跳转取消了加载）按编辑器建不起来处理，`SheetEditorLoadError` 的原因 `testing-module-failed`；页面在开始离开之后不上报编辑器的加载失败（`features/sheet-editor/start.tsx` 的 `loadFailureReporter`）。
- **主线程公式模式**（M3-P4 S1，测试构建的地址参数 `formula=main`）：档案按 `FormulaExecution` 组合——生产用公式 Worker；主线程是同一份档案的变体（不注册 RPC、三处 `notExecuteFormula` 为假、`UniverFormulaEnginePlugin({ intervalCount: 20 })`，M4 的退路），档案标识不变；测试构建的开关在 `editor/testing/formula-mode.ts`，门禁 `artifacts` 按来源认出。S1 核实的内部行为：主线程模式下实例在一轮计算中被销毁时，运行时把停止标记复位、旧循环在让出点之后接着跑，语法树退成 `#NAME?` 节点写进 engine-formula 模块级的语法树缓存（页内所有实例共用，键含 unitId），重建之后的编辑器命中它；规避（P4 S5，`editor/formula-round-stop.ts`）：主线程模式下销毁之前，有一轮在算就先执行停止的 mutation（`onlyLocal`）、等这一轮结束的通知再销毁，时限 30 秒、到时限照样销毁并报页面错误；`SheetEditor.dispose` 因此交回 Promise，编辑器槽位在新建之前等上一次销毁完。`FORMULA_PROTOCOL` 的登记补上约定"停止标记只在让出点检查、销毁时被复位、Worker 模式不需要"与 1.0.1 的证据。Worker 模式不受影响。M4 把主线程模式变成生产的退路时必须保留这条规避。
- **捕获时机的接线**（M3-P4 S4）：`SheetEditor` 加公式进度（`onFormulaProgress`）、组合输入（`composing`、`onCompositionChange`——只认 DOM 事件，在 document 的捕获阶段、页头以外，不认 SDK 的 DOM 标记，批注的输入框也盖得到）与面板的防抖（`settlePanels`，登记 `PANEL_DEBOUNCES`：批注浮层 300 ms、数据验证详情面板 1 秒，两者卸载时都不清、不 flush；M3 合并前评审 CX4 起另交出"防抖中"的状态与开始、到点的通知，并进 `uncommittedInput`，`settlePanels` 等调用这一刻的到点、只给捕获之前的等待用）。进入编辑时带"公式待更新"的文档以公开配置 `UniverSheetsFormulaPlugin({ initialFormulaComputing: CalculationMode.FORCED })` 创建（白名单加 `CalculationMode`）；收齐的跟踪器加兜底：没看到带 `forceCalculation === true` 的触发命令之前不算收齐（`FORMULA_PROTOCOL.forceCalculationParam`，`FormulaProgress.awaitingForcedRound`）。**DEF-020 的结论**：变更检测、公式收齐与捕获时机不按 `trigger` 区分来源——变更检测只看类型、执行选项、`unitId` 与排除名单；收齐判断调用 SDK 的 `shouldTrigger` 时读的是同一个 params 对象，`trigger` 被串改不会让两边不一致；回归在 `change-classifier`、`formula-settle-tracker`、`calculation-trigger` 的单元测试。测试构建的自动保存控制在 `editor/testing/autosave-control.ts`（`window.__nerveAutosaveControl`），门禁按来源认出。
- **编辑器适配层引用的 contracts 模块不能带 zod 的结构**：适配层引用带 zod 结构的模块时，构建把 zod 与 contracts 的几个模块拆进一个新的共享分块，它在 `zod-jitless` 之前执行，三个浏览器的编辑器页都出现一条 eval 的 CSP 违规。打开自检的失败种类与写法因此放在不引用 zod 的 `open-check-failures.ts`，请求体的结构（`open-check.ts`）只给服务端。

## M4-P5 S1 的补充：公式执行模式与 Worker 故障事实（2026-10-16）

`createSheetEditor` 接受显式 `formulaMode: 'worker' | 'main-thread'`，不给时生产仍默认 Worker。显式选择优先于测试构建的查询参数，生产不会载入测试模式开关。主线程沿用同一档案、相同 IMAGE 限制与内存存储覆盖；计算中先停下再销毁的 30 秒规避不变。

返回的 `SheetEditor` 增加 `formulaMode`、`workerFailure()` 与 `onWorkerFailure(listener)`。后两者是首错 getter 和不回放的通知；调用方先订阅、再读 getter，避免漏掉接线前的故障。`FormulaWorkerError` 是既有 `SheetEditorLoadError` 的子类，只新增有限 `failure` 分类；构造抛错、握手前后 error/messageerror、Worker IMAGE 安装失败及 20 秒握手超时可区分，浏览器不能证明的加载/脚本原因不再细分。主线程 IMAGE 与渲染失败保留原普通错误。

`worker-image-policy.ts` 的监听活到实例销毁，首错之后的回报不能覆盖结果；握手成功不代表整个编辑器已渲染，挂载等待同时观察运行期错误，不能将这段间隙的 Worker 故障误报成渲染超时。所有退出都清理启动期限与监听；捕获调用方看到的公式收齐状态在 Worker 失败后为 false，公式进度订阅也会获知变化。只接住自身 Worker 的错误事件，不添加全局异常忽略。

此处是 P5 的基础接口；保存入口由下面的 S2 接线，页面重建、页头与诊断仍在后续 Step。S1 本身不宣称自动退化已完成，不修改保存协议或重新申请编辑权。

## M4-P5 S2 的补充：替换实例时保留保存会话（2026-10-16）

`features/sheet-editor/saving-editor.ts` 只拥有保存层订阅，不拥有 SDK。`EditingSession.startSaving` 创建稳定入口，原保存协调器、自动保存与本机保存视图始终引用它；替换具体实例不重建草稿、锁或租约。旧实例的逻辑修改序号在重新绑定时保留，新实例后续修改按偏移继续计数，不用公式计算伪造用户修改。

输入全部落入模型后才允许冻结：无组字、无打开的单元格编辑器、无未提交输入。捕获成功才释放旧实例订阅；冻结期间读固定快照，公式未收齐，排队保存不能读取已销毁模型。旧回调由绑定代次隔离，旧公式等待结束时重看当前实例状态；SDK 的创建、销毁和打开自检仍由页面与槽位负责。

`Autosave.captureForFormulaRecovery()` 沿原同步捕获路径登记 `formulasPending: true`，可在挂起调度时调用。`SaveCoordinator.noteFormulaRecovery(ref)` 使用原 WorkingDraft 的 sessionId/serial 建立确认边界：只有同会话、更晚 serial、公式已收齐的捕获获确认或通过原摘要去重，才能清掉待更新状态；旧 ACK、未知请求重放与认领都不能清它。最近边界在确认后保留，重复或更早登记也不会重新标脏。无新增持久序号、请求字段或正文来源。

`EditingSession.captureEditor/freezeEditor/replaceEditor` 供 S3 使用。冻结捕获失败时回到旧源；失去原租约、本机锁或本人会话后拒绝接纳新实例。停止自动捕获后仍可读取冻结正文，结束保存后才释放绑定；来源转交的原所有权规则不变。这一步尚未使页面自动重建，不能当作整个 US-M4-13 的验收。

## M4-P5 S3 的补充：页面组织公式恢复（2026-10-16）

`formula-fallback` 包装原创建工厂，只有结构化 Worker 故障才选择本页主线程偏好并以同一内容重试一次，后续打开保持强制重算。`formula-recovery` 只组织输入等待、冻结、槽位替换、自检和资格检查，不申请编辑权，不创建第二份草稿。槽位新增按待接纳实例身份比对的 discard，迟到结果不得清空后来任务。

自动保存分别登记已有输入准备与 HTTP；恢复先等待前者，避免旧提交 await 后读到新实例面板，不等待网络。组合输入结束后才挂完整屏障，提交单元格、等待面板各自结束后都复核资格。冻结之后失败继续保留完整正文；新实例通过自检、原页面代次/账户/协调器/调度/租约/本机锁检查后，才在同步段绑定并接纳。

保存、退出、交出、接管、刷新及确认后的续行按恢复状态受控；实际标签页回应原 busy 消息，不增加协议状态。失权通过稳定 captureEditor 取正文，换人、pagehide 和销毁优先。初次主线程退路进入编辑时登记公式补存，零用户修改也能清掉待更新标记；旧请求和 ACK 沿 S2 规则收尾。S4 继续页头和诊断接线，S5 验证真实浏览器与生产快照，S3 的单元与构建结果不能代替 A18。

## M4-P5 S4 的补充：恢复说明与有限诊断（2026-10-17）

沿原 `POST /documents/:id/open-check-failures` 兼容旧报告，新增严格的 `kind: formula-worker` 变体。只有 S1 七种 failure、revision/access/trigger 与四项页面构建/格式元数据；不接收正文、公式、资源内容、Worker URL 或异常原文。Worker 枚举放在 contracts 的无 Zod 事实模块，适配层继续导出同一类型；浏览器构建器不引入 schema 的求值。

服务端先按原只读事务校验可读权限，再与资源自检共用去重和每账户 10 分钟 20 条配额，保持 10,000 键上限。日志 event 为 `formula-worker-failed`，只说页面尝试改用主线程，不宣称已恢复或禁止编辑；旧 event 与旧请求体兼容。不落库、不记审计，后台请求仍受会话、CSRF、Origin 与体积限制。

页面本轮创建显式携带 revision/access/trigger，避免刷新时从旧 shown 误取修订。首错先锁存上报标记，再发一次后台请求，不因网络错误重试或改变恢复流程。运行期与恢复后资源自检分别报告，新增 `formula-recovery` 起因；后者仍阻止不完整模型进入保存。

页头单独说明等待输入、重建、暂停、失败和主线程成功。失败时同一页面有明确重试，当前会话、模式与保存终态限制动作；重建本身不要求联网。公式、云端保存、本机保存的读屏事实独立记忆。按钮、既有接管/放弃本机修改确认框按 S3 恢复状态保护，取消和会话/失权出口保持可用。此步通过单元/相关集成与原构建门槛，真实浏览器、生产快照和性能仍由 S5 验收。

## M4-P4 的补充：SDK 偏好按编辑器实例留在内存（2026-10-14）

`editor/internal-api/memory-local-storage.ts` 实现锁定 SDK 的 `ILocalStorageService` 全部异步接口，每个注入器独立 Map，读、写和遍历克隆值；销毁清空，迟到写入不能复活数据。内部 API 登记、统一出口及 lint 限制同时更新，平台功能不引用 SDK。

覆盖必须传给实际注册服务的 `UniverUIPlugin` 的 `override` 配置。核心 `Univer` 的 override 只替换该层声明的依赖，把这个 token 放在那里不会替换 UI 服务。实际 Render/UI 档案测试核对阅读/编辑实例隔离，真实浏览器通过数字格式界面核对当前实例偏好、重建后不继承、旧库/键不再新增。

SDK 模块加载仍会打开模块私有的 `UniverLocalStorage/kv`（v1）连接，`Univer.dispose()` 不能关闭它，因此不能承诺数据库永不出现或保留编辑器时可立即删库。本项目不修改 SDK、不拦截全局 IndexedDB；旧库删除 blocked/超时交回 pending，提示关闭本站编辑器后重试。此空库不承载本项目新写的偏好，也不改变发件箱加密/清理规则。产物门禁继续保证平台和公式 Worker 不因这个实现引入 UI 依赖，原资源预算不扩大。

## M4-P5 S5 的补充：Worker 让出间隔（2026-10-17）

公式 Worker 的 `UniverFormulaEnginePlugin` 显式使用 `intervalCount: 20`，主线程既有 20 保持。独立串行实测在同一 1,020 重型公式样本上比较原默认 500 与 20/50/100，每候选每浏览器 10 轮，共 120 轮；逐轮核对实际进度间隔、计算中 STOP、被停轮无结果和重算正确性。20 的整轮计算中位数相对原默认增加约 0.8%–4.4%，三个浏览器所观察的 stop 最大值分别从 1823.0/1826.8/799.0 ms 降至 13.3/14.6/12.0 ms。选择 20 的依据是停止响应与整轮成本，不是最快单轮。

这些数值只描述本机和该样本；停止计时从第一条实际计算进度后发命令到结束通知，包含消息往返，不代表单个长公式、依赖构建或任意停止时点的上界。完整分布、环境、源码/产物散列和复现入口见 [P5-S5 自审记录](../v0.1/M4-本地优先与离线恢复/reviews/P5-S5-自审记录.md)。

DEF-072 在原间隔 500 与最终间隔 20 分别做计时器 off/on 对照，每种 12 次真实冷热打开。按既有 500 ms 停顿口径，分别从 10/12、7/12 降为 0/12、0/12；每次缓存前提成立。最终采用公式 Worker 入口的 100 ms 空计时器，随 Worker 终止而结束；不修改 SDK、不增加页面消息或持久化状态。这个代价是 Worker 存活期间增加计时唤醒，以避免空闲后首次增量额外约一秒的等待。最终组合另跑三个浏览器各 10 轮，stop 最大值为 15.9/13.2/12.0 ms；整轮中位数为 4134.6/4209.5/1962.0 ms，比早先默认批次高约 8.4%/11.4%/16.3%。这不是同时期交替对照，不能把差值全归因于计时器；上文 0.8%–4.4% 仅属于间隔实验，不能概括最终组合。采用结论接受本次观察到的计算成本，不承诺所有工作簿吞吐或电量收益。

真实 Safari 27.0 的间隔 20 off/on 各三个页面（Worker 冷/热及主线程对照）均通过。Worker 首次额外时长 off=-2/+6 ms、on=+12/-3 ms，本轮未复现基线停顿，结论限于实际浏览器回归；因果改善来自上述两套 WebKit 对照，不将少量 Safari 样本描述成保证。

## M4-P5 S6 的补充：排队恢复前复核组字（2026-10-17）

独立审查 I1 证明：上一轮 `compositionend` 到恢复宏任务之间可能开始下一轮组字。恢复必须在实际任务开始、挂完整输入屏障之前再次读取组字状态；仍在组字就回到原有等待与订阅流程，不提交、捕获或销毁。否则窗口捕获屏障可能吞掉下一轮结束事件，导致冻结失败。此检查不改变保存资源身份，也不引入额外定时器或队列。连续两次重新组字的控制器反例及真实 DOM 屏障反例均已 RED→GREEN，相关 3,166 单元和三个浏览器 21 项回归通过；整 Phase 门禁仍在 S6 验收。

## M4-P5 最终验收（2026-10-17，P6 补录）

上述实现及 I1 修复已随 main `aad47e8d` 验收，本机默认完整门禁、完整生产容器及同 SHA 六项 CI 原件全部通过，DEF-072 已关闭。有限故障契约、Safari 基线未复现、性能样本范围和未覆盖所有原生输入法的限制不变，详见 [P5 交接单](../v0.1/M4-本地优先与离线恢复/handoffs/P5-交接单.md)。

## M5-P2 S3 的补充：图片来源、命令预演和只读名称

IMAGE 包装通过公开 `BaseFunction.calculateAst` 接收实际 AST；`BaseAstNode` 类型和字面量来源识别只经 Worker 安全的 `internal-api/index.ts` 出口。固定节点种类、首参位置及展开前证明标记集中在 `image-formula-source.ts`，实际 Lexer/Parser/Interpreter、定义名称和缓存回归约束它们。新增 SDK 标记及移除条件见 [ADR-022](ADR-022-图片实例与SDK修复.md)。

图片命令协议、两份 drawing 服务的纯 JSON1 预演、目标工作表/单元格读取、结构操作及整条历史预检集中在 `image-commands`、`image-json`、`image-cells`、`image-structure`，经 `ui.ts` 暴露窄的检查能力。输入清洗与命令订阅留在图片/档案层，不向页面导出服务。登记表同时覆盖这些传递依赖，Worker 出口仍不得触达 UI 包。

普通高层写入在生成历史前归一，底层 mutation 只作接受/拒绝。Undo/Redo 的 Facade 通用事件不会触发，必须订阅专属 BeforeUndo/BeforeRedo，在首条 mutation 前检查整条记录；不能等部分执行之后再拒绝。JSON1 仅允许基础操作及已证明为纯的 text-unicode/number 子类型；TextX 原地修改行为不得进入预演。单元格检查仅访问本次目标、命名样式与图片载体，不为每次键入捕获整份快照。

旧坏图片清理在 `image-cleanup.ts` 内绑定当前 workbook、权限、对象版本和一次性确认票据；取消、过期、失败不改数据或清史。成功后仅清该 workbook 的撤销历史，并要求正式入口明确告知不可撤销。分组坏图不在该清理能力范围内。S3 仅建立能力，不开放清理或图片输入入口。

`SheetEditor.sheetName(id)` 是不捕获、不选区、不写模型的只读名称查询，经 EditMode/EditorPage 使用当前实例；销毁、重建、未知工作表及 SDK 非字符串名称返回 undefined。页面共用图片错误格式化器，用后端有界结构位置和本地名称给出说明，SDK 对象与服务端任意内容均不透出。保存、副本及原日志协议保持。


## M5-P3 S2 的补充：正式链接输入与导航

链接使用既有 contracts `canonicalLink`，不新增协议猜测或地址验证请求。适配层在 SDK 表单、四个明确写命令及点击导航三个边界应用同一规则；普通自动识别、粘贴和公式结果继续走既有单元格清洗。四命令标识集中在 `internal-api/link-input.ts`、经 `ui.ts` 导出并登记；拒绝通知使用公开 `FUniver.showMessage`，只显示固定文案，不透出用户地址。

固定 `@univerjs/sheets-hyper-link-ui@1.0.1` 的发布 ES/CJS/声明增加可选 `urlHandler.normalizeUrl`，由 `pnpm patch` 管理，来源、散列与覆盖路径见 `patches/univer-links.json`。桌面/移动表单和纯文本粘贴读取实例配置；resolver 在原协议白名单前规范化，无配置时保持 SDK 原行为。原 `isSafeUrl` 可接受相对路径，但只检查解析后的协议，不能代替平台对凭据、控制字符和协议相对地址的约束。内部工作表/区域/定义名称导航保留 SDK 实现。

首个 Facade 入口监听保持最先安装；只有明确输入策略已安装且实例为 edit 才放行七个链接入口。read 实例仍拦快捷键与写入口，独立只读防火墙继续保护底层修改。销毁时关闭 readiness 并移除策略监听，重建重新安装。合法明确写入只规范地址，保留显示文本；非法输入在 SDK 修改文本、模型和历史之前取消。

固定 SDK 原 Ctrl/Cmd+K 排除活动单元格编辑；`internal-api/link-shortcut.ts` 在 Ready 后用本实例 `IShortcutService` 补原工具栏命令，要求可编辑、策略就绪、正常单元格文档、非折叠选区、非公式栏、非组字和真实输入归属。隐藏输入不属于 `editorDOM`，以正常文档的 `DocSelectionRenderService.isFocusing` 和事件目标等于 activeElement 核对实例。销毁时移除绑定，原 SDK 谓词和全局监听不变。SDK 升级若公开支持此场景，先通过实例/只读/组字/销毁反例和富文本真实 UI，再删除本适配及登记。

实际富文本表单 autofocus 引起 Docs `_setEditing(false)`，文本/矩形数组引用和 segment 均不变；原 hyperlink listener 会立即关表单。同包 ES/CJS 补丁只给桌面/移动两个 popup 订阅增加上述身份与数组引用去重，真正换区、清空、上下文变化和销毁仍生效。订阅沿原 `disposeWithMe` 管理，不改全局 Docs、不延时重开。14 项真实发布 controller 对照覆盖桌面/移动，三浏览器真实故事核对桌面整段与子串、历史和重开；移动单元覆盖不冒称移动 UI 验收。上游修复相同焦点通知问题后，须经过这些对照才删除此段补丁；它与 URL normalizer 有独立删除条件。

S6 真实 UI 复现了另一处生命周期缺陷：查看菜单先出现，再进入单元格编辑，其普通取消命令仍可能覆盖尚未提交的正文。用户批准后，同包 ES/CJS 的桌面/移动控制器在编辑开始时立即移除查看菜单，并阻止排队的工作表事件操作正文菜单；编辑状态结束或清空时取消旧 Docs 订阅与菜单。编辑仍可见但文档、工作表、行或列变化时，撤掉旧所属单元格的正文菜单，并经原 `endEditing` 关闭旧正文表单；保留同一单元格通知、普通表单及范围选择器的 keepVisible 语义。不主动提交正文、不改写命令类型、不增加持久化字段。真实发布类的生命周期与原焦点回归合计 45 项通过；正式 UI 分别检查未提交前后文、rich 命令、历史和保存后客户端重建。Linux/ARM64 原三故事及当前 full05 默认完整门禁、container03 生产容器已通过，最终合并 SHA 的 CI 仍待执行。移动端只验证实际类，未声称移动 UI 验收。上游修复后，须通过这些反例、三浏览器故事及原只读/导航回归才能移除此段补丁。

外部导航只在明确点击时执行 `window.open(href, '_blank', 'noopener,noreferrer')`，回调再次检查地址，不接收内部锚点。配置、输入、保存和重开均不得引起外站预取。SDK 升级若提供相同的公开实例级规范化接点，先通过 resolver 默认行为、真实表单、富文本、只读、历史和导航回归，再删除补丁及登记；不能仅因版本变化移除。

## M5-P3 S3 的补充：数据验证异步工作的归属

固定 `sheets-data-validation@1.0.1` 的服务在插件内部直接注册，没有稳定替换配置；通过 `pnpm patch` 修改实际服务与模型，ES/CJS/声明同步，原件、安装产物与补丁散列见 `patches/univer-data-validation.json`。平台不复制插件或接管全局异常。公开四类校验方法及有效/无效语义保持，模型原三参数调用兼容新增的可选第四参数失败回调。

脏区在发出时捕获原 Workbook/Worksheet，合批和执行时都按对象身份复核；仅按 id 存在不足以隔离同 id 重建。初始缓冲在 Rendered 之后退订，避免持续持有后续脏区与已退役的对象。非当前表的 idle 句柄由服务管理，工作簿或服务退役时取消；已取消但迟到的回调仍先核对原归属。

已开始的模型计算登记取消回调，模型销毁、工作簿销毁及工作表移除命令结束本次等待；迟到结果不写缓存或发状态事件。模型按 Worksheet 的弱引用和单元格矩阵索引待办，在真实 dirtyRanges$ 发出时立即取消覆盖区域的旧任务，不等 20 ms 合批或下次计算。完成后移除对应任务；成功和失败清理还复核本格任务身份，旧值不能覆盖新 INVALID、清掉新 VALIDATING 或复活已删除规则的状态，邻格计算不受影响。

服务自身销毁终结其等待；单独销毁该服务时，仍活跃的共享模型继续维护原表缓存，不能将其等同于完整实例退役。范围/工作表方法在 await 后再次核对对象身份，再读取合并结果或取得缓存。正常取消使用内部 `DataValidationCancelledError`，不伪造 VALID；后台调度只吸收该类取消。真实计算异常传回调用方；若等待已取消，或原三参数模型调用没有失败回调，明确报告原错误一次，不因退役而改成取消。当前计算失败清除自己的 VALIDATING 状态，保留重试能力。

修复不取消底层公式引擎的共享计算；它切断退役任务的等待与结果发布。工作表单独删除会取消模型任务，已有 idle 句柄由身份检查阻止执行，在 idle 触发、工作簿或服务退役时回收。上游提供相同的调度清理、格级失效、模型失败通道和续体身份检查后，须先通过实际发布类的销毁/同 id/同格新旧值/合并区域/失败重试及迟到真实拒绝对照，以及真实页面初始与后续脏区、打开自检失败、阅读/编辑重建，才移除此补丁与登记。

DEF-057 的两条 Ready 路径分别记录：drawing 已在 P2 修复；formula 的首次建表前直接调用反例仍存在，但当前默认 Worker/主线程产品场景须按真实页面证据分类，不以该内部调用证明平台可达性。本 Step 不为未证实的默认路径修改公式引擎。

## M5-P3 S4 的补充：数据验证面板与范围高亮

UR-033 的固定包详情组件把一个尾调用防抖改成按实际输入顺序保留字段增量的有序待办，仅相邻同类编辑合并 1000 ms，不能跨范围操作合并前后两次设置。三个原 handler 已核实同步，flush 使用原 `syncExecuteCommand` 保留校验、权限和撤销。类型切换、确认、删除前提交；被拒绝时保留输入和详情，允许重试，真实异常继续可观察。

新类型可能因空公式尚不能生效：内部待办携带其类型设置草稿，只有执行时模型仍为旧类型才使用，其他情况与当前模型合并字段；在调用原命令前剥离草稿。范围/选项提交后仍保留尚未生效的类型，Undo/Redo 则以实际历史为准。最终矩阵揭示该本地遗漏后补五项反例和两项有效变异；实际组件与相关 SDK 回归共 81 项通过。

审查发现范围历史只更新草稿而没有更新编辑器正文，且范围命令平移 custom 公式后旧完整 setting 会覆盖结果。修正后历史完成即同步草稿并重建范围正文，不再留下 SDK 详情内 20 ms 的旧输入窗口；宿主原有捕获等待保持。Setting 只携带用户实际改动的字段，执行时合入当时模型；完整批次成功后同步草稿，必要时重建公式编辑器。实际公式平移只由 SDK 原命令完成，普通 bound 公式保持原语义。失败项和后续项保持顺序等待明确重试。

侧边栏 `open$` 变为 false 时同步提交，组件清理也提交仍归属原 Workbook/Worksheet 的待办。DOM 已隐藏不等于组件已卸载，不能只靠卸载清理。原工作簿或工作表退役时取消，不能向同 id 新对象提交；规则删除、本工作簿撤销/重做前取消旧待办，其他编辑器的历史不受影响。监听随组件释放。

UR-036 的范围高亮 effect 可能持有旧 sequenceNodes，却重写编辑器当前文本。`sheets-formula-ui` 改为执行时配对读取当前文本与解析结果，再调用原高亮；不新增解析器或输入层。数据验证详情在排队前和确认时用 SDK `isValidRange` 加目标工作表边界验证实际范围，保留整行/整列语义，无效输入不删除原规则。

两个包均固定 1.0.1，ES/CJS 由 pnpm patch 管理，无新增公开导出、声明或持久化字段；散列分别在 `patches/univer-data-validation-ui.json`、`patches/univer-range-highlight.json`。平台仍通过 `panel-debounce-watch` 的原窗口和单一捕获路径保存，批注原有 300 ms 等待保持。

S4 内容矩阵又发现 UR-037：`focusFormulaEditor` 先切换焦点再读选区，blur 会把尚未更新的渲染光标覆盖到刚输入后的逻辑光标，出现 `new-text`→`ew-textn`。同一 `sheets-formula-ui` 补丁在焦点切换前保存逻辑选区，之后沿原规则恢复；显式光标位置、拖选和空选区语义保持。Task 2 三浏览器兼容 21、公开 running 21 项通过；恢复原函数后两个入口在服务器内容断言失败。最终 S4 能力矩阵与相关回归见下文。

回归包括实际 SDK 组件/模型/命令、同种合并、跨种保留、关闭/退役、撤销、失败重试、范围边界，以及真实页面连续输入、列表类型、无效修正、关闭、删除历史。上游版本须通过同一组回归与三浏览器公开流程，确认上述边界后才移除补丁；UR-033/036 均未发送上游。S4 最终工程、三浏览器能力兼容 105/公开 running 99/相关兼容 291/相关 running 45/面板自动保存 18 项及单轮审查修正完成，原件绑定于 `final03-resumed-evidence.json`；P3 整体交付待 S6。

## M5-P3 S4 的补充：公式规则的计算完成与提交

完整自定义规则输入故事发现 S3 本地补丁的回归：公式结果通知也使用 dirtyRanges$，但它代表待等结果到达，不能一律按改值取消。本项不归因于上游原包。缓存事件增加可选 isFormulaResult，仅实际两个公式结果消费者设置；输入、规则和生命周期失效仍取消。模型保留同格等待者并标记计算代次；结果完成前若有更新，重新读取当前公式缓存，旧结论不发布。并发 validatorCell 等待同一次任务的最终状态，渲染查询仍同步返回 VALIDATING。真实错误继续传递，失败可重试；完成、取消、异常都释放新增等待者。

该修改仍在 `sheets-data-validation@1.0.1` 补丁内，新增缓存事件声明，未增加持久化字段或改变底层共享公式计算。实际 SDK 新 8 项与原生命周期 39 项通过；面板经审查及类型草稿补证增至 34 项（合计 81 项）；去掉代次复核、提前返回 VALIDATING 的两项变异均失败，恢复后全绿。原生 CJS 七项和新增未定义符号检查通过。独立审查修正与最终三浏览器验证完成。

UR-038 则是固定条件格式 UI 的旧错误状态：FormulaEditor 初始验证抑制期间，正确文本已更新但显示错误仍旧，beforeSubmit 因此拒绝。窄补丁让最终确认只依据当前文本的原有等号/非空/括号判定；非法输入仍拒绝，合法时清掉消息。`patches/univer-conditional-formatting-ui.json` 登记 ES/CJS。上游在同样的快速修正、错误拒绝、历史/实际绘制/重开回归通过后移除；未发送报告。

## M5-P3 S5 的补充：恢复原生输入光标

UR-039 的正式公式故事发现重命名工作表后首次文字无效：normal editor 虽已聚焦，原生 DOM Selection 仍在旧改名控件父节点。浏览器发出未取消的 beforeinput，但没有 input；SDK 没收到文字，云端保存和公式计算均发生在此后。原 `DocSelectionRenderService.focus` 对已聚焦元素只重复调用 focus，不重建原生选区。

固定 docs-ui 1.0.1 的 ES/CJS 在该入口恢复原生收字位置，仅限输入框仍实际聚焦、非 IME、且选区缺失或任一端点在框外。使用 input.ownerDocument，保留有效选区及方向、输入法草稿、焦点回调转移到其他控件。SDK 逻辑选区、正文、权限和保存通道不改，内部方法没有新增宿主接线。补丁与散列登记在 `patches/univer-native-focus.json`。

实际 SDK 单元 4 项有效 RED 后 7 项 GREEN；移除诊断后的 Chromium 六类公式整链及原有两条焦点历史通过。S5 最终三浏览器、相关保存/恢复/自检和独立审查状态见 S5 复核。上游通过相同原速输入反例、选区/IME/焦点转移边界和相关浏览器回归后方可移除补丁；未向上游发送。

## M5-P3 S5 的补充：表名全选任务的归属

UR-040 由三浏览器最终回归揭示：keepTextSelected 延后无条件全选，可能在用户原速输入“源数据”的中途重新选择已经键入的前缀，使结果成为“数据”或“据”。输入后一次读取捕获了丢前缀事实，原始失败快照也表明回车前内容已经不对；只等 DOM 聚焦不足以解决。

固定 sheets-ui 1.0.1 的同一函数保留异步初始全选，记录初始正文及 ownerDocument，并短暂监听后续键盘、beforeinput/input、compositionstart、pointerdown 和 focusout。回调先清理监听；有交互、正文改变、脱离页面、可编辑状态结束或所属 document 改变时退出。没有交互时仍正常全选；不新增公开符号、模型状态、权限或宿主输入实现。ES/CJS 对称补丁与原始/安装/patch 摘要在 `patches/univer-sheet-name-selection.json`。

该内部函数未公开导出，单元测试以 `?raw` 读取两份固定发布包，核对声明唯一后执行原函数，使用真实 DOM/Selection 和可控计时器。仅这一个测试文件明确登记原文读取及函数求值的逐行 lint 例外，目的为避免复制实现或新增生产测试出口；生产模块、依赖导入及内部 API 门禁保持原约束。既有序列化测试采用相同的限定求值方式。22 项中旧逻辑 20 项有效失败，修正后 22 项及 UR-039 7 项通过；移除交互守卫、正文守卫和所属文档读取的变异分别产生 10/2/2 项预期断言失败，恢复后 29 项通过。

无诊断的原速公式整链及 S4 工作表结构链三浏览器各三轮共 18 项通过；S5 final03 的 11,059 项单元、工程及三浏览器兼容 225/公开 running 21/自检两模式各 12 项全部通过。S5 单轮独立审查先于 UR-040，该新增补丁须由 S6 阶段审查覆盖；完整阶段门禁尚未完成。上游须通过相同反例、正常全选、输入/光标/IME、关闭/销毁/重开和跨 document 边界，以及三浏览器真实链路后，方能移除补丁；未发送上游。

## M5-P4 S6 的补充：列表编辑与搜索的焦点归属

列表非法输入的原 CI 故事曾把 `cyan` 分流到单元格与搜索框；本地被动观察确认搜索 input 的 React `autoFocus` 和零延时 timer 都会与编辑器争夺焦点。旧 SDK 的真实组件链出现 6 个行为反例，原 Chromium 故事的一次被动观察也检出了搜索取焦；这些事实不等同于重现原 CI 的完整失败。WebKit 链接问题另行调查。

固定 `sheets-data-validation-ui@1.0.1` 的 `DataValidationDropdownManagerService` 在 LIST/MULTIPLE_LIST 共用分支传 `autoFocusSearch: param.trigger !== 'editor-bridge'`。`sheets-ui@1.0.1` 的 `IListDropdownProps.autoFocusSearch?: boolean` 经真实 `SheetCellDropdownManagerService` 的 popup、`ListDropDown` 原样传到 `SelectList`，缺省为 true；显式打开及其他未传属性的调用保持自动搜索聚焦。React input 的 `autoFocus` 与延后 `focus()` 共用该策略，effect 依赖 `[showSearchOnDropdown, autoFocusSearch]`；隐藏搜索、切换策略及卸载都清理本实例 timer，包括编号为 0 的句柄。`showSearch` 仍控制搜索框是否显示；联动打开不自动取焦，用户主动进入搜索仍可过滤、选择，单选关闭和多选保留语义保持。

两包 ES/CJS、sheets-ui 声明及正常 pnpm 补丁/锁一致；数据验证的 `trigger?: 'editor-bridge'` 声明已有，无需新增宿主出口。原 UR-033 面板和 UR-040 表名修复全部保留，原始包与实际安装/patch 摘要继续登记在 `patches/univer-data-validation-ui.json`、`patches/univer-sheet-name-selection.json`。`registry.ts` 只补协议说明与回归索引；`EditorContainer`、全局焦点、校验和保存算法不变。

升级或移除本段补丁前，须通过 `data-validation-dropdown-focus.test.tsx` 的真实 manager → popup → 组件链：全过程无搜索 focusin、显式/缺省调用、主动搜索、timer 取消及实例重建；并复验原面板、验证生命周期/公式、原生光标与表名全选回归。原 `capabilities-rules.spec.ts` 下拉故事须在 Chromium、Chrome、WebKit 保留原速键入、拒绝提示、历史和保存重开断言，并让 red/cyan 各自的被动窗口真实开始、封存且零搜索事件；`list-focus-observation.test.ts` 校准 16 条、4 KiB、15,000 ms 上限及失效/异常清理。只有上游提供同等来源策略与生命周期、上述回归及原门禁通过，才移除本段补丁；旧面板与表名补丁各有独立移除条件。2026-10-31 原三浏览器故事已各一例首过，定向结果见[列表焦点复核](../v0.1/M5-表格能力与资源/reviews/P4-S6-列表编辑焦点复核.md)；独立任务审查的规格与质量均 Approved，C/I/M 均为 0；最终阶段门禁仍待，不据局部通过签署 P4 关闭。

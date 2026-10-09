// ESLint：代码规范与格式（规范 §1.2、§2），以 --max-warnings 0 运行。
// 模块边界的元素与策略随各 Phase 的新模块扩展（ADR：仓库结构与模块边界）。
import type { Linter } from 'eslint'
import antfu from '@antfu/eslint-config'
import { createTypeScriptImportResolver } from 'eslint-import-resolver-typescript'
import boundaries from 'eslint-plugin-boundaries'
import { createNodeResolver, importX } from 'eslint-plugin-import-x'
import playwright from 'eslint-plugin-playwright'

const SOURCE_CONDITION = '@nerve-office/source'

// 只有编辑器适配层可以引用 Univer；任何位置都不得引用 Pro（规范 §1.2、§3）
const UNIVER_ONLY_IN_EDITOR = {
  group: ['@univerjs/*', '@univerjs/**'],
  message: '只有 apps/web/src/editor/ 可以引用 @univerjs/*（规范 §1.2）',
}
const NO_UNIVER_PRO = {
  group: ['@univerjs-pro/*', '@univerjs-pro/**'],
  message: '禁止引入 @univerjs-pro/*（00 号计划书 §3.3）',
}
// 依赖一律按包名引用：写成 node_modules 里的路径，按包名生效的限制（Univer、Pro、内部 API、深层路径）都认不出来（审查 B4）
const NODE_MODULES_PATH_MESSAGE = '按包名引用依赖，不要写 node_modules 里的路径：按包名生效的限制认不出这种路径（审查 B4）'
const NO_NODE_MODULES_PATH = {
  regex: String.raw`(?:^|[\/])node_modules(?:[\/]|$)`,
  message: NODE_MODULES_PATH_MESSAGE,
}
// 包名一律小写（npm 的包名本来就不许大写）：写成 @UniverJS/engine-formula 时，按包名生效的限制（Univer 只在编辑器、内部 API、深层路径）都认不出，
// 而不区分大小写的文件系统（macOS 本机）上类型检查与构建照常通过（复验 TB5）。只看包名这一段，包里的路径不管
const UPPERCASE_PACKAGE_MESSAGE = '包名写成小写：写成大写时按包名生效的限制认不出，不区分大小写的文件系统上构建照常通过（复验 TB5）'
const NO_UPPERCASE_PACKAGE = {
  regex: String.raw`^(?:@[^/]*[A-Z]|@[^/]+/[^/]*[A-Z]|(?![@./#])[^/]*[A-Z])`,
  caseSensitive: true,
  message: UPPERCASE_PACKAGE_MESSAGE,
}

// 动态导入同样受限：no-restricted-imports 只管静态导入与再导出。
// esquery 的正则字面量里不能出现斜杠，所以用前缀判断
// import x = require('…') 与 import x = 命名空间.成员：受限导入与模块边界都只认 ES 模块的写法（复验 RB4）
const antfuRestrictedSyntax = ['TSEnumDeclaration[const=true]', 'TSExportAssignment', 'TSImportEqualsDeclaration']
const DYNAMIC_IMPORT_LITERAL_ONLY = {
  selector: 'ImportExpression[source.type!=\'Literal\']',
  message: '动态导入的路径必须是字面量，否则受限导入与模块边界都检查不到',
}
const DYNAMIC_UNIVER = {
  selector: 'ImportExpression[source.value=/^@univerjs(?!-pro)/]',
  message: '只有 apps/web/src/editor/ 可以引用 @univerjs/*（规范 §1.2）',
}
// 类型里的 import('…')（typeof import('@univerjs/x')、import('@univerjs/x').Y）同样是引用：no-restricted-imports 只管导入语句（复验 RB4）
const TYPE_IMPORT_UNIVER = {
  selector: 'TSImportType[source.value=/^@univerjs/]',
  message: '只有 apps/web/src/editor/ 可以引用 @univerjs/*（规范 §1.2）',
}
const DYNAMIC_UNIVER_PRO = {
  selector: 'ImportExpression[source.value=/^@univerjs-pro/]',
  message: '禁止引入 @univerjs-pro/*（00 号计划书 §3.3）',
}
const DYNAMIC_NODE_MODULES_PATH = {
  selector: 'ImportExpression[source.value=/node_modules/]',
  message: NODE_MODULES_PATH_MESSAGE,
}
// 动态导入与类型里的 import('…') 的包名同样要小写（复验 TB5）；esquery 的正则字面量里不能出现斜杠，写成 \x2F
const UPPERCASE_PACKAGE_SOURCE = String.raw`/^(?:@[^\x2F]*[A-Z]|@[^\x2F]+\x2F[^\x2F]*[A-Z]|(?![@.#\x2F])[^\x2F]*[A-Z])/`
const DYNAMIC_UPPERCASE_PACKAGE = [
  { selector: `ImportExpression[source.value=${UPPERCASE_PACKAGE_SOURCE}]`, message: UPPERCASE_PACKAGE_MESSAGE },
  { selector: `TSImportType[source.value=${UPPERCASE_PACKAGE_SOURCE}]`, message: UPPERCASE_PACKAGE_MESSAGE },
]
// import.meta.glob 按路径批量导入（构建时展开成导入），受限导入与模块边界都看不到它（复验 SB7）
const NO_IMPORT_META_GLOB = {
  selector: 'CallExpression[callee.object.type=\'MetaProperty\'][callee.property.name=/^glob/]',
  message: '不用 import.meta.glob：它按路径批量导入，受限导入与模块边界都检查不到（复验 SB7）',
}

// ---- 编辑器适配层的内部 API（P4 设计 §3.6.9，ADR-003、ADR-010）----
// Facade 之外的 SDK 符号只能经 apps/web/src/editor/internal-api/ 引用，那里逐项登记用途、证据与回归用例。
// 按包与导入名列出适配层实际用到的内部符号，以及决定不用的（UserManagerService 的 setCurrentUser、本地授权服务：ADR-009）；
// 命名空间导入、再导出与 import type 同样拦下
const INTERNAL_API_MESSAGE = '内部 API 只能经 apps/web/src/editor/internal-api/ 引用并登记（P4 设计 §3.6.9）'
const UNIVER_INTERNAL_SYMBOLS = [
  {
    name: '@univerjs/core',
    // IPermissionService、IUndoRedoService：只读守卫的本地权限点与撤销栈（M2-P3 设计 §3.6）；
    // IContextService、FOCUSING_FX_BAR_EDITOR、DOCS_FORMULA_BAR_EDITOR_UNIT_ID_KEY：只读守卫放开编辑栏的编辑器（P3 审查 A1）；
    // CustomRangeType：链接的改写认链接用的区间种类（M3-P3 S2，internal-api 的 CELL_LINK_PROTOCOL，与 contracts 的 HYPERLINK_RANGE_TYPE 核对）；
    // LocaleService：语言服务换成销毁之后不抛错的子类（internal-api 的 disposalSafeLocaleOverride），别处不直接取它、不另换；
    // ILogService、IResourceHook、IResourceManagerService、ResourceManagerService：打开自检的资源守卫（M3-P4，internal-api 的
    // createResourceLoadGuard）——资源管理服务的子类与 hook 的形状，类型也只在 internal-api 里
    importNames: [
      'AuthzIoLocalService',
      'CustomRangeType',
      'DOCS_FORMULA_BAR_EDITOR_UNIT_ID_KEY',
      'FOCUSING_FX_BAR_EDITOR',
      'IAuthzIoService',
      'IContextService',
      'ILogService',
      'IPermissionService',
      'IResourceHook',
      'IResourceManagerService',
      'IUndoRedoService',
      'LifecycleService',
      'LocaleService',
      'ResourceManagerService',
      'UserManagerService',
    ],
    message: INTERNAL_API_MESSAGE,
  },
  {
    // 只读守卫放开编辑栏的编辑器：编辑器管理服务的 focus$ 与 blur（P3 审查 A1）
    name: '@univerjs/docs-ui',
    importNames: ['IEditorService'],
    message: INTERNAL_API_MESSAGE,
  },
  {
    // 只读守卫取这份文档的渲染单元，拦下冻结线的拖动（P3 审查 B2）
    name: '@univerjs/engine-render',
    importNames: ['IRenderManagerService'],
    message: INTERNAL_API_MESSAGE,
  },
  {
    name: '@univerjs/engine-formula',
    importNames: [
      'BaseFunction',
      'BaseValueObject',
      'ErrorType',
      'ErrorValueObject',
      'FormulaExecutedStateType',
      'IActiveDirtyManagerService',
      'IFunctionService',
      'SetFormulaCalculationNotificationMutation',
      'SetFormulaCalculationResultMutation',
      'SetFormulaCalculationStartMutation',
      'SetFormulaCalculationStopMutation',
      'SetTriggerFormulaCalculationStartMutation',
    ],
    message: INTERNAL_API_MESSAGE,
  },
  {
    name: '@univerjs/sheets',
    importNames: [
      'SetRangeValuesMutation',
      // 只读守卫关掉与保留的工作表权限点、授权服务在只读时允许的动作（M2-P3 设计 §3.6）
      'getAllWorksheetPermissionPoint',
      'getAllWorksheetPermissionPointByPointPanel',
      'WorkbookCopyPermission',
      'WorkbookViewPermission',
      'WorksheetCopyPermission',
      'WorksheetViewPermission',
    ],
    message: INTERNAL_API_MESSAGE,
  },
  {
    // 只读守卫把浮动图片设为不可编辑：渲染读的是这个服务的标志（M2-P3 S3 的 E2E 发现之后）
    name: '@univerjs/drawing',
    importNames: ['IDrawingManagerService'],
    message: INTERNAL_API_MESSAGE,
  },
  {
    // 表格的图片服务：它的可编辑标志渲染不读（SDK 的权限控制器设的是它），决定不用；受限，免得绕过登记直接用
    name: '@univerjs/sheets-drawing',
    importNames: ['ISheetDrawingService'],
    message: INTERNAL_API_MESSAGE,
  },
  {
    // 冻结线与行列调整的渲染控制器：只读守卫在它们的拦截点上拦下拖动（P3 审查 B2；DEF-027，M3-P2 S3）
    name: '@univerjs/sheets-ui',
    importNames: ['HeaderFreezeRenderController', 'HeaderResizeRenderController'],
    message: INTERNAL_API_MESSAGE,
  },
]
// SDK 界面里的 DOM 标记（data-u-comp，P3 审查 A8）：不是公开 API，版本之间可能改名，只在 internal-api 里写（dom-markers.ts，逐项登记）。
// apps/web/src 里测试代码之外的字符串、模板、JSX 属性，以及 dataset.uComp 都算；测试要按 SDK 的结构造元素，不受限
const DOM_MARKER_MESSAGE = 'SDK 的 DOM 标记（data-u-comp）只在 apps/web/src/editor/internal-api/ 里写并登记（P3 审查 A8）：它不是公开 API，版本之间可能改名'
const SDK_DOM_MARKERS = [
  { selector: String.raw`Literal[value=/data-u-comp\b|\buComp\b/]`, message: DOM_MARKER_MESSAGE },
  { selector: String.raw`TemplateElement[value.raw=/data-u-comp\b|\buComp\b/]`, message: DOM_MARKER_MESSAGE },
  { selector: 'JSXAttribute[name.name=\'data-u-comp\']', message: DOM_MARKER_MESSAGE },
  { selector: 'MemberExpression[property.name=\'uComp\']', message: DOM_MARKER_MESSAGE },
]
// 取服务的注入器：Univer.__getInjector()，以及 Univer、Facade 与各个对象上的私有字段 _injector（复验 RB4：
// 方括号访问私有字段能通过类型检查，拿到的是同一个注入器）。点号访问、按标识符解构都算；这两个名字的字符串
// （方括号访问、字符串的键解构、Reflect.get 等）与不带插值的模板字符串同样拦下（审查 B4）。
// 对象字面量里用标识符写的同名属性不算，测试的假实现要定义它。变量作键、字符串拼接之类的写法 lint 看不出来，由代码审查保证
// eslint-disable-next-line no-restricted-syntax -- 规则本身要写出这两个名字
const INJECTOR_NAMES = ['__getInjector', '_injector'] as const
const NO_GET_INJECTOR = INJECTOR_NAMES.flatMap(name => [
  { selector: `MemberExpression[property.name='${name}']`, message: INTERNAL_API_MESSAGE },
  { selector: `ObjectPattern > Property[key.name='${name}']`, message: INTERNAL_API_MESSAGE },
  { selector: `Literal[value='${name}']`, message: INTERNAL_API_MESSAGE },
  { selector: `TemplateElement[value.cooked='${name}']`, message: INTERNAL_API_MESSAGE },
])
// 包名带查询串或片段（@univerjs/engine-formula?x）：按包名与导入名的限制都认不出，构建照常打包（复验 SB7）
const UNIVER_QUERY_IMPORTS = {
  regex: String.raw`^@univerjs/[^?#]*[?#]`,
  message: '引用 @univerjs/* 不带查询串与片段：按包名与导入名的限制认不出这种写法（复验 SB7）',
}
// Univer 的包都用 "./*" 导出了整个目录：按导入名的限制只认包的入口，深层路径拿得到同一批符号。
// 只允许包的入口、/facade、/locale/<语言> 与 /lib/index.css（样式）
const UNIVER_DEEP_IMPORTS = {
  regex: String.raw`^@univerjs/[^/]+/(?!(?:facade|locale/[\w-]+|lib/index\.css)$)`,
  message: '只引用 @univerjs/* 的包入口、/facade、/locale/<语言> 与 /lib/index.css：包里的深层路径绕得过内部 API 的限制（P4 设计 §3.6.9）',
}
// 动态导入绕得过按导入名的限制：编辑器里的 @univerjs/* 一律静态导入
const EDITOR_DYNAMIC_UNIVER = {
  selector: 'ImportExpression[source.value=/^@univerjs/]',
  message: '编辑器里的 @univerjs/* 用静态导入：内部 API 与深层路径的限制只认静态导入（P4 设计 §3.6.9）',
}
// 内部 API 里不用动态 import()（M2-P6 第二次复验 S1）：登记表的自测（internal-api/registry.test.ts）按文本扫描每个文件的导入导出，
// 只认静态的语句。动态引入的是哪个文件、用了它的哪些名字认不出来（与命名空间导入一样），引入的文件对 SDK 的引用就逃过了登记；
// internal-api 只是登记过的一层再导出与小封装，用不着动态引入。对 @univerjs/* 的动态引入另由 EDITOR_DYNAMIC_UNIVER 拦下，这里连同
// 同目录的文件与别的包一起拦。类型里的 import('./x.ts') 只带类型、不进产物，不在此列：只经它引用的文件在扫描里"从出口走不到"，照样报出
const INTERNAL_API_NO_DYNAMIC_IMPORT = {
  selector: 'ImportExpression',
  message: '内部 API（editor/internal-api/）里不用动态 import()：登记表的自测只认静态的导入导出语句，认不出动态引入的文件与它用到的名字（registry.test.ts，M2-P6 第二次复验 S1）',
}
// 类型里的 import('…') 同样绕得过：编辑器里的 @univerjs/* 类型用 import type 引用（复验 RB4）
const EDITOR_TYPE_IMPORT_UNIVER = {
  selector: 'TSImportType[source.value=/^@univerjs/]',
  message: '编辑器里的 @univerjs/* 类型用 import type 引用：内部 API 与深层路径的限制只认导入语句（复验 RB4）',
}
// 编辑器（含 internal-api）对 Univer 的包的导入源的共同限制：不引用 Pro、node_modules 里的路径、大写的包名、查询串与片段、深层路径
const EDITOR_UNIVER_SOURCE_PATTERNS = [NO_UNIVER_PRO, NO_NODE_MODULES_PATH, NO_UPPERCASE_PACKAGE, UNIVER_QUERY_IMPORTS, UNIVER_DEEP_IMPORTS]

// ---- 编辑器里能直接引用的 @univerjs/* 的值：白名单（M2-P6 复核 F4）----
// 上面的 UNIVER_INTERNAL_SYMBOLS 只拦登记过（与决定不用）的内部符号：没登记的新内部符号（例如 @univerjs/sheets 导出的
// SheetPermissionCheckController）照样能在 internal-api 之外直接引用。所以编辑器里 internal-api 与测试代码之外的文件，
// 对 @univerjs/* 的值引用只允许这里按导入源列出的公开符号：插件类、Univer 与 FUniver、用到的枚举、mergeLocales、主题，
// 以及 /locale/<语言> 的语言包（默认导出）。列的是适配层实际用到的；新用一个公开的值时加进来，内部符号经 internal-api 引用并登记。
// 不受这份白名单限制的：
// - 类型引用（import type、export type，只在编译时存在）；登记过的内部符号的类型仍由 UNIVER_INTERNAL_SYMBOLS 拦下；
// - 副作用导入（import '…/facade'、样式）：没有导入名；
// - internal-api（登记的地方）与测试代码（测试要构造 SDK 的对象，例如拦截器、公式的值对象；不进产物，SDK 改了直接失败）。
// 登记过的内部符号的值引用会报两条（清单与白名单），说的是同一件事。
// lint 看不出来、由审查保证的（写进 ADR-010）：Facade 对象上的方法调用（它们本来就是公开 API，其中的内部对象经返回值流出时
// 认不出来）、经注入器按字符串或变量取服务、对 SDK 对象的私有字段的其他访问写法
const UNIVER_PUBLIC_VALUES: Readonly<Record<string, readonly string[]>> = {
  '@univerjs/core': ['CommandType', 'LifecycleStages', 'LocaleType', 'LogLevel', 'mergeLocales', 'Univer'],
  '@univerjs/core/facade': ['FUniver'],
  '@univerjs/data-validation': ['UniverDataValidationPlugin'],
  '@univerjs/docs': ['UniverDocsPlugin'],
  '@univerjs/docs-drawing': ['UniverDocsDrawingPlugin'],
  '@univerjs/docs-ui': ['UniverDocsUIPlugin'],
  '@univerjs/drawing': ['UniverDrawingPlugin'],
  '@univerjs/drawing-ui': ['UniverDrawingUIPlugin'],
  '@univerjs/engine-formula': ['UniverFormulaEnginePlugin'],
  '@univerjs/engine-render': ['DeviceInputEventType', 'UniverRenderEnginePlugin'],
  '@univerjs/find-replace': ['UniverFindReplacePlugin'],
  '@univerjs/rpc': ['UniverRPCMainThreadPlugin', 'UniverRPCWorkerThreadPlugin'],
  '@univerjs/sheets': ['UniverSheetsPlugin'],
  '@univerjs/sheets-conditional-formatting': ['UniverSheetsConditionalFormattingPlugin'],
  '@univerjs/sheets-conditional-formatting-ui': ['UniverSheetsConditionalFormattingUIPlugin'],
  '@univerjs/sheets-data-validation': ['UniverSheetsDataValidationPlugin'],
  '@univerjs/sheets-data-validation-ui': ['UniverSheetsDataValidationUIPlugin'],
  '@univerjs/sheets-drawing': ['UniverSheetsDrawingPlugin'],
  '@univerjs/sheets-drawing-ui': ['UniverSheetsDrawingUIPlugin'],
  '@univerjs/sheets-filter': ['UniverSheetsFilterPlugin'],
  '@univerjs/sheets-filter-ui': ['UniverSheetsFilterUIPlugin'],
  '@univerjs/sheets-find-replace': ['UniverSheetsFindReplacePlugin'],
  '@univerjs/sheets-formula': ['CalculationMode', 'UniverRemoteSheetsFormulaPlugin', 'UniverSheetsFormulaPlugin'],
  '@univerjs/sheets-formula-ui': ['UniverSheetsFormulaUIPlugin'],
  '@univerjs/sheets-hyper-link': ['UniverSheetsHyperLinkPlugin'],
  '@univerjs/sheets-hyper-link-ui': ['UniverSheetsHyperLinkUIPlugin'],
  '@univerjs/sheets-note': ['UniverSheetsNotePlugin'],
  '@univerjs/sheets-note-ui': ['UniverSheetsNoteUIPlugin'],
  '@univerjs/sheets-numfmt': ['UniverSheetsNumfmtPlugin'],
  '@univerjs/sheets-numfmt-ui': ['UniverSheetsNumfmtUIPlugin'],
  '@univerjs/sheets-sort': ['UniverSheetsSortPlugin'],
  '@univerjs/sheets-sort-ui': ['UniverSheetsSortUIPlugin'],
  '@univerjs/sheets-ui': ['UniverSheetsUIPlugin'],
  '@univerjs/themes': ['defaultTheme'],
  '@univerjs/ui': ['KeyCode', 'UniverUIPlugin'],
}
const UNIVER_PUBLIC_VALUE_MESSAGE = '编辑器里（internal-api 与测试代码之外）对 @univerjs/* 的值引用只允许白名单（eslint.config.ts 的 UNIVER_PUBLIC_VALUES）里的公开符号：内部 API 经 apps/web/src/editor/internal-api/ 引用并登记（registry.ts，ADR-010）；新用一个公开的值时加进白名单（M2-P6 复核 F4）'
/** 白名单里的导入源：只允许列出的值，类型照常 */
const UNIVER_PUBLIC_VALUE_PATHS = Object.entries(UNIVER_PUBLIC_VALUES).map(([name, allowImportNames]) => ({ name, allowImportNames: [...allowImportNames], allowTypeImports: true, message: UNIVER_PUBLIC_VALUE_MESSAGE }))
/** 语言包（/locale/<语言>）：只用默认导出 */
const UNIVER_LOCALE_PATH = String.raw`[^/]+/locale/[\w-]+`
const UNIVER_LOCALE_DEFAULT_ONLY = { regex: String.raw`^@univerjs/${UNIVER_LOCALE_PATH}$`, allowImportNames: ['default'], allowTypeImports: true, message: UNIVER_PUBLIC_VALUE_MESSAGE }
/**
 * 白名单之外的导入源（没列出的包、包里没列出的 /facade 等）：任何值都不允许（导入名的模式 .* 认得出每一个名字，含默认导出、
 * 命名空间导入与 export *），类型与副作用导入照常。包名里只有小写字母、数字、- 与 /，拼进正则不用转义
 */
const UNIVER_UNLISTED_SOURCES = {
  regex: String.raw`^@univerjs/(?!(?:${Object.keys(UNIVER_PUBLIC_VALUES).map(name => name.slice('@univerjs/'.length)).join('|')})$)(?!${UNIVER_LOCALE_PATH}$)`,
  importNamePattern: '.*',
  allowTypeImports: true,
  message: UNIVER_PUBLIC_VALUE_MESSAGE,
}

// ---- E2E 的探针只能动态引入（M2-P6 复核 F5）----
// 探针（editor/testing/**）只在测试构建里，由 sheet-editor.ts 在 import.meta.env.MODE === 'e2e' 的分支里动态 import()（M2-P3 设计 §3.7）。
// 静态引用会把它的副作用带进生产构建：探针本身被摇树去掉，probe-facades.ts 给 Facade 补上的方法却留下，门禁 artifacts 只认探针的分块
// 与名字，发现不了。所以测试代码之外，对 testing/ 只能动态 import()：静态导入（含 import type）与再导出都拦下；testing/ 里的文件之间
// 照常静态引用（它们在同一个分块里），测试代码不受限。按引用路径的文字判断（路径里有 testing 这一段，不区分大小写）；
// 动态引入发生在哪个分支里 lint 看不出来，由门禁 artifacts（探针的分块与名字）与审查保证
const EDITOR_PROBE_MODULES = {
  regex: String.raw`(?:^|/)testing(?:/|$)`,
  message: '编辑器的 E2E 探针（editor/testing/**）只在测试构建里，只能经动态 import() 引入（sheet-editor.ts 的 e2e 分支）：静态导入与再导出会把 probe-facades.ts 补上的 Facade 带进生产构建，门禁 artifacts 发现不了（M2-P6 复核 F5）',
}

// ---- 编辑器页的测试构建探针同样只能动态引入（M4-P1 设计 §3.1）----
// features/sheet-editor 里 testing/ 下的文件（发件箱的浏览器层探针）只在测试构建里，由 start.tsx 在 e2e 分支、地址带 outboxProbe 时
// 动态 import()；editor/testing/ 同样只在测试构建里。静态导入（含 import type）与再导出都会让生产代码依赖它们（副作用可能留在生产构建里），
// 所以 sheet-editor 里测试代码之外的文件对路径里有 testing 这一段的模块只能动态引入。testing/ 里的文件之间照常静态引用；
// 页面自检的挂接（selftest-hook.ts）本身只在测试构建里（start.tsx 动态引入它），对 editor/testing/ 的类型引用不在此列
const SHEET_EDITOR_PROBE_MODULES = {
  regex: String.raw`(?:^|/)testing(?:/|$)`,
  message: '编辑器页的测试构建探针（features/sheet-editor/**/testing/**）与编辑器的 testing/ 只在测试构建里，只能经动态 import() 引入（start.tsx 的 e2e 分支）：静态导入（含 import type）与再导出会让生产代码依赖它们（M4-P1 设计 §3.1）',
}

// 测试与测试辅助只被测试静态引用：nerve/test-code-only-in-tests 按路径拦下的是静态导入，动态导入在这里拦（复验 R3）
const DYNAMIC_TEST_MODULES = {
  // 带查询或片段（?raw、#x）、大小写不同（不区分大小写的文件系统上照样找得到）也算（复验 S5）
  selector: String.raw`ImportExpression[source.value=/\.test(?:-support)?(?:\.[cm]?[jt]sx?)?(?:[?#].*)?$/i]`,
  message: '不要动态导入测试与测试辅助（*.test.*、*.test-support.*）：它们只被测试静态引用，不进入生产代码（审查 B17）',
}
const BASE_RESTRICTED_SYNTAX = [...antfuRestrictedSyntax, DYNAMIC_IMPORT_LITERAL_ONLY, DYNAMIC_UNIVER, TYPE_IMPORT_UNIVER, DYNAMIC_UNIVER_PRO, DYNAMIC_NODE_MODULES_PATH, ...DYNAMIC_UPPERCASE_PACKAGE, NO_IMPORT_META_GLOB, DYNAMIC_TEST_MODULES, ...NO_GET_INJECTOR]
/** 编辑器适配层：可以静态导入 Univer 的包，但不能引用 Pro */
const EDITOR_RESTRICTED_SYNTAX = [...antfuRestrictedSyntax, DYNAMIC_IMPORT_LITERAL_ONLY, DYNAMIC_UNIVER_PRO, DYNAMIC_NODE_MODULES_PATH, ...DYNAMIC_UPPERCASE_PACKAGE, NO_IMPORT_META_GLOB, DYNAMIC_TEST_MODULES, EDITOR_DYNAMIC_UNIVER, EDITOR_TYPE_IMPORT_UNIVER]

// 前端应用的入口（entries/*/main.{ts,tsx}，ADR-008）：按顺序执行的几步，第一步关掉 zod 的 JIT。
// zod 在创建结构时就读取 jitless，contracts 的结构在模块求值时创建，所以设置它的模块必须最先执行（审查 B1）。
// 普通的导入会被导入排序规则挪到副作用导入前面，所以入口只写副作用导入，代码放进它导入的模块
const APP_ENTRY_SYNTAX = [
  {
    selector: 'Program > :not(ImportDeclaration[specifiers.length=0])',
    message: '应用的入口只写副作用导入（import \'…\'），代码放进它导入的模块：普通的导入会被排序规则挪到前面先执行（ADR-008）',
  },
  {
    selector: String.raw`Program > ImportDeclaration:first-child:not([source.value=/\/shared\/lib\/zod-jitless\.ts$/])`,
    message: '应用的入口第一个导入 shared/lib/zod-jitless.ts：zod 在创建结构时读取 jitless，必须在任何结构创建之前关掉 JIT（ADR-008）',
  },
]

// 弹窗类的 Radix 原语（Dialog、AlertDialog）只在 shared/ui/dialog.tsx 里引入（M2-P1 复验）：别处直接从 radix-ui 引入，
// 会绕过对 dialog.tsx 的引用限制，把弹窗带进平台页面的首屏；按路径的限制（import-x/no-restricted-paths）与模块边界管不到第三方包。
// 对 web 的全部文件生效（M2-P2 复验：原来只管 shared，首屏的功能与应用层直接引入不报）。
// 按导入名检查：命名空间导入、export * 与动态导入 radix-ui 认不出引入的是什么，一并拦下，其他原语按名字引入
const RADIX_DIALOG_MESSAGE = '弹窗类的 Radix 原语（Dialog、AlertDialog）只在 shared/ui/dialog.tsx 里引入：别处引用它，会绕过对弹窗文件的引用限制，把弹窗带进平台页面的首屏（ADR-008，M2-P1 审查 B2、M2-P2 复验）'
const RADIX_DIALOG_OUTSIDE_DIALOG_FILE = [
  {
    selector: String.raw`:matches(ImportDeclaration, ExportNamedDeclaration)[source.value='radix-ui'] > :matches(ImportSpecifier[imported.name=/^(?:Dialog|AlertDialog)$/], ExportSpecifier[local.name=/^(?:Dialog|AlertDialog)$/])`,
    message: RADIX_DIALOG_MESSAGE,
  },
  {
    selector: String.raw`:matches(ImportDeclaration, ExportNamedDeclaration, ExportAllDeclaration, ImportExpression)[source.value=/^@radix-ui\/react-(?:alert-)?dialog(?:\/|$)/]`,
    message: RADIX_DIALOG_MESSAGE,
  },
  {
    selector: String.raw`:matches(ImportDeclaration[source.value='radix-ui'] > ImportNamespaceSpecifier, ExportAllDeclaration[source.value='radix-ui'], ImportExpression[source.value='radix-ui'])`,
    message: `${RADIX_DIALOG_MESSAGE}。radix-ui 的原语按名字引入（import { Slot } from 'radix-ui'）：命名空间导入、export * 与动态导入认不出引入的是什么`,
  },
]

// 人名一律经人名组件（shared/ui 的 PersonName）显示，纯文字里用 messages.people.text（规范 §2.4，M2-P6 复核 M2）：显示名是本人填的，
// 什么都能写（"李四（lisi）""李四 @lisi"），和登录名、别的文字拼成一段就冒充得了别人。lint 近似地拦下几种拼法：显示名（displayName）
// 出现在模板字符串的插值与 + 的拼接里；JSX 里显示名和别的文字、和登录名（username）是同一个元素的子节点。显示名单独占一个元素
// （表格里"显示名"那一列、PersonName 自己）照常。显示名与登录名认成员（user.displayName）与同名的变量，外面可以再套两层不改变值的写法：
// 可选链、?? || &&、条件表达式的两支、非空断言与类型断言（SAME_VALUE_WRAPPERS，例如 `${user?.displayName ?? ''}`，M2-P6 第 6 片复核第二批 S-2）。
// 认不出、由审查保证的写法（第 6 片复核 S5、第二批 S-2）：
// - 经变量转一手（const name = user.displayName）、解构时改了名（const { displayName: name } = user）；
// - 经函数或方法（[…].join()、'…'.concat()、String()、user.displayName.trim()、文案里自己写的拼接函数）；
// - 外面套了三层以上。
// 会误报的（第二批 G-b）：文案里同名的属性同样按人名报出，例如列标题、标签的键叫 displayName（`${text.columns.displayName}列`、
// <label>{text.displayName}：</label>）——文案的键换个名字（例如 displayNameLabel），或在那一行关掉检查、在 -- 之后写明原因。
// 对 web 的生产代码生效：各自配置 no-restricted-syntax 的块（平台代码、弹窗的文件、入口、编辑器）都带上这组限制
const PERSON_NAME_MESSAGE = '人名经 PersonName（shared/ui）显示，纯文字里用 messages.people.text：显示名（displayName）不和登录名、别的文字拼成一段（规范 §2.4，M2-P6 复核 M2）'
/**
 * 套在值外面、不改变值的写法：节点类型与值所在的属性。条件表达式只算两支（条件本身不是这个值）；
 * 类型断言的另一个属性是类型，不会是成员或变量
 */
const SAME_VALUE_WRAPPERS = [
  { types: ['ChainExpression', 'TSNonNullExpression', 'TSAsExpression', 'TSSatisfiesExpression'], keys: ['expression'] },
  { types: ['LogicalExpression'], keys: ['left', 'right'] },
  { types: ['ConditionalExpression'], keys: ['consequent', 'alternate'] },
] as const
/** 外面最多再套几层：`${user?.displayName ?? ''}` 是两层（?? 套着可选链） */
const SAME_VALUE_DEPTH = 2
const SAME_VALUE_WRAPPER = `:matches(${SAME_VALUE_WRAPPERS.flatMap(wrapper => wrapper.types).join(', ')})`
/** 处在外层的值的位置上（字段选择器：是外层节点的 expression、left 等属性） */
const SAME_VALUE_POSITION = `:matches(${[...new Set(SAME_VALUE_WRAPPERS.flatMap(wrapper => wrapper.keys))].map(key => `.${key}`).join(', ')})`

/** 直接放在 parent 里、值就是 field 本身的成员或变量（报在成员或变量上）：parent > 外层 > 内层 > 成员，外面零到两层 */
function fieldValueIn(parent: string, field: string): string[] {
  const leaf = `:matches(MemberExpression[property.name='${field}'], Identifier[name='${field}'])`
  return Array.from({ length: SAME_VALUE_DEPTH + 1 }, (_, depth) => depth === 0
    ? `${parent} > ${leaf}`
    : [parent, SAME_VALUE_WRAPPER, ...Array.from({ length: depth - 1 }).fill(`${SAME_VALUE_WRAPPER}${SAME_VALUE_POSITION}`), `${leaf}${SAME_VALUE_POSITION}`].join(' > '))
}

/**
 * 值就是 field 本身的 JSX 子节点 {…}：按从 expression 起的属性路径认（它要作 JSX 兄弟节点 ~ 的左边，只能写成这个节点自己的条件），
 * 外面零到两层的写法同 fieldValueIn
 */
function fieldValueChild(field: string): string {
  const at = (path: string, depth: number): string[] => [
    `[${path}.property.name='${field}']`,
    `[${path}.name='${field}']`,
    ...(depth === 0
      ? []
      : SAME_VALUE_WRAPPERS.flatMap(({ types, keys }) => keys.flatMap(key =>
          at(`${path}.${key}`, depth - 1).map(inner => `[${path}.type=/^(?:${types.join('|')})$/]${inner}`)))),
  ]
  return `JSXExpressionContainer:matches(${at('expression', SAME_VALUE_DEPTH).join(', ')})`
}

const DISPLAY_NAME_CHILD = fieldValueChild('displayName')
const USERNAME_CHILD = fieldValueChild('username')
/** JSX 里显示名的兄弟节点：有字的文本、字符串字面量、登录名 */
const NAME_NEIGHBOURS = [String.raw`JSXText[value=/\S/]`, String.raw`JSXExpressionContainer[expression.type='Literal'][expression.value=/\S/]`, USERNAME_CHILD]
const PERSON_NAME_CONCATENATION = [
  ...[...fieldValueIn('TemplateLiteral', 'displayName'), ...fieldValueIn('BinaryExpression[operator=\'+\']', 'displayName')].map(selector => ({ selector, message: PERSON_NAME_MESSAGE })),
  ...NAME_NEIGHBOURS.flatMap(neighbour => [
    { selector: `${neighbour} ~ ${DISPLAY_NAME_CHILD}`, message: PERSON_NAME_MESSAGE },
    { selector: `${DISPLAY_NAME_CHILD} ~ ${neighbour}`, message: PERSON_NAME_MESSAGE },
  ]),
]

// 读屏用的状态区（role="status"）要一直在无障碍树里（M2-P5 审查 B 的 M1）：display: none 或 visibility: hidden 的状态区不在树里，
// 内容出现时等于与容器一起插入，部分读屏软件不播报（M2-P2 复验）。空的时候只做视觉隐藏：用 shared/ui 的 StatusRegion。
// lint 近似地拦下 role="status"（字面量）的元素上的几种写法：
// - className 里出现 hidden 或 invisible：字符串、模板字符串、cn() 等调用的参数、条件表达式的两支都算，带变体前缀的（empty:hidden、
//   md:hidden、!hidden）也算；cn()、clsx() 的对象写法里键是 hidden 或 invisible 的（{ hidden: 条件 }，键写成字符串的已在上一条里）；
// - hidden 属性；aria-hidden 属性（M2-P5 复验 G1：状态区自己带 aria-hidden，同样不在树里）；
// - style 里 display: 'none' 或 visibility: 'hidden'。
// 认不出、由审查保证的写法（M2-P5 复验 G1 的探针列出的漏报，复验第二轮 G5 补上最后一段）：类名经变量、常量或函数转一手；
// style 里的值是条件表达式（display: 条件 ? 'none' : 'block'）、键写成字符串（'display': 'none'）；Tailwind 的 collapse（visibility: collapse）；
// inert 属性；只有 aria-live、没有 role 的区域；role 不是字面量；由组件按 props 给出 role 的（例如 Alert 默认 role="status"，
// <Alert className="hidden"> 认不出）；StatusRegion 的 className 是有内容时的样式，写进 hidden（例如 "hidden md:block"）有内容时同样离开无障碍树；
// 只看元素自己，祖先带 hidden 类、hidden 属性或 aria-hidden 的认不出；隐含 status 角色的 <output>；style 的值带类型断言
// （display: 'none' as const）、style 里 visibility: 'collapse'；展开的属性（{...{ hidden: true }}）。
// 会误报的（元素其实还在无障碍树里）：hidden={false}、aria-hidden={false}、aria-hidden="false" 也拦下（等于没写，去掉即可）；
// className 里与字面量 'hidden' 做比较的（例如 cn('x', state === 'hidden' && 'y')）也拦下，改写比较即可；className 里任何名叫 hidden 或
// invisible 的属性都拦下，包括对象写法里值是 false 的（{ hidden: false }）、cva 一类的变体参数（variants({ hidden: true })），
// 改名或去掉即可（复验第二轮 G5）。对 web 的生产代码生效，与人名的限制同在那几块
const LIVE_STATUS_MESSAGE = '读屏用的状态区（role="status"）要一直在无障碍树里，空的时候不能 display: none（hidden、empty:hidden）、invisible 或 aria-hidden：用 shared/ui 的 StatusRegion（空的时候只做视觉隐藏，M2-P5 审查 B 的 M1）'
/** role 是字面量 "status" 的 JSX 元素（role="status" 与 role={'status'}） */
const LIVE_STATUS_ELEMENT = 'JSXOpeningElement:has(> JSXAttribute[name.name=\'role\']:matches([value.value=\'status\'], [value.expression.value=\'status\']))'
/** 类名里让元素离开无障碍树的那几个：hidden、invisible，可以带变体前缀（empty:、md:、group-hover/x:）与 Tailwind 的 ! */
const HIDING_CLASS = String.raw`/(?:^|\s)(?:\S+:)?!?(?:hidden|invisible)!?(?:\s|$)/`
const LIVE_STATUS_HIDDEN = [
  { selector: `${LIVE_STATUS_ELEMENT} > JSXAttribute[name.name='className'] Literal[value=${HIDING_CLASS}]`, message: LIVE_STATUS_MESSAGE },
  { selector: `${LIVE_STATUS_ELEMENT} > JSXAttribute[name.name='className'] TemplateElement[value.raw=${HIDING_CLASS}]`, message: LIVE_STATUS_MESSAGE },
  // cn()、clsx() 的对象写法里键是标识符的：{ hidden: 条件 }、{ invisible }（计算出来的键 [x] 不算）
  { selector: `${LIVE_STATUS_ELEMENT} > JSXAttribute[name.name='className'] Property[computed=false][key.type='Identifier'][key.name=/^(?:hidden|invisible)$/]`, message: LIVE_STATUS_MESSAGE },
  { selector: `${LIVE_STATUS_ELEMENT} > JSXAttribute[name.name='hidden']`, message: LIVE_STATUS_MESSAGE },
  { selector: `${LIVE_STATUS_ELEMENT} > JSXAttribute[name.name='aria-hidden']`, message: LIVE_STATUS_MESSAGE },
  {
    selector: `${LIVE_STATUS_ELEMENT} > JSXAttribute[name.name='style'] Property:matches([key.name='display'][value.value='none'], [key.name='visibility'][value.value='hidden'])`,
    message: LIVE_STATUS_MESSAGE,
  },
]

/**
 * web 的生产代码对 no-restricted-syntax 的整组限制（nerve/web-radix-dialog），与编辑器里 internal-api 与测试代码之外的整组限制
 * （nerve/editor-sdk-dom-markers）。同名规则后者整体覆盖前者：在它们之上再加一条的块（页面自检的入口页、页面自检与 E2E 共用的文件，
 * 复验 C3）从这里展开，不各抄一份，免得以后改一处漏一处
 */
const WEB_RESTRICTED_SYNTAX = [...BASE_RESTRICTED_SYNTAX, ...RADIX_DIALOG_OUTSIDE_DIALOG_FILE, ...SDK_DOM_MARKERS, ...PERSON_NAME_CONCATENATION, ...LIVE_STATUS_HIDDEN]
const EDITOR_OUTSIDE_INTERNAL_API_SYNTAX = [...EDITOR_RESTRICTED_SYNTAX, ...NO_GET_INJECTOR, ...RADIX_DIALOG_OUTSIDE_DIALOG_FILE, ...SDK_DOM_MARKERS, ...PERSON_NAME_CONCATENATION, ...LIVE_STATUS_HIDDEN]

// 契约的请求结构里直接用 z.uuid()：大写的 id 原样交给服务端（M2-P2 审查 A1、复验 N3）
const CONTRACTS_REQUEST_UUID_MESSAGE = '请求里的 UUID 用 uuidSchema（ids/ids.ts，统一转成小写）：服务端按字符串比较 id 的地方（是不是本人、审计的明细）只认小写（M2-P2 审查 A1）'
const CONTRACTS_REQUEST_UUID = [
  {
    selector: 'CallExpression[callee.property.name=\'strictObject\'] CallExpression[callee.object.name=\'z\'][callee.property.name=\'uuid\']',
    message: CONTRACTS_REQUEST_UUID_MESSAGE,
  },
  {
    selector: String.raw`VariableDeclarator[id.name=/IdSchema$/] CallExpression[callee.object.name='z'][callee.property.name='uuid']`,
    message: CONTRACTS_REQUEST_UUID_MESSAGE,
  },
]

// ---- 后端（P2 设计 §3.1）----
// 每个后端文件的限制由 apiRules() 按"这个文件允许什么"组合出来，各覆盖块不各自抄一份，免得改一处漏一处（审查 B15）

// 数据库：只有仓储访问数据库（规范 §1.2，审查 B2）。
// 按包名锚定开头：包本身、包里的子路径与 pg-* 系列；本地文件（./pg-errors.ts）不算（复验 N6、F1）
const API_DATABASE_LIBRARIES = {
  regex: String.raw`^(?:pg|drizzle-orm)(?:$|\W)`,
  message: '只有 database 模块、各模块的 *.repository.ts 与 src/db/schema 能引用数据库的库（规范 §1.2）',
}
const API_DATABASE_HANDLES = {
  regex: String.raw`(?:^|/)database/index\.ts$`,
  importNames: ['DATABASE', 'executorOf', 'Database', 'DbExecutor', 'DbTransaction'],
  message: '只有仓储访问数据库：服务需要事务时用 TransactionRunner 开启，把事务传给仓储（规范 §1.2）',
}
const API_TABLES = {
  regex: String.raw`(?:^|/)db/schema/`,
  message: '表只由所属模块的仓储读写（规范 §1.2）；共用的枚举放在 contracts',
}
// 控制器不访问数据库、不写业务规则，事务由服务开启
const API_REPOSITORY_FROM_CONTROLLER = {
  regex: String.raw`\.repository(?:\.ts)?$`,
  message: '控制器不访问数据库、不写业务规则，经服务调用（规范 §1.2）',
}
const API_TRANSACTIONS_FROM_CONTROLLER = {
  regex: String.raw`(?:^|/)database/index\.ts$`,
  importNames: ['TransactionRunner'],
  message: '控制器不写业务规则，事务由服务开启（规范 §1.2）',
}
// 引用的写法要唯一，按引用路径与包名生效的限制才可靠（复验 F2、F3）：
// - 后端不用动态导入：受限导入与模块边界都只检查静态引用；
// - 相对引用写源文件的扩展名 .ts：写成 .js 同样能解析到源文件，却认不出是 database/index.ts；
// - Nest 只从包的入口引用：包里的深层路径同样能拿到 Logger 与不经校验的装饰器。
// 其余写法（例如路径里夹 ./、先在仓储里转出数据库句柄、createRequire）由审查保证
const API_NO_DYNAMIC_IMPORT = {
  selector: 'ImportExpression',
  message: '后端不用动态导入：受限导入与模块边界都只检查静态引用（P2 设计 §3.1）',
}
const API_RELATIVE_JS_EXTENSION = {
  regex: String.raw`^\.{1,2}/(?:.*/)?[^/]+\.[cm]?jsx?$`,
  message: '相对引用写源文件的扩展名 .ts：同一个文件只有一种写法，按路径生效的限制才可靠（P2 设计 §3.1）',
}
const API_NEST_DEEP_IMPORTS = {
  regex: String.raw`^@nestjs/[^/]+/`,
  message: '从包的入口引用 Nest（例如 @nestjs/common），不用包里的深层路径：按包名的限制只认入口（P2 设计 §3.1）',
}
// Nest 的 Logger 经进程级的静态实例转发，同一个进程里后建的应用会接管先建的应用的日志；应用代码用注入的 AppLogger（P2 设计 §3.4）
const API_NO_NEST_LOGGER = {
  name: '@nestjs/common',
  importNames: ['Logger', 'ConsoleLogger'],
  message: '应用代码经依赖注入使用 AppLogger（modules/logging），不用 Nest 的 Logger（P2 设计 §3.4）',
}
// 只有 config 模块读取 process.env（规范 §7）：node/no-process-env 只认 process.env，其他读法另外拦下（审查 B3）。
// 自动检查覆盖 import { env }、解构、globalThis.process.env 与给 process 改名的引用；再绕一层的写法（先赋给别的变量）由审查保证
const PROCESS_ENV_MESSAGE = '只有 config 模块读取环境变量（规范 §7）'
const PROCESS_ALIAS_MESSAGE = '引用 process 时不改名、不用命名空间：改了名，环境变量的检查就认不出来（规范 §7）'
const PROCESS_MODULE = String.raw`ImportDeclaration[source.value=/^(?:node:)?process$/]`
const API_PROCESS_ENV_IMPORTS = [
  { name: 'node:process', importNames: ['env'], message: PROCESS_ENV_MESSAGE },
  { name: 'process', importNames: ['env'], message: PROCESS_ENV_MESSAGE },
]
const API_PROCESS_ENV_SYNTAX = [
  { selector: 'VariableDeclarator[init.name=\'process\'] > ObjectPattern > Property[key.name=\'env\']', message: PROCESS_ENV_MESSAGE },
  { selector: 'AssignmentExpression[right.name=\'process\'] > ObjectPattern > Property[key.name=\'env\']', message: PROCESS_ENV_MESSAGE },
  { selector: 'MemberExpression[property.name=\'env\'][object.property.name=\'process\']', message: PROCESS_ENV_MESSAGE },
  { selector: `${PROCESS_MODULE} > ImportDefaultSpecifier[local.name!='process']`, message: PROCESS_ALIAS_MESSAGE },
  { selector: `${PROCESS_MODULE} > ImportNamespaceSpecifier`, message: PROCESS_ALIAS_MESSAGE },
]
// 只用参数化查询（规范 §5）：sql 模板标签会把插值变成参数。
// 自动检查覆盖 query()、execute() 的第一个参数（SQL 文本；含对象写法的 text）直接写成的拼接：带插值的模板字符串、+、concat()；
// 以及任何 .raw（含解构与别名）。其余写法（先拼成变量再传入，join()、replace()、String()、类型断言、三元表达式里的拼接）由审查保证（审查 B7、复验 N6、F5）
const SQL_CALL = 'CallExpression[callee.property.name=/^(?:query|execute)$/]'
const SQL_TEMPLATE_MESSAGE = 'SQL 不能用带插值的模板字符串拼接，用参数或 sql 模板标签（规范 §5）'
const SQL_CONCAT_MESSAGE = 'SQL 不能用字符串拼接，用参数或 sql 模板标签（规范 §5）'
/** SQL 文本的位置：第一个参数本身，或者第一个参数是对象时它的 text；后面的参数是绑定的值，不管 */
const SQL_TEXT_POSITIONS = [
  (node: string) => `${SQL_CALL} > ${node}:first-child`,
  (node: string) => `${SQL_CALL} > ObjectExpression:first-child > Property[key.name='text'] > ${node}`,
]
const API_SQL_CONCATENATION = SQL_TEXT_POSITIONS.flatMap(at => [
  { selector: at('TemplateLiteral[expressions.length>0]'), message: SQL_TEMPLATE_MESSAGE },
  { selector: at('BinaryExpression[operator=\'+\']'), message: SQL_CONCAT_MESSAGE },
  { selector: at('CallExpression[callee.property.name=\'concat\']'), message: SQL_CONCAT_MESSAGE },
])
const API_NO_RAW = {
  property: 'raw',
  message: '不用 .raw 拼接 SQL：用 sql 模板标签，动态的片段只能来自代码里的白名单（规范 §5）；表定义里的 CHECK 常量除外',
}
// antfu 的配置给 no-restricted-properties 的几项：同名规则后者整体覆盖前者，自己配置这条规则的块（后端、测试）要带上它们
const ANTFU_RESTRICTED_PROPERTIES = [
  { property: '__proto__', message: 'Use `Object.getPrototypeOf` or `Object.setPrototypeOf` instead.' },
  { property: '__defineGetter__', message: 'Use `Object.defineProperty` instead.' },
  { property: '__defineSetter__', message: 'Use `Object.defineProperty` instead.' },
  { property: '__lookupGetter__', message: 'Use `Object.getOwnPropertyDescriptor` instead.' },
  { property: '__lookupSetter__', message: 'Use `Object.getOwnPropertyDescriptor` instead.' },
]
// 有条件地跳过用例同样是跳过（规范 §8.4）：test/no-disabled-tests 只认 .skip 与 x 前缀，playwright/no-skipped-test 只认 test.skip 一类。
// skipIf、runIf 与用例里的 skip()（测试上下文的 ctx.skip()、解构出来的 skip、Playwright 的 testInfo.skip()）在测试里一并拦下；
// 确需跳过时用 eslint-disable 注释在 -- 之后写明原因（eslint-comments/require-description 要求写），经审查（M2-P6 第 6 片复核 S4）。
// it.skip、test.skip、describe.skip 另由上面两条规则报出，这里放过，不重复。
// 会误报的（复核第二批 G-c）：按属性名判断，测试里普通对象的 skip 属性同样报出，例如分页参数（page.skip、{ skip } = query 的解构）；
// test.describe.skip 这类两层的写法除了 playwright/no-skipped-test 再报一次。现在都没有这样的写法；遇到时换个名字（例如 offset），
// 或在那一行关掉检查、在 -- 之后写明原因
const TEST_SKIP_MESSAGE = '有条件地跳过用例（skipIf、runIf、用例里的 skip()）同样是跳过（规范 §8.4）：确需跳过时用 eslint-disable 注释在 -- 之后写明原因，经审查（M2-P6 第 6 片复核 S4）'
const TEST_SKIP_PROPERTIES = [
  { property: 'skipIf', message: TEST_SKIP_MESSAGE },
  { property: 'runIf', message: TEST_SKIP_MESSAGE },
  { property: 'skip', allowObjects: ['it', 'test', 'describe', 'suite'], message: TEST_SKIP_MESSAGE },
]
// 输入都经 contracts 里的结构校验（规范 §4）：参数装饰器必须带 schema；不接受 schema 的装饰器与原始的请求、响应对象会绕过校验（审查 B8）。
// 不经校验的装饰器在引用处就拦下（改名、命名空间引用、深层路径都拦得住），装饰器的写法再查一遍；
// 自己写的参数装饰器能拿到整个请求，由审查把关（复验 N6、F2）
const UNVALIDATED_PARAMETER_DECORATORS = ['Req', 'Request', 'Res', 'Response', 'Next', 'Headers', 'Ip', 'Session', 'HostParam', 'RawBody', 'UploadedFile', 'UploadedFiles']
const UNVALIDATED_DECORATOR_MESSAGE = '不用 @Req、@Res、@Headers 等不经校验的参数装饰器：需要请求里的信息时写参数装饰器（P2 设计 §3.1）'
const API_NO_UNVALIDATED_DECORATORS = {
  name: '@nestjs/common',
  importNames: UNVALIDATED_PARAMETER_DECORATORS,
  message: UNVALIDATED_DECORATOR_MESSAGE,
}
const API_PARAMETER_DECORATORS = [
  {
    selector: 'Decorator > CallExpression[callee.name=/^(?:Body|Query|Param)$/]:not(:has(Property[key.name=\'schema\']))',
    message: '输入必须带 schema，例如 @Body({ schema: createDocumentRequestSchema })（规范 §4）',
  },
  {
    selector: `Decorator > CallExpression[callee.name=/^(?:${UNVALIDATED_PARAMETER_DECORATORS.join('|')})$/]`,
    message: UNVALIDATED_DECORATOR_MESSAGE,
  },
]
const API_CONTROLLER_OUTSIDE_CONTROLLER_FILE = {
  selector: 'Decorator > CallExpression[callee.name=\'Controller\']',
  message: '控制器只写在 *.controller.ts 里：控制器的限制按文件名生效（P2 设计 §3.1）',
}
// 停用者文档的转移（DocumentTransferService）按 id 整批改写文档所在的空间，不经内容权限（M2-P2 设计 §3.8）：只由管理界面的模块调用，
// 它在调用之前检查系统管理员与停用的账户（M2-P2 审查 A9）。documents 模块自己经相对路径引用，不经公开入口，不受影响。
// 静态导入、import type 与再导出都拦下；命名空间导入（import * as）同样拦下
const API_DOCUMENT_TRANSFER = {
  regex: String.raw`(?:^|/)documents/index\.ts$`,
  importNames: ['DocumentTransferService'],
  message: '停用者文档的转移（DocumentTransferService）不经内容权限，只由管理界面的模块（modules/admin）调用（M2-P2 审查 A9）',
}
// 吊销本机密钥的入口（LocalKeyRevocation）不判断调用者是谁、有没有权限（M3-P6 设计 §3.7）：只由管理界面的模块调用，它在调用之前
// 在锁里复核操作者（system-admins 的共享锁）、锁住账户的行（两个并发的吊销由此串起来）。local-keys 模块自己经相对路径引用，不经公开入口，
// 不受影响；管理界面的控制器同样拦下（后面按文件类型的块），只有它的服务调用。写法同上：静态导入、import type、再导出与命名空间导入都拦下
const API_LOCAL_KEY_REVOCATION = {
  regex: String.raw`(?:^|/)local-keys/index\.ts$`,
  importNames: ['LocalKeyRevocation'],
  message: '吊销本机密钥的入口（LocalKeyRevocation）不判断调用者的权限，只由管理界面的模块（modules/admin）的服务调用：它先在锁里复核操作者、锁住账户的行（M3-P6 设计 §3.7）',
}
// 本机密钥的主密钥（LOCAL_KEYS_CONFIG）只给 local-keys 模块注入（M3-P6 设计 §3.4）：主密钥环在那里派生包装键与标识，别的模块经配置拿不到
// 主密钥（应用进程的 APP_CONFIG 里本来就去掉了它）。config 模块自己经相对路径引用，不受影响；app 层只调用 ConfigModule.forServer
const API_LOCAL_KEYS_CONFIG = {
  regex: String.raw`(?:^|/)config/index\.ts$`,
  importNames: ['LOCAL_KEYS_CONFIG'],
  message: '本机密钥的主密钥（LOCAL_KEYS_CONFIG）只给 local-keys 模块注入：别的模块经配置拿不到主密钥（M3-P6 设计 §3.4）',
}
// 到期的回收站清理（TrashPurgeService）不判断人的权限（操作者是系统，归档的空间照样清，M2-P4 设计 §3.1）：
// 只由定时任务的模块（modules/jobs）调用，人工的永久删除走 TrashService.purge。写法同上：静态导入、import type、
// 再导出与命名空间导入都拦下
const API_TRASH_PURGE = {
  regex: String.raw`(?:^|/)documents/index\.ts$`,
  importNames: ['TrashPurgeService'],
  message: '到期的回收站清理（TrashPurgeService）不判断人的权限，只由定时任务的模块（modules/jobs）调用（M2-P4 设计 §3.1）',
}
// 修订记录与回执的保留期清理（RevisionPurgeService）同样不判断人的权限，删掉的是别人的请求记录（M3-P3 设计 §3.9）：
// 只由定时任务的模块调用，写法同上
const API_REVISION_PURGE = {
  regex: String.raw`(?:^|/)documents/index\.ts$`,
  importNames: ['RevisionPurgeService'],
  message: '修订记录与回执的保留期清理（RevisionPurgeService）不判断人的权限，只由定时任务的模块（modules/jobs）调用（M3-P3 设计 §3.9）',
}
// 永久删除一个删除单元的本体（TrashEntryPurger）不判断任何人的权限：只在 documents 模块内部由 TrashService.purge（锁下判断过权限之后）
// 与 TrashPurgeService（到期的清理）调用，不从公开入口导出。别的模块直接引用它的文件由模块边界拦下；这里再拦下经公开入口的引用，
// 将来有人把它加进入口也拦得住。jobs 也不例外：它只经 TrashPurgeService（M2-P6 复核 A 的 G1）
const API_TRASH_ENTRY_PURGER = {
  regex: String.raw`(?:^|/)documents/index\.ts$`,
  importNames: ['TrashEntryPurger'],
  message: '永久删除一个删除单元的本体（TrashEntryPurger）不判断权限，只在 documents 模块内部使用：人工的永久删除经 TrashService.purge，到期的清理经 TrashPurgeService（M2-P6 复核 A 的 G1）',
}
// 一个模块的仓储只在这个模块里用（规范 §1.2）：别的模块需要它的数据时调用它的服务。模块边界只放行经公开入口（index.ts）的引用，
// 公开入口转出了仓储，别的模块就拿得到——documents 的公开入口转出 DocumentsRepository，只为集成测试专用的入口
// （app/integration.test-support.ts，集成测试直接核对仓储的查询范围，M2-P6 复核 A 的 S3）；documents 的服务经访问策略判断权限之后
// 才查询，别的模块拿到它的仓储就绕开了"可访问文档"的范围。所以按导入名拦下经任何 index.ts 引用的 *Repository（静态导入、import type、
// 再导出、命名空间导入与 export * 都算）：app 层的程序接口（app/index.ts）也不例外，命令行与 app 层的其他文件经它转手时，按路径的限制
// 认不出来（复验 R-S4）。模块自己的文件按相对路径引用自己的仓储（./x.repository.ts），不经 index.ts，不受影响；
// 仓储的类名都以 Repository 结尾（lint-rules-api.test.ts 核对每个 *.repository.ts，M2-P6 第 6 片复核 S4）。
// 会误报的（复核第二批 G-c）：按导入名的模式判断时，命名空间导入与 export * 认不出拿到的是哪些名字，所以 api 里经任何 index.ts 的
// import * as x 与 export * 一律报出，即使那个入口根本不转出仓储（现在没有这样的写法）；需要时改成按名字导入、按名字转出
const API_FOREIGN_REPOSITORIES = {
  regex: String.raw`(?:^|/)index\.ts$`,
  importNamePattern: 'Repository$',
  message: '一个模块的仓储只在这个模块里使用（规范 §1.2）：别的模块经它的服务（documents 的服务先经访问策略判断权限，M2-P6 复核 A 的 S3）；公开入口转出仓储只为集成测试专用的入口（app/integration.test-support.ts，M2-P6 第 6 片复核 S4）',
}
// documents 与 users 的仓储里一串 id 一律作为一个数组参数（database 模块的 inIdArray，M2-P6 复核 A 的 S-2、B 的 G1）：drizzle 的 inArray、
// notInArray 把每个 id 展开成一个参数，超过 65535 个参数时整条语句失败（每次都失败）。documents：子树里的文件夹、文档与连带的删除单元
// 没有数量上限；users：授权列表、成员列表补人名的人数没有分页的上界（M2-P5 审查 B 的 G6）。
// 包的入口与深层路径（drizzle-orm/sql/expressions 等）都拦下；别的模块的 id 列表有上限（分页、批量），不受这条限制
const API_ID_LISTS = {
  regex: String.raw`^drizzle-orm(?:$|/)`,
  importNames: ['inArray', 'notInArray'],
  message: 'documents 与 users 的仓储里一串 id 用 inIdArray（database 模块，整串 id 是一个数组参数）：drizzle 的 inArray、notInArray 把每个 id 展开成一个参数，数量没有上限时（子树里的文档、授权列表与成员列表的人）超过 65535 个参数整条语句失败（M2-P6 复核 A 的 S-2，M2-P5 审查 B 的 G6）',
}
// 集成测试专用的入口（M2-P6 复验 R-S4）：它转出数据库句柄与 documents 的仓储，只有 tests/integration 能引用。
// apps/api 里的任何文件（包括 app 层的其他文件与单元测试）引用它都拦下：按解析之后的路径判断，相对路径、包名的出口
// （@nerve-office/api/testing）都认得出；别的元素（命令行、各模块）另由模块边界拦下
const API_INTEGRATION_ENTRY = 'apps/api/src/app/integration.test-support.ts'
// 与时间有关的判断用数据库时间（规范 §5）：应用主机的时钟与数据库的不一致时，"到期了没有"两边的答案不同，例如定时清理按主机的钟
// 判断，钟快多少就提前多少永久删除（M2-P6 复核 A 的 Q-1、第 3 片 G7）。后端不取本机的"现在"：Date.now()、不带参数的 new Date()
// 与当作函数调用的 Date()；业务里的"现在"取数据库的 now()（database 模块的 DatabaseTime），时刻的比较尽量写在 SQL 里。
// 测试同样不用（规范 §8.1：时间可控，用假时钟）。进程自己的计时不是业务判断，按文件放行（API_WALL_CLOCK_FILES）；
// 经别名、globalThis.Date 之类的写法 lint 认不出来，由审查保证（M2-P6 第 6 片复核 S5）
const API_WALL_CLOCK_MESSAGE = '后端不取本机的"现在"（Date.now()、new Date()、Date()）：与时间有关的判断用数据库时间（规范 §5），取 database 模块的 DatabaseTime 或写在 SQL 里；进程自己的计时按文件放行（eslint.config.ts 的 API_WALL_CLOCK_FILES，M2-P6 第 6 片复核 S5）'
const API_WALL_CLOCK = [
  { selector: 'CallExpression[callee.object.name=\'Date\'][callee.property.name=\'now\']', message: API_WALL_CLOCK_MESSAGE },
  { selector: 'NewExpression[callee.name=\'Date\'][arguments.length=0]', message: API_WALL_CLOCK_MESSAGE },
  { selector: 'CallExpression[callee.name=\'Date\']', message: API_WALL_CLOCK_MESSAGE },
]
/**
 * 可以用本机时钟的后端文件：进程自己的计时，不是业务里的时间判断。
 * - 关停的时限（app/shutdown.ts）：从收到信号起算的几秒，与数据库无关，数据库可能已经不可用；
 * - 就绪检查结果的缓存（database 模块的 database-readiness.ts）：探针频繁时一秒内复用上一次的结果，检查本身就是在问数据库还在不在
 */
const API_WALL_CLOCK_FILES = {
  app: ['apps/api/src/app/shutdown.ts'],
  database: ['apps/api/src/modules/database/database-readiness.ts'],
}

/** 后端文件允许的例外。 */
interface ApiFileKind {
  /** 引用 drizzle-orm 与 pg（database 模块、仓储、表定义） */
  databaseLibraries?: boolean
  /** 引用 DATABASE、executorOf 与数据库类型（database 模块、仓储；集成测试专用的入口为集成测试转出） */
  databaseHandles?: boolean
  /** 引用表定义（仓储、表定义之间） */
  tables?: boolean
  /** 用 .raw（表定义里的 CHECK 常量） */
  rawSql?: boolean
  /** 控制器：可以写 @Controller；不引用仓储与 TransactionRunner */
  controller?: boolean
  /** 读取环境变量（config 模块） */
  processEnv?: boolean
  /** 引用停用者文档的转移 DocumentTransferService（管理界面的模块与 documents 模块） */
  documentTransfer?: boolean
  /** 引用吊销本机密钥的入口 LocalKeyRevocation（管理界面的模块，M3-P6） */
  localKeyRevocation?: boolean
  /** 注入本机密钥的主密钥 LOCAL_KEYS_CONFIG（local-keys 模块，M3-P6） */
  localKeysConfig?: boolean
  /**
   * 引用 documents 只给定时任务的入口：到期的回收站清理 TrashPurgeService、修订记录与回执的保留期清理 RevisionPurgeService
   * （定时任务的模块与 documents 模块）
   */
  jobEntries?: boolean
  /** 经别的模块的公开入口引用它的仓储（只有集成测试专用的入口，为集成测试转出 documents 的仓储） */
  foreignRepositories?: boolean
  /** 一串 id 只用一个数组参数，不用 drizzle 的 inArray、notInArray（documents 与 users 的仓储） */
  idArraysOnly?: boolean
  /** 用本机的时钟（Date.now() 等）：进程自己的计时，不是业务里的时间判断（API_WALL_CLOCK_FILES） */
  wallClock?: boolean
}

function apiRules(kind: ApiFileKind = {}): Linter.RulesRecord {
  const paths = [API_NO_NEST_LOGGER, API_NO_UNVALIDATED_DECORATORS, ...(kind.processEnv === true ? [] : API_PROCESS_ENV_IMPORTS)]
  const patterns = [
    UNIVER_ONLY_IN_EDITOR,
    NO_UNIVER_PRO,
    NO_NODE_MODULES_PATH,
    NO_UPPERCASE_PACKAGE,
    API_RELATIVE_JS_EXTENSION,
    API_NEST_DEEP_IMPORTS,
    ...(kind.databaseLibraries === true ? [] : [API_DATABASE_LIBRARIES]),
    ...(kind.databaseHandles === true ? [] : [API_DATABASE_HANDLES]),
    ...(kind.tables === true ? [] : [API_TABLES]),
    ...(kind.controller === true ? [API_REPOSITORY_FROM_CONTROLLER, API_TRANSACTIONS_FROM_CONTROLLER] : []),
    ...(kind.documentTransfer === true ? [] : [API_DOCUMENT_TRANSFER]),
    ...(kind.localKeyRevocation === true ? [] : [API_LOCAL_KEY_REVOCATION]),
    ...(kind.localKeysConfig === true ? [] : [API_LOCAL_KEYS_CONFIG]),
    ...(kind.jobEntries === true ? [] : [API_TRASH_PURGE, API_REVISION_PURGE]),
    API_TRASH_ENTRY_PURGER,
    ...(kind.foreignRepositories === true ? [] : [API_FOREIGN_REPOSITORIES]),
    ...(kind.idArraysOnly === true ? [API_ID_LISTS] : []),
  ]
  const syntax = [
    ...BASE_RESTRICTED_SYNTAX,
    API_NO_DYNAMIC_IMPORT,
    ...API_SQL_CONCATENATION,
    ...API_PARAMETER_DECORATORS,
    ...(kind.controller === true ? [] : [API_CONTROLLER_OUTSIDE_CONTROLLER_FILE]),
    ...(kind.processEnv === true ? [] : API_PROCESS_ENV_SYNTAX),
    ...(kind.wallClock === true ? [] : API_WALL_CLOCK),
  ]
  return {
    'no-restricted-imports': ['error', { paths, patterns }],
    'no-restricted-syntax': ['error', ...syntax],
    'no-restricted-properties': ['error', ...ANTFU_RESTRICTED_PROPERTIES, ...(kind.rawSql === true ? [] : [API_NO_RAW])],
    'node/no-process-env': kind.processEnv === true ? 'off' : 'error',
    // React 的规则把 Nest 的 useFactory、useValue 当作 Hook；后端没有 React
    'react/no-unnecessary-use-prefix': 'off',
  }
}

/** 元素之间只经公开入口引用；同一个元素内部不受限制（ADR-003）。 */
const PUBLIC_ENTRY = 'index.{ts,tsx}'

/**
 * 只给按需加载的页面（与编辑器页）用的文案：shared/i18n/zh-cn/ 下的文件与引用它的那一个功能（M2-P6 复核第二批）。
 * 平台页面首屏用到的在 messages.ts（经 shared/i18n/index.ts 给出），不在这里
 */
const LAZY_TEXTS: readonly { readonly file: string, readonly feature: string }[] = [
  { file: 'admin.ts', feature: 'admin' },
  { file: 'members.ts', feature: 'members' },
  { file: 'colleagues.ts', feature: 'colleagues' },
  { file: 'trash.ts', feature: 'trash' },
  { file: 'search.ts', feature: 'search' },
  { file: 'sharing.ts', feature: 'sharing' },
  { file: 'shared-with-me.ts', feature: 'shared-with-me' },
  { file: 'editor.ts', feature: 'sheet-editor' },
]

/** web 元素里的测试与测试辅助（相对元素的路径）：不进产物，模块边界上按需放行 */
const WEB_TEST_CODE = ['**/*.test.{ts,tsx}', '**/*.test-support.{ts,tsx}']

/**
 * 页面自检与 E2E 共用的文件（M3-P2 设计 §3.5，相对编辑器元素的路径）：只读入口的清单与预期、比较口径、自检结果的格式、
 * 模式切换的计时（S5：E2E 的实测与真实 Safari 的自检用同一套）、捕获时机复核的样本（M3-P4 S1：E2E 的生成器写库，自检按它核对）、
 * 测试构建的自动保存控制（M3-P4 设计 §3.14：E2E 用它挂在 window 上的名字、sessionStorage 的键与日志的写法）、交接日志（M3-P5 设计 §3.13 的
 * 观察钩子：E2E 与真实 Safari 的页面自检用它挂在 window 上的名字与记录的写法）。
 * 它们在 editor/testing/ 下（只在测试构建里），E2E 经模块边界的例外引用它们，所以它们不引用任何模块（nerve/editor-testing-shared）
 */
const SELFTEST_SHARED_FILES = ['testing/read-only-entries.ts', 'testing/content-compare.ts', 'testing/selftest-report.ts', 'testing/switch-timing.ts', 'testing/capture-samples.ts', 'testing/autosave-control.ts', 'testing/handover-log.ts']

/** 链接地址判定的跨引擎用例（M3-P3 设计 §3.2，相对 contracts 元素的路径）：Node 的单元测试与 E2E 共用的测试辅助 */
const LINK_ADDRESS_CASES_FILE = 'documents/link-address.test-support.ts'

// 动态 import() 同样是引用（复验 C3）：ts/no-restricted-imports 只看 import 与 export 声明，下面两块按路径的限制挡不住动态引入——
// 自检的入口页动态引入 shared/api 时 lint 放行，测试构建里两个页面的入口块照样多出 api、preload-helper（实测）。
// 这两组文件本来都用不着动态引入，一律不许
const SELFTEST_SHARED_NO_DYNAMIC_IMPORT = {
  selector: 'ImportExpression',
  message: '页面自检与 E2E 共用的文件（SELFTEST_SHARED_FILES）不引用任何模块，动态 import() 也不行：E2E 也引用它们，Playwright 的进程里不能带进 Univer 与 web 的其他代码（M3-P2 设计 §3.5，复验 C3）',
}
const SELFTEST_ENTRY_NO_DYNAMIC_IMPORT = {
  selector: 'ImportExpression',
  message: '页面自检的入口页不用动态 import()：受限导入只看 import 与 export 声明，动态引入平台页面、编辑器页共用的模块，测试构建里两个页面的入口块照样与生产构建的不同（M3-P2 复核 B4，复验 C3）',
}

/**
 * 共享层内部引用这些文案：模块边界不检查同一个元素内部的引用（boundaries/dependencies 的 checkInternals 默认关），
 * 改按解析之后的路径拦下——shared/i18n/index.ts 转出、shared 里别的文件中转，都会把它们带回首屏（M2-P6 复核第二批）
 */
const LAZY_TEXT_ZONES = LAZY_TEXTS.map(({ file, feature }) => ({
  target: 'apps/web/src/shared',
  from: `apps/web/src/shared/i18n/zh-cn/${file}`,
  message: `这份文案（shared/i18n/zh-cn/${file}）只由按需加载的 features/${feature} 引用：共享层（包括 shared/i18n/index.ts）转出或中转会把它带进平台页面的首屏（M2-P6 复核第二批）`,
}))

/**
 * 只给平台页面用的请求层模块不经 shared/api/index.ts 转出（M2-P6 复核第二批）：编辑器页也引用这个桶文件，转出就进了两个入口共用的块，
 * 实测平台页面的入口随之多出两个小块（共用的 react-router 等不再并进入口块，另有一个运行时的块）。用到的地方按路径引用。
 * 这条只是早期提示，只拦得住经桶文件转出这一条路（经 session.ts 等再转出、经 shared/lib 中转、编辑器那边直接引用都拦不住）；
 * 门禁 budgets 按平台页面首屏的文件数（2 个）从结果上兜住（第三批 S-b，tools/src/gates/policy.ts）
 */
const PLATFORM_ONLY_API_ZONES = ['request-ids.ts', 'write-outcome.ts'].map(file => ({
  target: 'apps/web/src/shared/api/index.ts',
  from: `apps/web/src/shared/api/${file}`,
  message: `shared/api/${file} 只给平台页面用，不经 shared/api/index.ts 转出：编辑器页也引用这个桶文件，转出会让平台页面的入口多出两个小块；用到的地方按路径引用（M2-P6 复核第二批）`,
}))

// ---- 测试代码只在测试里用（审查 B17）----
const CODE_FILES = '**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}'
/** 测试代码：测试、测试辅助、tests/ 下的包与测试的初始化文件。它们可以引用测试库与彼此 */
const TEST_CODE = ['**/*.test.{ts,tsx,mts,cts,js,jsx,mjs,cjs}', '**/*.test-support.{ts,tsx,mts,cts,js,jsx,mjs,cjs}', 'tests/**', '**/vitest.setup.*']
/** 构建与工具的配置、web 的构建插件：本来就用开发依赖（Vite、ESLint、drizzle-kit），不进产物 */
const BUILD_CODE = ['**/*.config.{ts,mts,cts,js,mjs,cjs}', 'apps/*/build/**']
const TEST_MODULES = {
  // 不区分大小写（no-restricted-imports 的默认）；带查询或片段（?raw、#x）也算（复验 S5）
  regex: String.raw`\.test(?:-support)?(?:\.[cm]?[jt]sx?)?(?:[?#].*)?$`,
  message: '测试与测试辅助（*.test.*、*.test-support.*）只被测试代码引用，不进入生产代码（审查 B17）',
}

/** 规范 §2.2：lint 不设警告级别，规则要么是错误，要么关闭。 */
function promoteRule(entry: Linter.RuleEntry): Linter.RuleEntry {
  if (entry === 'warn' || entry === 1)
    return 'error'
  if (Array.isArray(entry) && (entry[0] === 'warn' || entry[0] === 1)) {
    const options: readonly unknown[] = entry.slice(1)
    return ['error', ...options] as Linter.RuleEntry
  }
  return entry
}

function promoteWarnings<T extends Linter.Config>(configs: T[]): T[] {
  return configs.map((config) => {
    if (!config.rules)
      return config
    const rules: Linter.RulesRecord = {}
    for (const [name, entry] of Object.entries(config.rules)) {
      if (entry !== undefined)
        rules[name] = promoteRule(entry)
    }
    return { ...config, rules }
  })
}

export default antfu(
  {
    typescript: { tsconfigPath: 'tsconfig.json' },
    react: true,
    jsx: { a11y: true },
    // 文档是手写的中文，不做 lint 与格式化
    markdown: false,
    ignores: [
      'spikes/**',
      'refer/**',
      'docs/**',
      '**/dist/**',
      '**/coverage/**',
      '**/playwright-report/**',
      '**/test-results/**',
      '**/safari-results/**',
      '**/blob-report/**',
      // drizzle-kit 生成的 journal 与快照：合并后不再修改（ADR-005），不做 lint 与格式化。
      // 只忽略这些 JSON：SQL 本来就不检查，误放进迁移目录的代码文件仍然受边界约束（审查 B15）
      'apps/api/src/db/migrations/meta/**',
    ],
  },
  {
    name: 'nerve/rules',
    rules: {
      'ts/no-explicit-any': 'error',
      'ts/no-non-null-assertion': 'error',
      'ts/ban-ts-comment': ['error', { 'ts-expect-error': 'allow-with-description', 'ts-ignore': true, 'ts-nocheck': true }],
      // 只写 'error' 会保留上游配置里 allow: [warn, error] 的选项，这里用空选项覆盖
      'no-console': ['error', {}],
      'unicorn/filename-case': ['error', { case: 'kebabCase' }],
      'react/dom-no-dangerously-set-innerhtml': 'error',
      'no-restricted-imports': ['error', { patterns: [UNIVER_ONLY_IN_EDITOR, NO_UNIVER_PRO, NO_NODE_MODULES_PATH, NO_UPPERCASE_PACKAGE] }],
      'no-restricted-syntax': ['error', ...BASE_RESTRICTED_SYNTAX],
      // 三斜杠引用（/// <reference path|types|lib>）绕得过受限导入与模块边界：类型经 import type 或 tsconfig 的 types 引用（复验 RB4）
      'ts/triple-slash-reference': ['error', { path: 'never', types: 'never', lib: 'never' }],
      // 关掉检查的注释（eslint-disable…）要在 -- 之后写明原因，审查时看得到为什么（M2-P6 第 6 片复核 S4）；重新打开的 eslint-enable 不用写
      'eslint-comments/require-description': ['error', { ignore: ['eslint-enable'] }],
    },
  },
  {
    // 弹窗类的 Radix 原语只在 shared/ui/dialog.tsx 里引入：对 web 的全部文件生效（M2-P2 复验）；SDK 的 DOM 标记同样（P3 审查 A8）。
    // 同名规则后者整体覆盖前者：入口、弹窗的文件与编辑器的块另有自己的 no-restricted-syntax，在那里同样带上这两组限制
    name: 'nerve/web-radix-dialog',
    files: ['apps/web/src/**/*.{ts,tsx}'],
    ignores: [...TEST_CODE, 'apps/web/src/shared/ui/dialog.tsx'],
    rules: {
      'no-restricted-syntax': ['error', ...WEB_RESTRICTED_SYNTAX],
    },
  },
  {
    // 弹窗的文件自己可以引入 Radix 的弹窗原语（上一块不管它），SDK 的 DOM 标记与人名的限制照样生效（P3 审查 A8）
    name: 'nerve/web-dialog-file',
    files: ['apps/web/src/shared/ui/dialog.tsx'],
    rules: {
      'no-restricted-syntax': ['error', ...BASE_RESTRICTED_SYNTAX, ...SDK_DOM_MARKERS, ...PERSON_NAME_CONCATENATION, ...LIVE_STATUS_HIDDEN],
    },
  },
  {
    name: 'nerve/web-app-entries',
    files: ['apps/web/src/entries/*/main.{ts,tsx}'],
    // CSP 阳性对照只在测试构建里，不用 zod，它的入口里就是探针本身的代码；页面自检的入口页同样只在测试构建里、不用 zod，
    // 而且不能引用 zod-jitless 这类与平台页面、编辑器页共用的模块（M3-P2 复核 B4，见 nerve/selftest-entry-self-contained）
    ignores: ['apps/web/src/entries/csp-probe/**', 'apps/web/src/entries/selftest/**'],
    rules: {
      'no-restricted-syntax': ['error', ...BASE_RESTRICTED_SYNTAX, ...APP_ENTRY_SYNTAX, ...RADIX_DIALOG_OUTSIDE_DIALOG_FILE, ...SDK_DOM_MARKERS, ...PERSON_NAME_CONCATENATION, ...LIVE_STATUS_HIDDEN],
    },
  },
  {
    // 编辑器适配层可以引用 @univerjs/*，内部 API 除外：它们只能经 internal-api/ 引用（下一块）
    name: 'nerve/editor-may-import-univer',
    files: ['apps/web/src/editor/**'],
    rules: {
      'no-restricted-imports': ['error', { paths: UNIVER_INTERNAL_SYMBOLS, patterns: EDITOR_UNIVER_SOURCE_PATTERNS }],
      'no-restricted-syntax': ['error', ...EDITOR_RESTRICTED_SYNTAX, ...NO_GET_INJECTOR, ...RADIX_DIALOG_OUTSIDE_DIALOG_FILE],
    },
  },
  {
    // 编辑器里 internal-api 与测试代码之外：对 @univerjs/* 的值引用只允许白名单里的公开符号（M2-P6 复核 F4），在上一块的基础上加这组限制。
    // 同名规则后者整体覆盖前者：登记过的内部符号的清单与导入源的限制一并带上
    name: 'nerve/editor-univer-public-values',
    files: ['apps/web/src/editor/**'],
    ignores: [...TEST_CODE, 'apps/web/src/editor/internal-api/**'],
    rules: {
      'no-restricted-imports': ['error', {
        paths: [...UNIVER_INTERNAL_SYMBOLS, ...UNIVER_PUBLIC_VALUE_PATHS],
        patterns: [...EDITOR_UNIVER_SOURCE_PATTERNS, UNIVER_LOCALE_DEFAULT_ONLY, UNIVER_UNLISTED_SOURCES],
      }],
    },
  },
  {
    // SDK 的 DOM 标记只在 internal-api 里写（P3 审查 A8）：编辑器里 internal-api 与测试代码之外的文件，在上一块的基础上加这组限制。
    // 测试要按 SDK 的界面结构造元素（批注浮层、编辑栏），不受限
    name: 'nerve/editor-sdk-dom-markers',
    files: ['apps/web/src/editor/**'],
    ignores: [...TEST_CODE, 'apps/web/src/editor/internal-api/**'],
    rules: {
      'no-restricted-syntax': ['error', ...EDITOR_OUTSIDE_INTERNAL_API_SYNTAX],
    },
  },
  {
    // 内部 API 的出口（P4 设计 §3.6.9；M2-P3 起有两个：数据的包 index.ts、界面的包 ui.ts）：
    // 这里可以引用受限的内部符号、调用 __getInjector，导出的每一项都要登记（registry.ts）；不用动态 import()（登记表的扫描认不出）
    name: 'nerve/editor-internal-api',
    files: ['apps/web/src/editor/internal-api/**'],
    rules: {
      'no-restricted-imports': ['error', { patterns: EDITOR_UNIVER_SOURCE_PATTERNS }],
      'no-restricted-syntax': ['error', ...EDITOR_RESTRICTED_SYNTAX, ...RADIX_DIALOG_OUTSIDE_DIALOG_FILE, INTERNAL_API_NO_DYNAMIC_IMPORT],
    },
  },
  {
    // 请求里的 UUID 统一成小写（M2-P2 审查 A1）：请求结构（z.strictObject，响应结构都是宽松的 z.object）与路径里的 id（*IdSchema）
    // 用 uuidSchema，不直接用 z.uuid()，免得新写的请求结构又把大写的 id 原样交给服务端（复验 N3）
    name: 'nerve/contracts-request-ids',
    files: ['packages/contracts/src/**/*.ts'],
    ignores: [...TEST_CODE],
    rules: {
      'no-restricted-syntax': ['error', ...BASE_RESTRICTED_SYNTAX, ...CONTRACTS_REQUEST_UUID],
    },
  },
  // 后端：先是所有文件的限制，后面的块按文件类型放开各自需要的部分（后面的块覆盖前面的同名规则）
  { name: 'nerve/api', files: ['apps/api/src/**/*.ts'], rules: apiRules() },
  // 管理界面的模块可以引用停用者文档的转移（M2-P2 审查 A9）与吊销本机密钥的入口（M3-P6），定时任务的模块可以引用到期的回收站清理与修订记录、
  // 回执的保留期清理（M2-P4 设计 §3.1，M3-P3 设计 §3.9）；documents 模块自己都可以；local-keys 模块可以注入主密钥（M3-P6）。
  // 紧跟在上一块之后：后面按文件类型的块（控制器、仓储等）照常拦下，它们不需要
  { name: 'nerve/api-admin', files: ['apps/api/src/modules/admin/**/*.ts'], rules: apiRules({ documentTransfer: true, localKeyRevocation: true }) },
  { name: 'nerve/api-jobs', files: ['apps/api/src/modules/jobs/**/*.ts'], rules: apiRules({ jobEntries: true }) },
  { name: 'nerve/api-documents', files: ['apps/api/src/modules/documents/**/*.ts'], rules: apiRules({ documentTransfer: true, jobEntries: true }) },
  { name: 'nerve/api-local-keys', files: ['apps/api/src/modules/local-keys/**/*.ts'], rules: apiRules({ localKeysConfig: true }) },
  // 集成测试专用的入口为集成测试转出数据库句柄、documents 的仓储与全部的表定义；app 层的程序接口（index.ts）与 app 层的其他文件同样拿不到
  // （复验 N6，M2-P6 复核 A 的 S3、复验 R-S4、复核 B 的 B4）
  { name: 'nerve/api-integration-entry-exports', files: [API_INTEGRATION_ENTRY], rules: apiRules({ databaseHandles: true, foreignRepositories: true, tables: true }) },
  { name: 'nerve/api-database', files: ['apps/api/src/modules/database/**/*.ts'], rules: apiRules({ databaseLibraries: true, databaseHandles: true }) },
  // 进程自己的计时可以用本机时钟（API_WALL_CLOCK_FILES）：紧跟在所属的块之后，其余的限制照旧
  { name: 'nerve/api-app-wall-clock', files: API_WALL_CLOCK_FILES.app, rules: apiRules({ wallClock: true }) },
  { name: 'nerve/api-database-wall-clock', files: API_WALL_CLOCK_FILES.database, rules: apiRules({ databaseLibraries: true, databaseHandles: true, wallClock: true }) },
  { name: 'nerve/api-repositories', files: ['apps/api/src/modules/*/*.repository.ts'], rules: apiRules({ databaseLibraries: true, databaseHandles: true, tables: true }) },
  // documents 与 users 的仓储另外不用 inArray、notInArray（M2-P6 复核 A 的 S-2，M2-P5 审查 B 的 G6）：一串 id 一律是一个数组参数
  {
    name: 'nerve/api-id-array-repositories',
    files: ['apps/api/src/modules/documents/*.repository.ts', 'apps/api/src/modules/users/*.repository.ts'],
    rules: apiRules({ databaseLibraries: true, databaseHandles: true, tables: true, idArraysOnly: true }),
  },
  // 表定义里的 CHECK 约束要把代码里的常量拼成 SQL 字面量（drizzle-kit 不内联参数）；这里只有 DDL 与常量，没有运行时的输入
  { name: 'nerve/api-schema', files: ['apps/api/src/db/schema/**/*.ts'], rules: apiRules({ databaseLibraries: true, tables: true, rawSql: true }) },
  { name: 'nerve/api-controllers', files: ['apps/api/src/**/*.controller.ts'], rules: apiRules({ controller: true }) },
  { name: 'nerve/api-config', files: ['apps/api/src/modules/config/**/*.ts'], rules: apiRules({ processEnv: true }) },
  {
    name: 'nerve/tests',
    files: ['**/*.test.{ts,tsx}', 'tests/**/*.ts'],
    rules: {
      'ts/no-non-null-assertion': 'off',
      // 用例标题以中文或故事编号（US-M1-05 …）开头，"首字母小写"的约定不适用
      'test/prefer-lowercase-title': 'off',
      // 不允许跳过或占位的用例（规范 §8.4）；确需临时跳过时，用 eslint-disable 注释写明原因，经审查
      'test/no-disabled-tests': 'error',
      'test/warn-todo': 'error',
      // 有条件地跳过（skipIf、runIf、用例里的 skip()）同样拦下（TEST_SKIP_PROPERTIES）
      'no-restricted-properties': ['error', ...ANTFU_RESTRICTED_PROPERTIES, ...TEST_SKIP_PROPERTIES],
    },
  },
  // 后端的测试：上一块覆盖了后端各块的同名规则，.raw 的限制一并带上
  { name: 'nerve/api-tests', files: ['apps/api/src/**/*.test.ts'], rules: { 'no-restricted-properties': ['error', ...ANTFU_RESTRICTED_PROPERTIES, API_NO_RAW, ...TEST_SKIP_PROPERTIES] } },
  {
    // 测试代码之外（生产代码与仓库工具）只能引用本包 dependencies 里的包：测试库都在 devDependencies 里，或者根本没有声明。
    // 这条规则同时检查静态导入、动态导入与 import type。本地的测试与测试辅助按路径另外拦下，
    // 用 typescript-eslint 的同名规则单独配置：no-restricted-imports 已按文件类型组合了好几份，扁平配置里同名规则后者整体覆盖前者
    name: 'nerve/test-code-only-in-tests',
    files: [CODE_FILES],
    ignores: [...TEST_CODE, ...BUILD_CODE],
    rules: {
      'import-x/no-extraneous-dependencies': ['error', { devDependencies: false, optionalDependencies: false, peerDependencies: false, includeTypes: true }],
      'ts/no-restricted-imports': ['error', { patterns: [TEST_MODULES] }],
    },
  },
  {
    // 编辑器的 E2E 探针只能动态引入（M2-P6 复核 F5）：编辑器里测试代码与 testing/ 之外的文件，在上一块的基础上加这条限制。
    // 同名规则后者整体覆盖前者：测试与测试辅助的限制一并带上
    name: 'nerve/editor-probe-dynamic-only',
    files: ['apps/web/src/editor/**'],
    ignores: [...TEST_CODE, 'apps/web/src/editor/testing/**'],
    rules: {
      'ts/no-restricted-imports': ['error', { patterns: [TEST_MODULES, EDITOR_PROBE_MODULES] }],
    },
  },
  {
    // 编辑器页的测试构建探针只能动态引入（M4-P1 设计 §3.1）：sheet-editor 里测试代码、testing/ 与页面自检的挂接之外的文件，
    // 在 nerve/test-code-only-in-tests 的基础上加这条限制。同名规则后者整体覆盖前者：测试与测试辅助的限制一并带上
    name: 'nerve/sheet-editor-probe-dynamic-only',
    files: ['apps/web/src/features/sheet-editor/**'],
    ignores: [...TEST_CODE, 'apps/web/src/features/sheet-editor/**/testing/**', 'apps/web/src/features/sheet-editor/selftest-hook.ts'],
    rules: {
      'ts/no-restricted-imports': ['error', { patterns: [TEST_MODULES, SHEET_EDITOR_PROBE_MODULES] }],
    },
  },
  {
    // 页面自检与 E2E 共用的文件不引用任何模块（M3-P2 设计 §3.5）：E2E 经模块边界的例外引用它们，Playwright 的进程里不能带进 Univer
    // 与 web 的其他代码。它们在 editor/testing/ 下，上一块不管它们；同名规则后者整体覆盖前者，测试与测试辅助的限制一并带上。
    // 动态 import() 由 no-restricted-syntax 拦下（复验 C3），编辑器里 internal-api 与测试代码之外的整组限制一并带上
    name: 'nerve/editor-testing-shared',
    files: SELFTEST_SHARED_FILES.map(file => `apps/web/src/editor/${file}`),
    rules: {
      'ts/no-restricted-imports': ['error', { patterns: [TEST_MODULES, {
        regex: '.',
        message: '页面自检与 E2E 共用的文件（SELFTEST_SHARED_FILES）不引用任何模块：E2E 也引用它们，Playwright 的进程里不能带进 Univer 与 web 的其他代码（M3-P2 设计 §3.5）',
      }] }],
      'no-restricted-syntax': ['error', ...EDITOR_OUTSIDE_INTERNAL_API_SYNTAX, SELFTEST_SHARED_NO_DYNAMIC_IMPORT],
    },
  },
  {
    // 页面自检的入口页（entries/selftest，只在测试构建里）不引用平台页面与编辑器页共用的任何模块（contracts、shared、zod……，M3-P2 复核 B4）：
    // 引用了，那些模块在测试构建里成了三个入口共用的，分块的拆法随之改变，两个页面的入口块就与生产构建的不同，E2E 测的不再是生产的样子。
    // 只许引用入口页自己目录里的文件与结果的格式（editor/testing/selftest-report.ts，它不引用任何模块）。
    // 同名规则后者整体覆盖前者：测试与测试辅助的限制一并带上。动态 import() 由 no-restricted-syntax 拦下（复验 C3），web 的整组限制一并带上
    name: 'nerve/selftest-entry-self-contained',
    files: ['apps/web/src/entries/selftest/**'],
    rules: {
      'ts/no-restricted-imports': ['error', { patterns: [TEST_MODULES, {
        regex: String.raw`^(?!\./[\w-]+\.ts$|\.\./\.\./editor/testing/selftest-report\.ts$)`,
        message: '页面自检的入口页只引用自己目录里的文件与结果的格式（editor/testing/selftest-report.ts）：引用平台页面、编辑器页共用的模块，测试构建里两个页面的入口块就与生产构建的不同（M3-P2 复核 B4）',
      }] }],
      'no-restricted-syntax': ['error', ...WEB_RESTRICTED_SYNTAX, SELFTEST_ENTRY_NO_DYNAMIC_IMPORT],
    },
  },
  {
    name: 'nerve/cli-output',
    // 命令行入口直接向终端输出
    files: ['tools/src/**/cli.ts', 'tools/src/**/*-cli.ts', 'tools/src/git/commit-msg.ts'],
    rules: {
      'no-console': 'off',
    },
  },
  {
    name: 'nerve/no-cycles',
    files: ['**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}'],
    plugins: { 'import-x': importX },
    settings: {
      // import-x 默认只解析 .js 等文件，不声明扩展名与解析器就看不到 TypeScript 文件之间的引用
      'import-x/extensions': ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'],
      'import-x/parsers': { '@typescript-eslint/parser': ['.ts', '.tsx', '.mts', '.cts'] },
      'import-x/resolver-next': [
        createTypeScriptImportResolver({ conditionNames: [SOURCE_CONDITION, 'types', 'import', 'default'] }),
        createNodeResolver(),
      ],
    },
    rules: {
      // 只查仓库自己的代码，不遍历 node_modules
      'import-x/no-cycle': ['error', { ignoreExternal: true }],
    },
  },
  {
    // 集成测试专用的入口（app/integration.test-support.ts）只给 tests/integration：apps/api 里的任何文件都不引用它（M2-P6 复验 R-S4）。
    // 按解析之后的路径判断：相对路径（./integration.test-support.ts、../app/…）与包名的出口（@nerve-office/api/testing）都拦得住；
    // 单元测试也不例外（测试辅助的限制 nerve/test-code-only-in-tests 只管生产代码，同一个元素内部又不经模块边界）
    name: 'nerve/api-integration-entry',
    files: ['apps/api/src/**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}'],
    ignores: [API_INTEGRATION_ENTRY],
    rules: {
      'import-x/no-restricted-paths': ['error', {
        basePath: import.meta.dirname,
        zones: [{
          target: 'apps/api/src',
          from: API_INTEGRATION_ENTRY,
          message: '集成测试专用的入口（app/integration.test-support.ts）只给 tests/integration：它转出数据库句柄与 documents 的仓储，apps/api 里的文件经各模块的公开入口（M2-P6 复验 R-S4）',
        }],
      }],
    },
  },
  {
    // 带第三方运行时的重组件（弹窗 dialog.tsx，Radix Dialog，约 12 KiB gzip）不经 shared 的任何文件转出（ADR-008）：
    // web 没有声明 sideEffects，经 shared/ui 的桶文件引用会把它再导出的每个模块都带进首屏，首屏的预算还有余量、门禁 budgets 发现不了。
    // 按解析之后的路径判断：经 shared 里别的文件中转、换写法（'../ui/dialog.tsx'、'./dialog.js'）都拦得住（M2-P1 审查 B2，复验 N2、X6）。
    // 用到弹窗的功能模块（按需加载的管理界面）直接引用它；类型也一样直接引用。Radix 原语本身的限制见 nerve/web-radix-dialog
    name: 'nerve/web-ui-heavy-components',
    files: ['apps/web/src/shared/**/*.{ts,tsx}'],
    // 弹窗自己的文件引入 Radix 的原语；测试与测试辅助不进产物
    ignores: [...TEST_CODE, 'apps/web/src/shared/ui/dialog.tsx'],
    rules: {
      'import-x/no-restricted-paths': ['error', {
        basePath: import.meta.dirname,
        zones: [{
          target: 'apps/web/src/shared',
          from: 'apps/web/src/shared/ui/dialog.tsx',
          message: '弹窗（shared/ui/dialog.tsx，Radix Dialog）不经 shared 的其他文件转出：会随桶文件进平台页面的首屏；用到的功能模块直接引用这个文件（ADR-008，M2-P1 审查 B2）',
        }, ...LAZY_TEXT_ZONES, ...PLATFORM_ONLY_API_ZONES],
      }],
    },
  },
  {
    // 弹窗的文件不受上一块管（它自己引入 Radix 的原语），只给按需加载的页面用的文案的限制照样要有（同名规则后者整体覆盖前者，单独一块）
    name: 'nerve/web-dialog-file-texts',
    files: ['apps/web/src/shared/ui/dialog.tsx'],
    rules: {
      'import-x/no-restricted-paths': ['error', { basePath: import.meta.dirname, zones: LAZY_TEXT_ZONES }],
    },
  },
  {
    // 内部 API 只经两个出口引用（M2-P6 复验 N4）：编辑器里 internal-api 之外的文件（测试也一样）只能引用 internal-api/index.ts 与 ui.ts。
    // 出口导出的每一项在 registry.ts 登记，登记表的自测核对出口与登记一一对应、并扫描 internal-api 里每个文件对 @univerjs/* 的引用都归到
    // 登记的某一项；绕过出口直接引用里面的文件（例如 formula-protocol.ts），引到的东西就不经登记。
    // 按解析之后的路径判断：静态导入、import type、再导出与动态 import() 都算，路径的写法（../internal-api/./x.ts、绕一圈的相对路径）拦得住。
    // 目录名大小写不同的写法（../Internal-API/x.ts）按路径认不出，由类型检查拦下：internal-api 的每个文件都按 tsconfig 的 include 以本来的
    // 写法进了程序，forceConsistentCasingInFileNames 报 TS1149（Linux 上直接解析不到）。类型里的 import('…') 只带类型、不进产物，
    // lint 看不出来，由审查保证（ADR-010）
    name: 'nerve/editor-internal-api-exits',
    files: ['apps/web/src/editor/**/*.{ts,tsx}'],
    ignores: ['apps/web/src/editor/internal-api/**'],
    rules: {
      'import-x/no-restricted-paths': ['error', {
        basePath: import.meta.dirname,
        zones: [{
          target: 'apps/web/src/editor',
          from: 'apps/web/src/editor/internal-api',
          except: ['./index.ts', './ui.ts'],
          message: '内部 API 只经两个出口引用：internal-api/index.ts 与 ui.ts。要用里面别的文件的东西，经出口导出并在 registry.ts 登记（M2-P6 复验 N4）',
        }],
      }],
    },
  },
  {
    name: 'nerve/boundaries',
    // 模块边界只管各元素的目录；配置文件（vite.config.ts 等）不属于任何元素，不在这里检查
    files: [
      'apps/*/src/**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}',
      'apps/*/build/**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}',
      'packages/*/src/**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}',
      'tools/src/**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}',
      'tests/*/**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}',
    ],
    plugins: { boundaries },
    settings: {
      'boundaries/root-path': import.meta.dirname,
      'import/resolver': {
        typescript: { conditionNames: [SOURCE_CONDITION, 'types', 'import', 'default'] },
      },
      'boundaries/elements': [
        { type: 'contracts', pattern: 'packages/contracts/src', partialMatch: false },
        { type: 'web-entry', pattern: 'apps/web/src/entries/*', capture: ['entry'], partialMatch: false },
        { type: 'web-app', pattern: 'apps/web/src/app', partialMatch: false },
        { type: 'web-feature', pattern: 'apps/web/src/features/*', capture: ['feature'], partialMatch: false },
        { type: 'web-shared', pattern: 'apps/web/src/shared', partialMatch: false },
        { type: 'web-editor', pattern: 'apps/web/src/editor', partialMatch: false },
        // web 构建用的 Vite 插件（第三方许可清单等），由 vite.config.ts 引用
        { type: 'web-build', pattern: 'apps/web/build', partialMatch: false },
        // 后端（P2 设计 §3.1）：模块按目录名区分；表定义按所属模块分目录（src/db/schema/<模块>/index.ts）
        // app 是应用的组装与进程入口（main.ts）；index.ts 是命令行与集成测试共用的程序接口，
        // integration.test-support.ts 是只给集成测试的入口（数据库句柄、documents 的仓储与全部的表定义，M2-P6 复验 R-S4、复核 B 的 B4）
        { type: 'api-app', pattern: 'apps/api/src/app', partialMatch: false },
        { type: 'api-shared', pattern: 'apps/api/src/shared', partialMatch: false },
        { type: 'api-module', pattern: 'apps/api/src/modules/*', capture: ['module'], partialMatch: false },
        { type: 'api-schema', pattern: 'apps/api/src/db/schema/*', capture: ['module'], partialMatch: false },
        { type: 'api-cli', pattern: 'apps/api/src/cli', partialMatch: false },
        { type: 'tools', pattern: 'tools/src', partialMatch: false },
        { type: 'integration-tests', pattern: 'tests/integration', partialMatch: false },
        { type: 'e2e-tests', pattern: 'tests/e2e', partialMatch: false },
      ],
    },
    rules: {
      // 目录里的每个文件都必须属于某个元素，每个引用的目标也必须属于某个元素（否则可以借一个"无主"文件绕过边界）
      'boundaries/no-unknown-files': 'error',
      'boundaries/no-unknown-dependencies': 'error',
      'boundaries/dependencies': ['error', {
        default: 'disallow',
        policies: [
          // 同一个元素内部的引用不受限制
          {
            from: { element: { type: ['contracts', 'web-app', 'web-shared', 'web-editor', 'web-build', 'api-app', 'api-shared', 'api-cli', 'tools', 'integration-tests', 'e2e-tests'] } },
            allow: { to: { element: { type: '{{from.element.type}}' } } },
          },
          { from: { element: { type: 'web-entry' } }, allow: { to: { element: { type: 'web-entry', captured: { entry: '{{from.element.captured.entry}}' } } } } },
          { from: { element: { type: 'web-feature' } }, allow: { to: { element: { type: 'web-feature', captured: { feature: '{{from.element.captured.feature}}' } } } } },
          // 跨元素：contracts、功能模块与编辑器只经公开入口（index.ts）；应用与共享层是被组合的一方，可以直接引用
          {
            from: { element: { type: 'web-entry' } },
            allow: { to: [
              { element: { type: ['web-app', 'web-shared'] } },
              { element: { type: ['web-feature', 'contracts'], fileInternalPath: PUBLIC_ENTRY } },
            ] },
          },
          // 编辑器适配层只由编辑器页的入口与编辑器页（sheet-editor 功能）引用，而且只经它的公开入口（P4 设计 §3.1）
          {
            from: [
              { element: { type: 'web-entry', captured: { entry: 'editor' } } },
              { element: { type: 'web-feature', captured: { feature: 'sheet-editor' } } },
            ],
            allow: { to: { element: { type: 'web-editor', fileInternalPath: PUBLIC_ENTRY } } },
          },
          // 真实 Safari 的页面自检（M3-P2 设计 §3.5）：编辑器的 testing/ 只在测试构建里，这里只开三个口子——
          // E2E 引用与自检共用的文件（SELFTEST_SHARED_FILES：清单、比较口径、结果的格式，都不引用别的模块）；
          // 自检的入口页（entries/selftest）引用结果的格式（登录失败时同样交出结果）；
          // 编辑器页的挂接（sheet-editor 的 selftest-hook.ts，start.tsx 只在测试构建里动态引入它）动态引入自检模块
          { from: { element: { type: 'e2e-tests' } }, allow: { to: { element: { type: 'web-editor', fileInternalPath: SELFTEST_SHARED_FILES } } } },
          { from: { element: { type: 'web-entry', captured: { entry: 'selftest' } } }, allow: { to: { element: { type: 'web-editor', fileInternalPath: 'testing/selftest-report.ts' } } } },
          {
            from: { element: { type: 'web-feature', captured: { feature: 'sheet-editor' }, fileInternalPath: ['selftest-hook.ts', 'selftest-hook.test.ts'] } },
            allow: { to: { element: { type: 'web-editor', fileInternalPath: 'testing/selftest.ts' } } },
          },
          // 测试构建的自动保存控制（M3-P4 设计 §3.14）与交接日志（M3-P5 设计 §3.13）：编辑器页的组装处（start.tsx）只在测试构建里动态引入它们
          {
            from: { element: { type: 'web-feature', captured: { feature: 'sheet-editor' }, fileInternalPath: 'start.tsx' } },
            allow: { to: { element: { type: 'web-editor', fileInternalPath: ['testing/autosave-control.ts', 'testing/handover-log.ts'] } } },
          },
          {
            from: { element: { type: 'web-app' } },
            allow: { to: [
              { element: { type: 'web-shared' } },
              { element: { type: ['web-feature', 'contracts'], fileInternalPath: PUBLIC_ENTRY } },
            ] },
          },
          {
            from: { element: { type: 'web-feature' } },
            allow: { to: [
              { element: { type: 'web-shared' } },
              // 功能模块之间只经对方的公开入口（规范 §1.2）；循环依赖另由 import-x/no-cycle 拦下
              { element: { type: ['web-feature', 'contracts'], fileInternalPath: PUBLIC_ENTRY } },
            ] },
          },
          {
            from: { element: { type: 'web-editor' } },
            allow: { to: [
              { element: { type: 'web-shared' } },
              { element: { type: 'contracts', fileInternalPath: PUBLIC_ENTRY } },
            ] },
          },
          { from: { element: { type: ['web-shared', 'api-shared', 'integration-tests', 'e2e-tests'] } }, allow: { to: { element: { type: 'contracts', fileInternalPath: PUBLIC_ENTRY } } } },
          // 链接地址判定的跨引擎用例（M3-P3 设计 §3.2）：同一份表在 Node 的单元测试与三个浏览器的 E2E 里都跑（E2E 经探针调用页面里打包的
          // canonicalLink）。它是测试辅助，不经 contracts 的入口转出（生产代码引用不到它），这里只给 E2E 开这一个文件
          { from: { element: { type: 'e2e-tests' } }, allow: { to: { element: { type: 'contracts', fileInternalPath: LINK_ADDRESS_CASES_FILE } } } },
          // 后端：模块之间只经对方的 index.ts；一个模块只能引用自己的表定义；表定义之间经 index.ts 互相引用（外键）
          { from: { element: { type: 'api-module' } }, allow: { to: { element: { type: 'api-module', captured: { module: '{{from.element.captured.module}}' } } } } },
          { from: { element: { type: 'api-schema' } }, allow: { to: { element: { type: ['api-schema', 'contracts'], fileInternalPath: PUBLIC_ENTRY } } } },
          {
            from: { element: { type: 'api-app' } },
            allow: { to: [
              { element: { type: 'api-shared' } },
              { element: { type: ['api-module', 'contracts'], fileInternalPath: PUBLIC_ENTRY } },
            ] },
          },
          {
            from: { element: { type: 'api-module' } },
            allow: { to: [
              { element: { type: 'api-shared' } },
              { element: { type: ['api-module', 'contracts'], fileInternalPath: PUBLIC_ENTRY } },
              { element: { type: 'api-schema', captured: { module: '{{from.element.captured.module}}' }, fileInternalPath: PUBLIC_ENTRY } },
            ] },
          },
          // admin 与 workspace 是最上层的编排（ADR-014 的分层）：只由 app 层组装，别的模块都不引用它们。
          // 放在允许的策略之后覆盖"模块之间经公开入口"；同一个模块内部的引用不经过这条检查。
          // 这样 admin 转出的东西（例如绕过内容权限的转移）流不到别的模块（M2-P2 复验 N2）
          {
            from: { element: { type: 'api-module', captured: { module: '!admin' } } },
            disallow: { to: { element: { type: 'api-module', captured: { module: 'admin' } } } },
            message: 'admin 是最上层的编排（ADR-014）：只由 app 层组装，别的模块不引用它（M2-P2 复验 N2）',
          },
          {
            from: { element: { type: 'api-module', captured: { module: '!workspace' } } },
            disallow: { to: { element: { type: 'api-module', captured: { module: 'workspace' } } } },
            message: 'workspace 是最上层的编排（ADR-014）：只由 app 层组装，别的模块不引用它（M2-P2 复验 N2）',
          },
          // 命令行经模块的入口，或者经 app 层的程序接口（需要组装多个模块时，例如初始化管理员）
          { from: { element: { type: 'api-cli' } }, allow: { to: { element: { type: ['api-module', 'api-app'], fileInternalPath: PUBLIC_ENTRY } } } },
          // 集成测试专用的入口转出全部的表定义：集成测试按它生成建库语句，与迁移建出的库逐项比较（M2-P6 复核 B 的 B4；取代复验 S1 只核对判重键的那一条）
          { from: { element: { type: 'api-app', fileInternalPath: 'integration.test-support.ts' } }, allow: { to: { element: { type: 'api-schema', fileInternalPath: PUBLIC_ENTRY } } } },
          // 集成测试经 @nerve-office/api 的程序接口建应用，经集成测试专用的入口（@nerve-office/api/testing）拿数据库句柄与仓储（M2-P6 复验 R-S4）
          { from: { element: { type: 'integration-tests' } }, allow: { to: { element: { type: 'api-app', fileInternalPath: [PUBLIC_ENTRY, 'integration.test-support.ts'] } } } },
          {
            from: { element: { type: 'web-entry', captured: { entry: 'platform' } } },
            disallow: { to: { element: { type: 'web-editor' } } },
            message: '平台页面的入口不得引用编辑器，编辑器不进入平台页面的包（规范 §1.2）',
          },
          // 编辑器页带着 Univer：只由编辑器页的入口组合，平台的应用层、其他入口与其他功能都不引用它（P4 设计 §3.1；门禁 budgets 另外兜底）。
          // 放在允许的策略之后，覆盖"功能模块之间经公开入口"的允许；同一个功能内部的引用不经过这条检查
          {
            from: [
              { element: { type: 'web-app' } },
              { element: { type: 'web-entry', captured: { entry: '!editor' } } },
              { element: { type: 'web-feature' } },
            ],
            disallow: { to: { element: { type: 'web-feature', captured: { feature: 'sheet-editor' } } } },
            message: '编辑器页（features/sheet-editor）只由编辑器页的入口引用：它带着 Univer，平台页面的包里不能有它（P4 设计 §3.1）',
          },
          // 管理界面按需加载，不进平台页面的首屏（M2-P1 设计 §3.8，审查 B2）：只有路由表 app/routes.ts 经它的公开入口动态 import()，
          // 任何静态引用（含 import type 与再导出）都会把它带回首屏。页头的入口只引用 shared/lib/admin-paths.ts。
          // 同样放在允许的策略之后：先拦下所有引用，再放行路由表的动态导入（后面的策略覆盖前面的）；同一个功能内部的引用不经过这条检查
          {
            from: [
              { element: { type: 'web-app' } },
              { element: { type: 'web-entry' } },
              { element: { type: 'web-feature' } },
            ],
            disallow: { to: { element: { type: 'web-feature', captured: { feature: 'admin' } } } },
            message: '管理界面（features/admin）按需加载：只有 app/routes.ts 可以动态 import() 它的公开入口，静态引用会把它带进平台页面的首屏（M2-P1 审查 B2）',
          },
          {
            from: { element: { type: 'web-app', fileInternalPath: 'routes.ts' } },
            allow: {
              to: { element: { type: 'web-feature', captured: { feature: 'admin' }, fileInternalPath: PUBLIC_ENTRY } },
              dependency: { nodeKind: 'dynamic-import' },
            },
          },
          // 成员页同样按需加载（M2-P2 设计 §3.10）：它带着确认的弹窗与同事选择，只给查看与管理成员时用
          {
            from: [
              { element: { type: 'web-app' } },
              { element: { type: 'web-entry' } },
              { element: { type: 'web-feature' } },
            ],
            disallow: { to: { element: { type: 'web-feature', captured: { feature: 'members' } } } },
            message: '成员页（features/members）按需加载：只有 app/routes.ts 可以动态 import() 它的公开入口，静态引用会把它带进平台页面的首屏（M2-P2 设计 §3.10）',
          },
          {
            from: { element: { type: 'web-app', fileInternalPath: 'routes.ts' } },
            allow: {
              to: { element: { type: 'web-feature', captured: { feature: 'members' }, fileInternalPath: PUBLIC_ENTRY } },
              dependency: { nodeKind: 'dynamic-import' },
            },
          },
          // 回收站页同样按需加载（M2-P4 设计 §3.7）：它带着确认的弹窗，只有要找回删掉的东西时才用
          {
            from: [
              { element: { type: 'web-app' } },
              { element: { type: 'web-entry' } },
              { element: { type: 'web-feature' } },
            ],
            disallow: { to: { element: { type: 'web-feature', captured: { feature: 'trash' } } } },
            message: '回收站页（features/trash）按需加载：只有 app/routes.ts 可以动态 import() 它的公开入口，静态引用会把它带进平台页面的首屏（M2-P4 设计 §3.7）',
          },
          {
            from: { element: { type: 'web-app', fileInternalPath: 'routes.ts' } },
            allow: {
              to: { element: { type: 'web-feature', captured: { feature: 'trash' }, fileInternalPath: PUBLIC_ENTRY } },
              dependency: { nodeKind: 'dynamic-import' },
            },
          },
          // 搜索结果页同样按需加载（M2-P4 设计 §3.7）：页头的搜索框只带着关键词跳过去，结果的渲染不进首屏
          {
            from: [
              { element: { type: 'web-app' } },
              { element: { type: 'web-entry' } },
              { element: { type: 'web-feature' } },
            ],
            disallow: { to: { element: { type: 'web-feature', captured: { feature: 'search' } } } },
            message: '搜索结果页（features/search）按需加载：只有 app/routes.ts 可以动态 import() 它的公开入口，静态引用会把它带进平台页面的首屏（M2-P4 设计 §3.7）',
          },
          {
            from: { element: { type: 'web-app', fileInternalPath: 'routes.ts' } },
            allow: {
              to: { element: { type: 'web-feature', captured: { feature: 'search' }, fileInternalPath: PUBLIC_ENTRY } },
              dependency: { nodeKind: 'dynamic-import' },
            },
          },
          // 分享对话框（M2-P5 设计 §3.5）：它带着弹窗、同事选择与确认的弹窗。入口在两处，只有这两个文件可以引用它的公开入口：
          // - 平台页面文档的行操作（features/documents/share-entry.tsx）：只能动态 import()（组件级的按需加载，shared/lib/use-lazy-chunk.ts），
          //   静态引用会把它带进平台页面的首屏；
          // - 编辑器页的页头（features/sheet-editor/share-entry.tsx）：静态引用。它用到平台页面首屏里的模块，编辑器页也按需加载的话，
          //   打包会为"平台页面首屏 + 分享对话框"另拆出一块，平台页面的首屏多一个文件（门禁 budgets 的文件数上限）；理由见那个文件的开头
          {
            from: [
              { element: { type: 'web-app' } },
              { element: { type: 'web-entry' } },
              { element: { type: 'web-feature' } },
            ],
            disallow: { to: { element: { type: 'web-feature', captured: { feature: 'sharing' } } } },
            message: '分享对话框（features/sharing）只由入口所在的两个文件引用：平台页面文档的行操作（features/documents/share-entry.tsx，只能动态 import()，静态引用会把它带进平台页面的首屏）与编辑器页的页头（features/sheet-editor/share-entry.tsx）（M2-P5 设计 §3.5）',
          },
          {
            from: { element: { type: 'web-feature', captured: { feature: 'documents' }, fileInternalPath: 'share-entry.tsx' } },
            allow: {
              to: { element: { type: 'web-feature', captured: { feature: 'sharing' }, fileInternalPath: PUBLIC_ENTRY } },
              dependency: { nodeKind: 'dynamic-import' },
            },
          },
          {
            from: { element: { type: 'web-feature', captured: { feature: 'sheet-editor' }, fileInternalPath: 'share-entry.tsx' } },
            allow: { to: { element: { type: 'web-feature', captured: { feature: 'sharing' }, fileInternalPath: PUBLIC_ENTRY } } },
          },
          // "与我共享"页同样按需加载（M2-P5 设计 §3.5）：左侧导航里只有入口，列表的渲染不进首屏
          {
            from: [
              { element: { type: 'web-app' } },
              { element: { type: 'web-entry' } },
              { element: { type: 'web-feature' } },
            ],
            disallow: { to: { element: { type: 'web-feature', captured: { feature: 'shared-with-me' } } } },
            message: '"与我共享"页（features/shared-with-me）按需加载：只有 app/routes.ts 可以动态 import() 它的公开入口，静态引用会把它带进平台页面的首屏（M2-P5 设计 §3.5）',
          },
          {
            from: { element: { type: 'web-app', fileInternalPath: 'routes.ts' } },
            allow: {
              to: { element: { type: 'web-feature', captured: { feature: 'shared-with-me' }, fileInternalPath: PUBLIC_ENTRY } },
              dependency: { nodeKind: 'dynamic-import' },
            },
          },
          // 确认的弹窗带着 Radix Dialog（约 12 KiB gzip）：只由按需加载的功能（管理界面、成员页）引用，
          // 首屏的页面、应用层与入口引用它会把弹窗带进平台页面的首屏（ADR-008，M2-P2 设计 §3.10）。
          // 下面三条都只管平台页面：编辑器页（它的入口与 sheet-editor）是另一个包，有自己的预算（M2-P2 复验）
          {
            from: [
              { element: { type: 'web-app' } },
              { element: { type: 'web-entry', captured: { entry: '!editor' } } },
              { element: { type: 'web-feature', captured: { feature: '!{admin,members,trash,sharing,sheet-editor}' } } },
            ],
            disallow: { to: { element: { type: 'web-feature', captured: { feature: 'confirmation' } } } },
            message: '确认的弹窗（features/confirmation，带 Radix Dialog）只由按需加载的功能（features/admin、features/members、features/trash、features/sharing）引用，不进平台页面的首屏（ADR-008）',
          },
          // 弹窗的文件本身（shared/ui/dialog.tsx，Radix Dialog）同样只由按需加载的功能直接引用（M2-P2 审查 B8）：功能、应用层与入口引用共享层本来是允许的，
          // 这里在允许的策略之后覆盖。shared 内部的中转另由 nerve/web-ui-heavy-components 拦下
          {
            from: [
              { element: { type: 'web-app' } },
              { element: { type: 'web-entry', captured: { entry: '!editor' } } },
              { element: { type: 'web-feature', captured: { feature: '!{admin,members,trash,confirmation,sharing,sheet-editor}' } } },
            ],
            disallow: { to: { element: { type: 'web-shared', fileInternalPath: 'ui/dialog.tsx' } } },
            message: '弹窗（shared/ui/dialog.tsx，带 Radix Dialog）只由按需加载的功能（features/admin、features/members、features/trash、features/confirmation、features/sharing）引用：首屏的功能、应用层与入口引用它会把弹窗带进平台页面的首屏（ADR-008，M2-P2 审查 B8）',
          },
          // 按关键词选一项（features/colleagues：按名字选同事、选团队空间）只给按需加载的管理界面、成员页与分享对话框用（M2-P2 设计 §3.10，审查 B8）
          {
            from: [
              { element: { type: 'web-app' } },
              { element: { type: 'web-entry', captured: { entry: '!editor' } } },
              { element: { type: 'web-feature', captured: { feature: '!{admin,members,sharing,sheet-editor}' } } },
            ],
            disallow: { to: { element: { type: 'web-feature', captured: { feature: 'colleagues' } } } },
            message: '按关键词选一项（features/colleagues）只由按需加载的功能（features/admin、features/members、features/sharing）引用，不进平台页面的首屏（M2-P2 设计 §3.10，审查 B8）',
          },
          // 只给按需加载的页面（与编辑器页）用的文案按功能各放一个文件（shared/i18n/zh-cn/<功能>.ts，M2-P6 复核第二批）：只由对应的功能引用。
          // 应用层、入口、别的功能、编辑器适配层与共享层（包括 shared/i18n/index.ts 的转出）引用它，就会把它带进平台页面的首屏。
          // 同样放在允许的策略之后，覆盖"共享层可以随意引用"；测试与测试辅助不进产物，下一条再放行
          ...LAZY_TEXTS.map(({ file, feature }) => ({
            from: [
              { element: { type: ['web-app', 'web-entry', 'web-shared', 'web-editor'] } },
              { element: { type: 'web-feature', captured: { feature: `!${feature}` } } },
            ],
            disallow: { to: { element: { type: 'web-shared', fileInternalPath: `i18n/zh-cn/${file}` } } },
            message: `这份文案（shared/i18n/zh-cn/${file}）只由按需加载的 features/${feature} 引用：别处引用（包括经 shared/i18n/index.ts 转出）会把它带进平台页面的首屏（M2-P6 复核第二批）`,
          })),
          {
            from: { element: { type: ['web-app', 'web-entry', 'web-feature', 'web-shared', 'web-editor'], fileInternalPath: WEB_TEST_CODE } },
            allow: { to: { element: { type: 'web-shared', fileInternalPath: LAZY_TEXTS.map(({ file }) => `i18n/zh-cn/${file}`) } } },
          },
        ],
      }],
    },
  },
  {
    name: 'nerve/playwright',
    files: ['tests/e2e/**/*.spec.ts'],
    ...playwright.configs['flat/recommended'],
    rules: {
      ...playwright.configs['flat/recommended'].rules,
      'playwright/no-focused-test': 'error',
      // test.fixme 同样算跳过
      'playwright/no-skipped-test': ['error', { disallowFixme: true }],
    },
  },
).onResolved(promoteWarnings)

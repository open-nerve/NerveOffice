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
  { name: '@univerjs/core', importNames: ['AuthzIoLocalService', 'IAuthzIoService', 'LifecycleService', 'UserManagerService'], message: INTERNAL_API_MESSAGE },
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
  { name: '@univerjs/sheets', importNames: ['SetRangeValuesMutation'], message: INTERNAL_API_MESSAGE },
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
// 类型里的 import('…') 同样绕得过：编辑器里的 @univerjs/* 类型用 import type 引用（复验 RB4）
const EDITOR_TYPE_IMPORT_UNIVER = {
  selector: 'TSImportType[source.value=/^@univerjs/]',
  message: '编辑器里的 @univerjs/* 类型用 import type 引用：内部 API 与深层路径的限制只认导入语句（复验 RB4）',
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

// 弹窗类的 Radix 原语（Dialog、AlertDialog）只在 shared/ui/dialog.tsx 里引入（M2-P1 复验）：shared 的其他文件直接从 radix-ui 引入，
// 同样会随桶文件进首屏，按路径的限制（import-x/no-restricted-paths）管不到第三方包
const RADIX_DIALOG_OUTSIDE_DIALOG_FILE = [
  {
    selector: String.raw`:matches(ImportDeclaration, ExportNamedDeclaration)[source.value='radix-ui'] > :matches(ImportSpecifier[imported.name=/^(?:Dialog|AlertDialog)$/], ExportSpecifier[local.name=/^(?:Dialog|AlertDialog)$/])`,
    message: '弹窗类的 Radix 原语（Dialog、AlertDialog）只在 shared/ui/dialog.tsx 里引入：shared 的其他文件引用它，会随桶文件进平台页面的首屏（ADR-008，M2-P1 审查 B2）',
  },
  {
    selector: String.raw`:matches(ImportDeclaration, ExportNamedDeclaration, ExportAllDeclaration, ImportExpression)[source.value=/^@radix-ui\/react-(?:alert-)?dialog(?:\/|$)/]`,
    message: '弹窗类的 Radix 原语（Dialog、AlertDialog）只在 shared/ui/dialog.tsx 里引入：shared 的其他文件引用它，会随桶文件进平台页面的首屏（ADR-008，M2-P1 审查 B2）',
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

/** 后端文件允许的例外。 */
interface ApiFileKind {
  /** 引用 drizzle-orm 与 pg（database 模块、仓储、表定义） */
  databaseLibraries?: boolean
  /** 引用 DATABASE、executorOf 与数据库类型（database 模块、仓储；app 层的程序接口为集成测试转出） */
  databaseHandles?: boolean
  /** 引用表定义（仓储、表定义之间） */
  tables?: boolean
  /** 用 .raw（表定义里的 CHECK 常量） */
  rawSql?: boolean
  /** 控制器：可以写 @Controller；不引用仓储与 TransactionRunner */
  controller?: boolean
  /** 读取环境变量（config 模块） */
  processEnv?: boolean
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
  ]
  const syntax = [
    ...BASE_RESTRICTED_SYNTAX,
    API_NO_DYNAMIC_IMPORT,
    ...API_SQL_CONCATENATION,
    ...API_PARAMETER_DECORATORS,
    ...(kind.controller === true ? [] : [API_CONTROLLER_OUTSIDE_CONTROLLER_FILE]),
    ...(kind.processEnv === true ? [] : API_PROCESS_ENV_SYNTAX),
  ]
  return {
    'no-restricted-imports': ['error', { paths, patterns }],
    'no-restricted-syntax': ['error', ...syntax],
    'no-restricted-properties': kind.rawSql === true ? 'off' : ['error', API_NO_RAW],
    'node/no-process-env': kind.processEnv === true ? 'off' : 'error',
    // React 的规则把 Nest 的 useFactory、useValue 当作 Hook；后端没有 React
    'react/no-unnecessary-use-prefix': 'off',
  }
}

/** 元素之间只经公开入口引用；同一个元素内部不受限制（ADR-003）。 */
const PUBLIC_ENTRY = 'index.{ts,tsx}'

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
    },
  },
  {
    name: 'nerve/web-app-entries',
    files: ['apps/web/src/entries/*/main.{ts,tsx}'],
    // CSP 阳性对照只在测试构建里，不用 zod，它的入口里就是探针本身的代码
    ignores: ['apps/web/src/entries/csp-probe/**'],
    rules: {
      'no-restricted-syntax': ['error', ...BASE_RESTRICTED_SYNTAX, ...APP_ENTRY_SYNTAX],
    },
  },
  {
    // 编辑器适配层可以引用 @univerjs/*，内部 API 除外：它们只能经 internal-api/ 引用（下一块）
    name: 'nerve/editor-may-import-univer',
    files: ['apps/web/src/editor/**'],
    rules: {
      'no-restricted-imports': ['error', { paths: UNIVER_INTERNAL_SYMBOLS, patterns: [NO_UNIVER_PRO, NO_NODE_MODULES_PATH, NO_UPPERCASE_PACKAGE, UNIVER_QUERY_IMPORTS, UNIVER_DEEP_IMPORTS] }],
      'no-restricted-syntax': ['error', ...EDITOR_RESTRICTED_SYNTAX, ...NO_GET_INJECTOR],
    },
  },
  {
    // 内部 API 的唯一出口（P4 设计 §3.6.9）：这里可以引用受限的内部符号、调用 __getInjector，导出的每一项都要登记（registry.ts）
    name: 'nerve/editor-internal-api',
    files: ['apps/web/src/editor/internal-api/**'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [NO_UNIVER_PRO, NO_NODE_MODULES_PATH, NO_UPPERCASE_PACKAGE, UNIVER_QUERY_IMPORTS, UNIVER_DEEP_IMPORTS] }],
      'no-restricted-syntax': ['error', ...EDITOR_RESTRICTED_SYNTAX],
    },
  },
  // 后端：先是所有文件的限制，后面的块按文件类型放开各自需要的部分（后面的块覆盖前面的同名规则）
  { name: 'nerve/api', files: ['apps/api/src/**/*.ts'], rules: apiRules() },
  // app 层的程序接口（index.ts）为集成测试转出数据库句柄；app 层的其他文件同样拿不到（复验 N6）
  { name: 'nerve/api-app-entry', files: ['apps/api/src/app/index.ts'], rules: apiRules({ databaseHandles: true }) },
  { name: 'nerve/api-database', files: ['apps/api/src/modules/database/**/*.ts'], rules: apiRules({ databaseLibraries: true, databaseHandles: true }) },
  { name: 'nerve/api-repositories', files: ['apps/api/src/modules/*/*.repository.ts'], rules: apiRules({ databaseLibraries: true, databaseHandles: true, tables: true }) },
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
    },
  },
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
    // 带第三方运行时的重组件（弹窗 dialog.tsx，Radix Dialog，约 12 KiB gzip）不经 shared 的任何文件转出（ADR-008）：
    // web 没有声明 sideEffects，经 shared/ui 的桶文件引用会把它再导出的每个模块都带进首屏，首屏的预算还有余量、门禁 budgets 发现不了。
    // 按解析之后的路径判断：经 shared 里别的文件中转、换写法（'../ui/dialog.tsx'、'./dialog.js'）都拦得住（M2-P1 审查 B2，复验 N2、X6）。
    // 用到弹窗的功能模块（按需加载的管理界面）直接引用它；类型也一样直接引用
    name: 'nerve/web-ui-heavy-components',
    files: ['apps/web/src/shared/**/*.{ts,tsx}'],
    // 弹窗自己的文件引入 Radix 的原语；测试与测试辅助不进产物
    ignores: [...TEST_CODE, 'apps/web/src/shared/ui/dialog.tsx'],
    rules: {
      'no-restricted-syntax': ['error', ...BASE_RESTRICTED_SYNTAX, ...RADIX_DIALOG_OUTSIDE_DIALOG_FILE],
      'import-x/no-restricted-paths': ['error', {
        basePath: import.meta.dirname,
        zones: [{
          target: 'apps/web/src/shared',
          from: 'apps/web/src/shared/ui/dialog.tsx',
          message: '弹窗（shared/ui/dialog.tsx，Radix Dialog）不经 shared 的其他文件转出：会随桶文件进平台页面的首屏；用到的功能模块直接引用这个文件（ADR-008，M2-P1 审查 B2）',
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
        // app 是应用的组装与进程入口（main.ts）；index.ts 是命令行与集成测试共用的程序接口
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
          // 命令行经模块的入口，或者经 app 层的程序接口（需要组装多个模块时，例如初始化管理员）
          { from: { element: { type: 'api-cli' } }, allow: { to: { element: { type: ['api-module', 'api-app'], fileInternalPath: PUBLIC_ENTRY } } } },
          // 集成测试经 @nerve-office/api 的程序接口建应用
          { from: { element: { type: 'integration-tests' } }, allow: { to: { element: { type: 'api-app', fileInternalPath: PUBLIC_ENTRY } } } },
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

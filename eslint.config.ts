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

// 动态导入同样受限：no-restricted-imports 只管静态导入与再导出。
// esquery 的正则字面量里不能出现斜杠，所以用前缀判断
const antfuRestrictedSyntax = ['TSEnumDeclaration[const=true]', 'TSExportAssignment']
const DYNAMIC_IMPORT_LITERAL_ONLY = {
  selector: 'ImportExpression[source.type!=\'Literal\']',
  message: '动态导入的路径必须是字面量，否则受限导入与模块边界都检查不到',
}
const DYNAMIC_UNIVER = {
  selector: 'ImportExpression[source.value=/^@univerjs(?!-pro)/]',
  message: '只有 apps/web/src/editor/ 可以引用 @univerjs/*（规范 §1.2）',
}
const DYNAMIC_UNIVER_PRO = {
  selector: 'ImportExpression[source.value=/^@univerjs-pro/]',
  message: '禁止引入 @univerjs-pro/*（00 号计划书 §3.3）',
}

const BASE_RESTRICTED_SYNTAX = [...antfuRestrictedSyntax, DYNAMIC_IMPORT_LITERAL_ONLY, DYNAMIC_UNIVER, DYNAMIC_UNIVER_PRO]

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
      'no-restricted-imports': ['error', { patterns: [UNIVER_ONLY_IN_EDITOR, NO_UNIVER_PRO] }],
      'no-restricted-syntax': ['error', ...BASE_RESTRICTED_SYNTAX],
    },
  },
  {
    name: 'nerve/editor-may-import-univer',
    files: ['apps/web/src/editor/**'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [NO_UNIVER_PRO] }],
      'no-restricted-syntax': ['error', ...antfuRestrictedSyntax, DYNAMIC_IMPORT_LITERAL_ONLY, DYNAMIC_UNIVER_PRO],
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
              { element: { type: ['web-feature', 'web-editor', 'contracts'], fileInternalPath: PUBLIC_ENTRY } },
            ] },
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
          { from: { element: { type: 'api-cli' } }, allow: { to: { element: { type: 'api-module', fileInternalPath: PUBLIC_ENTRY } } } },
          // 集成测试经 @nerve-office/api 的程序接口建应用
          { from: { element: { type: 'integration-tests' } }, allow: { to: { element: { type: 'api-app', fileInternalPath: PUBLIC_ENTRY } } } },
          {
            from: { element: { type: 'web-entry', captured: { entry: 'platform' } } },
            disallow: { to: { element: { type: 'web-editor' } } },
            message: '平台页面的入口不得引用编辑器，编辑器不进入平台页面的包（规范 §1.2）',
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

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

// 后端（P2 设计 §3.1）：只有 database 模块、各模块的仓储与表定义能访问数据库
const API_DATABASE_LIBRARIES = {
  group: ['drizzle-orm', 'drizzle-orm/**', 'pg'],
  message: '只有 database 模块、各模块的 *.repository.ts 与 src/db/schema 能访问数据库（规范 §1.2）',
}
const API_REPOSITORY_FROM_CONTROLLER = {
  regex: String.raw`\.repository(?:\.ts)?$`,
  message: '控制器不访问数据库、不写业务规则，经服务调用（规范 §1.2）',
}
// 只用参数化查询（规范 §5）：sql 模板标签会把插值变成参数；query()、execute() 的参数不能是拼出来的字符串
const API_NO_SQL_CONCATENATION = [
  {
    selector: 'CallExpression[callee.object.name=\'sql\'][callee.property.name=\'raw\']',
    message: '不用 sql.raw 拼接 SQL：用 sql 模板标签，动态的片段只能来自代码里的白名单（规范 §5）',
  },
  {
    selector: 'CallExpression[callee.property.name=/^(?:query|execute)$/] > TemplateLiteral[expressions.length>0]',
    message: 'SQL 不能用带插值的模板字符串拼接，用参数或 sql 模板标签（规范 §5）',
  },
  {
    selector: 'CallExpression[callee.property.name=/^(?:query|execute)$/] > BinaryExpression[operator=\'+\']',
    message: 'SQL 不能用字符串拼接，用参数或 sql 模板标签（规范 §5）',
  },
]
// 控制器的输入都经 contracts 里的结构校验（规范 §4）；原始的请求与响应对象会绕过校验与统一的错误响应
const API_CONTROLLER_PARAMETERS = [
  {
    selector: 'Decorator > CallExpression[callee.name=/^(?:Body|Query|Param)$/]:not(:has(Property[key.name=\'schema\']))',
    message: '控制器的输入必须带 schema，例如 @Body({ schema: createDocumentRequestSchema })（规范 §4）',
  },
  {
    selector: 'Decorator > CallExpression[callee.name=/^(?:Req|Request|Res|Response|Next)$/]',
    message: '不用 @Req、@Res、@Next：需要请求里的信息时写参数装饰器（P2 设计 §3.1）',
  },
]

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
  {
    name: 'nerve/api',
    files: ['apps/api/src/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [UNIVER_ONLY_IN_EDITOR, NO_UNIVER_PRO, API_DATABASE_LIBRARIES] }],
      'no-restricted-syntax': ['error', ...BASE_RESTRICTED_SYNTAX, ...API_NO_SQL_CONCATENATION],
      // 只有 config 模块读取 process.env（规范 §7）
      'node/no-process-env': 'error',
    },
  },
  {
    name: 'nerve/api-database-access',
    files: ['apps/api/src/modules/database/**/*.ts', 'apps/api/src/modules/*/*.repository.ts', 'apps/api/src/db/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [UNIVER_ONLY_IN_EDITOR, NO_UNIVER_PRO] }],
    },
  },
  {
    name: 'nerve/api-controllers',
    files: ['apps/api/src/**/*.controller.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [UNIVER_ONLY_IN_EDITOR, NO_UNIVER_PRO, API_DATABASE_LIBRARIES, API_REPOSITORY_FROM_CONTROLLER] }],
      'no-restricted-syntax': ['error', ...BASE_RESTRICTED_SYNTAX, ...API_NO_SQL_CONCATENATION, ...API_CONTROLLER_PARAMETERS],
    },
  },
  {
    name: 'nerve/api-config-reads-env',
    files: ['apps/api/src/modules/config/**/*.ts'],
    rules: {
      'node/no-process-env': 'off',
    },
  },
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
          { from: { element: { type: 'api-schema' } }, allow: { to: { element: { type: 'api-schema', fileInternalPath: PUBLIC_ENTRY } } } },
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

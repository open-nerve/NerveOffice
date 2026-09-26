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
      'tools/.gates/**',
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
    },
  },
  {
    name: 'nerve/editor-may-import-univer',
    files: ['apps/web/src/editor/**'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [NO_UNIVER_PRO] }],
    },
  },
  {
    name: 'nerve/tests',
    files: ['**/*.test.{ts,tsx}', 'tests/**/*.ts'],
    rules: {
      'ts/no-non-null-assertion': 'off',
      // 用例标题以中文或故事编号（US-M1-05 …）开头，"首字母小写"的约定不适用
      'test/prefer-lowercase-title': 'off',
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
    files: ['**/*.{ts,tsx}'],
    plugins: { 'import-x': importX },
    settings: {
      'import-x/resolver-next': [
        createTypeScriptImportResolver({ conditionNames: [SOURCE_CONDITION, 'types', 'import', 'default'] }),
        createNodeResolver(),
      ],
    },
    rules: {
      'import-x/no-cycle': 'error',
    },
  },
  {
    name: 'nerve/boundaries',
    files: ['apps/**/*.{ts,tsx}', 'packages/**/*.{ts,tsx}', 'tools/**/*.ts', 'tests/**/*.ts'],
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
        { type: 'tools', pattern: 'tools/src', partialMatch: false },
        { type: 'integration-tests', pattern: 'tests/integration', partialMatch: false },
        { type: 'e2e-tests', pattern: 'tests/e2e', partialMatch: false },
      ],
    },
    rules: {
      'boundaries/dependencies': ['error', {
        default: 'disallow',
        policies: [
          // 同一个元素内部的引用不受限制
          { from: { element: { type: 'contracts' } }, allow: { to: { element: { type: 'contracts' } } } },
          { from: { element: { type: 'tools' } }, allow: { to: { element: { type: 'tools' } } } },
          { from: { element: { type: 'integration-tests' } }, allow: { to: { element: { type: 'integration-tests' } } } },
          { from: { element: { type: 'e2e-tests' } }, allow: { to: { element: { type: 'e2e-tests' } } } },
          {
            from: { element: { type: 'web-entry' } },
            allow: { to: [
              { element: { type: 'web-entry', captured: { entry: '{{from.element.captured.entry}}' } } },
              { element: { type: ['web-app', 'web-feature', 'web-shared', 'web-editor', 'contracts'] } },
            ] },
          },
          { from: { element: { type: 'web-app' } }, allow: { to: { element: { type: ['web-app', 'web-feature', 'web-shared', 'contracts'] } } } },
          {
            from: { element: { type: 'web-feature' } },
            allow: { to: [
              { element: { type: 'web-feature', captured: { feature: '{{from.element.captured.feature}}' } } },
              { element: { type: ['web-shared', 'contracts'] } },
            ] },
          },
          { from: { element: { type: 'web-shared' } }, allow: { to: { element: { type: ['web-shared', 'contracts'] } } } },
          { from: { element: { type: 'web-editor' } }, allow: { to: { element: { type: ['web-editor', 'web-shared', 'contracts'] } } } },
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
      'playwright/no-skipped-test': 'error',
    },
  },
).onResolved(promoteWarnings)

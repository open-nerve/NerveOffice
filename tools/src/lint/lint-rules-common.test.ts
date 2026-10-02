// lint 规则的自测（通用的部分）：受限导入（Univer 只在编辑器、包名小写、动态导入的路径）、循环依赖、规范 §2.1 的类型与写法（每类文件）、
// 关掉检查的注释、测试代码只在测试里、测试的写法。规范里标为【自动】的 lint 规则真的生效；共用的准备与时限见 lint-harness.test-support.ts
import { describe, expect, it } from 'vitest'
import {
  API_CONTROLLER,
  API_SERVICE,
  CONTRACTS_FILE,
  E2E_FILE,
  EDITOR_FILE,
  INTEGRATION_FILE,
  INTERNAL_API_FILE,
  LINT_TIMEOUT,
  prepareLint,
  restrictedPatterns,
  severity,
  TOOLS_TEST_FILE,
  WEB_FEATURE_FILE,
  WEB_FILE,
  WEB_SHARED_FILE,
  WEB_TEST_FILE,
  WEB_TEST_SUPPORT,
} from './lint-harness.test-support.ts'

const { lint, rulesFor, configFor } = prepareLint({ warmUp: [WEB_FILE, CONTRACTS_FILE, TOOLS_TEST_FILE, E2E_FILE, API_CONTROLLER, INTEGRATION_FILE] })

describe('US-M1-11 lint 规则的自测：受限导入', () => {
  it('编辑器之外引用 @univerjs/* 或 Pro 会失败，静态导入、再导出与动态导入都算', async () => {
    expect(await rulesFor('import { Univer } from \'@univerjs/core\'\nexport const u = Univer\n', WEB_FILE)).toContain('no-restricted-imports')
    expect(await rulesFor('export * from \'@univerjs/core\'\n', WEB_FILE)).toContain('no-restricted-imports')
    expect(await rulesFor('import { x } from \'@univerjs-pro/license\'\nexport const y = x\n', WEB_FILE)).toContain('no-restricted-imports')
    expect(await rulesFor('export async function load() {\n  return import(\'@univerjs/core\')\n}\n', WEB_FILE)).toContain('no-restricted-syntax')
    expect(await rulesFor('export async function load() {\n  return import(\'@univerjs-pro/license\')\n}\n', WEB_FILE)).toContain('no-restricted-syntax')
  })

  describe('包名写成大写会失败：静态导入、再导出、动态导入与类型里的 import() 都算，编辑器与后端里也算；包里的路径与相对路径不管（复验 TB5）', () => {
    const cases: [string, string][] = [
      ['import { IFunctionService } from \'@UniverJS/engine-formula\'\n\nexport const s = IFunctionService\n', 'no-restricted-imports'],
      ['import { IFunctionService } from \'@univerjs/Engine-formula\'\n\nexport const s = IFunctionService\n', 'no-restricted-imports'],
      ['export * from \'React\'\n', 'no-restricted-imports'],
      ['export async function load() {\n  return import(\'@UniverJS/engine-formula\')\n}\n', 'no-restricted-syntax'],
      ['export type F = typeof import(\'@UniverJS/engine-formula\')\n', 'no-restricted-syntax'],
    ]

    it.each([WEB_FILE, EDITOR_FILE, INTERNAL_API_FILE, 'apps/api/src/modules/documents/documents.service.ts'])('%s', async (file) => {
      for (const [code, rule] of cases) {
        const report = await lint(code, file)
        expect(report.rules, code).toContain(rule)
        expect(report.messages.join('\n'), code).toContain('包名写成小写')
      }
    })

    it('包里的路径与相对路径不管', async () => {
      const allowed = 'import { createRoot } from \'react-dom/client\'\nimport { Univer } from \'./Sample.ts\'\n\nexport const used = [createRoot, Univer]\n'
      expect((await lint(allowed, WEB_FILE)).messages.join('\n')).not.toContain('包名写成小写')
    })
  })

  it('动态导入的路径必须是字面量', async () => {
    expect(await rulesFor('export async function load(name: string) {\n  return import(name)\n}\n', WEB_FILE)).toContain('no-restricted-syntax')
  })

  it('编辑器适配层可以引用 @univerjs/*，但不能引用 Pro', async () => {
    // 按路径计算配置不需要文件存在
    const editor = await configFor('apps/web/src/editor/adapter.ts')
    expect(restrictedPatterns(editor)).toContain('@univerjs-pro/*')
    expect(restrictedPatterns(editor)).not.toContain('@univerjs/*')
    expect(restrictedPatterns(await configFor(WEB_FILE))).toContain('@univerjs/*')
  })

  it('TypeScript 文件之间的循环依赖会失败', async () => {
    // licenses.ts 被 license-bundle.ts 引用，这里让它反过来引用 license-bundle.ts
    const code = 'import { checkLicenseBundle } from \'./license-bundle.ts\'\n\nexport const f = checkLicenseBundle\n'
    expect(await rulesFor(code, 'tools/src/gates/licenses.ts')).toContain('import-x/no-cycle')
  })
}, LINT_TIMEOUT)

describe('US-M1-11 lint 规则的自测：类型与写法（规范 §2.1），每类文件都生效（M2-P6 第 6 片复核 S4）', () => {
  /** 一段同时违反 §2.1 各条的代码：any、非空断言、console、悬空的 Promise、没覆盖全部分支的 switch、只当类型用却没写 import type、@ts-ignore */
  const VIOLATIONS = [
    'import { z } from \'zod\'',
    '',
    'async function job(): Promise<void> {}',
    '',
    'export type S = z.ZodString',
    '',
    'export function f(x: any, kind: \'a\' | \'b\', y?: string): string {',
    '  console.error(x)',
    '  job()',
    '  switch (kind) {',
    '    case \'a\':',
    '      return y!',
    '  }',
    '  // @ts-ignore',
    '  return 1',
    '}',
    '',
  ].join('\n')
  const RULES = ['ts/no-explicit-any', 'ts/no-non-null-assertion', 'no-console', 'ts/no-floating-promises', 'ts/switch-exhaustiveness-check', 'ts/consistent-type-imports', 'ts/ban-ts-comment']
  /** 测试代码可以用非空断言（规范 §2.1）；命令行的入口直接向终端输出（§2.2） */
  const TEST_EXEMPT = ['ts/no-non-null-assertion']
  const CLI_EXEMPT = ['no-console']
  const FILES: (readonly [file: string, exempt: readonly string[]])[] = [
    [CONTRACTS_FILE, []],
    // web：应用层、功能、共享层、编辑器适配层、内部 API、平台页面的入口挂载的文件、构建插件与构建配置
    [WEB_FILE, []],
    [WEB_FEATURE_FILE, []],
    [WEB_SHARED_FILE, []],
    [EDITOR_FILE, []],
    [INTERNAL_API_FILE, []],
    ['apps/web/src/entries/platform/mount.tsx', []],
    ['apps/web/build/third-party-licenses.ts', []],
    ['apps/web/vite.config.ts', []],
    // 后端：服务、控制器、仓储、配置、表定义、命令行、应用的组装
    [API_SERVICE, []],
    [API_CONTROLLER, []],
    ['apps/api/src/modules/audit/audit.repository.ts', []],
    ['apps/api/src/modules/config/config.ts', []],
    ['apps/api/src/db/schema/audit/index.ts', []],
    ['apps/api/src/cli/migrate.ts', []],
    ['apps/api/src/app/app.module.ts', []],
    // 仓库工具与根目录的配置
    ['tools/src/gates/run.ts', []],
    ['tools/src/gates/cli.ts', CLI_EXEMPT],
    ['vitest.config.ts', []],
    // 测试与测试辅助
    [TOOLS_TEST_FILE, TEST_EXEMPT],
    [WEB_TEST_FILE, TEST_EXEMPT],
    [WEB_TEST_SUPPORT, []],
    ['apps/api/src/app/validation.test.ts', TEST_EXEMPT],
    [INTEGRATION_FILE, TEST_EXEMPT],
    [E2E_FILE, TEST_EXEMPT],
  ]

  it.each(FILES)('%s', async (file, exempt) => {
    const rules = await rulesFor(VIOLATIONS, file)
    expect(rules).toEqual(expect.arrayContaining(RULES.filter(rule => !exempt.includes(rule))))
    for (const rule of exempt)
      expect(rules).not.toContain(rule)
  })

  it('@ts-expect-error 要写明原因', async () => {
    expect(await rulesFor('// @ts-expect-error\nexport const n: number = \'x\'\n', CONTRACTS_FILE)).toContain('ts/ban-ts-comment')
    expect(await rulesFor('// @ts-expect-error 样例：故意赋错类型\nexport const n: number = \'x\'\n', CONTRACTS_FILE)).not.toContain('ts/ban-ts-comment')
  })

  it('禁止 dangerouslySetInnerHTML，图片必须有替代文字（无障碍规则在 ESLint 10 下生效）', async () => {
    const code = 'export function App({ html }: { html: string }) {\n  return <div><div dangerouslySetInnerHTML={{ __html: html }} /><img src="a.png" /></div>\n}\n'
    expect(await rulesFor(code, WEB_FILE)).toEqual(expect.arrayContaining(['react/dom-no-dangerously-set-innerhtml', 'jsx-a11y/alt-text']))
  })

  it('文件名必须是短横线小写', async () => {
    expect((await configFor(CONTRACTS_FILE)).rules?.['unicorn/filename-case']).toEqual([2, { case: 'kebabCase' }])
  })
}, LINT_TIMEOUT)

describe('US-M1-11 lint 规则的自测：关掉检查的注释要在 -- 之后写明原因（M2-P6 第 6 片复核 S4）', () => {
  const RULE = 'eslint-comments/require-description'

  it.each([CONTRACTS_FILE, WEB_FILE, API_SERVICE, 'tools/src/gates/run.ts', TOOLS_TEST_FILE, E2E_FILE])('%s', async (file) => {
    for (const code of ['// eslint-disable-next-line no-console\nconsole.log(1)\n', '/* eslint-disable no-console */\nconsole.log(1)\n', 'console.log(1) // eslint-disable-line no-console\n'])
      expect(await rulesFor(code, file), code).toContain(RULE)
    // 写了原因的放行；重新打开（eslint-enable）不用写。contracts 没有 console 的类型，另报 no-unsafe-call，与这条无关
    const described = await rulesFor('/* eslint-disable no-console -- 样例：说明为什么关掉 */\nconsole.log(1)\n/* eslint-enable no-console */\n', file)
    expect(described).not.toContain(RULE)
    expect(described).not.toContain('no-console')
  })
}, LINT_TIMEOUT)

describe('US-M1-11 lint 规则的自测：测试代码只在测试里（审查 B17）', () => {
  const EXTRANEOUS = 'import-x/no-extraneous-dependencies'

  it('生产代码与仓库工具不能引用测试库：静态导入、import type 与动态导入都算', async () => {
    expect(await rulesFor('import { vi } from \'vitest\'\n\nexport const mock = vi.fn\n', WEB_FILE)).toContain(EXTRANEOUS)
    expect(await rulesFor('import type { Mock } from \'vitest\'\n\nexport type M = Mock\n', WEB_FILE)).toContain(EXTRANEOUS)
    expect(await rulesFor('export async function load(): Promise<unknown> {\n  return import(\'vitest\')\n}\n', WEB_FILE)).toContain(EXTRANEOUS)
    expect(await rulesFor('import { render } from \'@testing-library/react\'\n\nexport const r = render\n', WEB_FILE)).toContain(EXTRANEOUS)
    expect(await rulesFor('import { test } from \'@playwright/test\'\n\nexport const t = test\n', WEB_FILE)).toContain(EXTRANEOUS)
    expect(await rulesFor('import { Test } from \'@nestjs/testing\'\n\nexport const t = Test\n', API_SERVICE)).toContain(EXTRANEOUS)
    expect(await rulesFor('import { describe } from \'vitest\'\n\nexport const d = describe\n', 'tools/src/gates/run.ts')).toContain(EXTRANEOUS)
    // 本包 dependencies 里的包照常引用
    expect(await rulesFor('import { z } from \'zod\'\n\nexport const s = z.string()\n', WEB_FILE)).not.toContain(EXTRANEOUS)
  })

  it('生产代码不能引用测试与测试辅助', async () => {
    expect(await rulesFor('import { renderApp } from \'./render-app.test-support.tsx\'\n\nexport const r = renderApp\n', WEB_FILE)).toContain('ts/no-restricted-imports')
    for (const path of ['./render-app.test-support.tsx?raw', './render-app.TEST-SUPPORT.tsx', './app.test.tsx#x'])
      expect(await rulesFor(`import value from '${path}'\n\nexport const v = value\n`, WEB_FILE), path).toContain('ts/no-restricted-imports')
    expect(await rulesFor('import { installFakeApi } from \'../shared/testing/fake-api.test-support.ts\'\n\nexport const f = installFakeApi\n', WEB_FILE)).toContain('ts/no-restricted-imports')
  })

  it('动态导入测试与测试辅助同样拦下（复验 R3）', async () => {
    const load = (path: string): string => `export async function load(): Promise<unknown> {\n  return import('${path}')\n}\n`
    for (const path of ['../shared/testing/fake-api.test-support.ts', './app.test.tsx', './render-app.test-support', './app.TEST.tsx', '../shared/testing/fake-api.test-support.ts?raw', './app.test.tsx#x'])
      expect(await rulesFor(load(path), WEB_FILE), path).toContain('no-restricted-syntax')
    expect(await rulesFor(load('../../../../tests/integration/src/support/api-app.ts'), 'tools/src/gates/run.ts')).not.toContain('no-restricted-syntax')
  })

  it('测试与测试辅助可以引用测试库与测试辅助；构建配置与构建插件可以用开发依赖', async () => {
    const code = 'import { render } from \'@testing-library/react\'\nimport { vi } from \'vitest\'\nimport { installFakeApi } from \'../shared/testing/fake-api.test-support.ts\'\n\nexport const used = [render, vi, installFakeApi]\n'
    for (const file of [WEB_TEST_SUPPORT, WEB_TEST_FILE]) {
      const rules = await rulesFor(code, file)
      expect(rules, file).not.toContain(EXTRANEOUS)
      expect(rules, file).not.toContain('ts/no-restricted-imports')
    }
    for (const file of ['apps/web/vite.config.ts', 'apps/web/build/third-party-licenses.ts', 'vitest.config.ts', 'tests/integration/src/support/api-app.ts'])
      expect(severity((await configFor(file)).rules?.[EXTRANEOUS]), file).toBeUndefined()
  })
}, LINT_TIMEOUT)

describe('US-M1-11 lint 规则的自测：测试的写法', () => {
  it('不允许 .only', async () => {
    expect(await rulesFor('import { it } from \'vitest\'\n\nit.only(\'x\', () => {})\n', TOOLS_TEST_FILE)).toContain('test/no-only-tests')
    expect(await rulesFor('import { test } from \'@playwright/test\'\n\ntest.only(\'x\', async () => {})\n', E2E_FILE)).toContain('playwright/no-focused-test')
  })

  it('不允许跳过或占位的用例（skip、todo、fixme）', async () => {
    expect(await rulesFor('import { it } from \'vitest\'\n\nit.skip(\'x\', () => {})\n', TOOLS_TEST_FILE)).toContain('test/no-disabled-tests')
    expect(await rulesFor('import { it } from \'vitest\'\n\nit.todo(\'x\')\n', TOOLS_TEST_FILE)).toContain('test/warn-todo')
    expect(await rulesFor('import { test } from \'@playwright/test\'\n\ntest.skip(\'x\', async () => {})\n', E2E_FILE)).toContain('playwright/no-skipped-test')
    expect(await rulesFor('import { test } from \'@playwright/test\'\n\ntest.fixme(\'x\', async () => {})\n', E2E_FILE)).toContain('playwright/no-skipped-test')
  })

  describe('有条件地跳过同样拦下：skipIf、runIf、用例里的 skip()；关闭检查时写明原因就放行（M2-P6 第 6 片复核 S4）', () => {
    const SKIP_MESSAGE = '有条件地跳过用例（skipIf、runIf、用例里的 skip()）同样是跳过'
    const VITEST_CASES = [
      'import { it } from \'vitest\'\n\nconst slow = true\n\nit.skipIf(slow)(\'x\', () => {})\n',
      'import { describe } from \'vitest\'\n\nconst ci = false\n\ndescribe.runIf(ci)(\'x\', () => {})\n',
      'import { it } from \'vitest\'\n\nit(\'x\', (context) => {\n  context.skip()\n})\n',
      'import { it } from \'vitest\'\n\nit(\'x\', ({ skip }) => {\n  skip()\n})\n',
    ]

    // 后端的测试另有一块配置（.raw 的限制一并带上），单独核对
    it.each([TOOLS_TEST_FILE, WEB_TEST_FILE, 'apps/api/src/app/validation.test.ts', 'tests/integration/src/support/held-lock.test.ts'])('%s', async (file) => {
      for (const code of VITEST_CASES) {
        const report = await lint(code, file)
        expect(report.rules, code).toContain('no-restricted-properties')
        expect(report.messages.join('\n'), code).toContain(SKIP_MESSAGE)
      }
      const described = 'import { it } from \'vitest\'\n\nconst slow = true\n\n// eslint-disable-next-line no-restricted-properties -- 样例：说明为什么跳过\nit.skipIf(slow)(\'x\', () => {})\n'
      expect(await rulesFor(described, file)).toEqual([])
    })

    it('Playwright：testInfo.skip() 与有条件的 test.skip() 都拦下', async () => {
      const report = await lint('import { test } from \'@playwright/test\'\n\ntest(\'x\', async ({ page }, testInfo) => {\n  testInfo.skip(true, \'原因\')\n  await page.goto(\'/\')\n})\n', E2E_FILE)
      expect(report.messages.join('\n')).toContain(SKIP_MESSAGE)
      expect(await rulesFor('import { test } from \'@playwright/test\'\n\ntest(\'x\', async ({ page, browserName }) => {\n  test.skip(browserName === \'webkit\', \'原因\')\n  await page.goto(\'/\')\n})\n', E2E_FILE)).toContain('playwright/no-skipped-test')
    })

    it('后端的测试照样拦下 .raw（同名规则由测试的配置块覆盖，后端的测试另配一块）', async () => {
      const report = await lint('declare const sql: { raw: (text: string) => unknown }\n\nexport const s = sql.raw(\'x\')\n', 'apps/api/src/app/validation.test.ts')
      expect(report.messages.join('\n')).toContain('不用 .raw 拼接 SQL')
    })
  })

  it('没有警告级别的规则（规范 §2.2）', async () => {
    for (const file of [WEB_FILE, CONTRACTS_FILE, 'tools/src/git/strip-ai-trailers.ts', E2E_FILE, API_CONTROLLER, INTEGRATION_FILE, 'pnpm-workspace.yaml', 'package.json']) {
      const warned = Object.entries((await configFor(file)).rules ?? {}).filter(([, entry]) => [1, 'warn'].includes(severity(entry) as number | string))
      expect(warned.map(([name]) => `${file} ${name}`)).toEqual([])
    }
  })
}, LINT_TIMEOUT)

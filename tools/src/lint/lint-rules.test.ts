// 规范里标为【自动】的 lint 规则真的生效：对违规的代码执行 ESLint，确认报出对应的规则；
// 按路径生效的规则，再用 ESLint 为该路径计算出的配置来确认。
// 类型感知的解析只接受 tsconfig 里真实存在的文件，所以 lintText 借用仓库里已有的文件路径；
// 需要"被引用的目标"时，临时创建探针文件（已加入 .gitignore），用完删除。
import type { Linter } from 'eslint'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { ESLint } from 'eslint'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { REPO_ROOT } from '../shared/repo.ts'

const PROBE = `lint-probe-${process.pid}`
const PROBE_FILES = {
  // 编辑器里的文件（任何一个都不应被平台入口引用）
  editor: `apps/web/src/editor/${PROBE}/editor-part.ts`,
  // 不属于任何元素的"无主"文件：借它中转就能绕过边界
  stray: `apps/web/src/${PROBE}.ts`,
}

let eslint: ESLint

beforeAll(() => {
  for (const path of Object.values(PROBE_FILES)) {
    mkdirSync(join(REPO_ROOT, dirname(path)), { recursive: true })
    writeFileSync(join(REPO_ROOT, path), 'export const probe = 1\n')
  }
  eslint = new ESLint({ cwd: REPO_ROOT })
})

afterAll(() => {
  rmSync(join(REPO_ROOT, dirname(PROBE_FILES.editor)), { recursive: true, force: true })
  rmSync(join(REPO_ROOT, PROBE_FILES.stray), { force: true })
})

interface Report { rules: string[], messages: string[] }

async function lint(code: string, filePath: string): Promise<Report> {
  const [result] = await eslint.lintText(code, { filePath: join(REPO_ROOT, filePath) })
  const messages = result?.messages ?? []
  return { rules: messages.map(m => m.ruleId ?? `解析失败：${m.message}`), messages: messages.map(m => m.message) }
}

async function rulesFor(code: string, filePath: string): Promise<string[]> {
  return (await lint(code, filePath)).rules
}

async function configFor(filePath: string): Promise<Linter.Config> {
  return await eslint.calculateConfigForFile(join(REPO_ROOT, filePath)) as Linter.Config
}

function severity(entry: Linter.RuleEntry | undefined): unknown {
  return Array.isArray(entry) ? entry[0] : entry
}

function restrictedPatterns(config: Linter.Config): string[] {
  const entry = config.rules?.['no-restricted-imports']
  const options = Array.isArray(entry) ? entry[1] as { patterns?: { group: string[] }[] } : undefined
  return (options?.patterns ?? []).flatMap(p => p.group)
}

const WEB_FILE = 'apps/web/src/app/app.tsx'
const PLATFORM_ENTRY = 'apps/web/src/entries/platform/main.tsx'
const CONTRACTS_FILE = 'packages/contracts/src/errors/error-response.ts'

describe('US-M1-11 lint 规则的自测：受限导入', () => {
  it('编辑器之外引用 @univerjs/* 或 Pro 会失败，静态导入、再导出与动态导入都算', async () => {
    expect(await rulesFor('import { Univer } from \'@univerjs/core\'\nexport const u = Univer\n', WEB_FILE)).toContain('no-restricted-imports')
    expect(await rulesFor('export * from \'@univerjs/core\'\n', WEB_FILE)).toContain('no-restricted-imports')
    expect(await rulesFor('import { x } from \'@univerjs-pro/license\'\nexport const y = x\n', WEB_FILE)).toContain('no-restricted-imports')
    expect(await rulesFor('export async function load() {\n  return import(\'@univerjs/core\')\n}\n', WEB_FILE)).toContain('no-restricted-syntax')
    expect(await rulesFor('export async function load() {\n  return import(\'@univerjs-pro/license\')\n}\n', WEB_FILE)).toContain('no-restricted-syntax')
  })

  it('动态导入的路径必须是字面量', async () => {
    expect(await rulesFor('export async function load(name: string) {\n  return import(name)\n}\n', WEB_FILE)).toContain('no-restricted-syntax')
  })

  it('编辑器适配层可以引用 @univerjs/*，但不能引用 Pro', async () => {
    // 按路径计算配置不需要文件存在；探针文件在 .gitignore 里，ESLint 会忽略它们，所以这里用普通路径
    const editor = await configFor('apps/web/src/editor/adapter.ts')
    expect(restrictedPatterns(editor)).toContain('@univerjs-pro/*')
    expect(restrictedPatterns(editor)).not.toContain('@univerjs/*')
    expect(restrictedPatterns(await configFor(WEB_FILE))).toContain('@univerjs/*')
  })
})

describe('US-M1-11 lint 规则的自测：模块边界与循环依赖', () => {
  it('跨越模块边界的引用会失败（平台代码引用仓库工具）', async () => {
    const code = 'import { stripAiTrailers } from \'../../../../tools/src/git/strip-ai-trailers.ts\'\nexport const f = stripAiTrailers\n'
    expect(await rulesFor(code, WEB_FILE)).toContain('boundaries/dependencies')
  })

  it('平台页面的入口不能引用编辑器', async () => {
    const report = await lint(`import { probe } from '../../editor/${PROBE}/editor-part.ts'\nexport const p = probe\n`, PLATFORM_ENTRY)
    expect(report.rules).toContain('boundaries/dependencies')
    expect(report.messages.join('\n')).toContain('平台页面的入口不得引用编辑器')
  })

  it('不能借"无主"文件中转绕过边界', async () => {
    expect(await rulesFor(`import { probe } from '../../${PROBE}.ts'\nexport const p = probe\n`, PLATFORM_ENTRY)).toContain('boundaries/no-unknown-dependencies')
    const config = await configFor('apps/web/src/stray.ts')
    expect(severity(config.rules?.['boundaries/no-unknown-files'])).toBe(2)
  })

  it('跨元素只能引用公开入口', async () => {
    expect(await rulesFor('import { errorResponseSchema } from \'../../../../packages/contracts/src/errors/error-response.ts\'\nexport const s = errorResponseSchema\n', WEB_FILE)).toContain('boundaries/dependencies')
  })

  it('TypeScript 文件之间的循环依赖会失败', async () => {
    // licenses.ts 被 license-bundle.ts 引用，这里让它反过来引用 license-bundle.ts
    const code = 'import { checkLicenseBundle } from \'./license-bundle.ts\'\n\nexport const f = checkLicenseBundle\n'
    expect(await rulesFor(code, 'tools/src/gates/licenses.ts')).toContain('import-x/no-cycle')
  })
})

describe('US-M1-11 lint 规则的自测：类型与写法', () => {
  it('禁止 any、非空断言与 console（包括 console.error）', async () => {
    const rules = await rulesFor('export function f(x: any, y?: string): string {\n  console.error(x)\n  return y!\n}\n', CONTRACTS_FILE)
    expect(rules).toEqual(expect.arrayContaining(['ts/no-explicit-any', 'ts/no-non-null-assertion', 'no-console']))
  })

  it('禁止 @ts-ignore', async () => {
    expect(await rulesFor('// @ts-ignore\nexport const n: number = \'x\'\n', CONTRACTS_FILE)).toContain('ts/ban-ts-comment')
  })

  it('Promise 不能悬空', async () => {
    expect(await rulesFor('async function job(): Promise<void> {}\n\nexport function run(): void {\n  job()\n}\n', CONTRACTS_FILE)).toContain('ts/no-floating-promises')
  })

  it('switch 必须覆盖联合类型的全部分支', async () => {
    const code = 'export function f(x: \'a\' | \'b\'): number {\n  switch (x) {\n    case \'a\':\n      return 1\n  }\n  return 0\n}\n'
    expect(await rulesFor(code, CONTRACTS_FILE)).toContain('ts/switch-exhaustiveness-check')
  })

  it('只用于类型的导入写成 import type', async () => {
    expect(await rulesFor('import { z } from \'zod\'\n\nexport type S = z.ZodString\n', CONTRACTS_FILE)).toContain('ts/consistent-type-imports')
  })

  it('禁止 dangerouslySetInnerHTML，图片必须有替代文字（无障碍规则在 ESLint 10 下生效）', async () => {
    const code = 'export function App({ html }: { html: string }) {\n  return <div><div dangerouslySetInnerHTML={{ __html: html }} /><img src="a.png" /></div>\n}\n'
    expect(await rulesFor(code, WEB_FILE)).toEqual(expect.arrayContaining(['react/dom-no-dangerously-set-innerhtml', 'jsx-a11y/alt-text']))
  })

  it('文件名必须是短横线小写', async () => {
    expect((await configFor(CONTRACTS_FILE)).rules?.['unicorn/filename-case']).toEqual([2, { case: 'kebabCase' }])
  })
})

describe('US-M1-11 lint 规则的自测：测试的写法', () => {
  it('不允许 .only', async () => {
    expect(await rulesFor('import { it } from \'vitest\'\n\nit.only(\'x\', () => {})\n', 'tools/src/git/strip-ai-trailers.test.ts')).toContain('test/no-only-tests')
    expect(await rulesFor('import { test } from \'@playwright/test\'\n\ntest.only(\'x\', async () => {})\n', 'tests/e2e/specs/foundation/framework-smoke.spec.ts')).toContain('playwright/no-focused-test')
  })

  it('不允许跳过或占位的用例（skip、todo、fixme）', async () => {
    const vitestFile = 'tools/src/git/strip-ai-trailers.test.ts'
    expect(await rulesFor('import { it } from \'vitest\'\n\nit.skip(\'x\', () => {})\n', vitestFile)).toContain('test/no-disabled-tests')
    expect(await rulesFor('import { it } from \'vitest\'\n\nit.todo(\'x\')\n', vitestFile)).toContain('test/warn-todo')
    const e2eFile = 'tests/e2e/specs/foundation/framework-smoke.spec.ts'
    expect(await rulesFor('import { test } from \'@playwright/test\'\n\ntest.skip(\'x\', async () => {})\n', e2eFile)).toContain('playwright/no-skipped-test')
    expect(await rulesFor('import { test } from \'@playwright/test\'\n\ntest.fixme(\'x\', async () => {})\n', e2eFile)).toContain('playwright/no-skipped-test')
  })

  it('没有警告级别的规则（规范 §2.2）', async () => {
    for (const file of [WEB_FILE, CONTRACTS_FILE, 'tools/src/git/strip-ai-trailers.ts', 'tests/e2e/specs/foundation/framework-smoke.spec.ts', 'pnpm-workspace.yaml', 'package.json']) {
      const warned = Object.entries((await configFor(file)).rules ?? {}).filter(([, entry]) => [1, 'warn'].includes(severity(entry) as number | string))
      expect(warned.map(([name]) => `${file} ${name}`)).toEqual([])
    }
  })
}, 60_000)

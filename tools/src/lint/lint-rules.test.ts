// 规范里标为【自动】的 lint 规则真的生效：对几段违规的代码执行 ESLint，确认报出对应的规则；
// 按路径生效的规则，用 ESLint 为该路径计算出的配置来确认。
// 类型感知的解析只接受 tsconfig 里真实存在的文件，所以 lintText 借用仓库里已有的文件路径。
// 这组用例要加载完整的 ESLint 配置，比其他单元测试慢。
import type { Linter } from 'eslint'
import { ESLint } from 'eslint'
import { beforeAll, describe, expect, it } from 'vitest'
import { REPO_ROOT } from '../shared/repo.ts'

let eslint: ESLint

beforeAll(() => {
  eslint = new ESLint({ cwd: REPO_ROOT })
})

async function rulesFor(code: string, filePath: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath: `${REPO_ROOT}/${filePath}` })
  return (result?.messages ?? []).map(m => m.ruleId ?? `解析失败：${m.message}`)
}

async function configFor(filePath: string): Promise<Linter.Config> {
  return await eslint.calculateConfigForFile(`${REPO_ROOT}/${filePath}`) as Linter.Config
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

describe('US-M1-11 lint 规则的自测', () => {
  it('编辑器之外引用 @univerjs/* 或 Pro 会失败', async () => {
    expect(await rulesFor('import { Univer } from \'@univerjs/core\'\nexport const u = Univer\n', WEB_FILE)).toContain('no-restricted-imports')
    expect(await rulesFor('import { x } from \'@univerjs-pro/license\'\nexport const y = x\n', WEB_FILE)).toContain('no-restricted-imports')
  })

  it('编辑器适配层可以引用 @univerjs/*，但不能引用 Pro', async () => {
    const patterns = restrictedPatterns(await configFor('apps/web/src/editor/adapter.ts'))
    expect(patterns).toContain('@univerjs-pro/*')
    expect(patterns).not.toContain('@univerjs/*')
    expect(restrictedPatterns(await configFor(WEB_FILE))).toContain('@univerjs/*')
  })

  it('跨越模块边界的引用会失败（平台代码引用仓库工具）', async () => {
    const code = 'import { stripAiTrailers } from \'../../../../tools/src/git/strip-ai-trailers.ts\'\nexport const f = stripAiTrailers\n'
    expect(await rulesFor(code, WEB_FILE)).toContain('boundaries/dependencies')
  })

  it('禁止 any、非空断言与 console', async () => {
    const rules = await rulesFor('export function f(x: any, y?: string): string {\n  console.info(x)\n  return y!\n}\n', 'packages/contracts/src/index.ts')
    expect(rules).toEqual(expect.arrayContaining(['ts/no-explicit-any', 'ts/no-non-null-assertion', 'no-console']))
  })

  it('禁止 dangerouslySetInnerHTML，图片必须有替代文字（无障碍规则在 ESLint 10 下生效）', async () => {
    const code = 'export function App({ html }: { html: string }) {\n  return <div><div dangerouslySetInnerHTML={{ __html: html }} /><img src="a.png" /></div>\n}\n'
    expect(await rulesFor(code, WEB_FILE)).toEqual(expect.arrayContaining(['react/dom-no-dangerously-set-innerhtml', 'jsx-a11y/alt-text']))
  })

  it('测试里不允许 .only', async () => {
    expect(await rulesFor('import { it } from \'vitest\'\n\nit.only(\'x\', () => {})\n', 'tools/src/git/strip-ai-trailers.test.ts')).toContain('test/no-only-tests')
    expect(await rulesFor('import { test } from \'@playwright/test\'\n\ntest.only(\'x\', async () => {})\n', 'tests/e2e/specs/foundation/framework-smoke.spec.ts')).toContain('playwright/no-focused-test')
  })

  it('文件名必须是短横线小写', async () => {
    const entry = (await configFor('packages/contracts/src/errors/error-response.ts')).rules?.['unicorn/filename-case']
    expect(entry).toEqual([2, { case: 'kebabCase' }])
  })

  it('没有警告级别的规则（规范 §2.2）', async () => {
    for (const file of [WEB_FILE, 'packages/contracts/src/index.ts', 'tools/src/git/strip-ai-trailers.ts', 'tests/e2e/specs/foundation/framework-smoke.spec.ts']) {
      const warned = Object.entries((await configFor(file)).rules ?? {}).filter(([, entry]) => [1, 'warn'].includes(severity(entry) as number | string))
      expect(warned.map(([name]) => `${file} ${name}`)).toEqual([])
    }
  })
}, 60_000)

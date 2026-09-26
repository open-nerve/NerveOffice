import type { EntryBudget, ViteManifest } from './budgets.ts'
import { describe, expect, it } from 'vitest'
import { checkBudgets, initialFiles } from './budgets.ts'

const MANIFEST: ViteManifest = {
  'index.html': { file: 'assets/index.js', imports: ['_shared.js'] },
  '_shared.js': { file: 'assets/shared.js', imports: ['_deep.js'] },
  '_deep.js': { file: 'assets/deep.js' },
  // 只被动态加载的块（manifest 里在 dynamicImports，不在 imports）
  'src/lazy.ts': { file: 'assets/lazy.js' },
  'editor.html': { file: 'assets/editor.js', imports: ['_shared.js'] },
}

const SIZES: Record<string, number> = { 'assets/index.js': 10_000, 'assets/shared.js': 20_000, 'assets/deep.js': 5_000, 'assets/lazy.js': 900_000, 'assets/editor.js': 1_000 }

const budget = (entry: string, maxGzipBytes: number): EntryBudget => ({ entry, label: '平台页面', maxGzipBytes, reason: '测试' })

describe('US-M1-11 首屏 JS 的体积预算', () => {
  it('首屏的文件：入口块与它静态引用的块（递归），不含动态加载的块；共用的块只算一次', () => {
    expect(initialFiles(MANIFEST, 'index.html')).toEqual(['assets/deep.js', 'assets/index.js', 'assets/shared.js'])
    expect(initialFiles(MANIFEST, 'missing.html')).toBeUndefined()
  })

  it('不超过预算：通过，并给出实测值', () => {
    const result = checkBudgets(MANIFEST, [budget('index.html', 35_000)], file => SIZES[file] ?? 0)
    expect(result.violations).toEqual([])
    expect(result.notes[0]).toContain('34.2 KiB')
  })

  it('超过预算：违规', () => {
    const result = checkBudgets(MANIFEST, [budget('index.html', 34_999)], file => SIZES[file] ?? 0)
    expect(result.violations.map(v => v.rule)).toEqual(['budgets/exceeded'])
  })

  it('预算指向的入口不存在：违规（预算表要跟着入口一起改）', () => {
    const result = checkBudgets(MANIFEST, [budget('platform.html', 1)], () => 0)
    expect(result.violations.map(v => v.rule)).toEqual(['budgets/missing-entry'])
  })
})

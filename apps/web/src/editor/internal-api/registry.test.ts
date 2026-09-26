import { describe, expect, it } from 'vitest'
import * as internalApi from './index.ts'
import source from './index.ts?raw'
import { INTERNAL_API_REGISTRY } from './registry.ts'

/** index.ts 只写再导出（export { … } from、export type { … } from），从源码里取出导出的名字；有别的写法就报出来 */
function exportedNames(text: string): { names: string[], unexpected: string[] } {
  const names: string[] = []
  const unexpected: string[] = []
  const statements = text.split('\n').filter(line => line.trim() !== '' && !line.trim().startsWith('//'))
  for (const line of statements) {
    const match = /^export (?:type )?\{([^}]+)\} from '[^']+'$/.exec(line.trim())
    if (match === null) {
      unexpected.push(line)
      continue
    }
    for (const specifier of (match[1] ?? '').split(',')) {
      const name = specifier.trim().split(/\s+as\s+/).at(-1)
      if (name !== undefined && name !== '')
        names.push(name)
    }
  }
  return { names, unexpected }
}

describe('内部 API 登记表', () => {
  const registered = INTERNAL_API_REGISTRY.map(entry => entry.name)
  const { names, unexpected } = exportedNames(source)

  it('index.ts 只写再导出', () => {
    expect(unexpected).toEqual([])
    expect(names.length).toBeGreaterThan(0)
  })

  it('导出的每一项都已登记，登记的每一项都还在导出', () => {
    expect([...names].sort()).toEqual([...registered].sort())
  })

  it('运行时能拿到的导出都在登记表里（类型只在源码里看得到）', () => {
    expect(Object.keys(internalApi).filter(name => !registered.includes(name))).toEqual([])
  })

  it('每一项写明来源、用途、证据与回归用例，名字不重复', () => {
    const incomplete = INTERNAL_API_REGISTRY.filter(entry => [entry.origin, entry.purpose, entry.evidence, entry.regression].some(text => text.trim() === ''))
    expect(incomplete.map(entry => entry.name)).toEqual([])
    expect(new Set(registered).size).toBe(registered.length)
  })
})

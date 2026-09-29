import { describe, expect, it } from 'vitest'
import * as internalApi from './index.ts'
import source from './index.ts?raw'
import { INTERNAL_API_REGISTRY } from './registry.ts'
import * as uiApi from './ui.ts'
import uiSource from './ui.ts?raw'

/** 出口只写再导出（export { … } from、export type { … } from），从源码里取出导出的名字与来源；有别的写法就报出来 */
function reExports(text: string): { names: string[], sources: string[], unexpected: string[] } {
  const names: string[] = []
  const sources: string[] = []
  const unexpected: string[] = []
  const statements = text.split('\n').filter(line => line.trim() !== '' && !line.trim().startsWith('//'))
  for (const line of statements) {
    const match = /^export (?:type )?\{([^}]+)\} from '([^']+)'$/.exec(line.trim())
    if (match === null) {
      unexpected.push(line)
      continue
    }
    sources.push(match[2] ?? '')
    for (const specifier of (match[1] ?? '').split(',')) {
      const name = specifier.trim().split(/\s+as\s+/).at(-1)
      if (name !== undefined && name !== '')
        names.push(name)
    }
  }
  return { names, sources, unexpected }
}

/** 界面的包：公式 Worker 引用 index.ts，这些包从那里再导出会整包打进 Worker */
const UI_PACKAGE = /^@univerjs\/(?:[\w-]+-ui|ui|design|engine-render)$/

describe('内部 API 登记表', () => {
  const registered = INTERNAL_API_REGISTRY.map(entry => entry.name)
  const main = reExports(source)
  const ui = reExports(uiSource)

  it('两个出口都只写再导出', () => {
    expect([...main.unexpected, ...ui.unexpected]).toEqual([])
    expect(main.names.length).toBeGreaterThan(0)
    expect(ui.names.length).toBeGreaterThan(0)
  })

  it('导出的每一项都已登记，登记的每一项都还在导出；两个出口不重复', () => {
    expect([...main.names, ...ui.names].sort()).toEqual([...registered].sort())
  })

  it('运行时能拿到的导出都在登记表里（类型只在源码里看得到）', () => {
    expect([...Object.keys(internalApi), ...Object.keys(uiApi)].filter(name => !registered.includes(name))).toEqual([])
  })

  it('index.ts 不从界面的包再导出（公式 Worker 引用它）；界面的包只在 ui.ts', () => {
    expect(main.sources.filter(from => UI_PACKAGE.test(from))).toEqual([])
    expect(ui.sources.filter(from => !UI_PACKAGE.test(from))).toEqual([])
  })

  it('每一项写明来源、用途、证据与回归用例，名字不重复', () => {
    const incomplete = INTERNAL_API_REGISTRY.filter(entry => [entry.origin, entry.purpose, entry.evidence, entry.regression].some(text => text.trim() === ''))
    expect(incomplete.map(entry => entry.name)).toEqual([])
    expect(new Set(registered).size).toBe(registered.length)
  })
})

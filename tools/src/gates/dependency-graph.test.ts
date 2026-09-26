import type { LsProject } from './pnpm-outputs.ts'
import { describe, expect, it } from 'vitest'
import { checkGraphComplete, checkSingletons, checkUniver, collectInstalled } from './dependency-graph.ts'
import { readFixture } from './fixtures.ts'
import { lsOutputSchema } from './pnpm-outputs.ts'

const store = '/repo/node_modules/.pnpm'
const univerPolicy = { version: '1.0.0', independent: { '@univerjs/icons': '1.43.0' } }

function node(name: string, version: string, suffix = '', dependencies?: LsProject['dependencies']) {
  const dir = `${name.replace('/', '+')}@${version}${suffix}`
  return { from: name, version, path: `${store}/${dir}/node_modules/${name}`, ...(dependencies ? { dependencies } : {}) }
}

function project(dependencies: LsProject['dependencies'], optionalDependencies?: LsProject['dependencies']): LsProject[] {
  return [{ name: '@nerve-office/web', path: '/repo/apps/web', dependencies, optionalDependencies }]
}

function names(projects: LsProject[]): string[] {
  return collectInstalled(projects).installed.map(p => p.name).sort()
}

describe('collectInstalled（pnpm 12 的真实输出）', () => {
  it('项目这一层的可选依赖及其子树进入生产依赖图', () => {
    const projects = lsOutputSchema.parse(readFixture('pnpm-12/ls-optional-dependencies.json'))
    expect(names(projects)).toEqual(['pg-int8', 'pg-types', 'postgres-array', 'postgres-bytea', 'postgres-date', 'postgres-interval', 'xtend', 'zod'])
  })

  it('包名取真实的包名，不取别名', () => {
    const projects = lsOutputSchema.parse(readFixture('pnpm-12/ls-alias.json'))
    expect(collectInstalled(projects).installed.filter(p => p.name === 'react').map(p => p.version).sort()).toEqual(['18.3.1', '19.3.0'])
  })

  it('去重占位不会让后面完整的子树被跳过', () => {
    const projects = lsOutputSchema.parse(readFixture('pnpm-12/ls-deduped.json'))
    const graph = collectInstalled(projects)
    expect(graph.unexpanded).toEqual([])
    expect(graph.installed.length).toBeGreaterThan(3)
  })

  it('按安装路径去重，跳过工作区内部包', () => {
    const react = node('react', '19.3.0')
    const graph = collectInstalled(project({
      'react': react,
      'react-dom': node('react-dom', '19.3.0', '_react@19.3.0', { react: { ...react, deduped: true } }),
      '@nerve-office/contracts': { version: 'link:../../packages/contracts', path: '/repo/packages/contracts' },
    }))
    expect(graph.installed.map(p => p.name).sort()).toEqual(['react', 'react-dom'])
  })
})

describe('US-M1-11 A01 依赖图完整', () => {
  it('违规：某个依赖只以去重占位出现，子树从未展开', () => {
    const graph = collectInstalled(project({ 'react-dom': node('react-dom', '19.3.0', '', { scheduler: { ...node('scheduler', '0.28.0'), deduped: true } }) }))
    expect(checkGraphComplete(graph).map(v => v.rule)).toEqual(['deps/incomplete-tree'])
  })
})

describe('US-M1-11 A01 Univer 的版本与 Pro', () => {
  it('合规：还没有引入 Univer', () => {
    expect(checkUniver(collectInstalled(project({ react: node('react', '19.3.0') })).installed, univerPolicy)).toEqual([])
  })

  it('合规：协调发布的包都是基线版本，独立发版的包按清单', () => {
    const { installed } = collectInstalled(project({
      '@univerjs/core': node('@univerjs/core', '1.0.0'),
      '@univerjs/sheets': node('@univerjs/sheets', '1.0.0'),
      '@univerjs/icons': node('@univerjs/icons', '1.43.0'),
    }))
    expect(checkUniver(installed, univerPolicy)).toEqual([])
  })

  it('违规：出现 @univerjs-pro/* 或名字像 Pro 的包，包括作为可选依赖和经别名引入', () => {
    const { installed } = collectInstalled(project(
      { 'innocent-name': { ...node('@univerjs-pro/license', '1.0.0'), from: '@univerjs-pro/license' } },
      { 'univer-pro-sheets': node('univer-pro-sheets', '0.1.0') },
    ))
    expect(checkUniver(installed, univerPolicy).map(v => v.rule)).toEqual(['deps/univer-pro', 'deps/univer-pro'])
  })

  it('违规：协调发布的包版本不一致', () => {
    const { installed } = collectInstalled(project({
      '@univerjs/core': node('@univerjs/core', '1.0.0'),
      '@univerjs/sheets': node('@univerjs/sheets', '1.0.1'),
    }))
    expect(checkUniver(installed, univerPolicy).map(v => `${v.rule} ${v.subject}`)).toEqual(['deps/univer-version @univerjs/sheets'])
  })

  it('违规：独立发版的包不是清单里的版本', () => {
    const { installed } = collectInstalled(project({ '@univerjs/icons': node('@univerjs/icons', '1.44.0') }))
    expect(checkUniver(installed, univerPolicy).map(v => v.rule)).toEqual(['deps/univer-version'])
  })
})

describe('US-M1-11 A01 单例', () => {
  it('合规：react 只有一份，被多个包引用', () => {
    const react = node('react', '19.3.0')
    const { installed } = collectInstalled(project({ 'react': react, 'react-dom': node('react-dom', '19.3.0', '_react@19.3.0', { react }) }))
    expect(checkSingletons(installed, ['react', 'react-dom'])).toEqual([])
  })

  it('违规：react 装了两个版本（真实输出：经别名引入的第二份）', () => {
    const { installed } = collectInstalled(lsOutputSchema.parse(readFixture('pnpm-12/ls-alias.json')))
    expect(checkSingletons(installed, ['react']).map(v => v.rule)).toEqual(['deps/singleton'])
  })

  it('违规：第二份 react 作为可选依赖引入', () => {
    const { installed } = collectInstalled(project({ react: node('react', '19.3.0') }, { 'legacy-widget': node('legacy-widget', '1.0.0', '', { react: node('react', '18.3.1') }) }))
    expect(checkSingletons(installed, ['react']).map(v => v.rule)).toEqual(['deps/singleton'])
  })

  it('违规：同一版本因 peer 依赖不同装成两份（pnpm 的 peer 变体）', () => {
    const { installed } = collectInstalled(project({
      '@univerjs/ui': node('@univerjs/ui', '1.0.0', '_react@19.3.0'),
      'other': node('other', '1.0.0', '', { '@univerjs/ui': node('@univerjs/ui', '1.0.0', '_react@19.2.0') }),
    }))
    expect(checkSingletons(installed, []).map(v => `${v.rule} ${v.subject}`)).toEqual(['deps/singleton @univerjs/ui'])
  })
})

import type { LsProject } from './dependency-graph.ts'
import { describe, expect, it } from 'vitest'
import { checkSingletons, checkUniver, collectInstalled } from './dependency-graph.ts'

const store = '/repo/node_modules/.pnpm'
const univerPolicy = { version: '1.0.0', independent: { '@univerjs/icons': '1.43.0' } }

function node(name: string, version: string, suffix = '', dependencies?: LsProject['dependencies']) {
  const dir = `${name.replace('/', '+')}@${version}${suffix}`
  return { version, path: `${store}/${dir}/node_modules/${name}`, ...(dependencies ? { dependencies } : {}) }
}

function project(dependencies: LsProject['dependencies']): LsProject[] {
  return [{ name: '@nerve-office/web', dependencies }]
}

describe('collectInstalled', () => {
  it('按安装路径去重，跳过工作区内部包', () => {
    const react = node('react', '19.3.0')
    const installed = collectInstalled(project({
      'react': react,
      'react-dom': node('react-dom', '19.3.0', '_react@19.3.0', { react }),
      '@nerve-office/contracts': { version: 'link:../../packages/contracts', path: '/repo/packages/contracts' },
    }))
    expect(installed.map(p => p.name).sort()).toEqual(['react', 'react-dom'])
  })
})

describe('US-M1-11 A01 Univer 的版本与 Pro', () => {
  it('合规：还没有引入 Univer', () => {
    expect(checkUniver(collectInstalled(project({ react: node('react', '19.3.0') })), univerPolicy)).toEqual([])
  })

  it('合规：协调发布的包都是基线版本，独立发版的包按清单', () => {
    const installed = collectInstalled(project({
      '@univerjs/core': node('@univerjs/core', '1.0.0'),
      '@univerjs/sheets': node('@univerjs/sheets', '1.0.0'),
      '@univerjs/icons': node('@univerjs/icons', '1.43.0'),
    }))
    expect(checkUniver(installed, univerPolicy)).toEqual([])
  })

  it('违规：出现 @univerjs-pro/* 或名字像 Pro 的包', () => {
    const installed = collectInstalled(project({
      '@univerjs-pro/license': node('@univerjs-pro/license', '1.0.0'),
      'univer-pro-sheets': node('univer-pro-sheets', '0.1.0'),
    }))
    expect(checkUniver(installed, univerPolicy).map(v => v.rule)).toEqual(['deps/univer-pro', 'deps/univer-pro'])
  })

  it('违规：协调发布的包版本不一致', () => {
    const installed = collectInstalled(project({
      '@univerjs/core': node('@univerjs/core', '1.0.0'),
      '@univerjs/sheets': node('@univerjs/sheets', '1.0.1'),
    }))
    expect(checkUniver(installed, univerPolicy).map(v => `${v.rule} ${v.subject}`)).toEqual(['deps/univer-version @univerjs/sheets'])
  })

  it('违规：独立发版的包不是清单里的版本', () => {
    const installed = collectInstalled(project({ '@univerjs/icons': node('@univerjs/icons', '1.44.0') }))
    expect(checkUniver(installed, univerPolicy).map(v => v.rule)).toEqual(['deps/univer-version'])
  })
})

describe('US-M1-11 A01 单例', () => {
  it('合规：react 只有一份，被多个包引用', () => {
    const react = node('react', '19.3.0')
    const installed = collectInstalled(project({ 'react': react, 'react-dom': node('react-dom', '19.3.0', '_react@19.3.0', { react }) }))
    expect(checkSingletons(installed, ['react', 'react-dom'])).toEqual([])
  })

  it('违规：react 装了两个版本', () => {
    const installed = collectInstalled(project({
      'react': node('react', '19.3.0'),
      'legacy-widget': node('legacy-widget', '1.0.0', '', { react: node('react', '18.3.1') }),
    }))
    expect(checkSingletons(installed, ['react']).map(v => v.rule)).toEqual(['deps/singleton'])
  })

  it('违规：同一版本因 peer 依赖不同装成两份（pnpm 的 peer 变体）', () => {
    const installed = collectInstalled(project({
      '@univerjs/ui': node('@univerjs/ui', '1.0.0', '_react@19.3.0'),
      'other': node('other', '1.0.0', '', { '@univerjs/ui': node('@univerjs/ui', '1.0.0', '_react@19.2.0') }),
    }))
    expect(checkSingletons(installed, []).map(v => `${v.rule} ${v.subject}`)).toEqual(['deps/singleton @univerjs/ui'])
  })
})

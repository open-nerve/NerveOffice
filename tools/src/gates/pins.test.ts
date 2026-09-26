import type { Manifest } from './pins.ts'
import { describe, expect, it } from 'vitest'
import { checkPins } from './pins.ts'

const catalogs = { default: { react: '19.3.0', zod: '4.6.5' } }
const root: Manifest = { path: 'package.json', json: { name: 'nerve-office', packageManager: 'pnpm@12.6.0' } }

function withDeps(dependencies: Record<string, string>, devDependencies: Record<string, string> = {}): Manifest {
  return { path: 'apps/web/package.json', json: { name: '@nerve-office/web', dependencies, devDependencies } }
}

describe('US-M1-11 A01 精确版本', () => {
  it('合规：外部依赖都经目录引用，内部包用 workspace:*', () => {
    expect(checkPins([root, withDeps({ 'react': 'catalog:', '@nerve-office/contracts': 'workspace:*' })], catalogs)).toEqual([])
  })

  it.each(['^19.3.0', '~19.3.0', '19.3.0', 'latest', '*', 'github:facebook/react', 'npm:react@19.3.0'])('违规：依赖直接写版本或范围 %s', (spec) => {
    const violations = checkPins([root, withDeps({ react: spec })], catalogs)
    expect(violations.map(v => v.rule)).toEqual(['pins/dependency-spec'])
  })

  it('违规：目录里没有这个依赖', () => {
    expect(checkPins([root, withDeps({ lodash: 'catalog:' })], catalogs).map(v => v.rule)).toEqual(['pins/catalog-missing'])
  })

  it('违规：内部包没有用 workspace:*', () => {
    const violations = checkPins([root, withDeps({ '@nerve-office/contracts': 'catalog:' })], catalogs)
    expect(violations.map(v => v.rule)).toEqual(['pins/workspace-internal'])
  })

  it.each(['^19.3.0', '19.x', '>=19', 'latest', '19.3'])('违规：目录里的版本不是精确版本 %s', (version) => {
    const violations = checkPins([root], { default: { react: version } })
    expect(violations.map(v => v.rule)).toEqual(['pins/catalog-version'])
  })

  it('合规：目录里的预发布版本也是精确版本', () => {
    expect(checkPins([root], { default: { react: '19.4.0-rc.1' } })).toEqual([])
  })

  it.each([undefined, 'pnpm@^12.6.0', 'pnpm@latest', 'npm@11.0.0'])('违规：根 package.json 的 packageManager 不是精确的 pnpm 版本 %s', (packageManager) => {
    const manifest: Manifest = { path: 'package.json', json: { name: 'nerve-office', ...(packageManager === undefined ? {} : { packageManager }) } }
    expect(checkPins([manifest], catalogs).map(v => v.rule)).toEqual(['pins/package-manager'])
  })

  it('合规：packageManager 带完整性哈希', () => {
    const manifest: Manifest = { path: 'package.json', json: { name: 'nerve-office', packageManager: 'pnpm@12.6.0+sha512.abc123' } }
    expect(checkPins([manifest], catalogs)).toEqual([])
  })
})

// A01：所有依赖精确锁定（规范 §3，00 号计划书 §3.2）。
// 外部依赖一律经 pnpm 默认目录（catalog）引用，目录里的版本必须是精确版本；内部包用 workspace:*。
import type { Violation } from './types.ts'

const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Z.-]+)?$/i
const PACKAGE_MANAGER = /^pnpm@\d+\.\d+\.\d+(?:\+sha\d+\.[0-9a-f]+)?$/i
const INTERNAL_SCOPE = '@nerve-office/'
const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies'] as const

export interface Manifest {
  path: string
  json: {
    name?: string
    packageManager?: string
    dependencies?: Record<string, string>
    devDependencies?: Record<string, string>
    optionalDependencies?: Record<string, string>
  }
}

/** 目录名到"依赖名 → 版本"的映射；`catalog:` 引用的是 `default`。 */
export type Catalogs = Record<string, Record<string, string>>

function checkDependency(manifest: Manifest, name: string, spec: string, catalogs: Catalogs): Violation[] {
  const subject = `${manifest.path} ${name}`
  if (name.startsWith(INTERNAL_SCOPE)) {
    return spec === 'workspace:*'
      ? []
      : [{ rule: 'pins/workspace-internal', subject, detail: `内部包必须写 workspace:*，现在是 ${spec}` }]
  }
  if (!spec.startsWith('catalog:'))
    return [{ rule: 'pins/dependency-spec', subject, detail: `外部依赖必须经目录引用（catalog:），现在是 ${spec}` }]
  const catalogName = spec.slice('catalog:'.length) || 'default'
  if (catalogs[catalogName]?.[name] === undefined)
    return [{ rule: 'pins/catalog-missing', subject, detail: `目录 ${catalogName} 里没有 ${name}` }]
  return []
}

export function checkPins(manifests: readonly Manifest[], catalogs: Catalogs, rootManifestPath = 'package.json'): Violation[] {
  const violations: Violation[] = []

  for (const [catalogName, entries] of Object.entries(catalogs)) {
    for (const [name, version] of Object.entries(entries)) {
      if (!EXACT_VERSION.test(version))
        violations.push({ rule: 'pins/catalog-version', subject: `目录 ${catalogName} ${name}`, detail: `必须是精确版本，现在是 ${version}` })
    }
  }

  for (const manifest of manifests) {
    if (manifest.path === rootManifestPath && !PACKAGE_MANAGER.test(manifest.json.packageManager ?? '')) {
      violations.push({
        rule: 'pins/package-manager',
        subject: manifest.path,
        detail: `packageManager 必须是精确的 pnpm 版本，现在是 ${manifest.json.packageManager ?? '（未设置）'}`,
      })
    }
    for (const field of DEPENDENCY_FIELDS) {
      for (const [name, spec] of Object.entries(manifest.json[field] ?? {}))
        violations.push(...checkDependency(manifest, name, spec, catalogs))
    }
  }
  return violations
}

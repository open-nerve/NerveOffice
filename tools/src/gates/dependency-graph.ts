// A01：生产依赖图的检查（00 号计划书 §3.3）：没有 Pro、Univer 版本一致、应为单例的包只有一份。
// 输入是 `pnpm ls --prod --json --depth Infinity` 的输出；按安装路径区分实例，
// 因为同一版本也可能因为 peer 依赖不同，被 pnpm 装成多份。
import type { Violation } from './types.ts'

export interface LsNode {
  version: string
  path: string
  dependencies?: Record<string, LsNode>
}

export interface LsProject {
  name: string
  dependencies?: Record<string, LsNode>
}

export interface InstalledPackage {
  name: string
  version: string
  path: string
}

export interface UniverPolicy {
  version: string
  independent: Readonly<Record<string, string>>
}

/** 展开依赖树，按安装路径去重；工作区内部包（`link:`）不计入。 */
export function collectInstalled(projects: readonly LsProject[]): InstalledPackage[] {
  const byPath = new Map<string, InstalledPackage>()
  const visit = (dependencies: Record<string, LsNode> | undefined): void => {
    for (const [name, dependency] of Object.entries(dependencies ?? {})) {
      if (dependency.version.startsWith('link:') || byPath.has(dependency.path))
        continue
      byPath.set(dependency.path, { name, version: dependency.version, path: dependency.path })
      visit(dependency.dependencies)
    }
  }
  for (const project of projects)
    visit(project.dependencies)
  return [...byPath.values()]
}

function groupByName(installed: readonly InstalledPackage[]): Map<string, InstalledPackage[]> {
  const groups = new Map<string, InstalledPackage[]>()
  for (const item of installed)
    groups.set(item.name, [...(groups.get(item.name) ?? []), item])
  return groups
}

export function checkUniver(installed: readonly InstalledPackage[], policy: UniverPolicy): Violation[] {
  const violations: Violation[] = []
  for (const [name, instances] of groupByName(installed)) {
    if (name.startsWith('@univerjs-pro/') || /univer-?pro/i.test(name)) {
      violations.push({ rule: 'deps/univer-pro', subject: name, detail: '禁止引入 Univer Pro（00 号计划书 §3.3）' })
      continue
    }
    if (!name.startsWith('@univerjs/'))
      continue
    const expected = policy.independent[name] ?? policy.version
    const versions = [...new Set(instances.map(i => i.version))]
    if (versions.length !== 1 || versions[0] !== expected)
      violations.push({ rule: 'deps/univer-version', subject: name, detail: `应为 ${expected}，实际是 ${versions.join('、')}` })
  }
  return violations
}

/** 名单里的包与每个 `@univerjs/*` 包，都只能有一个安装实例。 */
export function checkSingletons(installed: readonly InstalledPackage[], singletons: readonly string[]): Violation[] {
  const violations: Violation[] = []
  for (const [name, instances] of groupByName(installed)) {
    if (!singletons.includes(name) && !name.startsWith('@univerjs/'))
      continue
    if (instances.length > 1) {
      const where = instances.map(i => i.path.replace(/^.*\/node_modules\/\.pnpm\//, '')).join('、')
      violations.push({ rule: 'deps/singleton', subject: name, detail: `应只有一份实例，实际有 ${instances.length} 份：${where}` })
    }
  }
  return violations
}

// A01：生产依赖图的检查（00 号计划书 §3.3）：没有 Pro、Univer 版本一致、应为单例的包只有一份。
// 输入是 `pnpm ls --prod --json --depth Infinity` 的输出（先经 lsOutputSchema 校验）：
// - 按安装路径区分实例，因为同一版本也可能因为 peer 依赖不同，被 pnpm 装成多份；
// - 包名取 from（依赖可以用别名，例如 "react-legacy": "npm:react@18"）；
// - 项目这一层的可选依赖同样进入生产依赖图。
import type { LsNode, LsProject } from './pnpm-outputs.ts'
import type { Violation } from './types.ts'

export interface InstalledPackage {
  name: string
  version: string
  path: string
}

export interface UniverPolicy {
  version: string
  independent: Readonly<Record<string, string>>
}

export interface CollectedGraph {
  installed: InstalledPackage[]
  /** 只以去重占位出现、整棵子树从未展开过的安装实例：这时依赖图不完整，不能据此判断 */
  unexpanded: string[]
}

/**
 * 展开生产依赖树（dependencies 与项目层的 optionalDependencies），按安装路径去重。
 * 工作区内部包（版本是 link:）本身不计入，但它的依赖照常展开：服务端的清单只以 API 为根，
 * API 经 contracts 用到的外部包只出现在 link 的子树里，跳过整棵子树会让它们漏出许可清单（Codex 评审 CX10）。
 * 按路径只展开一次，工作区包互相依赖成环时也会停下。
 */
export function collectInstalled(projects: readonly LsProject[]): CollectedGraph {
  const byPath = new Map<string, InstalledPackage>()
  const expanded = new Set<string>()
  const placeholders = new Set<string>()
  const visit = (dependencies: Record<string, LsNode> | undefined): void => {
    for (const [key, node] of Object.entries(dependencies ?? {})) {
      if (!node.version.startsWith('link:') && !byPath.has(node.path))
        byPath.set(node.path, { name: node.from ?? key, version: node.version, path: node.path })
      if (node.deduped === true) {
        if (!expanded.has(node.path))
          placeholders.add(node.path)
        continue
      }
      if (expanded.has(node.path))
        continue
      expanded.add(node.path)
      placeholders.delete(node.path)
      visit(node.dependencies)
    }
  }
  for (const project of projects) {
    visit(project.dependencies)
    visit(project.optionalDependencies)
  }
  return { installed: [...byPath.values()], unexpanded: [...placeholders].sort() }
}

function groupByName(installed: readonly InstalledPackage[]): Map<string, InstalledPackage[]> {
  const groups = new Map<string, InstalledPackage[]>()
  for (const item of installed)
    groups.set(item.name, [...(groups.get(item.name) ?? []), item])
  return groups
}

export function checkGraphComplete(graph: CollectedGraph): Violation[] {
  return graph.unexpanded.map(path => ({
    rule: 'deps/incomplete-tree',
    subject: path.replace(/^.*\/node_modules\/\.pnpm\//, ''),
    detail: 'pnpm 的输出里只有去重占位、没有展开这个依赖的子树，依赖图不完整，不能据此判断',
  }))
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

/**
 * pnpm 的各个目录里的 Univer 包与版本基线一致（复验 RA6、SA9）：目录决定安装哪个版本，checkUniver 核对安装的实例。
 * 文档记录的版本（contracts 的 UNIVER_SDK_VERSION）由后端的单元测试（sdk-version.test.ts）与默认目录核对
 */
export function checkUniverCatalog(catalogs: Readonly<Record<string, Readonly<Record<string, string>>>>, policy: UniverPolicy): Violation[] {
  return Object.entries(catalogs).flatMap(([catalog, entries]) => Object.entries(entries)
    .filter(([name]) => name.startsWith('@univerjs/'))
    .flatMap(([name, version]) => {
      const expected = policy.independent[name] ?? policy.version
      return version === expected ? [] : [{ rule: 'deps/univer-catalog', subject: `目录 ${catalog} ${name}`, detail: `目录里是 ${version}，版本基线（UNIVER_POLICY）是 ${expected}` }]
    }))
}

/** 名单里的每一项是包名，或者 `@作用域/*`（这个作用域下的每个包）。 */
function singletonMatcher(singletons: readonly string[]): (name: string) => boolean {
  const names = new Set(singletons.filter(entry => !entry.endsWith('/*')))
  const scopes = singletons.filter(entry => entry.endsWith('/*')).map(entry => entry.slice(0, -1))
  return name => names.has(name) || scopes.some(scope => name.startsWith(scope))
}

/** 名单里的包都只能有一个安装实例；`@作用域/*` 表示这个作用域下的每个包各只能有一个。 */
export function checkSingletons(installed: readonly InstalledPackage[], singletons: readonly string[]): Violation[] {
  const violations: Violation[] = []
  const isSingleton = singletonMatcher(singletons)
  for (const [name, instances] of groupByName(installed)) {
    if (!isSingleton(name))
      continue
    if (instances.length > 1) {
      const where = instances.map(i => i.path.replace(/^.*\/node_modules\/\.pnpm\//, '')).join('、')
      violations.push({ rule: 'deps/singleton', subject: name, detail: `应只有一份实例，实际有 ${instances.length} 份：${where}` })
    }
  }
  return violations
}

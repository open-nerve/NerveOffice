// 按名称执行门禁：从仓库读取输入（执行 pnpm、vitest、playwright 的列举命令），交给各检查模块（纯函数）判断。
import type { CollectedGraph } from './dependency-graph.ts'
import type { Manifest } from './pins.ts'
import type { Violation } from './types.ts'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { commandJson, listFiles, packageName, readJson, readText, readWorkspaceConfig, REPO_ROOT, workspacePackageDirs } from '../shared/repo.ts'
import { checkStories, parseDesignStoryIds, parseRegistry, testsFromPlaywrightList, testsFromVitestList } from '../stories/stories.ts'
import { ARTIFACT_FILE_TYPES, checkFileTypes, scanArtifacts } from './artifacts.ts'
import { checkAudit } from './audit.ts'
import { checkGraphComplete, checkSingletons, checkUniver, collectInstalled } from './dependency-graph.ts'
import { bundledPackagesSchema, checkLicenseBundle } from './license-bundle.ts'
import { checkDevelopmentLicenses, checkProductionLicenses, flattenLicenseReport, licensesByPath } from './licenses.ts'
import { checkPins } from './pins.ts'
import { checkPnpmConfig } from './pnpm-config.ts'
import { auditReportSchema, licenseReportSchema, lsOutputSchema } from './pnpm-outputs.ts'
import { ARTIFACT_POLICY, AUDIT_EXCEPTIONS, LICENSE_EXCEPTIONS, PNPM_POLICY, PRODUCTION_LICENSES, SINGLETON_PACKAGES, UNIVER_POLICY } from './policy.ts'

export const GATE_NAMES = ['pins', 'config', 'stories', 'deps', 'licenses', 'artifacts', 'audit'] as const
export type GateName = typeof GATE_NAMES[number]

export interface GateOutcome {
  name: GateName
  title: string
  violations: Violation[]
  notes: string[]
}

const WEB_DIST = 'apps/web/dist'
const STORY_REGISTRY = 'tests/stories.json'
const E2E_SPECS = 'tests/e2e/specs'

/** 生产包：apps/* 与 packages/*（它们的依赖会进入产物或服务端运行时）。 */
function productionPackageNames(): string[] {
  return workspacePackageDirs(readWorkspaceConfig()).filter(dir => /^(?:apps|packages)\//.test(dir)).map(packageName)
}

let productionGraph: CollectedGraph | undefined
function productionDependencyGraph(): CollectedGraph {
  const filters = productionPackageNames().flatMap(name => ['--filter', name])
  productionGraph ??= collectInstalled(lsOutputSchema.parse(commandJson('pnpm', ['ls', '--prod', '--json', '--depth', 'Infinity', '--recursive', ...filters])))
  return productionGraph
}

function pins(): GateOutcome {
  const config = readWorkspaceConfig()
  const paths = ['package.json', ...workspacePackageDirs(config).map(dir => join(dir, 'package.json'))]
  const manifests: Manifest[] = paths.map(path => ({ path, json: readJson(path) as Manifest['json'] }))
  return { name: 'pins', title: '精确版本', violations: checkPins(manifests, { default: config.catalog, ...config.catalogs }), notes: [`${manifests.length} 个 package.json，目录里 ${Object.keys(config.catalog).length} 个依赖`] }
}

function config(): GateOutcome {
  return { name: 'config', title: '包管理配置', violations: checkPnpmConfig(readText('pnpm-workspace.yaml'), PNPM_POLICY), notes: [] }
}

function stories(): GateOutcome {
  const registry = parseRegistry(readJson(STORY_REGISTRY))
  const designIds = parseDesignStoryIds(readText(registry.design))
  const tests = [
    ...testsFromVitestList(commandJson('pnpm', ['exec', 'vitest', 'list', '--json', '--project', 'unit', '--project', 'unit-web', '--project', 'integration']), REPO_ROOT),
    ...testsFromPlaywrightList(commandJson('pnpm', ['--filter', '@nerve-office/e2e', 'exec', 'playwright', 'test', '--list', '--reporter=json']), E2E_SPECS),
  ]
  const active = Object.entries(registry.stories).filter(([, s]) => s.status === 'active').map(([id]) => id)
  return { name: 'stories', title: '故事对照', violations: checkStories(designIds, registry, tests), notes: [`${designIds.length} 个故事，active：${active.join('、') || '无'}；列举出 ${tests.length} 个会执行的测试`] }
}

function deps(): GateOutcome {
  const graph = productionDependencyGraph()
  const univer = graph.installed.filter(p => p.name.startsWith('@univerjs/')).length
  return {
    name: 'deps',
    title: '依赖图（Univer 版本、Pro、单例）',
    violations: [...checkGraphComplete(graph), ...checkUniver(graph.installed, UNIVER_POLICY), ...checkSingletons(graph.installed, SINGLETON_PACKAGES)],
    notes: [`生产依赖 ${graph.installed.length} 个安装实例（含可选依赖），其中 @univerjs/* ${univer} 个`],
  }
}

function licenses(): GateOutcome {
  const graph = productionDependencyGraph()
  const report = licenseReportSchema.parse(commandJson('pnpm', ['licenses', 'list', '--json']))
  const all = flattenLicenseReport(report)
  return {
    name: 'licenses',
    title: '许可',
    violations: [
      ...checkProductionLicenses(graph.installed, licensesByPath(report), PRODUCTION_LICENSES, LICENSE_EXCEPTIONS),
      ...checkDevelopmentLicenses(all, LICENSE_EXCEPTIONS),
    ],
    notes: [`生产依赖 ${graph.installed.length} 个安装实例，全部依赖 ${all.length} 个包`],
  }
}

function artifacts(): GateOutcome {
  const title = '产物扫描与第三方许可清单'
  if (!existsSync(join(REPO_ROOT, WEB_DIST, 'index.html')))
    return { name: 'artifacts', title, violations: [{ rule: 'artifacts/missing-build', subject: WEB_DIST, detail: '没有构建产物，先执行 pnpm build' }], notes: [] }
  const files = listFiles(WEB_DIST, () => true)
  const textFiles = files.filter(p => (ARTIFACT_FILE_TYPES.text as readonly string[]).includes(p.slice(p.lastIndexOf('.')).toLowerCase()))
  const { violations, hosts } = scanArtifacts(textFiles.map(path => ({ path, content: readText(path) })), ARTIFACT_POLICY)
  const bundleFile = join(WEB_DIST, '.vite', 'third-party-packages.json')
  const bundle = existsSync(join(REPO_ROOT, bundleFile))
    ? bundledPackagesSchema.parse(readJson(bundleFile))
    : undefined
  const bundleViolations: Violation[] = bundle === undefined
    ? [{ rule: 'license-bundle/missing-file', subject: bundleFile, detail: '没有第三方许可清单，检查 web 构建是否挂上了许可收集插件' }]
    : checkLicenseBundle(bundle, PRODUCTION_LICENSES, LICENSE_EXCEPTIONS)
  const hostSummary = [...hosts].map(([host, count]) => `${host}×${count}`).join('、') || '无'
  return {
    name: 'artifacts',
    title,
    violations: [...checkFileTypes(files), ...violations, ...bundleViolations],
    notes: [`${files.length} 个文件，扫描其中 ${textFiles.length} 个；出现的主机：${hostSummary}；打进产物的第三方包 ${bundle?.length ?? 0} 个`],
  }
}

function audit(): GateOutcome {
  const today = new Date().toISOString().slice(0, 10)
  const production = auditReportSchema.parse(commandJson('pnpm', ['audit', '--prod', '--json']))
  const all = auditReportSchema.parse(commandJson('pnpm', ['audit', '--json']))
  const counts = Object.entries(all.metadata.vulnerabilities).filter(([, n]) => n > 0).map(([level, n]) => `${level} ${n}`).join('、') || '无'
  return { name: 'audit', title: '依赖漏洞', violations: checkAudit(production, AUDIT_EXCEPTIONS, today), notes: [`全部依赖（含开发依赖）的漏洞：${counts}`] }
}

const GATES: Readonly<Record<GateName, () => GateOutcome>> = { pins, config, stories, deps, licenses, artifacts, audit }

export function runGate(name: GateName): GateOutcome {
  return GATES[name]()
}

// 按名称执行门禁：从仓库读取输入，交给各检查模块（纯函数）判断。
import type { AuditReport } from './audit.ts'
import type { LsProject } from './dependency-graph.ts'
import type { LicenseEntry, LicenseReport } from './licenses.ts'
import type { Manifest } from './pins.ts'
import type { Violation } from './types.ts'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { listFiles, pnpmJson, readJson, readText, readWorkspaceConfig, REPO_ROOT, workspacePackageDirs } from '../shared/repo.ts'
import { checkStories, extractTitles, parseDesignStoryIds, parseRegistry } from '../stories/stories.ts'
import { scanArtifacts } from './artifacts.ts'
import { checkAudit } from './audit.ts'
import { checkSingletons, checkUniver, collectInstalled } from './dependency-graph.ts'
import { checkLicenseBundle, parseLicenseMarkdown } from './license-bundle.ts'
import { checkDevelopmentLicenses, checkProductionLicenses, flattenLicenseReport } from './licenses.ts'
import { checkPins } from './pins.ts'
import { checkPnpmConfig } from './pnpm-config.ts'
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
const WEB_SUPPLEMENT_LICENSES = 'apps/web/third-party-licenses'
const STORY_REGISTRY = 'tests/stories.json'

/** 生产包：apps/* 与 packages/*（它们的依赖会进入产物或服务端运行时）。 */
function productionPackageNames(): string[] {
  const dirs = workspacePackageDirs(readWorkspaceConfig()).filter(dir => /^(?:apps|packages)\//.test(dir))
  return dirs.map(dir => (readJson(join(dir, 'package.json')) as { name: string }).name)
}

function filters(names: readonly string[]): string[] {
  return names.flatMap(name => ['--filter', name])
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
  const kinds = [
    { kind: 'e2e' as const, files: listFiles('tests/e2e/specs', p => p.endsWith('.spec.ts')) },
    { kind: 'integration' as const, files: listFiles('tests/integration/src', p => p.endsWith('.test.ts')) },
    { kind: 'unit' as const, files: ['apps', 'packages', 'tools'].flatMap(dir => listFiles(dir, p => /\/src\/.*\.test\.tsx?$/.test(p) && !p.includes('node_modules'))) },
  ]
  const titles = kinds.flatMap(({ kind, files }) => files.flatMap(file => extractTitles(readText(file)).map(title => ({ file, kind, title }))))
  const active = Object.entries(registry.stories).filter(([, s]) => s.status === 'active').map(([id]) => id)
  return { name: 'stories', title: '故事对照', violations: checkStories(designIds, registry, titles), notes: [`${designIds.length} 个故事，active：${active.join('、') || '无'}`] }
}

function deps(): GateOutcome {
  const projects = pnpmJson(['ls', '--prod', '--json', '--depth', 'Infinity', '--recursive', ...filters(productionPackageNames())]) as LsProject[]
  const installed = collectInstalled(projects)
  const univer = installed.filter(p => p.name.startsWith('@univerjs/')).length
  return {
    name: 'deps',
    title: '依赖图（Univer 版本、Pro、单例）',
    violations: [...checkUniver(installed, UNIVER_POLICY), ...checkSingletons(installed, SINGLETON_PACKAGES)],
    notes: [`生产依赖 ${installed.length} 个安装实例，其中 @univerjs/* ${univer} 个`],
  }
}

function dedupe(entries: readonly LicenseEntry[]): LicenseEntry[] {
  return [...new Map(entries.map(e => [`${e.name}|${e.license}`, e])).values()]
}

function licenses(): GateOutcome {
  const production = dedupe(productionPackageNames().flatMap(name => flattenLicenseReport(pnpmJson(['licenses', 'list', '--prod', '--json', '--filter', name]) as LicenseReport)))
  const all = dedupe(flattenLicenseReport(pnpmJson(['licenses', 'list', '--json']) as LicenseReport))
  return {
    name: 'licenses',
    title: '许可',
    violations: [...checkProductionLicenses(production, PRODUCTION_LICENSES, LICENSE_EXCEPTIONS), ...checkDevelopmentLicenses(all, LICENSE_EXCEPTIONS)],
    notes: [`生产依赖 ${production.length} 个包，全部依赖 ${all.length} 个包`],
  }
}

function supplementNames(): Set<string> {
  const files = listFiles(WEB_SUPPLEMENT_LICENSES, p => p.endsWith('/LICENSE'))
  return new Set(files.map(file => file.slice(WEB_SUPPLEMENT_LICENSES.length + 1, -'/LICENSE'.length)))
}

function artifacts(): GateOutcome {
  if (!existsSync(join(REPO_ROOT, WEB_DIST, 'index.html')))
    return { name: 'artifacts', title: '产物扫描与第三方许可清单', violations: [{ rule: 'artifacts/missing-build', subject: WEB_DIST, detail: '没有构建产物，先执行 pnpm build' }], notes: [] }
  const files = listFiles(WEB_DIST, p => !p.includes('/.vite/') && /\.(?:js|mjs|css|html|svg)$/.test(p))
  const { violations, hosts } = scanArtifacts(files.map(path => ({ path, content: readText(path) })), ARTIFACT_POLICY)
  const licenseFile = join(WEB_DIST, '.vite', 'license.md')
  const bundle = existsSync(join(REPO_ROOT, licenseFile))
    ? checkLicenseBundle(parseLicenseMarkdown(readText(licenseFile)), supplementNames(), PRODUCTION_LICENSES)
    : [{ rule: 'license-bundle/missing-file', subject: licenseFile, detail: '没有第三方许可清单，检查构建是否开启了 build.license' }]
  const hostSummary = [...hosts].map(([host, count]) => `${host}×${count}`).join('、') || '无'
  return { name: 'artifacts', title: '产物扫描与第三方许可清单', violations: [...violations, ...bundle], notes: [`扫描 ${files.length} 个文件；出现的主机：${hostSummary}`] }
}

function audit(): GateOutcome {
  const today = new Date().toISOString().slice(0, 10)
  const production = pnpmJson(['audit', '--prod', '--json']) as AuditReport
  const all = pnpmJson(['audit', '--json']) as AuditReport & { metadata?: { vulnerabilities?: Record<string, number> } }
  const counts = Object.entries(all.metadata?.vulnerabilities ?? {}).filter(([, n]) => n > 0).map(([level, n]) => `${level} ${n}`).join('、') || '无'
  return { name: 'audit', title: '依赖漏洞', violations: checkAudit(production, AUDIT_EXCEPTIONS, today), notes: [`全部依赖（含开发依赖）的漏洞：${counts}`] }
}

const GATES: Readonly<Record<GateName, () => GateOutcome>> = { pins, config, stories, deps, licenses, artifacts, audit }

export function runGate(name: GateName): GateOutcome {
  return GATES[name]()
}

// 按名称执行门禁：从仓库读取输入（执行 pnpm、vitest、playwright 的列举命令），交给各检查模块（纯函数）判断。
// Vitest 列举全部项目，新增项目时不会漏掉。
// 读取外部输入的方式（执行命令、产物目录、当天日期）可以注入，便于用样例测试装配逻辑。
import type { CollectedGraph } from './dependency-graph.ts'
import type { Violation } from './types.ts'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import process from 'node:process'
import { gzipSync } from 'node:zlib'
import { z } from 'zod'
import { commandJson, packageName, readJson, readText, readWorkspaceConfig, REPO_ROOT, workspacePackageDirs } from '../shared/repo.ts'
import { checkStories, parseDesignStoryIds, parseRegistry, testsFromPlaywrightList, testsFromVitestList } from '../stories/stories.ts'
import { checkFileTypes, checkTestOnlyArtifacts, classifyArtifact, scanArtifacts } from './artifacts.ts'
import { checkAudit } from './audit.ts'
import { checkBudgets, initialFiles, initialStyles, reachableFiles, referencedWorkers, viteManifestSchema, workerClosure } from './budgets.ts'
import { checkGraphComplete, checkSingletons, checkUniver, collectInstalled } from './dependency-graph.ts'
import { bundledPackagesSchema, checkLicenseBundle } from './license-bundle.ts'
import { checkDevelopmentLicenses, checkProductionLicenses, flattenLicenseReport, licensesByPath } from './licenses.ts'
import { gitIn, runMigrationsGate } from './migrations-gate.ts'
import { MIGRATIONS_DIR } from './migrations.ts'
import { checkPins } from './pins.ts'
import { checkPnpmConfig, checkPnpmfiles, PNPMFILE_NAMES } from './pnpm-config.ts'
import { auditReportSchema, licenseReportSchema, lsOutputSchema } from './pnpm-outputs.ts'
import { ARTIFACT_POLICY, AUDIT_EXCEPTIONS, EDITOR_ENTRIES, ENTRY_BUDGETS, LICENSE_EXCEPTIONS, PLATFORM_ENTRIES, PNPM_POLICY, PRODUCTION_LICENSES, SINGLETON_PACKAGES, UNIVER_POLICY, WORKER_BUDGETS } from './policy.ts'
import { runSchemaGate } from './schema-gate.ts'

export const GATE_NAMES = ['pins', 'config', 'stories', 'migrations', 'schema', 'deps', 'licenses', 'artifacts', 'budgets', 'audit'] as const
export type GateName = typeof GATE_NAMES[number]

export interface GateOutcome {
  name: GateName
  title: string
  violations: Violation[]
  notes: string[]
}

/** 执行命令并返回它输出的 JSON。 */
export type CommandRunner = (command: string, args: readonly string[]) => unknown

const WEB_DIST = join(REPO_ROOT, 'apps/web/dist')
const STORY_REGISTRY = 'tests/stories.json'
const E2E_SPECS = 'tests/e2e/specs'

const manifestSchema = z.object({
  name: z.string().optional(),
  packageManager: z.string().optional(),
  dependencies: z.record(z.string(), z.string()).optional(),
  devDependencies: z.record(z.string(), z.string()).optional(),
  optionalDependencies: z.record(z.string(), z.string()).optional(),
})

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
  const manifests = paths.map(path => ({ path, json: manifestSchema.parse(readJson(path)) }))
  return { name: 'pins', title: '精确版本', violations: checkPins(manifests, { default: config.catalog, ...config.catalogs }), notes: [`${manifests.length} 个 package.json，目录里 ${Object.keys(config.catalog).length} 个依赖`] }
}

function config(): GateOutcome {
  const pnpmfiles = PNPMFILE_NAMES.filter(name => existsSync(join(REPO_ROOT, name)))
  return { name: 'config', title: '包管理配置', violations: [...checkPnpmConfig(readText('pnpm-workspace.yaml'), PNPM_POLICY), ...checkPnpmfiles(pnpmfiles)], notes: [] }
}

function stories(): GateOutcome {
  const registry = parseRegistry(readJson(STORY_REGISTRY))
  const designIds = parseDesignStoryIds(readText(registry.design))
  const tests = [
    ...testsFromVitestList(commandJson('pnpm', ['exec', 'vitest', 'list', '--json']), REPO_ROOT),
    // 经 e2e 包的 list 脚本：它按 @nerve-office/source 条件解析工作区的包，用例引用的 contracts 不必先构建（静态检查在构建之前执行）
    ...testsFromPlaywrightList(commandJson('pnpm', ['--silent', '--filter', '@nerve-office/e2e', 'run', 'list']), E2E_SPECS),
  ]
  const active = Object.entries(registry.stories).filter(([, s]) => s.status === 'active').map(([id]) => id)
  return { name: 'stories', title: '故事对照', violations: checkStories(designIds, registry, tests), notes: [`${designIds.length} 个故事，active：${active.join('、') || '无'}；列举出 ${tests.length} 个会执行的测试`] }
}

function migrations(): GateOutcome {
  const result = runMigrationsGate({ root: REPO_ROOT, env: process.env, git: gitIn(REPO_ROOT) })
  return { name: 'migrations', title: '迁移只向前', ...result }
}

function schema(): GateOutcome {
  return { name: 'schema', title: '表定义与迁移同步', ...runSchemaGate(join(REPO_ROOT, MIGRATIONS_DIR)) }
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
  const notInstalled = graph.installed.filter(item => !existsSync(item.path)).length
  return {
    name: 'licenses',
    title: '许可',
    violations: [
      ...checkProductionLicenses(graph.installed, licensesByPath(report), PRODUCTION_LICENSES, LICENSE_EXCEPTIONS, existsSync),
      ...checkDevelopmentLicenses(all, LICENSE_EXCEPTIONS),
    ],
    notes: [`生产依赖 ${graph.installed.length} 个安装实例（本机没装的平台专属包 ${notInstalled} 个，以 CI 的检查为准），全部依赖 ${all.length} 个包`],
  }
}

/** 产物目录下的全部文件，路径相对产物目录。 */
function filesIn(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile())
    .map(entry => relative(dir, join(entry.parentPath, entry.name)))
    .sort()
}

function readManifest(distDir: string): ReturnType<typeof viteManifestSchema.parse> | undefined {
  const manifestFile = join(distDir, '.vite', 'manifest.json')
  return existsSync(manifestFile) ? viteManifestSchema.parse(JSON.parse(readFileSync(manifestFile, 'utf8'))) : undefined
}

/**
 * 地址可以按前缀放行的文件（P4 设计 §3.9）：编辑器页能加载到的 JS 与样式（首屏与动态加载的块）与它创建的 Worker。
 * 平台页面的产物（入口页、首屏的 JS 与样式，含两边共用的块）除外；其他文件与找不到构建清单时一律只按具体地址（审查 A 路建议 B1）
 */
function prefixFiles(distDir: string): Set<string> {
  const manifest = readManifest(distDir)
  if (manifest === undefined)
    return new Set()
  const readText = (file: string): string => readFileSync(join(distDir, file), 'utf8')
  const platform = new Set(PLATFORM_ENTRIES.flatMap(entry => [entry, ...(initialFiles(manifest, entry) ?? []), ...initialStyles(manifest, entry)]))
  const editor = EDITOR_ENTRIES.flatMap((entry) => {
    const files = reachableFiles(manifest, entry)
    return [entry, ...files, ...referencedWorkers(files.filter(file => file.endsWith('.js')), readText).flatMap(worker => workerClosure(worker, readText))]
  })
  return new Set(editor.filter(file => !platform.has(file)))
}

/** distDir 是 web 构建产物的目录（绝对路径）。 */
export function artifactsGate(distDir: string): GateOutcome {
  const title = '产物扫描与第三方许可清单'
  if (!existsSync(join(distDir, 'index.html')))
    return { name: 'artifacts', title, violations: [{ rule: 'artifacts/missing-build', subject: relative(REPO_ROOT, distDir), detail: '没有构建产物，先执行 pnpm build' }], notes: [] }
  const files = filesIn(distDir)
  const textFiles = files.filter(path => classifyArtifact(path) === 'text')
  const scanned = textFiles.map(path => ({ path, content: readFileSync(join(distDir, path), 'utf8') }))
  const { violations, hosts, runtimeHosts, unusedAddresses, knownDynamicCode, globalThisProbes } = scanArtifacts(scanned, ARTIFACT_POLICY, { prefixFiles: prefixFiles(distDir) })
  const bundleFile = join(distDir, '.vite', 'third-party-packages.json')
  const bundle = existsSync(bundleFile) ? bundledPackagesSchema.parse(JSON.parse(readFileSync(bundleFile, 'utf8'))) : undefined
  const bundleViolations: Violation[] = bundle === undefined
    ? [{ rule: 'license-bundle/missing-file', subject: '.vite/third-party-packages.json', detail: '没有第三方许可清单，检查 web 构建是否挂上了许可收集插件' }]
    : checkLicenseBundle(bundle, PRODUCTION_LICENSES, LICENSE_EXCEPTIONS)
  const hostSummary = [...hosts].map(([host, count]) => `${host}×${count}`).join('、') || '无'
  const knownSummary = [...knownDynamicCode].map(([name, count]) => `${name}×${count}`).join('、') || '无'
  return {
    name: 'artifacts',
    title,
    violations: [...checkFileTypes(files), ...checkTestOnlyArtifacts(files), ...violations, ...bundleViolations],
    notes: [
      `${files.length} 个文件，扫描其中 ${textFiles.length} 个；打进产物的第三方包 ${bundle?.length ?? 0} 个`,
      `出现的主机：${hostSummary}；主机在运行时拼出的地址 ${runtimeHosts} 处（由 CSP 兜底）`,
      `允许清单里这次没出现的地址（核对后删除）：${unusedAddresses.join('、') || '无'}`,
      `已登记的动态代码（出现次数为 0 的登记已经过时，核对后删除）：${knownSummary}；全局对象探测 ${globalThisProbes} 处（上限 ${ARTIFACT_POLICY.globalThisProbeMax}）`,
    ],
  }
}

/** distDir 是 web 构建产物的目录（绝对路径）。 */
export function budgetsGate(distDir: string): GateOutcome {
  const title = '首屏体积预算'
  const manifest = readManifest(distDir)
  if (manifest === undefined)
    return { name: 'budgets', title, violations: [{ rule: 'budgets/missing-build', subject: relative(REPO_ROOT, distDir), detail: '没有构建清单，先执行 pnpm build' }], notes: [] }
  return {
    name: 'budgets',
    title,
    ...checkBudgets(manifest, ENTRY_BUDGETS, WORKER_BUDGETS, {
      gzipSize: file => gzipSync(readFileSync(join(distDir, file))).length,
      readText: file => readFileSync(join(distDir, file), 'utf8'),
    }),
  }
}

/** today 是当天的日期（YYYY-MM-DD）。 */
export function auditGate(run: CommandRunner, today: string): GateOutcome {
  const production = auditReportSchema.parse(run('pnpm', ['audit', '--prod', '--json']))
  const all = auditReportSchema.parse(run('pnpm', ['audit', '--json']))
  const counts = Object.entries(all.metadata.vulnerabilities).filter(([, n]) => n > 0).map(([level, n]) => `${level} ${n}`).join('、') || '无'
  return { name: 'audit', title: '依赖漏洞', violations: checkAudit(production, AUDIT_EXCEPTIONS, today), notes: [`全部依赖（含开发依赖）的漏洞：${counts}`] }
}

const GATES: Readonly<Record<GateName, () => GateOutcome>> = {
  pins,
  config,
  stories,
  migrations,
  schema,
  deps,
  licenses,
  artifacts: () => artifactsGate(WEB_DIST),
  budgets: () => budgetsGate(WEB_DIST),
  audit: () => auditGate(commandJson, new Date().toISOString().slice(0, 10)),
}

export function runGate(name: GateName): GateOutcome {
  return GATES[name]()
}

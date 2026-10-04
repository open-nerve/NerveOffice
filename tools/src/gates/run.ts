// 按名称执行门禁：从仓库读取输入（执行 pnpm、vitest、playwright 的列举命令），交给各检查模块（纯函数）判断。
// Vitest 列举全部项目，新增项目时不会漏掉。
// 读取外部输入的方式（执行命令、产物目录、当天日期）可以注入（GateInputs），门禁表按注入的输入装配：
// 单元测试经 runGate 走一遍装配，确认每个名字接的就是对应的门禁（M2-P6 第 6 片复核第二批 M-1）。
import type { CollectedGraph } from './dependency-graph.ts'
import type { Violation } from './types.ts'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import process from 'node:process'
import { gzipSync } from 'node:zlib'
import { z } from 'zod'
import { API_PACKAGE, SERVER_LICENSE_SUPPLEMENT, serverLicenseViolations, serverPackages } from '../deploy/server-licenses.ts'
import { commandJson, listFiles, packageName, readJson, readText, readWorkspaceConfig, REPO_ROOT, workspacePackageDirs } from '../shared/repo.ts'
import { checkStories, parseDesignStoryIds, parseRegistry, testsFromPlaywrightList, testsFromVitestList } from '../stories/stories.ts'
import { checkFileTypes, checkTestOnlyArtifacts, checkTestOnlySources, classifyArtifact, scanArtifacts } from './artifacts.ts'
import { checkAudit } from './audit.ts'
import { checkBudgets, entryWorkers, reachableFiles, viteManifestSchema, workerClosure } from './budgets.ts'
import { checkContainerImages } from './container-images.ts'
import { checkGraphComplete, checkSingletons, checkUniver, checkUniverCatalog, collectInstalled } from './dependency-graph.ts'
import { bundledPackagesSchema, checkLicenseBundle, checkLicenseText, checkLicenseTextFile, LICENSE_TEXT_FILE } from './license-bundle.ts'
import { checkDevelopmentLicenses, checkProductionLicenses, flattenLicenseReport, licensesByPath } from './licenses.ts'
import { gitIn, runMigrationsGate } from './migrations-gate.ts'
import { MIGRATIONS_DIR } from './migrations.ts'
import { MODULE_SOURCES_FILE, moduleSourcesSchema } from './module-sources.ts'
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

/** 门禁从仓库之外读取的输入：runGate 默认用真实的（REPOSITORY_INPUTS），单元测试注入样例 */
export interface GateInputs {
  /** 执行命令并返回它输出的 JSON：pnpm 的列举与漏洞扫描、vitest 与 playwright 的列举 */
  readonly run: CommandRunner
  /** web 构建产物的目录（绝对路径） */
  readonly webDist: string
  /** 当天的日期（YYYY-MM-DD）：漏洞的例外按它判断有没有到期 */
  readonly today: () => string
}

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

/** 生产依赖图按执行命令的方式缓存：deps 与 licenses 一起执行时只列举一次 */
const productionGraphs = new WeakMap<CommandRunner, CollectedGraph>()
function productionDependencyGraph(run: CommandRunner): CollectedGraph {
  const cached = productionGraphs.get(run)
  if (cached !== undefined)
    return cached
  const filters = productionPackageNames().flatMap(name => ['--filter', name])
  const graph = collectInstalled(lsOutputSchema.parse(run('pnpm', ['ls', '--prod', '--json', '--depth', 'Infinity', '--recursive', ...filters])))
  productionGraphs.set(run, graph)
  return graph
}

/** 引用容器镜像的文件：deploy 下的 Dockerfile 与编排文件，CI 的工作流 */
function containerImageFiles(): { path: string, content: string }[] {
  const paths = [
    ...listFiles('deploy', path => /(?:^|\/)(?:Dockerfile(?:\.[\w-]+)?|compose(?:\.[\w-]+)?\.ya?ml)$/.test(path)),
    ...listFiles(join('.github', 'workflows'), path => /\.ya?ml$/.test(path)),
  ]
  return paths.map(path => ({ path, content: readText(path) }))
}

function pins(): GateOutcome {
  const config = readWorkspaceConfig()
  const paths = ['package.json', ...workspacePackageDirs(config).map(dir => join(dir, 'package.json'))]
  const manifests = paths.map(path => ({ path, json: manifestSchema.parse(readJson(path)) }))
  const packageManager = manifests.find(item => item.path === 'package.json')?.json.packageManager ?? ''
  const images = containerImageFiles()
  const imagePolicy = { nodeVersion: readText('.node-version').trim(), pnpmVersion: /^pnpm@([^+]+)/.exec(packageManager)?.[1] ?? '' }
  return {
    name: 'pins',
    title: '精确版本',
    violations: [...checkPins(manifests, { default: config.catalog, ...config.catalogs }), ...checkContainerImages(images, imagePolicy)],
    notes: [`${manifests.length} 个 package.json，目录里 ${Object.keys(config.catalog).length} 个依赖；${images.length} 个文件引用容器镜像`],
  }
}

function config(): GateOutcome {
  const pnpmfiles = PNPMFILE_NAMES.filter(name => existsSync(join(REPO_ROOT, name)))
  return { name: 'config', title: '包管理配置', violations: [...checkPnpmConfig(readText('pnpm-workspace.yaml'), PNPM_POLICY), ...checkPnpmfiles(pnpmfiles)], notes: [] }
}

/**
 * 故事对照：读登记表与它列出的各份总设计，列举会执行的测试，交给 checkStories。
 * run 执行两条列举命令；单元测试注入样例（真的列举全部用例要十几秒，慢在 vitest list：仓库现状由 static-gates 一步核对）
 */
export function storiesGate(run: CommandRunner): GateOutcome {
  const registry = parseRegistry(readJson(STORY_REGISTRY))
  const designIds = registry.designs.flatMap(design => parseDesignStoryIds(readText(design)))
  const tests = [
    ...testsFromVitestList(run('pnpm', ['exec', 'vitest', 'list', '--json']), REPO_ROOT),
    // 经 e2e 包的 list 脚本：它按 @nerve-office/source 条件解析工作区的包，用例引用的 contracts 不必先构建（静态检查在构建之前执行）
    ...testsFromPlaywrightList(run('pnpm', ['--silent', '--filter', '@nerve-office/e2e', 'run', 'list']), E2E_SPECS),
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

/** pnpm 的全部目录：默认目录（catalog:）与具名目录（catalog:<名字>） */
function workspaceCatalogs(): Record<string, Record<string, string>> {
  const config = readWorkspaceConfig()
  return { default: config.catalog, ...config.catalogs }
}

function deps(run: CommandRunner): GateOutcome {
  const graph = productionDependencyGraph(run)
  const univer = graph.installed.filter(p => p.name.startsWith('@univerjs/')).length
  return {
    name: 'deps',
    title: '依赖图（Univer 版本、Pro、单例）',
    violations: [
      ...checkGraphComplete(graph),
      ...checkUniverCatalog(workspaceCatalogs(), UNIVER_POLICY),
      ...checkUniver(graph.installed, UNIVER_POLICY),
      ...checkSingletons(graph.installed, SINGLETON_PACKAGES),
    ],
    notes: [`生产依赖 ${graph.installed.length} 个安装实例（含可选依赖），其中 @univerjs/* ${univer} 个`],
  }
}

function licenses(run: CommandRunner): GateOutcome {
  const graph = productionDependencyGraph(run)
  const report = licenseReportSchema.parse(run('pnpm', ['licenses', 'list', '--json']))
  const all = flattenLicenseReport(report)
  const notInstalled = graph.installed.filter(item => !existsSync(item.path)).length
  // 服务端的许可清单随镜像生成（P5 设计 §3.2.1）：这里提前核对依赖图完整、每个包都有许可正文，不必等到构建镜像才失败（审查 A10）
  const serverGraph = collectInstalled(lsOutputSchema.parse(run('pnpm', ['ls', '--prod', '--json', '--depth', 'Infinity', '--filter', API_PACKAGE])))
  const server = serverPackages(serverGraph, SERVER_LICENSE_SUPPLEMENT)
  const serverMissing = serverLicenseViolations(serverGraph, server.packages)
  return {
    name: 'licenses',
    title: '许可',
    violations: [
      ...checkProductionLicenses(graph.installed, licensesByPath(report), PRODUCTION_LICENSES, LICENSE_EXCEPTIONS, existsSync),
      ...checkDevelopmentLicenses(all, LICENSE_EXCEPTIONS),
      ...serverMissing,
    ],
    notes: [
      `生产依赖 ${graph.installed.length} 个安装实例（本机没装的平台专属包 ${notInstalled} 个，以 CI 的检查为准），全部依赖 ${all.length} 个包`,
      `服务端的许可清单：${server.packages.length} 个包（本机装上的）`,
    ],
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

/** web 构建写出的模块来源清单（M3-P2 复核 B2）；没有时为 undefined */
function readModuleSources(distDir: string): ReturnType<typeof moduleSourcesSchema.parse> | undefined {
  const file = join(distDir, MODULE_SOURCES_FILE)
  return existsSync(file) ? moduleSourcesSchema.parse(JSON.parse(readFileSync(file, 'utf8'))) : undefined
}

/**
 * 地址可以按前缀放行的文件（P4 设计 §3.9）：编辑器页能加载到的全部产物，即入口页、JS 与样式（首屏与动态加载的块）、
 * 它创建的 Worker 与 Worker 加载的块。其他入口（平台页面与构建清单里别的入口）能加载到的产物（含与编辑器共用的块）除外；
 * 其他文件、清单里没有的入口、找不到构建清单时，一律只按具体地址（审查 A 路建议 B1，复验 RA8、SA6）
 */
function prefixFiles(distDir: string): Set<string> {
  const manifest = readManifest(distDir)
  if (manifest === undefined)
    return new Set()
  const readText = (file: string): string => readFileSync(join(distDir, file), 'utf8')
  const loadableFrom = (entry: string): string[] => manifest[entry] === undefined
    ? []
    : [entry, ...reachableFiles(manifest, entry), ...entryWorkers(manifest, entry).flatMap(worker => workerClosure(worker, readText, true))]
  // 编辑器之外的入口：平台页面，以及构建清单里其他的入口（新增的、改了名的，复验 SA6）
  const others = [...new Set([...PLATFORM_ENTRIES, ...Object.keys(manifest).filter(entry => manifest[entry]?.isEntry === true && !EDITOR_ENTRIES.includes(entry))])]
  const platform = new Set(others.flatMap(loadableFrom))
  return new Set(EDITOR_ENTRIES.flatMap(loadableFrom).filter(file => !platform.has(file)))
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
  // 随部署分发的是许可正文：清单说收集过正文不等于正文还在产物里，两者都要核对（Codex 评审 CX9）
  const textFile = join(distDir, LICENSE_TEXT_FILE)
  const licenseText = existsSync(textFile) ? readFileSync(textFile, 'utf8') : undefined
  const bundleViolations: Violation[] = bundle === undefined
    ? [
        { rule: 'license-bundle/missing-file', subject: '.vite/third-party-packages.json', detail: '没有第三方许可清单，检查 web 构建是否挂上了许可收集插件' },
        // 没有清单就无从逐个核对正文，只核对正文的文件还在
        ...checkLicenseTextFile(licenseText),
      ]
    : [...checkLicenseBundle(bundle, PRODUCTION_LICENSES, LICENSE_EXCEPTIONS), ...checkLicenseText(bundle, licenseText)]
  // 测试专用的模块按来源认（M3-P2 复核 B2）：没有清单就无从核对，报出来
  const sources = readModuleSources(distDir)
  const sourceViolations: Violation[] = sources === undefined
    ? [{ rule: 'artifacts/missing-module-sources', subject: MODULE_SOURCES_FILE, detail: '没有模块来源清单，检查 web 构建是否挂上了 module-sources 插件' }]
    : checkTestOnlySources(sources, files)
  const hostSummary = [...hosts].map(([host, count]) => `${host}×${count}`).join('、') || '无'
  const knownSummary = [...knownDynamicCode].map(([name, count]) => `${name}×${count}`).join('、') || '无'
  return {
    name: 'artifacts',
    title,
    violations: [...checkFileTypes(files), ...checkTestOnlyArtifacts(files), ...sourceViolations, ...violations, ...bundleViolations],
    notes: [
      `${files.length} 个文件，扫描其中 ${textFiles.length} 个；打进产物的第三方包 ${bundle?.length ?? 0} 个；按来源核对了 ${Object.keys(sources ?? {}).length} 个脚本`,
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
      files: filesIn(distDir),
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

/** 真实的输入：执行命令、仓库里的 web 构建产物、本机当天的日期 */
const REPOSITORY_INPUTS: GateInputs = { run: commandJson, webDist: WEB_DIST, today: () => new Date().toISOString().slice(0, 10) }

/**
 * 门禁表：按注入的输入装配，每个名字一项（类型保证不漏）。故事对照只由 pnpm verify 的静态门禁一步核对仓库现状
 * （门禁自测不再重复跑，M2-P6 第 6 片复核 M1）：这里的装配由 run.test.ts 经 runGate 用样例核对，
 * 静态门禁一步带着它由 plan.test.ts 核对（复核第二批 M-1）
 */
function gates(inputs: GateInputs): Readonly<Record<GateName, () => GateOutcome>> {
  return {
    pins,
    config,
    stories: () => storiesGate(inputs.run),
    migrations,
    schema,
    deps: () => deps(inputs.run),
    licenses: () => licenses(inputs.run),
    artifacts: () => artifactsGate(inputs.webDist),
    budgets: () => budgetsGate(inputs.webDist),
    audit: () => auditGate(inputs.run, inputs.today()),
  }
}

/** 执行一个门禁；inputs 省略时读真实的仓库（命令行 cli.ts 与"门禁对仓库现状通过"的自测） */
export function runGate(name: GateName, inputs: GateInputs = REPOSITORY_INPUTS): GateOutcome {
  return gates(inputs)[name]()
}

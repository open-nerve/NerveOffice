// lint 规则自测的共用部分：对违规的代码执行 ESLint，确认报出对应的规则；按路径生效的规则，再用 ESLint 为该路径计算出的配置来确认。
// 自测按领域分成几个文件（lint-rules-*.test.ts，M2-P6 第 6 片复核 M1）：原来一个文件 91 条，是 pnpm test 的关键路径——
// 覆盖率那一轮里其他文件 59 秒都跑完了，它一个跑到 140 秒。分开之后几个文件并行，各自只为用到的 tsconfig 工程建类型程序。
// 类型感知的解析只接受 tsconfig 里真实存在的文件，所以 lintText 借用仓库里已有的文件路径；
// 需要"被引用的目标"时，临时创建探针文件（已加入 .gitignore），用完删除。
import type { Linter } from 'eslint'
import { mkdirSync, rmdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { ESLint } from 'eslint'
import { afterAll, beforeAll } from 'vitest'
import { REPO_ROOT } from '../shared/repo.ts'

/** 探针文件的名字带进程号：几个自测文件并行时各用各的 */
export const PROBE = `lint-probe-${process.pid}`
export const PROBE_FILES = {
  // 编辑器里的文件（任何一个都不应被平台入口引用）
  editor: `apps/web/src/editor/${PROBE}/editor-part.ts`,
  // 不属于任何元素的"无主"文件：借它中转就能绕过边界
  stray: `apps/web/src/${PROBE}.ts`,
  // 编辑器页的入口与编辑器页（sheet-editor 功能）里的文件：作为"从这里引用"的位置（P4 设计 §3.1）
  editorEntry: `apps/web/src/entries/editor/${PROBE}.ts`,
  sheetEditor: `apps/web/src/features/sheet-editor/${PROBE}.ts`,
  // 编辑器页里被引用的文件
  sheetEditorPart: `apps/web/src/features/sheet-editor/${PROBE}-part.ts`,
}

export const WEB_FILE = 'apps/web/src/app/app.tsx'
export const WEB_TEST_FILE = 'apps/web/src/app/app.test.tsx'
export const WEB_TEST_SUPPORT = 'apps/web/src/app/render-app.test-support.tsx'
export const WEB_SHARED_FILE = 'apps/web/src/shared/lib/format.ts'
export const WEB_FEATURE_FILE = 'apps/web/src/features/auth/session.ts'
export const PLATFORM_ENTRY = 'apps/web/src/entries/platform/main.tsx'
export const EDITOR_FILE = 'apps/web/src/editor/sheet-editor.ts'
export const INTERNAL_API_FILE = 'apps/web/src/editor/internal-api/index.ts'
export const CONTRACTS_FILE = 'packages/contracts/src/errors/error-response.ts'
export const TOOLS_TEST_FILE = 'tools/src/git/strip-ai-trailers.test.ts'
export const E2E_FILE = 'tests/e2e/specs/foundation/framework-smoke.spec.ts'
export const API_CONTROLLER = 'apps/api/src/modules/health/health.controller.ts'
export const API_SERVICE = 'apps/api/src/modules/health/application-state.ts'
export const API_CONFIG = 'apps/api/src/modules/config/config.ts'
export const INTEGRATION_FILE = 'tests/integration/src/support/api-app.ts'
/** 集成测试专用的入口（包的出口 @nerve-office/api/testing，M2-P6 复验 R-S4） */
export const API_INTEGRATION_ENTRY = 'apps/api/src/app/integration.test-support.ts'

/** 内部 API 的限制的说明（开头一段） */
export const INTERNAL_MESSAGE = '内部 API 只能经 apps/web/src/editor/internal-api/ 引用并登记'
/** 弹窗类的 Radix 原语的限制的说明（开头一段，M2-P2 复验） */
export const RADIX_DIALOG_MESSAGE = '弹窗类的 Radix 原语（Dialog、AlertDialog）只在 shared/ui/dialog.tsx 里引入'

// 时限只用来发现卡住的用例，不是性能预算。实测（M2-P6 第 6 片，本机 Apple M4 Pro 12 核，背景负载约 1 核）：
// - 预热（beforeAll：加载整份配置，为本文件用到的每个 tsconfig 工程建类型程序）：单独跑 2.3–4.3 秒；
// - 用例：一条检查十几段代码以内（P2 交接单的约定）。单独跑最慢 1.1 秒（按 node_modules 里的路径引用 Univer 的那一段，类型检查要解析
//   包里的文件），其余都在 1 秒以内；与全部单元测试一起跑（pnpm test）最慢 1.7 秒；覆盖率那一轮最慢 5.2 秒（还是那一段），其余 2.6 秒以内。
//   一段代码的代价：编辑器里带 @univerjs 引用的 120–180 毫秒，一行常量 35–40 毫秒，tools 的文件 7–10 毫秒。
// CI（GitHub 的 4 核机器，跑的是覆盖率那一轮）比本机慢：tests 一步是本机的 3.2 倍、lint 一步 2.3 倍，最慢的用例估计 17 秒左右；
// 最坏的一次是 M2-P2 合并之后，本机单独 2.1 秒的用例在 CI 上超过了当时的 20 秒（≥ 9.5 倍）。时限取 CI 估计值的三倍多
export const WARM_UP_TIMEOUT = 120_000
export const LINT_TIMEOUT = 60_000

export interface Report { rules: string[], messages: string[] }

export interface LintHarness {
  /** 把代码放在 filePath 的位置检查：报出的规则与说明（解析失败也算一条，写明原因） */
  readonly lint: (code: string, filePath: string) => Promise<Report>
  readonly rulesFor: (code: string, filePath: string) => Promise<string[]>
  /** 把代码放在探针文件的位置检查（探针在 .gitignore 里，用不跳过忽略规则的实例） */
  readonly lintAtProbe: (code: string, probePath: string) => Promise<Report>
  /** ESLint 为这个路径计算出的配置（文件不必存在） */
  readonly configFor: (filePath: string) => Promise<Linter.Config>
}

export interface LintSetup {
  /**
   * 本文件用到的每个 tsconfig 工程各一个真实文件：类型感知的 lint 第一次运行时要加载整份配置、为工程建立类型程序，
   * 这是整个文件共用的准备工作，放在 beforeAll 里做完，不算进某一个用例的时限
   */
  readonly warmUp: readonly string[]
  /** 本文件要用探针文件（"无主"文件、编辑器页的入口等位置） */
  readonly probes?: boolean
}

function reportOf(result: ESLint.LintResult | undefined): Report {
  const messages = result?.messages ?? []
  return { rules: messages.map(m => m.ruleId ?? `解析失败：${m.message}`), messages: messages.map(m => m.message) }
}

/** 在当前测试文件里准备 ESLint（beforeAll）并在结束时清理探针（afterAll） */
export function prepareLint(setup: LintSetup): LintHarness {
  let eslint: ESLint | undefined
  /**
   * 不按忽略规则跳过的实例：探针文件在 .gitignore 里，普通的实例不检查它们。
   * 编辑器页的入口与 sheet-editor 功能在 P4 的 S3 之前还没有真实的文件，"从这里引用"的规则只能借探针的位置检查
   */
  let eslintOnProbes: ESLint | undefined
  /** 为探针新建的目录，由深到浅。清理时只删空目录，不递归删除，免得删掉同一时间别人写进去的文件 */
  const createdDirs: string[] = []

  beforeAll(async () => {
    if (setup.probes === true) {
      for (const path of Object.values(PROBE_FILES)) {
        const dir = join(REPO_ROOT, dirname(path))
        const firstCreated = mkdirSync(dir, { recursive: true })
        if (firstCreated !== undefined) {
          for (let current = dir; current.startsWith(firstCreated); current = dirname(current))
            createdDirs.push(current)
        }
        writeFileSync(join(REPO_ROOT, path), 'export const probe = 1\n')
      }
      eslintOnProbes = new ESLint({ cwd: REPO_ROOT, ignore: false })
    }
    eslint = new ESLint({ cwd: REPO_ROOT })
    await Promise.all([
      eslint.lintFiles(setup.warmUp.map(file => join(REPO_ROOT, file))),
      ...(eslintOnProbes === undefined ? [] : [eslintOnProbes.lintFiles([join(REPO_ROOT, PROBE_FILES.sheetEditor)])]),
    ])
  }, WARM_UP_TIMEOUT)

  afterAll(() => {
    if (setup.probes !== true)
      return
    for (const path of Object.values(PROBE_FILES))
      rmSync(join(REPO_ROOT, path), { force: true })
    for (const dir of createdDirs) {
      try {
        rmdirSync(dir)
      }
      catch (error) {
        // 目录里还有别的文件（ENOTEMPTY）或已经不在（ENOENT）时放过
        const code = (error as NodeJS.ErrnoException).code
        if (code !== 'ENOTEMPTY' && code !== 'ENOENT')
          throw error
      }
    }
  })

  function ready(instance: ESLint | undefined, what: string): ESLint {
    if (instance === undefined)
      throw new Error(`${what}还没准备好：prepareLint 的 beforeAll 没有执行${what === '探针的实例' ? '，或者没有声明 probes: true' : ''}`)
    return instance
  }

  const lint = async (code: string, filePath: string): Promise<Report> =>
    reportOf((await ready(eslint, 'ESLint 实例').lintText(code, { filePath: join(REPO_ROOT, filePath) }))[0])
  return {
    lint,
    rulesFor: async (code, filePath) => (await lint(code, filePath)).rules,
    lintAtProbe: async (code, probePath) => reportOf((await ready(eslintOnProbes, '探针的实例').lintText(code, { filePath: join(REPO_ROOT, probePath) }))[0]),
    configFor: async filePath => await ready(eslint, 'ESLint 实例').calculateConfigForFile(join(REPO_ROOT, filePath)) as Linter.Config,
  }
}

export function severity(entry: Linter.RuleEntry | undefined): unknown {
  return Array.isArray(entry) ? entry[0] : entry
}

export interface RestrictedImports {
  paths?: { name: string, importNames?: string[] }[]
  patterns?: { group?: string[], regex?: string }[]
}

export function restrictedImports(config: Linter.Config): RestrictedImports {
  const entry = config.rules?.['no-restricted-imports']
  return Array.isArray(entry) ? entry[1] as RestrictedImports : {}
}

/** 受限导入的模式：group 里的每一项与 regex。 */
export function restrictedPatterns(config: Linter.Config): string[] {
  return (restrictedImports(config).patterns ?? []).flatMap(p => [...(p.group ?? []), ...(p.regex === undefined ? [] : [p.regex])])
}

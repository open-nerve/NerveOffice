// pnpm verify 的步骤与编排（规范 §9）：本机合并前的门禁与 CI 执行同一套步骤。
// 编排是纯函数，执行命令的方式由调用方注入，便于测试。

export interface Step {
  id: string
  command: readonly string[]
}

/**
 * 分片（只给 CI 用，本机一律 `all`）：CI 上一个 job 跑完整套要三十多分钟，时限 45 分钟已经不宽裕（M2-P3 的实测 37 分钟），
 * 所以把 E2E 拆到按浏览器并行的 job 里。两个分片合起来与 `all` 完全相同，由 plan.test.ts 的用例守住。
 * - `no-e2e`：不构建、不跑 E2E 的部分；
 * - `e2e`：构建与 E2E（产物门禁、漏洞扫描留给 no-e2e，不重复执行）。
 *
 * 分片只在 `--ci` 下成立：本机的完整门禁要先启动开发数据库（DATABASE 一步），而分片都不含它，
 * 本机直接 `--scope=…` 会连不上库、莫名其妙地失败，所以 parseArgs 要求两个参数一起给（M2-P4 审查建议 7）。
 */
export const PLAN_SCOPES = ['all', 'no-e2e', 'e2e'] as const

export type PlanScope = typeof PLAN_SCOPES[number]

/** 命令行给的字符串是不是分片的名字 */
export function isPlanScope(value: string): value is PlanScope {
  return (PLAN_SCOPES as readonly string[]).includes(value)
}

export interface PlanOptions {
  /** 只执行 lint、类型检查、单元测试与静态检查（供 pre-push 使用） */
  fast: boolean
  /** 在 CI 中执行：数据库由服务容器提供，另加漏洞扫描 */
  ci: boolean
  /** 本机也执行漏洞扫描（需要联网） */
  audit: boolean
  /** CI 的分片；省略为 `all` */
  scope?: PlanScope
}

export const VERIFY_USAGE = '用法：pnpm verify [--fast] [--audit] [--keep-going]；CI 的分片：pnpm verify --ci [--scope=all|no-e2e|e2e]'

/** 命令行参数的解析结果：要么是一套可以执行的选项，要么是一句给用户的说明 */
export type ParsedArgs
  = { readonly ok: true, readonly options: PlanOptions, readonly keepGoing: boolean }
    | { readonly ok: false, readonly error: string }

const KNOWN_FLAGS: readonly string[] = ['--fast', '--ci', '--audit', '--keep-going']
const SCOPE_PREFIX = '--scope='

/** 解析 pnpm verify 的命令行参数（纯函数，由 cli.ts 调用；不认识的参数与用错的组合都在这里拦下）。 */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  const args = new Set(argv)
  const unknown = [...args].filter(arg => !KNOWN_FLAGS.includes(arg) && !arg.startsWith(SCOPE_PREFIX))
  if (unknown.length > 0)
    return { ok: false, error: `未知的参数：${unknown.join(' ')}。${VERIFY_USAGE}` }

  const ci = args.has('--ci')
  const scopeArgs = [...args].filter(arg => arg.startsWith(SCOPE_PREFIX))
  const scope = scopeArgs.at(-1)?.slice(SCOPE_PREFIX.length) ?? 'all'
  if (!isPlanScope(scope))
    return { ok: false, error: `不认识的分片：${scope}（可选 ${PLAN_SCOPES.join('、')}）。${VERIFY_USAGE}` }
  // 分片不含"启动开发数据库"一步：本机这样跑会连不上库，失败的原因还看不出来（M2-P4 审查建议 7）
  if (scopeArgs.length > 0 && !ci)
    return { ok: false, error: `--scope 只给 CI 的分片用，必须与 --ci 一起给；本机跑完整的一套即可。${VERIFY_USAGE}` }

  return { ok: true, options: { fast: args.has('--fast'), ci, audit: args.has('--audit'), scope }, keepGoing: args.has('--keep-going') }
}

export type StepStatus = 'passed' | 'failed' | 'skipped'

export interface StepResult {
  step: Step
  status: StepStatus
  durationMs: number
}

const LINT: Step = { id: 'lint', command: ['pnpm', 'lint'] }
const TYPECHECK: Step = { id: 'typecheck', command: ['pnpm', 'typecheck'] }
const UNIT: Step = { id: 'unit', command: ['pnpm', 'test'] }
// 门禁分三步执行（STATIC_GATES、ARTIFACT_GATES、AUDIT），合起来恰好是全部门禁（gates/run.ts 的 GATE_NAMES），各一次；
// 故事对照只在这里对仓库现状核对，必须留在静态门禁一步（--fast 也执行），由 plan.test.ts 核对（M2-P6 第 6 片复核第二批 M-1）
const STATIC_GATES: Step = { id: 'static-gates', command: ['node', 'tools/src/gates/cli.ts', 'pins', 'config', 'stories', 'migrations', 'schema'] }
const DATABASE: Step = { id: 'database', command: ['pnpm', 'db:up'] }
// 单元与集成测试合计的覆盖率（规范 §8.3），需要数据库；已经包含单元测试，完整模式不再单独执行单元测试
const TESTS: Step = { id: 'tests', command: ['pnpm', 'test:coverage'] }
// 先删除旧产物，构建没有真正执行时，后面的产物检查会失败
const CLEAN: Step = { id: 'clean', command: ['pnpm', 'clean'] }
const BUILD: Step = { id: 'build', command: ['pnpm', 'build'] }
const ARTIFACT_GATES: Step = { id: 'artifact-gates', command: ['node', 'tools/src/gates/cli.ts', 'deps', 'licenses', 'artifacts', 'budgets'] }
const E2E: readonly Step[] = [
  // E2E 测的是测试构建：生产构建加上 CSP 探针（P3 设计 §3.9），输出到 dist-e2e，不影响产物门禁检查的生产构建
  { id: 'build-e2e', command: ['pnpm', '--filter', '@nerve-office/web', 'run', 'build:e2e'] },
  // 后端已经在 build 一步构建；E2E 的服务脚本自己建库、迁移、初始化管理员。
  // 经 e2e 包的 test 脚本运行：它按 @nerve-office/source 条件解析工作区的包（用例引用 contracts 的源码）；
  // 浏览器由 E2E_BROWSERS 决定（CI 的分片每个 job 一个浏览器）
  { id: 'e2e', command: ['pnpm', '--filter', '@nerve-office/e2e', 'run', 'test'] },
]
const AUDIT: Step = { id: 'audit', command: ['node', 'tools/src/gates/cli.ts', 'audit'] }

export function planSteps(options: PlanOptions): Step[] {
  const scope = options.scope ?? 'all'
  if (options.fast)
    return [LINT, TYPECHECK, UNIT, STATIC_GATES, ...(options.ci || options.audit ? [AUDIT] : [])]
  // e2e 分片：只构建与跑 E2E。构建是 E2E 的前提，所以两个分片都构建（产物门禁只在 no-e2e 那片执行，不重复）
  if (scope === 'e2e')
    return [CLEAN, BUILD, ...E2E]
  const steps = [LINT, TYPECHECK, STATIC_GATES, ...(options.ci ? [] : [DATABASE]), TESTS, CLEAN, BUILD, ARTIFACT_GATES]
  if (scope === 'all')
    steps.push(...E2E)
  if (options.ci || options.audit)
    steps.push(AUDIT)
  return steps
}

export function runSteps(steps: readonly Step[], execute: (step: Step) => number, options: { keepGoing: boolean, now: () => number }): StepResult[] {
  const results: StepResult[] = []
  let failed = false
  for (const step of steps) {
    if (failed && !options.keepGoing) {
      results.push({ step, status: 'skipped', durationMs: 0 })
      continue
    }
    const started = options.now()
    const exitCode = execute(step)
    const status: StepStatus = exitCode === 0 ? 'passed' : 'failed'
    failed ||= status === 'failed'
    results.push({ step, status, durationMs: options.now() - started })
  }
  return results
}

export function summarize(results: readonly StepResult[]): { ok: boolean, lines: string[] } {
  const lines = results.map(({ step, status, durationMs }) => {
    const label = `${step.id}（${step.command.join(' ')}）`
    if (status === 'skipped')
      return `- ${label}未执行`
    return `${status === 'passed' ? '✔' : '✖'} ${label}${(durationMs / 1000).toFixed(1)} 秒`
  })
  return { ok: results.every(r => r.status === 'passed'), lines }
}

// pnpm verify 的步骤与编排（规范 §9）：本机合并前的门禁与 CI 执行同一套步骤。
// 编排是纯函数，执行命令的方式由调用方注入，便于测试。

export interface Step {
  id: string
  command: readonly string[]
}

export interface PlanOptions {
  /** 只执行 lint、类型检查、单元测试与静态检查（供 pre-push 使用） */
  fast: boolean
  /** 在 CI 中执行：数据库由服务容器提供，另加漏洞扫描 */
  ci: boolean
  /** 本机也执行漏洞扫描（需要联网） */
  audit: boolean
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
const STATIC_GATES: Step = { id: 'static-gates', command: ['node', 'tools/src/gates/cli.ts', 'pins', 'config', 'stories', 'migrations', 'schema'] }
const DATABASE: Step = { id: 'database', command: ['pnpm', 'db:up'] }
// 单元与集成测试合计的覆盖率（规范 §8.3），需要数据库；已经包含单元测试，完整模式不再单独执行单元测试
const TESTS: Step = { id: 'tests', command: ['pnpm', 'test:coverage'] }
const BUILD_AND_E2E: readonly Step[] = [
  // 先删除旧产物，构建没有真正执行时，后面的产物检查会失败
  { id: 'clean', command: ['pnpm', 'clean'] },
  { id: 'build', command: ['pnpm', 'build'] },
  { id: 'artifact-gates', command: ['node', 'tools/src/gates/cli.ts', 'deps', 'licenses', 'artifacts', 'budgets'] },
  // E2E 测的是测试构建：生产构建加上 CSP 探针（P3 设计 §3.9），输出到 dist-e2e，不影响上一步检查的生产构建
  { id: 'build-e2e', command: ['pnpm', '--filter', '@nerve-office/web', 'run', 'build:e2e'] },
  // 后端已经在 build 一步构建；E2E 的服务脚本自己建库、迁移、初始化管理员。
  // 经 e2e 包的 test 脚本运行：它按 @nerve-office/source 条件解析工作区的包（用例引用 contracts 的源码）
  { id: 'e2e', command: ['pnpm', '--filter', '@nerve-office/e2e', 'run', 'test'] },
]
const AUDIT: Step = { id: 'audit', command: ['node', 'tools/src/gates/cli.ts', 'audit'] }

export function planSteps(options: PlanOptions): Step[] {
  const steps = options.fast
    ? [LINT, TYPECHECK, UNIT, STATIC_GATES]
    : [LINT, TYPECHECK, STATIC_GATES, ...(options.ci ? [] : [DATABASE]), TESTS, ...BUILD_AND_E2E]
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

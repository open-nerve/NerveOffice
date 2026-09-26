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

const FAST_STEPS: readonly Step[] = [
  { id: 'lint', command: ['pnpm', 'lint'] },
  { id: 'typecheck', command: ['pnpm', 'typecheck'] },
  { id: 'unit', command: ['pnpm', 'test:coverage'] },
  { id: 'static-gates', command: ['node', 'tools/src/gates/cli.ts', 'pins', 'config', 'stories'] },
]

const DATABASE: Step = { id: 'database', command: ['pnpm', 'db:up'] }
const FULL_STEPS: readonly Step[] = [
  { id: 'integration', command: ['pnpm', 'test:integration'] },
  // 先删除旧产物，构建没有真正执行时，后面的产物检查会失败
  { id: 'clean', command: ['pnpm', 'clean'] },
  { id: 'build', command: ['pnpm', 'build'] },
  { id: 'artifact-gates', command: ['node', 'tools/src/gates/cli.ts', 'deps', 'licenses', 'artifacts'] },
  // 构建已经在上一步完成，这里直接跑 Playwright
  { id: 'e2e', command: ['pnpm', '--filter', '@nerve-office/e2e', 'exec', 'playwright', 'test'] },
]
const AUDIT: Step = { id: 'audit', command: ['node', 'tools/src/gates/cli.ts', 'audit'] }

export function planSteps(options: PlanOptions): Step[] {
  const steps = [...FAST_STEPS]
  if (!options.fast)
    steps.push(...(options.ci ? [] : [DATABASE]), ...FULL_STEPS)
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

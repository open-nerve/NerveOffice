import type { StepResult } from './plan.ts'
import { describe, expect, it } from 'vitest'
import { planSteps, runSteps, summarize } from './plan.ts'

describe('planSteps', () => {
  it('--fast 只执行 lint、类型检查、单元测试与静态检查（供 pre-push 使用）', () => {
    expect(planSteps({ fast: true, ci: false, audit: false }).map(s => s.id)).toEqual(['lint', 'typecheck', 'unit', 'static-gates'])
  })

  it('本机的完整门禁：先启动开发数据库，再把单元与集成测试合在一起跑并统计覆盖率；构建之后检查依赖与产物，最后跑 E2E', () => {
    const steps = planSteps({ fast: false, ci: false, audit: false })
    expect(steps.map(s => s.id)).toEqual([
      'lint',
      'typecheck',
      'static-gates',
      'database',
      'tests',
      'clean',
      'build',
      'artifact-gates',
      'e2e',
    ])
    expect(steps.find(s => s.id === 'tests')?.command).toEqual(['pnpm', 'test:coverage'])
  })

  it('快速门禁的单元测试不统计覆盖率（覆盖率的下限按单元与集成测试合计，需要数据库）', () => {
    expect(planSteps({ fast: true, ci: false, audit: false }).find(s => s.id === 'unit')?.command).toEqual(['pnpm', 'test'])
  })

  it('在 CI 中使用服务容器，不启动开发数据库；另加漏洞扫描', () => {
    expect(planSteps({ fast: false, ci: true, audit: false }).map(s => s.id)).toEqual([
      'lint',
      'typecheck',
      'static-gates',
      'tests',
      'clean',
      'build',
      'artifact-gates',
      'e2e',
      'audit',
    ])
  })

  it('本机可以显式加上漏洞扫描', () => {
    expect(planSteps({ fast: true, ci: false, audit: true }).map(s => s.id).at(-1)).toBe('audit')
  })
})

describe('runSteps', () => {
  const steps = planSteps({ fast: true, ci: false, audit: false })

  it('依次执行，遇到失败就停下，后面的步骤记为未执行', () => {
    const executed: string[] = []
    const results = runSteps(steps, (step) => {
      executed.push(step.id)
      return step.id === 'typecheck' ? 1 : 0
    }, { keepGoing: false, now: () => 0 })
    expect(executed).toEqual(['lint', 'typecheck'])
    expect(results.map(r => `${r.step.id}:${r.status}`)).toEqual(['lint:passed', 'typecheck:failed', 'unit:skipped', 'static-gates:skipped'])
  })

  it('--keep-going 时执行全部步骤', () => {
    const results = runSteps(steps, step => (step.id === 'lint' ? 2 : 0), { keepGoing: true, now: () => 0 })
    expect(results.map(r => r.status)).toEqual(['failed', 'passed', 'passed', 'passed'])
  })

  it('记录每一步的耗时', () => {
    let clock = 0
    const results = runSteps(steps.slice(0, 1), () => {
      clock += 1500
      return 0
    }, { keepGoing: false, now: () => clock })
    expect(results[0]?.durationMs).toBe(1500)
  })
})

describe('summarize', () => {
  it('输出每一步的结果，全部通过时返回成功', () => {
    const [step] = planSteps({ fast: true, ci: false, audit: false })
    const results: StepResult[] = [{ step: step!, status: 'passed', durationMs: 2345 }]
    const { ok, lines } = summarize(results)
    expect(ok).toBe(true)
    expect(lines).toEqual(['✔ lint（pnpm lint）2.3 秒'])
  })

  it('有失败或未执行的步骤时返回失败', () => {
    const [a, b] = planSteps({ fast: true, ci: false, audit: false })
    const { ok, lines } = summarize([{ step: a!, status: 'failed', durationMs: 0 }, { step: b!, status: 'skipped', durationMs: 0 }])
    expect(ok).toBe(false)
    expect(lines).toEqual(['✖ lint（pnpm lint）0.0 秒', '- typecheck（pnpm typecheck）未执行'])
  })
})

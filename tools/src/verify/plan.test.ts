import type { StepResult } from './plan.ts'
import { describe, expect, it } from 'vitest'
import { parseArgs, planSteps, runSteps, summarize } from './plan.ts'

describe('parseArgs', () => {
  it('没有参数就是本机的完整门禁', () => {
    expect(parseArgs([])).toEqual({ ok: true, keepGoing: false, options: { fast: false, ci: false, audit: false, scope: 'all' } })
  })

  it('认得 --fast、--ci、--audit 与 --keep-going', () => {
    expect(parseArgs(['--fast', '--ci', '--audit', '--keep-going'])).toEqual({
      ok: true,
      keepGoing: true,
      options: { fast: true, ci: true, audit: true, scope: 'all' },
    })
  })

  it('CI 的分片要与 --ci 一起给', () => {
    expect(parseArgs(['--ci', '--scope=e2e'])).toEqual({ ok: true, keepGoing: false, options: { fast: false, ci: true, audit: false, scope: 'e2e' } })
  })

  /**
   * 分片都不含"启动开发数据库"一步（planSteps 里的 DATABASE 只在非 CI 的完整门禁里）：
   * 本机 `pnpm verify --scope=e2e` 会连不上库、失败得莫名其妙，所以直接拦下（M2-P4 审查建议 7）
   */
  it('本机不带 --ci 用 --scope：直接拦下，并说明它只给 CI 的分片用', () => {
    const parsed = parseArgs(['--scope=e2e'])
    expect(parsed.ok).toBe(false)
    expect(parsed.ok ? '' : parsed.error).toContain('--scope 只给 CI 的分片用，必须与 --ci 一起给')
  })

  it('不认识的分片与未知的参数都拦下，并列出可选项', () => {
    const scope = parseArgs(['--ci', '--scope=unit'])
    expect(scope.ok ? '' : scope.error).toContain('不认识的分片：unit')
    const unknown = parseArgs(['--quick'])
    expect(unknown.ok ? '' : unknown.error).toContain('未知的参数：--quick')
  })
})

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
      'build-e2e',
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
      'build-e2e',
      'e2e',
      'audit',
    ])
  })

  it('本机可以显式加上漏洞扫描', () => {
    expect(planSteps({ fast: true, ci: false, audit: true }).map(s => s.id).at(-1)).toBe('audit')
  })

  it('CI 的分片：no-e2e 不跑 E2E，e2e 只构建与跑 E2E（产物门禁与漏洞扫描不重复执行）', () => {
    expect(planSteps({ fast: false, ci: true, audit: false, scope: 'no-e2e' }).map(s => s.id)).toEqual([
      'lint',
      'typecheck',
      'static-gates',
      'tests',
      'clean',
      'build',
      'artifact-gates',
      'audit',
    ])
    expect(planSteps({ fast: false, ci: true, audit: false, scope: 'e2e' }).map(s => s.id)).toEqual(['clean', 'build', 'build-e2e', 'e2e'])
  })

  it('两个分片合起来与完整的一套一样：CI 分片之后不会有步骤漏掉（规范 §9：本机与 CI 执行同一套步骤）', () => {
    const options = { fast: false, ci: true, audit: false } as const
    const complete = planSteps({ ...options }).map(s => s.id)
    const sharded = [...planSteps({ ...options, scope: 'no-e2e' }), ...planSteps({ ...options, scope: 'e2e' })].map(s => s.id)
    expect(new Set(sharded)).toEqual(new Set(complete))
    // 两片都构建（E2E 要用构建产物），除此之外没有重复执行的步骤
    expect(sharded.filter((id, index) => sharded.indexOf(id) !== index)).toEqual(['clean', 'build'])
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

import type { CoverageSegment, SegmentOutcome } from './coverage-resources.ts'
import { describe, expect, it } from 'vitest'
import { coverageSegments, runCoverageSegments } from './coverage-resources.ts'

const ok: SegmentOutcome = { status: 0, signal: null }

function run(outcomes: readonly SegmentOutcome[]) {
  const started: string[] = []
  const messages: string[] = []
  const code = runCoverageSegments(coverageSegments({ PATH: '/bin' }), (segment: CoverageSegment) => {
    started.push(segment.label)
    return outcomes[started.length - 1] ?? ok
  }, message => messages.push(message))
  return { code, started, messages }
}

describe('M5R-M-21 完整门禁 tests 一步：覆盖率之后接着跑测试资源工具的 Python 回归', () => {
  it('先覆盖率、后 Python 回归，命令与原来的 test:coverage、test:cleanup:check 一致', () => {
    expect(coverageSegments({}).map(segment => [segment.command, ...segment.args].join(' '))).toEqual([
      'vitest run --coverage',
      'python3 -B -m unittest discover -f -s tools/test-resources -p test_*.py',
    ])
  })

  it('Python 回归不继承 CI job 的托管策略，其余环境（含句柄查询方式）照常继承', () => {
    const [coverage, resources] = coverageSegments({ NERVE_TEST_RESOURCE_POLICY: 'github-hosted-vm', NERVE_TEST_LSOF_MODE: 'github-ubuntu-sudo', CI: 'true' })
    expect(coverage?.env).toMatchObject({ NERVE_TEST_RESOURCE_POLICY: 'github-hosted-vm' })
    expect(resources?.env).toEqual({ NERVE_TEST_LSOF_MODE: 'github-ubuntu-sudo', CI: 'true' })
  })

  it('两段都通过才算通过', () => {
    expect(run([ok, ok])).toMatchObject({ code: 0, started: ['单元与集成测试的覆盖率', '测试资源工具的 Python 回归'] })
  })

  it('覆盖率失败时仍跑 Python 回归，整步失败；Python 回归失败同样整步失败', () => {
    expect(run([{ status: 1, signal: null }, ok])).toMatchObject({ code: 1, started: ['单元与集成测试的覆盖率', '测试资源工具的 Python 回归'] })
    expect(run([ok, { status: 1, signal: null }]).code).toBe(1)
  })

  it('没能启动算失败，后一段照常执行', () => {
    const result = run([{ status: null, signal: null, error: new Error('spawn vitest ENOENT') }, ok])
    expect(result).toMatchObject({ code: 1, started: ['单元与集成测试的覆盖率', '测试资源工具的 Python 回归'] })
    expect(result.messages.join('\n')).toContain('spawn vitest ENOENT')
  })

  it('某一段被信号结束（运行器正在停止本轮）：不再开始下一段', () => {
    expect(run([{ status: null, signal: 'SIGTERM' }, ok])).toMatchObject({ code: 1, started: ['单元与集成测试的覆盖率'] })
  })
})

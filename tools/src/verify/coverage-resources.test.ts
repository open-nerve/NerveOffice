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

  it('两段都照原样继承调用方的环境（只在本机完整门禁里执行，CI 不跑这一步）', () => {
    const env = { DATABASE_URL: 'postgres://example', NERVE_TEST_LSOF_MODE: 'direct' }
    expect(coverageSegments(env).map(segment => segment.env)).toEqual([env, env])
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

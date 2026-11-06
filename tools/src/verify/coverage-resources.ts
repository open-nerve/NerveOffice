// 本机完整门禁 tests 一步的两段（M5R-M-21，D-10）：在同一轮受管运行（package.json 的 test:verify，run.py integration）里
// 先跑单元与集成测试的覆盖率，再跑测试资源工具的 Python 回归。
// - 两段都执行，任一失败即以非零退出；某一段被信号结束时不再开始下一段（运行器正在停止本轮）；
// - 不新增受管运行；pre-push 的快速门禁（pnpm test）不含它；
// - CI 不跑这一步、只跑覆盖率（plan.ts，2026-11-06 需求方决定）：Python 回归是严格策略下的工具单测，GitHub 托管 VM 的
//   全宿主 lsof 必有无法解释的记录，严格核验在那里必然判不完整（ADR-024）；Linux 兼容运行与 CI 子集另行设计（DEF-080）

export interface CoverageSegment {
  readonly label: string
  readonly command: string
  readonly args: readonly string[]
  readonly env: NodeJS.ProcessEnv
}

export interface SegmentOutcome {
  /** 进程的退出码；没能启动时为 null */
  readonly status: number | null
  /** 被信号结束时的信号名 */
  readonly signal: NodeJS.Signals | null
  readonly error?: Error
}

export function coverageSegments(env: NodeJS.ProcessEnv): CoverageSegment[] {
  return [
    { label: '单元与集成测试的覆盖率', command: 'vitest', args: ['run', '--coverage'], env },
    { label: '测试资源工具的 Python 回归', command: 'python3', args: ['-B', '-m', 'unittest', 'discover', '-f', '-s', 'tools/test-resources', '-p', 'test_*.py'], env },
  ]
}

/** 依次执行；返回整步的退出码。log 只收说明文字 */
export function runCoverageSegments(segments: readonly CoverageSegment[], run: (segment: CoverageSegment) => SegmentOutcome, log: (message: string) => void): number {
  let failed = false
  for (const segment of segments) {
    log(`▶ ${segment.label}：${segment.command} ${segment.args.join(' ')}`)
    const outcome = run(segment)
    if (outcome.signal !== null) {
      log(`${segment.label}被信号 ${outcome.signal} 结束，不再开始下一段`)
      return 1
    }
    if (outcome.error !== undefined || outcome.status === null) {
      log(`${segment.label}没能启动：${outcome.error?.message ?? '原因未知'}`)
      failed = true
    }
    else if (outcome.status !== 0) {
      log(`${segment.label}失败（退出码 ${outcome.status}）`)
      failed = true
    }
  }
  return failed ? 1 : 0
}

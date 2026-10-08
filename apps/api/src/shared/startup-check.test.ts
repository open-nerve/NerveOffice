// 启动自检共同的做法（审计表的保护、本机密钥的主密钥）：只记日志、不阻止启动，最多等 2 秒，超过时照常启动、有了结果再记
import type { StartupCheckOutcome } from './startup-check.ts'
import { describe, expect, it, vi } from 'vitest'
import { runStartupCheck, STARTUP_CHECK_WAIT_MS } from './startup-check.ts'

function recorder<T>() {
  const reports: StartupCheckOutcome<T>[] = []
  const slow = vi.fn()
  return { reports, slow, report: (outcome: StartupCheckOutcome<T>) => void reports.push(outcome) }
}

describe('runStartupCheck', () => {
  it('2 秒以内有了结果：交给 report 一次，不说慢', async () => {
    const { reports, slow, report } = recorder<number>()
    await runStartupCheck({ run: async () => 42, report, slow })
    expect(reports).toEqual([{ value: 42 }])
    expect(slow).not.toHaveBeenCalled()
  })

  it('查询失败（包括同步抛出的）：同样交给 report，不让启动失败', async () => {
    const failed = recorder<number>()
    await expect(runStartupCheck({ run: async () => Promise.reject(new Error('连接被拒绝')), report: failed.report, slow: failed.slow })).resolves.toBeUndefined()
    expect(failed.reports).toEqual([{ error: new Error('连接被拒绝') }])
    const thrown = recorder<number>()
    await expect(runStartupCheck({
      run: () => {
        throw new Error('同步抛出')
      },
      report: thrown.report,
      slow: thrown.slow,
    })).resolves.toBeUndefined()
    expect(thrown.reports).toEqual([{ error: new Error('同步抛出') }])
  })

  it('超过 2 秒：先照常返回（说慢），结果出来之后再交给 report', async () => {
    vi.useFakeTimers()
    try {
      const { reports, slow, report } = recorder<string>()
      let answer: (value: string) => void = () => {}
      let returned = false
      const running = runStartupCheck({
        run: async () => new Promise<string>((resolve) => {
          answer = resolve
        }),
        report,
        slow,
      }).then(() => {
        returned = true
      })
      await vi.advanceTimersByTimeAsync(STARTUP_CHECK_WAIT_MS - 1)
      expect(returned).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      await running
      expect(slow).toHaveBeenCalledTimes(1)
      expect(reports).toEqual([])
      answer('晚到的结果')
      await vi.waitFor(() => expect(reports).toEqual([{ value: '晚到的结果' }]))
    }
    finally {
      vi.useRealTimers()
    }
  })
})

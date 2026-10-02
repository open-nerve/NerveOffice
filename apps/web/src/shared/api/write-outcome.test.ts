// 写操作没能确认结果之后的共用做法：结果未知时在时限之内刷新（M2-P6 复核第三批 S-a），刷新失败或者超时时说明里不说"已刷新"（第三批 G-a）；
// 超时之后刷新在后台成功了，告诉调用方（第五批 G4）。
import { describe, expect, it, vi } from 'vitest'
import { ApiError, NetworkError } from './client.ts'
import { OUTCOME_REFRESH_TIME_LIMIT_MS, refreshIfUnknown, refreshWithin, writeFailureText } from './write-outcome.ts'

/** 一直不回来的刷新（服务端挂起） */
async function hanging(): Promise<void> {
  return new Promise<void>(() => {})
}

describe('refreshWithin：在时限之内刷新（第三批 S-a）', () => {
  it('刷新成功为 true；刷新失败（拒绝）为 false', async () => {
    expect(await refreshWithin(async () => {})).toBe(true)
    expect(await refreshWithin(async () => {
      throw new NetworkError('网络请求失败')
    })).toBe(false)
  })

  it('刷新一直不回来：到了时限就兑现为 false，不一直等下去；时限与按需加载的部署检测相同，是 10 秒', async () => {
    vi.useFakeTimers()
    try {
      let settled: boolean | undefined
      void refreshWithin(hanging).then((result) => {
        settled = result
      })
      await vi.advanceTimersByTimeAsync(OUTCOME_REFRESH_TIME_LIMIT_MS - 1)
      expect(settled).toBeUndefined()
      await vi.advanceTimersByTimeAsync(1)
      expect(settled).toBe(false)
    }
    finally {
      vi.useRealTimers()
    }
    expect(OUTCOME_REFRESH_TIME_LIMIT_MS).toBe(10_000)
    expect(await refreshWithin(hanging, { timeLimitMs: 20 })).toBe(false)
  })

  it('到了时限之后刷新在后台成功了：调用 onLateRefresh（说明随后改回"已刷新"，第五批 G4）；后台失败了、在时限之内就有了结果，都不调用', async () => {
    let finish: (ok: boolean) => void = () => {}
    const late = async () => new Promise<void>((resolve, reject) => {
      finish = ok => (ok ? resolve() : reject(new NetworkError('网络请求失败')))
    })
    const onLateRefresh = vi.fn()
    expect(await refreshWithin(late, { timeLimitMs: 20, onLateRefresh })).toBe(false)
    expect(onLateRefresh).not.toHaveBeenCalled()
    finish(true)
    await vi.waitFor(() => expect(onLateRefresh).toHaveBeenCalledTimes(1))

    const failsLater = vi.fn()
    expect(await refreshWithin(late, { timeLimitMs: 20, onLateRefresh: failsLater })).toBe(false)
    finish(false)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(failsLater).not.toHaveBeenCalled()

    const inTime = vi.fn()
    expect(await refreshWithin(async () => {}, { onLateRefresh: inTime })).toBe(true)
    expect(await refreshWithin(async () => {
      throw new NetworkError('网络请求失败')
    }, { onLateRefresh: inTime })).toBe(false)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(inTime).not.toHaveBeenCalled()
  })
})

describe('refreshIfUnknown：只在结果未知时刷新', () => {
  it('结果未知（网络、5xx）：刷新，兑现为刷新好了没有；确定的失败（4xx、服务端自己回答的 503）不刷新，兑现为 false', async () => {
    const refresh = vi.fn(async () => {})
    expect(await refreshIfUnknown(new NetworkError('网络请求失败'), refresh)).toBe(true)
    expect(await refreshIfUnknown(new ApiError(502, 'INTERNAL_ERROR', 'x'), refresh)).toBe(true)
    expect(refresh).toHaveBeenCalledTimes(2)
    expect(await refreshIfUnknown(new ApiError(500, 'INTERNAL_ERROR', 'x'), async () => {
      throw new NetworkError('网络请求失败')
    })).toBe(false)
    expect(await refreshIfUnknown(new ApiError(500, 'INTERNAL_ERROR', 'x'), hanging, { timeLimitMs: 20 })).toBe(false)
    // 晚到的刷新同样转给调用方
    let finish: () => void = () => {}
    const onLateRefresh = vi.fn()
    expect(await refreshIfUnknown(new NetworkError('网络请求失败'), async () => new Promise<void>((resolve) => {
      finish = resolve
    }), { timeLimitMs: 20, onLateRefresh })).toBe(false)
    finish()
    await vi.waitFor(() => expect(onLateRefresh).toHaveBeenCalledTimes(1))

    refresh.mockClear()
    expect(await refreshIfUnknown(new ApiError(409, 'LAST_ADMIN', 'x'), refresh)).toBe(false)
    expect(await refreshIfUnknown(new ApiError(503, 'SERVICE_UNAVAILABLE', 'x'), refresh)).toBe(false)
    expect(refresh).not.toHaveBeenCalled()
  })

  it('also 认出的确定拒绝（上一次多半已经生效）同样在时限之内刷新，兑现为刷新好了没有；没认出的照旧不刷新（第四批）', async () => {
    const taken = new ApiError(409, 'ALREADY_MEMBER', 'x')
    const also = (error: unknown) => error === taken
    const refresh = vi.fn(async () => {})
    expect(await refreshIfUnknown(taken, refresh, { also })).toBe(true)
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(await refreshIfUnknown(taken, async () => {
      throw new NetworkError('网络请求失败')
    }, { also })).toBe(false)
    expect(await refreshIfUnknown(taken, hanging, { also, timeLimitMs: 20 })).toBe(false)

    refresh.mockClear()
    expect(await refreshIfUnknown(new ApiError(409, 'LAST_ADMIN', 'x'), refresh, { also })).toBe(false)
    expect(refresh).not.toHaveBeenCalled()
    // 结果未知时不看 also
    expect(await refreshIfUnknown(new NetworkError('网络请求失败'), refresh, { also: () => false })).toBe(true)
  })
})

describe('writeFailureText：失败的说明（第三批 G-a）', () => {
  it('结果未知、页面已经刷新：说可能已经生效、页面已刷新；没能刷新：说页面显示的可能还是之前的状态，不说"已刷新"', () => {
    const error = new ApiError(500, 'INTERNAL_ERROR', 'x')
    expect(writeFailureText(error, true)).toBe('没能确认是否已经完成（服务器出了点问题，请稍后重试）。可能已经生效：页面已按服务端现在的状态刷新，看得出是否已经生效；还没有的话，可以再试一次。')
    expect(writeFailureText(error, false)).toBe('没能确认是否已经完成（服务器出了点问题，请稍后重试）。可能已经生效，只是页面没能刷新，显示的可能还是之前的状态：请稍后再看；确认还没有生效的话，可以再试一次。')
    expect(writeFailureText(error, false)).not.toContain('已按服务端现在的状态刷新')
  })

  it('确定的失败：按错误码说明，与刷新无关', () => {
    expect(writeFailureText(new ApiError(409, 'LAST_ADMIN', 'x'), false)).toBe('至少要保留一个有效的系统管理员')
    expect(writeFailureText(new ApiError(409, 'LAST_ADMIN', 'x'), true)).toBe('至少要保留一个有效的系统管理员')
  })
})

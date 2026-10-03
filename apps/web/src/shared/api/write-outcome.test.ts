// 写操作没能确认结果之后的共用做法：结果未知时在时限之内刷新（M2-P6 复核第三批 S-a），刷新失败或者超时时说明里不说"已刷新"（第三批 G-a）；
// 超时之后刷新在后台成功了，告诉调用方（第五批 G4）。写操作成功之后的刷新同样有时限（Codex 对抗评审 CX4）。
import type { BackgroundRefresh } from './write-outcome.ts'
import { describe, expect, it, vi } from 'vitest'
import { ApiError, NetworkError } from './client.ts'
import { OUTCOME_REFRESH_TIME_LIMIT_MS, refreshAfterSuccess, refreshIfUnknown, refreshWithin, writeFailureText } from './write-outcome.ts'

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

/** 由用例决定何时有结果的刷新：finish(true) 成功，finish(false) 失败 */
function controlled() {
  let finish: (ok: boolean) => void = () => {}
  const refresh = async () => new Promise<void>((resolve, reject) => {
    finish = ok => (ok ? resolve() : reject(new NetworkError('网络请求失败')))
  })
  return { refresh, finish: (ok: boolean) => finish(ok) }
}

describe('refreshAfterSuccess：写操作成功之后在时限之内等刷新（Codex 对抗评审 CX4）', () => {
  it('在时限之内有了结果：成功、失败都兑现为 undefined——刷新失败不算这次操作失败（由列表自己说明没能刷新），不拒绝', async () => {
    expect(await refreshAfterSuccess(async () => {})).toBeUndefined()
    await expect(refreshAfterSuccess(async () => {
      throw new NetworkError('网络请求失败')
    })).resolves.toBeUndefined()
  })

  it('一直不回来：到了时限就兑现为在后台的刷新，不一直等下去；时限与失败之后的刷新相同（10 秒）', async () => {
    vi.useFakeTimers()
    try {
      let result: BackgroundRefresh | undefined | 'pending' = 'pending'
      void refreshAfterSuccess(hanging).then((background) => {
        result = background
      })
      await vi.advanceTimersByTimeAsync(OUTCOME_REFRESH_TIME_LIMIT_MS - 1)
      expect(result).toBe('pending')
      await vi.advanceTimersByTimeAsync(1)
      expect(result).not.toBe('pending')
      expect(result).toBeDefined()
      expect((result as unknown as BackgroundRefresh).settled()).toBe(false)
    }
    finally {
      vi.useRealTimers()
    }
  })

  it.each([['成功', true], ['失败', false]] as const)('后台的刷新随后%s：标为已经有了结果，通知订阅者（说明随之不再说"还在刷新"）；取消订阅的不再通知', async (_name, ok) => {
    const late = controlled()
    const background = await refreshAfterSuccess(late.refresh, { timeLimitMs: 20 })
    if (background === undefined)
      throw new Error('前提：到了时限还没有结果')
    const listener = vi.fn()
    const unsubscribed = vi.fn()
    background.subscribe(listener)
    background.subscribe(unsubscribed)()
    expect(background.settled()).toBe(false)
    late.finish(ok)
    await vi.waitFor(() => expect(background.settled()).toBe(true))
    expect(listener).toHaveBeenCalledTimes(1)
    expect(unsubscribed).not.toHaveBeenCalled()
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

import { describe, expect, it, vi } from 'vitest'
import { createConnectionState } from './connection-state.ts'

describe('页面连接事实', () => {
  it('浏览器离线立即不可用；online 只允许尝试，新的完整成功才恢复', () => {
    let now = 100
    const state = createConnectionState({ online: true, now: () => now })
    state.setBrowserOnline(false)
    expect(state.view()).toMatchObject({ available: false, browserOnline: false, problem: 'offline', since: 100 })
    now = 500
    state.setBrowserOnline(true)
    expect(state.view()).toMatchObject({ available: false, browserOnline: true, problem: 'unresponsive', since: 100 })
    state.succeeded(state.beginRequest())
    expect(state.view()).toMatchObject({ available: true, problem: undefined, since: undefined })
  })

  it('初始离线不等事件；离线中甚至真实成功也不能打开操作', () => {
    const state = createConnectionState({ online: false, now: () => 20 })
    state.succeeded(state.beginRequest())
    expect(state.view()).toMatchObject({ available: false, problem: 'offline', since: 20 })
  })

  it('故障前开始的成功回包不能恢复故障后的事实', () => {
    const state = createConnectionState({ online: true, now: () => 10 })
    const slowFailure = state.beginRequest()
    const early = state.beginRequest()
    // 成功请求开始得较晚，但仍在故障被观测之前；仅比较请求顺序挡不住这次旧成功。
    state.failed(slowFailure)
    const failed = state.view()
    state.succeeded(early)
    expect(state.view()).toBe(failed)
    state.succeeded(state.beginRequest())
    expect(state.view().available).toBe(true)
  })

  it('离线与重新 online 使先前请求失效，包括离线期间开始的请求', () => {
    const state = createConnectionState({ online: true, now: () => 10 })
    const before = state.beginRequest()
    state.setBrowserOnline(false)
    const offline = state.beginRequest()
    state.setBrowserOnline(true)
    state.succeeded(before)
    state.succeeded(offline)
    expect(state.view().available).toBe(false)
  })

  it('较新请求已成功，较早请求的晚到失败不能倒退', () => {
    const state = createConnectionState({ online: true, now: () => 10 })
    const early = state.beginRequest()
    state.succeeded(state.beginRequest())
    state.failed(early)
    expect(state.view().available).toBe(true)
  })

  it('连续故障保留异常起点，但使此前的复核票据失效', () => {
    let now = 10
    const state = createConnectionState({ online: true, now: () => now })
    state.failed(state.beginRequest())
    const checking = state.beginRequest()
    const generation = state.view().generation
    now = 1000
    state.failed(state.beginRequest())
    state.succeeded(checking)
    expect(state.view()).toMatchObject({ available: false, since: 10, generation: generation + 1 })
  })

  it('相同浏览器状态和例行成功不发布新快照；取消订阅后不再通知', () => {
    const state = createConnectionState({ online: true, now: () => 0 })
    const changed = vi.fn()
    const stop = state.subscribe(changed)
    const initial = state.view()
    state.setBrowserOnline(true)
    state.succeeded(state.beginRequest())
    expect(state.view()).toBe(initial)
    expect(changed).not.toHaveBeenCalled()
    state.failed(state.beginRequest())
    expect(changed).toHaveBeenCalledTimes(1)
    stop()
    state.setBrowserOnline(false)
    expect(changed).toHaveBeenCalledTimes(1)
  })
})

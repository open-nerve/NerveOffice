// 测试构建的交接日志（M3-P5 设计 §3.13 的观察钩子）：挂在 window 上；按先后记下报来的事件与墙上时间，交出的是拷贝；清空、同步的订阅、条数上限
import type { HandoverLog, HandoverLogEntry } from './handover-log.ts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HANDOVER_LOG_GLOBAL, installHandoverLog } from './handover-log.ts'

function onWindow(): HandoverLog {
  return (window as unknown as Record<string, HandoverLog>)[HANDOVER_LOG_GLOBAL] as HandoverLog
}

afterEach(() => {
  delete (window as unknown as Record<string, unknown>)[HANDOVER_LOG_GLOBAL]
})

describe('测试构建的交接日志（M3-P5 设计 §3.13）', () => {
  it('挂在 window 上；按先后记下每一条事件（种类、单调时钟的时刻与各自的字段），另记记下时的墙上时间', () => {
    let wall = 1_000
    const installed = installHandoverLog(window, () => wall)
    expect(onWindow()).toBe(installed.log)
    installed.observe({ kind: 'handover-request', at: 12.5, requestId: 'r-1' } as { kind: string, at: number })
    wall = 1_250
    installed.observe({ kind: 'handover-reply', at: 260, requestId: 'r-1', reply: 'ack', detail: 'editing' } as { kind: string, at: number })
    expect(onWindow().log()).toEqual([
      { kind: 'handover-request', at: 12.5, requestId: 'r-1', wall: 1_000 },
      { kind: 'handover-reply', at: 260, requestId: 'r-1', reply: 'ack', detail: 'editing', wall: 1_250 },
    ])
  })

  it('交出的是拷贝：改了交出的那一份、报来的事件对象之后再变，日志都不变', () => {
    const installed = installHandoverLog(window, () => 1)
    const event = { kind: 'acquire', at: 1, trigger: 'enter', takeover: null as string | null }
    installed.observe(event)
    event.takeover = 'force'
    const first = onWindow().log()
    ;(first[0] as Record<string, unknown>).kind = '改过'
    expect(onWindow().log()).toEqual([{ kind: 'acquire', at: 1, trigger: 'enter', takeover: null, wall: 1 }])
  })

  it('清空；订阅的人每记下一条就同步收到一份拷贝，退订之后不再收到', () => {
    const installed = installHandoverLog(window, () => 7)
    const seen: HandoverLogEntry[] = []
    const stop = onWindow().subscribe(entry => seen.push(entry))
    installed.observe({ kind: 'entered', at: 3 })
    expect(seen).toEqual([{ kind: 'entered', at: 3, wall: 7 }])
    stop()
    installed.observe({ kind: 'lock-stolen', at: 4 })
    expect(seen).toHaveLength(1)
    onWindow().clear()
    expect(onWindow().log()).toEqual([])
  })

  it('订阅的人出错：这一条照样记下，错误交回报来的那一方（编辑器页接住、上报）', () => {
    const installed = installHandoverLog(window, () => 1)
    onWindow().subscribe(() => {
      throw new Error('订阅的人出错')
    })
    expect(() => installed.observe({ kind: 'entered', at: 1 })).toThrow('订阅的人出错')
    expect(onWindow().log()).toHaveLength(1)
  })

  it('最多留 2000 条：再多就丢掉最早的', () => {
    const installed = installHandoverLog(window, () => 0)
    for (let at = 0; at < 2005; at += 1)
      installed.observe({ kind: 'request-renewed', at })
    const log = onWindow().log()
    expect(log).toHaveLength(2000)
    expect(log[0]?.at).toBe(5)
    expect(log.at(-1)?.at).toBe(2004)
  })

  it('墙上时间默认是 Date.now', () => {
    vi.spyOn(Date, 'now').mockReturnValue(42)
    const installed = installHandoverLog(window)
    installed.observe({ kind: 'entered', at: 1 })
    expect(onWindow().log()[0]?.wall).toBe(42)
    vi.restoreAllMocks()
  })
})

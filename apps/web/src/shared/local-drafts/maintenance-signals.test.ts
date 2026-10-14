import type { SessionResponse } from '@nerve-office/contracts'
import type { DraftMaintenance } from './draft-maintenance.ts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { setApiSession, setCsrfToken } from '../api/client.ts'
import { rememberSessionPermit } from '../api/session-association.ts'
import { watchMaintenanceSignals } from './maintenance-signals.ts'
import { publishLocalSession } from './session-events.ts'

const USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const PERMIT = { userId: USER, generation: '00000000-0000-4000-8000-000000000011' }
const OTHER = { userId: USER, generation: '00000000-0000-4000-8000-000000000012' }
const SESSION: SessionResponse = { user: { id: USER, username: 'alice', displayName: '甲', systemRole: 'member' }, personalSpace: { id: USER, name: '甲' }, csrfToken: 'csrf', features: { localDraftsEnabled: false } }
const stops: (() => void)[] = []
afterEach(() => {
  stops.splice(0).forEach(stop => stop())
  setCsrfToken(undefined)
})
function fixture() {
  const target = new EventTarget()
  const visibility = new EventTarget()
  let visible = true
  const model: Pick<DraftMaintenance, 'activate' | 'refresh'> = { activate: vi.fn(), refresh: vi.fn(async () => {}) }
  const listeners = new Set<() => void>()
  const channel = { subscribe: (listener: () => void) => {
    listeners.add(listener)
    return () => listeners.delete(listener)
  } }
  const stop = watchMaintenanceSignals({ model, target, visibility, visible: () => visible, channel })
  stops.push(stop)
  return {
    model,
    target,
    visibility,
    stop,
    hide: () => { visible = false },
    show: () => { visible = true },
    broadcast: () => listeners.forEach(listener => listener()),
  }
}

describe('两个入口共用真实采纳和浏览器信号，不另请求会话', () => {
  it('公开入口仅触发无身份维护；以后真实采纳即使部署关闭仍维护原草稿', () => {
    const t = fixture()
    expect(t.model.activate).toHaveBeenLastCalledWith(undefined)
    expect(t.model.refresh).toHaveBeenCalledOnce()
    rememberSessionPermit(SESSION, PERMIT)
    setApiSession(SESSION)
    expect(t.model.activate).toHaveBeenLastCalledWith(PERMIT)
    setCsrfToken(undefined)
    expect(t.model.activate).toHaveBeenLastCalledWith(undefined)
  })

  it('只接收匹配本页原许可的停写，不因旧失败撤销后来采纳的来源', () => {
    rememberSessionPermit(SESSION, PERMIT)
    setApiSession(SESSION)
    const t = fixture()
    publishLocalSession({ kind: 'stopped', previous: OTHER, cleanup: undefined })
    expect(t.model.activate).toHaveBeenCalledTimes(1)
    publishLocalSession({ kind: 'stopped', previous: PERMIT, cleanup: undefined })
    expect(t.model.activate).toHaveBeenLastCalledWith(undefined)
  })

  it('聚焦、联网、可见性与跨页消息只请求串行重查；关闭后全部退订', () => {
    const t = fixture()
    t.target.dispatchEvent(new Event('focus'))
    t.target.dispatchEvent(new Event('online'))
    t.hide()
    t.visibility.dispatchEvent(new Event('visibilitychange'))
    expect(t.model.refresh).toHaveBeenCalledTimes(3)
    t.show()
    t.visibility.dispatchEvent(new Event('visibilitychange'))
    t.broadcast()
    expect(t.model.refresh).toHaveBeenCalledTimes(5)
    t.stop()
    t.target.dispatchEvent(new Event('focus'))
    t.visibility.dispatchEvent(new Event('visibilitychange'))
    t.broadcast()
    expect(t.model.refresh).toHaveBeenCalledTimes(5)
  })

  it('页面隐藏清掉旧元数据；从 bfcache 返回重新按原响应核对，不借广播授权', () => {
    rememberSessionPermit(SESSION, PERMIT)
    setApiSession(SESSION)
    const t = fixture()
    t.target.dispatchEvent(new Event('pagehide'))
    expect(t.model.activate).toHaveBeenLastCalledWith(undefined)
    t.target.dispatchEvent(new Event('pageshow'))
    expect(t.model.activate).toHaveBeenLastCalledWith(PERMIT)
    expect(t.model.refresh).toHaveBeenCalledTimes(2)
  })
})

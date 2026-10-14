import type { SessionResponse } from '@nerve-office/contracts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { rememberSessionPermit } from '../api/session-association.ts'
import { recordApiSession } from '../api/session-context.ts'
import { watchLogoutSource } from './logout-source.ts'

const SESSION: SessionResponse = { user: { id: 'u', username: 'alice', displayName: '甲', systemRole: 'member' }, personalSpace: { id: 's', name: '甲' }, csrfToken: 'original', features: { localDraftsEnabled: true } }
const PERMIT = { userId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', generation: '00000000-0000-4000-8000-000000000011' }
const stops: (() => void)[] = []
afterEach(() => {
  stops.splice(0).forEach(stop => stop())
  recordApiSession(undefined)
})
function fixture() {
  let ended = false
  const session = { ...SESSION, user: { ...SESSION.user, id: PERMIT.userId } }
  rememberSessionPermit(session, PERMIT)
  recordApiSession(session)
  const target = new EventTarget()
  const visibility = new EventTarget()
  const invalidate = vi.fn()
  const recheck = vi.fn(async () => {})
  let broadcast = () => {}
  const channel = { announce: vi.fn(), close: vi.fn(), subscribe: (listener: () => void) => {
    broadcast = listener
    return () => {
      broadcast = () => {}
    }
  } }
  const stop = watchLogoutSource({ session, permit: PERMIT, ended: () => ended, invalidate, recheck, target, visibility, visible: () => true, channel })
  stops.push(stop)
  return { session, stop, target, visibility, invalidate, recheck, broadcast: () => broadcast(), end: () => {
    ended = true
  } }
}
describe('退出页面原来源的生命周期', () => {
  it('实际新登录即使同一账户也结束旧预览；同来源查询不误伤', () => {
    const t = fixture()
    const same = { ...t.session }
    rememberSessionPermit(same, PERMIT)
    recordApiSession(same)
    expect(t.invalidate).not.toHaveBeenCalled()
    recordApiSession({ ...t.session, csrfToken: 'new-login' })
    expect(t.invalidate).toHaveBeenCalledTimes(1)
  })
  it('同 token 但新本机代次也结束旧预览', () => {
    const t = fixture()
    const next = { ...t.session }
    rememberSessionPermit(next, { ...PERMIT, generation: '00000000-0000-4000-8000-000000000012' })
    recordApiSession(next)
    expect(t.invalidate).toHaveBeenCalledTimes(1)
  })
  it('只有本操作已确认服务端结束，清掉自己的请求上下文才不失效', () => {
    const t = fixture()
    t.end()
    recordApiSession(undefined)
    expect(t.invalidate).not.toHaveBeenCalled()
    recordApiSession({ ...t.session, csrfToken: 'new-login' })
    expect(t.invalidate).toHaveBeenCalledTimes(1)
  })
  it('广播不取新身份，保守结束旧操作；恢复可见只核对持久资格', () => {
    const t = fixture()
    t.target.dispatchEvent(new Event('focus'))
    t.visibility.dispatchEvent(new Event('visibilitychange'))
    expect(t.recheck).toHaveBeenCalledTimes(2)
    t.broadcast()
    expect(t.invalidate).toHaveBeenCalledTimes(1)
    t.stop()
    t.target.dispatchEvent(new Event('focus'))
    t.broadcast()
    expect(t.recheck).toHaveBeenCalledTimes(2)
    expect(t.invalidate).toHaveBeenCalledTimes(1)
  })
  it('进入 bfcache 时即撤下旧预览，不让返回页面继续借旧确认', () => {
    const t = fixture()
    t.target.dispatchEvent(new Event('pagehide'))
    expect(t.invalidate).toHaveBeenCalledTimes(1)
  })
})

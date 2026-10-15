import type { SessionResponse } from '@nerve-office/contracts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { setApiSession, setCsrfToken } from './client.ts'
import { currentApiSession, subscribeApiSession } from './session-context.ts'

const SESSION: SessionResponse = { user: { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', username: 'alice', displayName: '甲', systemRole: 'member' }, personalSpace: { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', name: '甲' }, csrfToken: 'csrf', features: { localDraftsEnabled: false } }
afterEach(() => setCsrfToken(undefined))
describe('真实响应的轻量采纳通知', () => {
  it('采纳原对象与清空来源都通知，单独设置 CSRF 不能继承旧响应', () => {
    const listener = vi.fn()
    const stop = subscribeApiSession(listener)
    setApiSession(SESSION)
    expect(currentApiSession()).toBe(SESSION)
    expect(listener).toHaveBeenLastCalledWith(SESSION)
    setCsrfToken('unassociated-token')
    expect(currentApiSession()).toBeUndefined()
    expect(listener).toHaveBeenLastCalledWith(undefined)
    stop()
    const count = listener.mock.calls.length
    setApiSession(SESSION)
    expect(listener).toHaveBeenCalledTimes(count)
  })

  it('失效的宿主监听器不能阻断采纳或其余宿主', () => {
    const stopBad = subscribeApiSession(() => {
      throw new Error('closed host')
    })
    const listener = vi.fn()
    const stop = subscribeApiSession(listener)
    expect(() => setApiSession(SESSION)).not.toThrow()
    expect(listener).toHaveBeenCalledWith(SESSION)
    stopBad()
    stop()
  })
})

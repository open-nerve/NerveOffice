import type { SessionResponse } from '@nerve-office/contracts'
import { describe, expect, it, vi } from 'vitest'
import { associatedSessionPermit, rememberSessionPermit } from '../../shared/api/session-association.ts'
import { createSessionImageAccess } from '../../shared/lib/session-image-access.ts'
import { createEditorImageAccess } from './image-access.ts'

const alice: SessionResponse = {
  user: { id: 'alice', username: 'alice', displayName: 'Alice', systemRole: 'member' },
  personalSpace: { id: 'alice-space', name: 'Alice' },
  csrfToken: 'alice-token',
  features: { localDraftsEnabled: true },
}
const bob: SessionResponse = { ...alice, user: { ...alice.user, id: 'bob' }, csrfToken: 'bob-token' }
const source = '/api/assets/11111111-1111-4111-8111-111111111111'

describe('本页图片的身份许可', () => {
  it('未确认时关闭，确认原对象并保留会话关联，通知前状态已经生效', () => {
    const access = createEditorImageAccess('alice')
    const permit = { generation: 'original' }
    rememberSessionPermit(alice, permit)
    const seen: (SessionResponse | undefined)[] = []
    access.subscribe(() => seen.push(access.current()))
    expect(access.current()).toBeUndefined()
    expect(access.owner).toBe('alice')
    access.confirm(alice)
    expect(access.current()).toBe(alice)
    expect(seen).toEqual([alice])
    expect(associatedSessionPermit(access.current()!)).toBe(permit)
  })

  it('本人同令牌重复确认只更新响应对象，不触发图片重读循环', () => {
    const access = createEditorImageAccess('alice')
    access.confirm(alice)
    const changed = vi.fn()
    access.subscribe(changed)
    const latest = { ...alice }
    access.confirm(latest)
    access.confirm(alice)
    access.confirm(latest)
    expect(access.current()).toBe(latest)
    expect(changed).not.toHaveBeenCalled()
  })

  it('失败来源跨同身份停写/确认保留，当前许可仍更新；明确刷新换读取轮次', () => {
    const access = createEditorImageAccess('alice')
    access.confirm(alice)
    const failed = access.readFailures()
    failed.add(source)
    access.suspend()
    access.suspend()
    const latest = { ...alice }
    access.confirm(latest)
    access.confirm({ ...latest })
    expect(access.current()).toEqual(latest)
    expect(access.readFailures()).toBe(failed)
    expect(access.readFailures().has(source)).toBe(true)
    access.refresh()
    expect(access.readFailures()).not.toBe(failed)
    expect(access.readFailures().has(source)).toBe(false)
    failed.add(source)
    expect(access.readFailures().has(source)).toBe(false)
  })

  it.each(['csrf', 'other-user', 'dispose'] as const)('%s 退休旧失败轮次，旧轮次不能污染新身份', (change) => {
    const access = createEditorImageAccess('alice')
    access.confirm(alice)
    const old = access.readFailures()
    old.add(source)
    if (change === 'csrf') {
      access.confirm({ ...alice, csrfToken: 'new-token' })
    }
    else if (change === 'other-user') {
      access.confirm(bob)
      expect(access.current()).toBeUndefined()
      access.confirm(alice)
    }
    else {
      access.dispose()
      access.confirm(alice)
      expect(access.current()).toBeUndefined()
    }
    expect(access.readFailures()).not.toBe(old)
    old.add(source)
    expect(access.readFailures().has(source)).toBe(false)
  })

  it('历史预览使用的默认控制器仍在同身份暂停后确认时刷新，不采用编辑页失败锁存', () => {
    const access = createSessionImageAccess('alice')
    access.confirm(alice)
    const old = access.readFailures()
    old.add(source)
    access.suspend()
    const latest = { ...alice }
    access.confirm(latest)
    expect(access.current()).toBe(latest)
    expect(access.readFailures()).not.toBe(old)
    expect(access.readFailures().has(source)).toBe(false)
  })

  it('本人换令牌、从暂停恢复和明确复核才通知，暂停期间复核不激活', () => {
    const access = createEditorImageAccess('alice')
    access.confirm(alice)
    const seen: (SessionResponse | undefined)[] = []
    access.subscribe(() => seen.push(access.current()))
    const latest = { ...alice, csrfToken: 'fresh' }
    access.confirm(latest)
    access.refresh()
    access.suspend()
    access.suspend()
    access.refresh()
    access.confirm(latest)
    expect(seen).toEqual([latest, latest, undefined, latest])
  })

  it('换人同步暂停且不接纳新用户，本人回来后才恢复', () => {
    const access = createEditorImageAccess('alice')
    access.confirm(alice)
    const seen: (SessionResponse | undefined)[] = []
    access.subscribe(() => seen.push(access.current()))
    access.confirm(bob)
    expect(access.current()).toBeUndefined()
    access.confirm(bob)
    access.confirm(alice)
    expect(seen).toEqual([undefined, alice])
  })

  it('取消订阅后无通知；销毁先清身份再通知，之后不能复活或保留订阅', () => {
    const access = createEditorImageAccess('alice')
    access.confirm(alice)
    const removed = vi.fn()
    access.subscribe(removed)()
    const seen: (SessionResponse | undefined)[] = []
    access.subscribe(() => seen.push(access.current()))
    access.dispose()
    access.dispose()
    access.confirm(alice)
    access.refresh()
    access.subscribe(removed)
    access.confirm(bob)
    expect(access.current()).toBeUndefined()
    expect(seen).toEqual([undefined])
    expect(removed).not.toHaveBeenCalled()
  })
})

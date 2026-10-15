import type { SessionResponse } from '@nerve-office/contracts'
import type { LocalCleanup } from '../outbox/local-cleanup.ts'
import type { LogoutFlowOptions, LogoutQualification } from './logout-flow.ts'
import { describe, expect, it, vi } from 'vitest'
import { ApiError, NetworkError } from '../api/api-errors.ts'
import { deferred } from '../outbox/outbox-lock.test-support.ts'
import { createLogoutFlow } from './logout-flow.ts'

const USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const G1 = '00000000-0000-4000-8000-000000000011'
const G2 = '00000000-0000-4000-8000-000000000012'
const PERMIT = { userId: USER, generation: G1 }
const CLEANUP = { userId: USER, generation: G2, cause: 'logout' as const }
const SESSION: SessionResponse = { user: { id: USER, username: 'alice', displayName: '甲', systemRole: 'member' }, personalSpace: { id: USER, name: '甲' }, csrfToken: 'original-csrf', features: { localDraftsEnabled: true } }
const ENTRY = { documentId: USER, title: '离线预算', updatedAt: 1000, mirrorOnly: false }

function fixture() {
  let alive = true
  let qualified: LogoutQualification = 'active'
  const trace: string[] = []
  const inventory = { load: vi.fn<LogoutFlowOptions['inventory']['load']>(async () => ({ kind: 'listed', entries: [ENTRY], incomplete: false })), dispose: vi.fn() }
  const cleanup = {
    beginUser: vi.fn<LocalCleanup['beginUser']>(async () => {
      trace.push('begin')
      qualified = 'clearing'
      return { kind: 'clearing', permit: CLEANUP }
    }),
    removeUser: vi.fn<LocalCleanup['removeUser']>(async () => {
      trace.push('local')
      qualified = 'cleared'
      return { kind: 'cleared', pending: [] }
    }),
  }
  const requestLogout = vi.fn<LogoutFlowOptions['requestLogout']>(async () => {
    trace.push('server')
  })
  const stopped = vi.fn<LogoutFlowOptions['stopped']>(() => {
    trace.push('stop')
  })
  const clearCache = vi.fn(() => {
    trace.push('cache')
  })
  const qualify = vi.fn<LogoutFlowOptions['qualify']>(async () => qualified)
  const options: LogoutFlowOptions = { session: SESSION, permit: PERMIT, inventory, cleanup, qualify, stopped, requestLogout, clearCache, still: () => alive }
  return {
    flow: createLogoutFlow(options),
    options,
    cleanup,
    qualify,
    inventory,
    requestLogout,
    stopped,
    clearCache,
    trace,
    leave: () => { alive = false },
    replace: () => { qualified = 'invalidated' },
    qualifyAs: (value: LogoutQualification) => { qualified = value },
  }
}

describe('退出确认固定原来源，本机与服务器分别报告', () => {
  it('漏广播后恢复可见的只读复核立刻撤下失效预览，不补取登录资格', async () => {
    const t = fixture()
    await t.flow.preview()
    t.replace()
    await t.flow.recheck()
    expect(t.flow.view()).toMatchObject({ stage: 'invalidated', preview: undefined })
    expect(t.cleanup.beginUser).not.toHaveBeenCalled()
    expect(t.requestLogout).not.toHaveBeenCalled()
  })
  it('预览、取消不开始清理或退出；预览结果不完整会保留这一事实', async () => {
    const t = fixture()
    t.inventory.load.mockResolvedValueOnce({ kind: 'listed', entries: [ENTRY], incomplete: true })
    await t.flow.preview()
    expect(t.flow.view()).toMatchObject({ stage: 'ready', preview: { kind: 'listed', entries: [ENTRY], incomplete: true } })
    expect(t.cleanup.beginUser).not.toHaveBeenCalled()
    expect(t.requestLogout).not.toHaveBeenCalled()
    t.flow.dispose()
    expect(t.flow.view().preview).toBeUndefined()
    await t.flow.confirm()
    expect(t.cleanup.beginUser).not.toHaveBeenCalled()
    expect(t.requestLogout).not.toHaveBeenCalled()
  })

  it('明确确认后先立栅栏、通知停写、清本机，再退出原会话和清缓存', async () => {
    const t = fixture()
    await t.flow.confirm()
    expect(t.cleanup.beginUser).not.toHaveBeenCalled()
    await t.flow.preview()
    await t.flow.confirm()
    expect(t.trace).toEqual(['begin', 'stop', 'local', 'server', 'cache'])
    expect(t.cleanup.beginUser).toHaveBeenCalledExactlyOnceWith(PERMIT, 'logout')
    expect(t.stopped).toHaveBeenCalledExactlyOnceWith(PERMIT, CLEANUP)
    expect(t.cleanup.removeUser).toHaveBeenCalledExactlyOnceWith(CLEANUP)
    expect(t.requestLogout).toHaveBeenCalledExactlyOnceWith(SESSION)
    expect(t.flow.view()).toMatchObject({ stage: 'result', busy: undefined, preview: undefined, local: { kind: 'cleared' }, server: { kind: 'ended' } })
  })

  it('pending 即使文档数组为空也未清完；服务端照常退出，重试只补本机', async () => {
    const t = fixture()
    t.cleanup.removeUser.mockResolvedValueOnce({ kind: 'pending', pending: [] })
    await t.flow.preview()
    await t.flow.confirm()
    expect(t.flow.view()).toMatchObject({ local: { kind: 'pending', pending: [] }, server: { kind: 'ended' }, canRetry: true })
    await t.flow.retry()
    expect(t.cleanup.beginUser).toHaveBeenCalledTimes(1)
    expect(t.cleanup.removeUser).toHaveBeenNthCalledWith(2, CLEANUP)
    expect(t.requestLogout).toHaveBeenCalledTimes(1)
    expect(t.clearCache).toHaveBeenCalledTimes(1)
    expect(t.flow.view()).toMatchObject({ local: { kind: 'cleared' }, server: { kind: 'ended' }, canRetry: false })
  })

  it('主库开始清理失败仍尝试服务器退出；不得伪造清理资格，原来源尚在才可重试', async () => {
    const t = fixture()
    t.cleanup.beginUser.mockResolvedValueOnce({ kind: 'unavailable', reason: 'blocked' })
    await t.flow.preview()
    await t.flow.confirm()
    expect(t.flow.view()).toMatchObject({ local: { kind: 'unavailable', reason: 'blocked' }, server: { kind: 'ended' } })
    expect(t.stopped).not.toHaveBeenCalled()
    expect(t.cleanup.removeUser).not.toHaveBeenCalled()
    await t.flow.retry()
    expect(t.cleanup.beginUser).toHaveBeenCalledTimes(2)
    expect(t.requestLogout).toHaveBeenCalledTimes(1)
    expect(t.flow.view().local.kind).toBe('cleared')
  })

  it('本机已清完但退出响应未知，重试原服务器请求，不重复清理或称已退出', async () => {
    const t = fixture()
    const error = new NetworkError('回包丢失')
    t.requestLogout.mockRejectedValueOnce(error)
    await t.flow.preview()
    await t.flow.confirm()
    expect(t.flow.view()).toMatchObject({ local: { kind: 'cleared' }, server: { kind: 'unknown', error }, canRetry: true })
    expect(t.clearCache).not.toHaveBeenCalled()
    await t.flow.retry()
    expect(t.cleanup.removeUser).toHaveBeenCalledTimes(1)
    expect(t.requestLogout).toHaveBeenNthCalledWith(2, SESSION)
    expect(t.flow.view().server.kind).toBe('ended')
  })

  it.each(['UNAUTHENTICATED', 'SESSION_EXPIRED'])('服务器确认原会话已结束（%s），不另查会话或重新退出新登录', async (code) => {
    const t = fixture()
    t.requestLogout.mockRejectedValueOnce(new ApiError(401, code, '原会话已结束'))
    await t.flow.preview()
    await t.flow.confirm()
    expect(t.requestLogout).toHaveBeenCalledTimes(1)
    expect(t.clearCache).toHaveBeenCalledTimes(1)
    expect(t.flow.view().server.kind).toBe('ended')
  })

  it('旧预览之后新登录，旧确认不清理也不发退出', async () => {
    const t = fixture()
    await t.flow.preview()
    t.replace()
    await t.flow.confirm()
    expect(t.flow.view()).toMatchObject({ stage: 'invalidated', preview: undefined, canRetry: false })
    expect(t.cleanup.beginUser).not.toHaveBeenCalled()
    expect(t.requestLogout).not.toHaveBeenCalled()
  })

  it.each(['pending', 'unknown'] as const)('旧 %s 结果遇到新登录，原重试不借新资格，清除旧标题', async (kind) => {
    const t = fixture()
    if (kind === 'pending')
      t.cleanup.removeUser.mockResolvedValueOnce({ kind: 'pending', pending: [{ userId: USER, documentId: USER }] })
    else
      t.requestLogout.mockRejectedValueOnce(new NetworkError('未知'))
    await t.flow.preview()
    await t.flow.confirm()
    t.replace()
    await t.flow.retry()
    expect(t.flow.view()).toMatchObject({ stage: 'invalidated', preview: undefined, local: { kind: 'invalidated' }, canRetry: false })
    expect(t.cleanup.removeUser).toHaveBeenCalledTimes(1)
    expect(t.requestLogout).toHaveBeenCalledTimes(1)
  })

  it('旧清理过程中换人，不再替新登录发服务器退出', async () => {
    const t = fixture()
    const held = deferred<Awaited<ReturnType<LocalCleanup['removeUser']>>>()
    t.cleanup.removeUser.mockImplementationOnce(async () => held.promise)
    await t.flow.preview()
    const confirming = t.flow.confirm()
    await vi.waitFor(() => expect(t.cleanup.removeUser).toHaveBeenCalledTimes(1))
    t.replace()
    held.resolve({ kind: 'pending', pending: [] })
    await confirming
    expect(t.requestLogout).not.toHaveBeenCalled()
    expect(t.flow.view().stage).toBe('invalidated')
  })

  it('旧退出迟到后已有新登录，不清除新账户缓存，不把新会话认作已退出', async () => {
    const t = fixture()
    const held = deferred<void>()
    t.requestLogout.mockImplementationOnce(async () => held.promise)
    await t.flow.preview()
    const confirming = t.flow.confirm()
    await vi.waitFor(() => expect(t.requestLogout).toHaveBeenCalledTimes(1))
    t.replace()
    held.resolve()
    await confirming
    expect(t.clearCache).not.toHaveBeenCalled()
    expect(t.flow.view().stage).toBe('invalidated')
  })

  it('重入确认/重试不重复执行；页面离开后迟到预览不重新展示标题', async () => {
    const t = fixture()
    const held = deferred<Awaited<ReturnType<typeof t.inventory.load>>>()
    t.inventory.load.mockImplementationOnce(async () => held.promise)
    const preview = t.flow.preview()
    await t.flow.confirm()
    t.leave()
    held.resolve({ kind: 'listed', entries: [ENTRY], incomplete: false })
    await preview
    expect(t.flow.view()).toMatchObject({ stage: 'invalidated', preview: undefined })
    expect(t.cleanup.beginUser).not.toHaveBeenCalled()
    const next = fixture()
    await next.flow.preview()
    await Promise.all([next.flow.confirm(), next.flow.confirm(), next.flow.retry()])
    expect(next.requestLogout).toHaveBeenCalledTimes(1)
  })

  it('库完全不可用时说明本机未建立清理资格，但仍能明确退出服务器', async () => {
    const t = fixture()
    const flow = createLogoutFlow({ ...t.options, permit: undefined, qualify: async () => 'unavailable' })
    t.inventory.load.mockResolvedValue({ kind: 'unavailable', reason: 'storage' })
    await flow.preview()
    await flow.confirm()
    expect(flow.view()).toMatchObject({ local: { kind: 'unconfirmed' }, server: { kind: 'ended' }, canRetry: false })
    expect(t.requestLogout).toHaveBeenCalledTimes(1)
    expect(t.cleanup.beginUser).not.toHaveBeenCalled()
  })

  it('本机清理抛错与目录失败如实保留，服务器仍退出；重试只沿同一许可补清', async () => {
    const t = fixture()
    const error = new Error('目录暂时不可用')
    t.cleanup.removeUser.mockRejectedValueOnce(error)
    await t.flow.preview()
    await t.flow.confirm()
    expect(t.flow.view()).toMatchObject({ local: { kind: 'failed', error }, server: { kind: 'ended' } })
    await t.flow.retry()
    expect(t.cleanup.beginUser).toHaveBeenCalledTimes(1)
    expect(t.cleanup.removeUser).toHaveBeenNthCalledWith(2, CLEANUP)
    expect(t.flow.view().local.kind).toBe('cleared')
  })

  it('背景维护已经凭原资格清完，旧结果重试核对 cleared 后不重复删除', async () => {
    const t = fixture()
    t.cleanup.removeUser.mockResolvedValueOnce({ kind: 'pending', pending: [] })
    await t.flow.preview()
    await t.flow.confirm()
    t.qualify.mockResolvedValue('cleared')
    await t.flow.retry()
    expect(t.cleanup.removeUser).toHaveBeenCalledTimes(1)
    expect(t.flow.view()).toMatchObject({ local: { kind: 'cleared' }, canRetry: false })
  })

  it.each(['confirm', 'retry'] as const)('%s 已核对 clearing 后背景凭原许可清完，本次删除被拒绝仍结束原服务器会话', async (action) => {
    const t = fixture()
    await t.flow.preview()
    if (action === 'retry') {
      t.cleanup.removeUser.mockResolvedValueOnce({ kind: 'pending', pending: [] })
      await t.flow.confirm()
    }
    const entered = deferred<void>()
    const completed = deferred<void>()
    t.cleanup.removeUser.mockImplementationOnce(async (permit) => {
      expect(permit).toEqual(CLEANUP)
      entered.resolve()
      await completed.promise
      return { kind: 'invalidated' }
    })
    const running = t.flow[action]()
    await entered.promise
    expect(await t.qualify(CLEANUP)).toBe('clearing')
    // 背景维护先完成同一次清理，前台持有的删除许可已经结束。
    t.qualifyAs('cleared')
    completed.resolve()
    await running
    expect(t.flow.view()).toMatchObject({ stage: 'result', local: { kind: 'cleared' }, server: { kind: 'ended' }, canRetry: false })
    expect(t.cleanup.beginUser).toHaveBeenCalledExactlyOnceWith(PERMIT, 'logout')
    expect(t.requestLogout).toHaveBeenCalledExactlyOnceWith(SESSION)
    expect(t.clearCache).toHaveBeenCalledTimes(1)
    const removals = action === 'confirm' ? 1 : 2
    expect(t.cleanup.removeUser).toHaveBeenCalledTimes(removals)
    await t.flow.retry()
    expect(t.cleanup.removeUser).toHaveBeenCalledTimes(removals)
    expect(t.requestLogout).toHaveBeenCalledTimes(1)
  })

  it.each(['clearing', 'unavailable'] as const)('删除被拒绝后复核为 %s，保留未清完结果并继续原服务器退出，不能伪报来源变化', async (qualification) => {
    const t = fixture()
    await t.flow.preview()
    t.cleanup.removeUser.mockImplementationOnce(async () => {
      t.qualifyAs(qualification)
      return { kind: 'invalidated' }
    })
    await t.flow.confirm()
    expect(t.flow.view()).toMatchObject({ stage: 'result', local: { kind: 'pending' }, server: { kind: 'ended' }, canRetry: true })
    expect(t.requestLogout).toHaveBeenCalledExactlyOnceWith(SESSION)
    expect(t.cleanup.beginUser).toHaveBeenCalledTimes(1)
    t.qualifyAs('cleared')
    await t.flow.retry()
    expect(t.flow.view()).toMatchObject({ local: { kind: 'cleared' }, canRetry: false })
    expect(t.cleanup.removeUser).toHaveBeenCalledExactlyOnceWith(CLEANUP)
  })

  it('删除被拒绝后复核确实换代，旧确认不得继续退出或获取新的删除许可', async () => {
    const t = fixture()
    await t.flow.preview()
    t.cleanup.removeUser.mockImplementationOnce(async () => {
      t.replace()
      return { kind: 'invalidated' }
    })
    await t.flow.confirm()
    expect(t.flow.view()).toMatchObject({ stage: 'invalidated', local: { kind: 'invalidated' }, canRetry: false })
    expect(t.requestLogout).not.toHaveBeenCalled()
    expect(t.clearCache).not.toHaveBeenCalled()
    expect(t.cleanup.beginUser).toHaveBeenCalledExactlyOnceWith(PERMIT, 'logout')
  })

  it('CSRF 已被新登录替换时结束旧流程，不自动改用新令牌、不清新缓存', async () => {
    const t = fixture()
    t.requestLogout.mockRejectedValueOnce(new ApiError(403, 'CSRF_TOKEN_INVALID', '来源已变化'))
    await t.flow.preview()
    await t.flow.confirm()
    expect(t.flow.view()).toMatchObject({ stage: 'invalidated', canRetry: false })
    expect(t.clearCache).not.toHaveBeenCalled()
    await t.flow.retry()
    expect(t.requestLogout).toHaveBeenCalledTimes(1)
  })

  it('beginUser 已拒绝原代次时不能发退出；通知失败则仍依赖持久栅栏继续原操作', async () => {
    const t = fixture()
    t.cleanup.beginUser.mockResolvedValueOnce({ kind: 'session-invalid' })
    await t.flow.preview()
    await t.flow.confirm()
    expect(t.flow.view().stage).toBe('invalidated')
    expect(t.requestLogout).not.toHaveBeenCalled()
    const next = fixture()
    next.stopped.mockImplementationOnce(() => {
      throw new Error('组件已关闭')
    })
    await next.flow.preview()
    await next.flow.confirm()
    expect(next.flow.view()).toMatchObject({ local: { kind: 'cleared' }, server: { kind: 'ended' } })
  })

  it('预览读取失败或完成后无法复核存储，不显示无法再确认的旧标题，也不声称列表完整', async () => {
    const t = fixture()
    t.inventory.load.mockRejectedValueOnce(new Error('无法列出'))
    await t.flow.preview()
    expect(t.flow.view()).toMatchObject({ stage: 'ready', preview: { kind: 'unavailable', reason: 'storage' } })
    const next = fixture()
    next.qualify.mockRejectedValueOnce(new Error('无法核对'))
    await next.flow.preview()
    expect(next.flow.view()).toMatchObject({ stage: 'ready', preview: { kind: 'unavailable', reason: 'storage' } })
  })
})

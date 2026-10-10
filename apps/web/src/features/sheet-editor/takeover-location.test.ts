import type { DocumentEditor } from '@nerve-office/contracts'
import type { LeaseLoss } from './edit-lease.ts'
import type { FetchedEditStatus } from './editor-api.ts'
import { describe, expect, it, vi } from 'vitest'
import { NetworkError } from '../../shared/api/index.ts'
import { settle } from './fake-lease-clock.test-support.ts'
import { resolveTakeoverLoss } from './takeover-location.ts'

const ELSEWHERE: LeaseLoss = { kind: 'taken-over', where: 'elsewhere' }
const HERE: LeaseLoss = { kind: 'taken-over', where: 'this-browser' }
const EDITOR: DocumentEditor = {
  holder: { id: '0199a2c4-1f2e-7a3b-8c4d-0000000000e1', username: 'amy', displayName: '艾米' },
  lastActiveAt: '2026-10-04T03:03:00.000Z',
  sameUser: true,
  sameSession: true,
}

function status(editor: DocumentEditor | null): FetchedEditStatus {
  return { status: { revision: 4, editor, canEdit: true, canTakeOver: false, formulasPending: false, request: null, reservation: null, interruption: null }, serverTime: undefined }
}

function deferred<T>() {
  let resolve: (value: T) => void = () => {}
  let reject: (error: unknown) => void = () => {}
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

describe('本人接管的位置采用服务端事实（DEF-071）', () => {
  it.each([
    { sameSession: true, local: false, loss: ELSEWHERE, expected: HERE },
    { sameSession: true, local: true, loss: ELSEWHERE, expected: HERE },
    { sameSession: false, local: true, loss: HERE, expected: ELSEWHERE },
    { sameSession: false, local: false, loss: HERE, expected: ELSEWHERE },
  ])('sameSession=$sameSession，local=$local：服务端胜过本机/原失效位置', async ({ sameSession, local, loss, expected }) => {
    const read = vi.fn(async () => status({ ...EDITOR, sameSession }))
    await expect(resolveTakeoverLoss(loss, read, Promise.resolve(local))).resolves.toEqual(expected)
    expect(read).toHaveBeenCalledOnce()
  })

  it('服务端已经确定时不等本机；本机之后失败也不产生未处理拒绝', async () => {
    const local = deferred<boolean>()
    await expect(resolveTakeoverLoss(ELSEWHERE, async () => status(EDITOR), local.promise)).resolves.toEqual(HERE)
    local.reject(new Error('旧锁查询迟到的失败'))
    await settle()
  })

  it('本机先说这里、服务端还在路上时不先定论；之后 sameSession=false 采用别处', async () => {
    const remote = deferred<FetchedEditStatus>()
    let resolved: LeaseLoss | undefined
    const locating = resolveTakeoverLoss(HERE, async () => remote.promise, Promise.resolve(true)).then((loss) => {
      resolved = loss
    })
    await settle()
    expect(resolved).toBeUndefined()
    remote.resolve(status({ ...EDITOR, sameSession: false }))
    await locating
    expect(resolved).toEqual(ELSEWHERE)
  })

  it.each([
    { label: '没有持有者', read: async () => status(null) },
    { label: '变成他人', read: async () => status({ ...EDITOR, sameUser: false, sameSession: false }) },
    { label: '读取失败', read: async (): Promise<FetchedEditStatus> => { throw new NetworkError('断网') } },
  ])('$label：回退到本机，已有的本机位置不丢失', async ({ read }) => {
    await expect(resolveTakeoverLoss(ELSEWHERE, read, Promise.resolve(true))).resolves.toEqual(HERE)
    await expect(resolveTakeoverLoss(ELSEWHERE, read, Promise.resolve(false))).resolves.toEqual(ELSEWHERE)
    await expect(resolveTakeoverLoss(HERE, read, Promise.resolve(false))).resolves.toEqual(HERE)
  })

  it('服务端与本机都读不到时，保留原失效位置', async () => {
    await expect(resolveTakeoverLoss(ELSEWHERE, async () => status(null), Promise.reject(new Error('锁不可用')))).resolves.toEqual(ELSEWHERE)
  })

  it.each<LeaseLoss>([{ kind: 'forced' }, { kind: 'lease', reason: 'revoked' }, { kind: 'held', holder: undefined }])('$kind 不查询、不改变原因、也不等待本机', async (loss) => {
    const read = vi.fn(async () => status(EDITOR))
    await expect(resolveTakeoverLoss(loss, read, new Promise<boolean>(() => {}))).resolves.toBe(loss)
    expect(read).not.toHaveBeenCalled()
  })
})

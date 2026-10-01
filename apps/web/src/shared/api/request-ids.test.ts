// 带 requestId 的新建共用的记账（M2-P6 复核 M1）：结果未知时保留；之前有过结果未知的，之后的会话类拒绝仍保留；
// 成功、或者与载荷有关的确定拒绝才换新；结果未知之后遇到 REQUEST_ID_CONFLICT，说明上一次已经生效。
import { describe, expect, it } from 'vitest'
import { ApiError, NetworkError, ResponseFormatError } from './client.ts'
import { createRequestIdLedger } from './request-ids.ts'

/** 依次给出 id-1、id-2……的记账：看得出用的是第几个 */
function ledger() {
  let next = 0
  return createRequestIdLedger(() => {
    next += 1
    return `id-${next}`
  })
}

/** 用这件事的 requestId 发一次请求：result 是这次的结果（错误就抛出）；返回这次用的 requestId 与抛出的错误 */
async function attempt(requestIds: ReturnType<typeof ledger>, key: string, result: unknown): Promise<{ readonly id: string, readonly error: unknown }> {
  let id = ''
  try {
    await requestIds.send(key, async (requestId) => {
      id = requestId
      if (result instanceof Error)
        throw result
      return result
    })
    return { id, error: undefined }
  }
  catch (error) {
    return { id, error }
  }
}

const unknown = (): Error => new NetworkError('网络请求失败')
const serverError = (): Error => new ApiError(500, 'INTERNAL_ERROR', '服务器内部错误')
const busy = (): Error => new ApiError(503, 'SERVICE_UNAVAILABLE', '服务暂时不可用')
const csrf = (): Error => new ApiError(403, 'CSRF_TOKEN_INVALID', '请求已失效')
const expired = (): Error => new ApiError(401, 'SESSION_EXPIRED', '登录已过期')
const unauthenticated = (): Error => new ApiError(401, 'UNAUTHENTICATED', '请先登录')
const conflict = (): Error => new ApiError(409, 'REQUEST_ID_CONFLICT', '请求标识已被另一个请求使用')

describe('带 requestId 的新建：requestId 的去留（M2-P6 复核 M1）', () => {
  it('结果未知（网络、5xx、回包读不出来）：保留，再试沿用同一个', async () => {
    const requestIds = ledger()
    const first = await attempt(requestIds, 'a', unknown())
    const second = await attempt(requestIds, 'a', serverError())
    const third = await attempt(requestIds, 'a', new ResponseFormatError('回包与契约不一致'))
    const fourth = await attempt(requestIds, 'a', { ok: true })
    expect([first.id, second.id, third.id, fourth.id]).toEqual(['id-1', 'id-1', 'id-1', 'id-1'])
  })

  it('成功之后换新：再做一次同样的事是另一件事', async () => {
    const requestIds = ledger()
    await attempt(requestIds, 'a', { ok: true })
    expect((await attempt(requestIds, 'a', { ok: true })).id).toBe('id-2')
  })

  it('结果未知之后，重试先撞上会话类的拒绝（别的标签页换了令牌、登录状态刚变化）：仍然保留，第三次不会建出第二份（P11）', async () => {
    for (const rejection of [csrf, expired, unauthenticated]) {
      const requestIds = ledger()
      const first = await attempt(requestIds, 'a', unknown())
      const second = await attempt(requestIds, 'a', rejection())
      const third = await attempt(requestIds, 'a', { ok: true })
      expect([first.id, second.id, third.id], rejection().message).toEqual(['id-1', 'id-1', 'id-1'])
    }
  })

  it('会话类的拒绝本身也不换新：服务端没有看这个 requestId', async () => {
    const requestIds = ledger()
    await attempt(requestIds, 'a', csrf())
    expect((await attempt(requestIds, 'a', { ok: true })).id).toBe('id-1')
  })

  it('服务端忙（503）：这一次确定没有生效，更早那一次却可能生效了，保留', async () => {
    const requestIds = ledger()
    await attempt(requestIds, 'a', unknown())
    await attempt(requestIds, 'a', busy())
    expect((await attempt(requestIds, 'a', { ok: true })).id).toBe('id-1')
  })

  it('与载荷有关的确定拒绝（内容不合法、没有权限、不存在、同名）：这件事有了结论，下一次换新', async () => {
    for (const rejection of [
      new ApiError(400, 'REQUEST_INVALID', '请求的格式或参数不合法'),
      new ApiError(403, 'PERMISSION_DENIED', '空间已归档，只能查看'),
      new ApiError(404, 'NOT_FOUND', '请求的资源不存在或无权访问'),
      new ApiError(409, 'FOLDER_DEPTH_EXCEEDED', '文件夹的层级超过上限'),
    ]) {
      const requestIds = ledger()
      await attempt(requestIds, 'a', rejection)
      expect((await attempt(requestIds, 'a', { ok: true })).id, rejection.code).toBe('id-2')
    }
  })

  it('结果未知之后遇到 REQUEST_ID_CONFLICT（改了名字再提交）：说明上一次已经生效，requestId 换新，不会一直撞同一个（P1）', async () => {
    const requestIds = ledger()
    await attempt(requestIds, 'a', unknown())
    const second = await attempt(requestIds, 'a', conflict())
    expect(second.id).toBe('id-1')
    expect(requestIds.earlierAttemptDone(second.error)).toBe(true)
    const third = await attempt(requestIds, 'a', { ok: true })
    expect(third.id).toBe('id-2')
  })

  it('之前没有结果未知的 REQUEST_ID_CONFLICT：不说"上一次已经生效"（那是别的原因），照样换新', async () => {
    const requestIds = ledger()
    const first = await attempt(requestIds, 'a', conflict())
    expect(requestIds.earlierAttemptDone(first.error)).toBe(false)
    expect((await attempt(requestIds, 'a', { ok: true })).id).toBe('id-2')
    // 别的错误、不是错误的值都不算
    expect(requestIds.earlierAttemptDone(unknown())).toBe(false)
    expect(requestIds.earlierAttemptDone(undefined)).toBe(false)
  })

  it('按事情记账：换了一件事（例如换了目标位置）用另一个；回到结果未知的那件事，沿用它原来的', async () => {
    const requestIds = ledger()
    const first = await attempt(requestIds, 'to-root', unknown())
    const elsewhere = await attempt(requestIds, 'to-plan', unknown())
    const back = await attempt(requestIds, 'to-root', unknown())
    expect([first.id, elsewhere.id, back.id]).toEqual(['id-1', 'id-2', 'id-1'])
  })

  it('失败原样抛出：调用方照常按错误显示与处理', async () => {
    const requestIds = ledger()
    const error = csrf()
    expect((await attempt(requestIds, 'a', error)).error).toBe(error)
  })
})

import type { SessionResponse } from '@nerve-office/contracts'
import { Univer } from '@univerjs/core'
import { UniverDrawingPlugin } from '@univerjs/drawing'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setCsrfToken } from '../../shared/api/client.ts'
import { rememberSessionPermit } from '../../shared/api/session-association.ts'
import { reportRequestSessionFailure } from '../../shared/api/session-tracking.ts'
import { createSessionImageAccess } from '../../shared/lib/session-image-access.ts'
import { apiError, installFakeApi } from '../../shared/testing/fake-api.test-support.ts'
import { injectorOf } from '../internal-api/index.ts'
import { IURLImageService } from '../internal-api/ui.ts'
import { decodeImage } from './decode-image.ts'
import { BYTES, decoded, SOURCE } from './image-resources.test-support.ts'
import { createPlatformImageIo } from './platform-image-io.ts'

vi.hoisted(() => {
  globalThis.Path2D ??= class {} as unknown as typeof Path2D
})
// 真实 readAsset/apiFetch 解析 401 并安排原微任务；仅控制本机副作用的完成时序，不模拟存储性能。
vi.mock('../../shared/api/session-tracking.ts', () => ({ reportRequestSessionFailure: vi.fn(async () => {}) }))
// jsdom 无像素解码；请求、取消、资源表与 drawing IO 使用真实实现。
vi.mock('./decode-image.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./decode-image.ts')>()
  return { ...actual, decodeImage: vi.fn() }
})

const USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const G1 = '00000000-0000-4000-8000-000000000011'
const G2 = '00000000-0000-4000-8000-000000000012'
const cleanup: (() => void)[] = []

function session(generation: string, token = 'same-csrf'): SessionResponse {
  const value: SessionResponse = {
    user: { id: USER, username: 'alice', displayName: '甲', systemRole: 'member' },
    personalSpace: { id: USER, name: '甲' },
    csrfToken: token,
    features: { localDraftsEnabled: true },
  }
  rememberSessionPermit(value, Object.freeze({ userId: USER, generation }))
  return value
}

function setup() {
  const original = session(G1)
  const identity = createSessionImageAccess(USER, { preserveReadFailures: true })
  identity.confirm(original)
  const failed = vi.fn()
  const events: string[] = []
  // 只记录实际 abort 后的状态；不改变 signal、异常或 Promise 的处理次序。
  vi.stubGlobal('AbortController', class extends AbortController {
    override abort(reason?: unknown): void {
      super.abort(reason)
      if (reason instanceof DOMException && reason.name === 'AbortError' && this.signal.aborted)
        events.push(`aborted:${reason.message}`)
    }
  })
  const adapter = createPlatformImageIo({ access: 'edit', identity, origin: 'https://app.test', changed: vi.fn(), failed })
  const univer = new Univer()
  univer.registerPlugin(UniverDrawingPlugin, { override: adapter.override })
  cleanup.push(() => {
    adapter.dispose()
    univer.dispose()
    identity.dispose()
  })
  let requests = 0
  const api = installFakeApi({ [`GET ${SOURCE}`]: () => {
    requests += 1
    return requests === 1
      ? apiError(401, 'UNAUTHENTICATED', '受控图片认证失败')
      : new Response(BYTES.data, { headers: { 'content-type': BYTES.mimeType, 'x-asset-status': '200' } })
  } })
  const url = injectorOf(univer).get(IURLImageService)
  const first = async () => url.getImage(SOURCE).then((value) => {
    events.push('settled')
    return value
  }, (error: unknown) => {
    events.push('settled')
    return error
  })
  return { original, identity, failed, events, api, url, first }
}

beforeEach(() => {
  vi.mocked(reportRequestSessionFailure).mockReset().mockResolvedValue(undefined)
  vi.mocked(decodeImage).mockReset().mockImplementation(async () => decoded())
})

afterEach(() => {
  for (const finish of cleanup.splice(0))
    finish()
  setCsrfToken(undefined)
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('真实图片客户端 401 与本机撤权竞态', () => {
  it('原 401 没有取消竞争时仍只报告一次，失败占位不重读，显式刷新才恢复', async () => {
    const h = setup()
    const image = await h.first()
    expect(typeof image).toBe('string')
    expect(await h.url.getImage(SOURCE)).toBe(image)
    expect(h.identity.readFailures().has(SOURCE)).toBe(true)
    expect(h.failed).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ status: 401, code: 'UNAUTHENTICATED' }))
    expect(h.api.requests).toHaveLength(1)
    h.identity.refresh()
    expect(await h.url.getImage(SOURCE)).toBe('blob:https://app.test/first')
    expect(h.api.requests).toHaveLength(2)
    expect(h.failed).toHaveBeenCalledOnce()
  })

  it('原请求 401 自身先撤权：取消结果不变，同人同 CSRF 恢复仍保留失败来源且不自动重读', async () => {
    const h = setup()
    vi.mocked(reportRequestSessionFailure).mockImplementationOnce(async () => {
      h.events.push('report')
      h.identity.suspend()
      h.events.push('stopped')
    })
    expect(await h.first()).toMatchObject({ name: 'AbortError' })
    // 断言在副作用之外；client 会吞副作用异常，不能把断言放入 mock 回调。
    expect(reportRequestSessionFailure).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ status: 401, code: 'UNAUTHENTICATED' }),
      { userId: USER, generation: G1 },
    )
    expect(h.events.indexOf('report')).toBeLessThan(h.events.indexOf('stopped'))
    expect(h.events.indexOf('aborted:图片上传代次已更新')).toBeGreaterThan(h.events.indexOf('report'))
    expect(h.events.indexOf('aborted:图片上传代次已更新')).toBeLessThan(h.events.indexOf('settled'))
    expect(h.events.indexOf('stopped')).toBeLessThan(h.events.indexOf('settled'))
    expect(h.identity.current()).toBeUndefined()
    expect(h.api.requests).toHaveLength(1)
    const confirmed = session(G2)
    h.identity.confirm(confirmed)
    const image = await h.url.getImage(SOURCE)
    expect(h.identity.current()).toBe(confirmed)
    expect.soft(new URL(image).pathname).toMatch(/\.svg$/)
    expect.soft(h.identity.readFailures().has(SOURCE)).toBe(true)
    expect.soft(h.api.requests).toHaveLength(1)
    expect.soft(h.failed).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ status: 401, code: 'UNAUTHENTICATED' }))
    h.identity.refresh()
    expect(await h.url.getImage(SOURCE)).toBe('blob:https://app.test/first')
    expect(h.api.requests).toHaveLength(2)
  })

  it.each(['csrf', 'refresh', 'permission', 'dispose'] as const)('旧 401 尚未交回显示层前发生 %s：退休轮次不能污染新读取', async (change) => {
    const h = setup()
    const retired = h.identity.readFailures()
    vi.mocked(reportRequestSessionFailure).mockImplementationOnce(async () => {
      h.events.push('report')
      if (change === 'csrf') {
        h.identity.confirm(session(G2, 'new-csrf'))
      }
      else if (change === 'refresh') {
        h.identity.refresh()
      }
      else if (change === 'permission') {
        h.identity.resetReadFailures()
        h.identity.suspend()
      }
      else {
        h.identity.dispose()
      }
      h.events.push('retired')
    })
    expect(await h.first()).toMatchObject({ name: 'AbortError' })
    expect(reportRequestSessionFailure).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ status: 401, code: 'UNAUTHENTICATED' }),
      { userId: USER, generation: G1 },
    )
    expect(h.events.indexOf('retired')).toBeLessThan(h.events.indexOf('settled'))
    expect(h.identity.readFailures()).not.toBe(retired)
    if (change === 'permission')
      h.identity.confirm(session(G2))
    if (change === 'dispose')
      await expect(h.url.getImage(SOURCE)).rejects.toMatchObject({ name: 'AbortError' })
    else
      expect(await h.url.getImage(SOURCE)).toBe('blob:https://app.test/first')
    expect(h.identity.readFailures().has(SOURCE)).toBe(false)
    expect(h.failed).not.toHaveBeenCalled()
    expect(h.api.requests).toHaveLength(change === 'dispose' ? 1 : 2)
  })
})

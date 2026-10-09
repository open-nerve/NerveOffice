// 本机密钥的客户端（M4-P1 设计 §3.4.9，S6）：测试构建里的探针自己发请求（会话里的 CSRF 令牌）、用生产的 importLocalKey 导入，
// 取真的服务端给的密钥（请求层的写法——自动带 CSRF、按契约校验——由 local-key.ts 的单元测试覆盖）——导入出的密钥不可导出、
// 是 AES-GCM-256、版本与服务端的一致，并且就是服务端给的那一把（探针用它加密，E2E 用服务端给的原始字节在 Node 里独立解开）；
// 系统管理员吊销之后再取得到新的一版（吊销经管理接口，照 US-M3-17 的做法由管理员在另一台设备上操作）；会话失效时如实交回会话类的错误。
// 打开的是一份不存在的文档：页面确认会话、拿到 CSRF 令牌之后说明"内容不存在"，探针在这之后取。标签 @test-build
import type { LocalKey } from '@nerve-office/contracts'
import type { Page } from '@playwright/test'
import { Buffer } from 'node:buffer'
import { createDecipheriv, randomBytes } from 'node:crypto'
import { localKeySchema } from '@nerve-office/contracts'
import { createUser, expireSessions } from '../../support/database.ts'
import { e2eOrigin } from '../../support/environment.ts'
import { expect, test } from '../../support/fixtures.ts'
import { openOutboxProbe, outcomeOf, probeLocalKey } from '../../support/outbox-probe.ts'
import { actAs, loginThroughApi } from '../../support/session.ts'

/** 页面确认过会话（拿到了 CSRF 令牌）：不存在的文档的说明出来了 */
async function sessionConfirmed(page: Page): Promise<void> {
  await expect(page.getByText('内容不存在，或者你没有访问权限')).toBeVisible()
}

/** 测试这边经接口取同一个人当前的本机密钥（服务端的事实）：版本与原始字节 */
async function serverKey(page: Page): Promise<LocalKey> {
  const { csrfToken } = await (await page.request.get('/api/auth/session')).json() as { csrfToken: string }
  const response = await page.request.post('/api/local-key', { headers: { 'origin': e2eOrigin(), 'x-csrf-token': csrfToken } })
  expect(response.status(), await response.text()).toBe(200)
  return localKeySchema.parse(await response.json())
}

/** 用服务端给的原始字节（base64）在 Node 里独立解开探针加密的东西（AES-256-GCM，标签 16 字节附在末尾） */
function decrypt(rawBase64: string, ivHex: string, sealedHex: string): string {
  const sealed = Buffer.from(sealedHex, 'hex')
  const decipher = createDecipheriv('aes-256-gcm', Buffer.from(rawBase64, 'base64'), Buffer.from(ivHex, 'hex'), { authTagLength: 16 })
  decipher.setAuthTag(sealed.subarray(sealed.length - 16))
  return Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - 16)), decipher.final()]).toString('utf8')
}

const PLAIN = '本机草稿'

test.describe('本机密钥的客户端', { tag: '@test-build' }, () => {
  test('取到的密钥不可导出、AES-GCM-256、用途只有加密与解密，版本与服务端一致，就是服务端给的那一把；系统管理员吊销之后再取得到新的一版', async ({ page, anotherDevice }) => {
    const owner = await createUser('lk-client')
    const admin = await createUser('lk-client-admin', '吊销的管理员', { systemRole: 'admin' })
    await loginThroughApi(page, owner)
    await openOutboxProbe(page)
    await sessionConfirmed(page)

    // 第一次取：服务端生成第 1 版
    expect(await probeLocalKey(page, 'fetch')).toEqual({ kind: 'fetched', version: 1, extractable: false, usages: ['decrypt', 'encrypt'], algorithm: { name: 'AES-GCM', length: 256 }, exportRejected: 'InvalidAccessError' })
    const first = await serverKey(page)
    expect(first.version).toBe(1)
    const iv = randomBytes(12).toString('hex')
    const plainHex = Buffer.from(PLAIN, 'utf8').toString('hex')
    expect(decrypt(first.key, iv, await probeLocalKey(page, 'encryptHex', plainHex, iv)), '探针导入的就是服务端给的那一把').toBe(PLAIN)

    // 系统管理员在另一台设备上吊销：之后再取得到第 2 版、另一把
    await loginThroughApi(anotherDevice, admin)
    await actAs(anotherDevice, 'POST', `/api/admin/users/${owner.id}/local-key/revoke`)
    expect(outcomeOf(await probeLocalKey(page, 'fetch'), 'fetched')).toMatchObject({ version: 2, extractable: false })
    const second = await serverKey(page)
    expect(second.version).toBe(2)
    expect(second.key).not.toBe(first.key)
    const sealed = await probeLocalKey(page, 'encryptHex', plainHex, iv)
    expect(decrypt(second.key, iv, sealed)).toBe(PLAIN)
    expect(() => decrypt(first.key, iv, sealed), '吊销了的那一把解不开新的').toThrow()
  })

  test('会话失效之后再取：取用的请求本身被拒绝（401），如实交回会话类的错误，不交回密钥', async ({ page }) => {
    const owner = await createUser('lk-client-expired')
    await loginThroughApi(page, owner)
    await openOutboxProbe(page)
    await sessionConfirmed(page)
    expect(outcomeOf(await probeLocalKey(page, 'fetch'), 'fetched').version).toBe(1)
    await expireSessions(owner)
    const failed = outcomeOf(await probeLocalKey(page, 'fetch'), 'failed')
    expect(failed.error.status).toBe(401)
    expect(['UNAUTHENTICATED', 'SESSION_EXPIRED']).toContain(failed.error.code)
  })
})

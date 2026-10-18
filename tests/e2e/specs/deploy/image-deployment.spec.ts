// 和后端重启共用串行项目：等所有普通浏览器/崩溃项目结束，再独占实例检查图片预算和持久卷。
import type { APIRequestContext, Page } from '@playwright/test'
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { assetUploadResponseSchema, errorResponseSchema } from '@nerve-office/contracts'
import { restartApi } from '../../support/api-process.ts'
import { expectAssetHeaders, renderAsset, saveAssetSnapshot, uploadAsset } from '../../support/asset-protocol.ts'
import { createUser, withDatabase } from '../../support/database.ts'
import { e2eOrigin } from '../../support/environment.ts'
import { expect, test } from '../../support/fixtures.ts'
import { deploymentImageBytes, deploymentImageFixtures, expectHealthyImageContainer, imageContainerMetrics } from '../../support/image-deployment.ts'
import { loginThroughApi } from '../../support/session.ts'
import { createSheetThroughApi, savedContent } from '../../support/sheet.ts'

/** 逐项执行既有 accept/reject 清单，任何一项失败都使完整矩阵失败。 */
async function checkFixture(page: Page, csrfToken: string, fixture: (typeof deploymentImageFixtures)[number], rows: object[]): Promise<void> {
  const started = performance.now()
  const response = await page.request.post('/api/assets', { data: deploymentImageBytes(fixture), headers: { 'origin': e2eOrigin(), 'x-csrf-token': csrfToken, 'content-type': fixture.declaredType, 'x-asset-extension': fixture.extension } })
  rows.push({ id: fixture.id, status: response.status(), requestMs: Math.round((performance.now() - started) * 100) / 100 })
  if (fixture.expected.status === 'reject') {
    expect(response.status(), fixture.id).toBe(fixture.expected.reason === 'bytes' ? 413 : 422)
    expect(errorResponseSchema.parse(await response.json()).error, fixture.id).toMatchObject({ code: fixture.expected.reason === 'bytes' ? 'PAYLOAD_TOO_LARGE' : 'ASSET_INVALID', ...(fixture.expected.rule === undefined ? {} : { details: { rule: fixture.expected.rule } }) })
    return
  }
  expect(response.status(), `${fixture.id}: ${await response.text()}`).toBe(201)
  const image = assetUploadResponseSchema.parse(await response.json())
  expect(image, fixture.id).toMatchObject({ width: fixture.expected.width, height: fixture.expected.height, mimeType: fixture.declaredType })
  const rendered = await renderAsset(page, image.url)
  await expectAssetHeaders(rendered.response, 200, image.mimeType)
  expect({ width: rendered.width, height: rendered.height }, fixture.id).toEqual({ width: image.width, height: image.height })
  expect(rendered.body, fixture.id).toHaveLength(image.bytes)
  const metadata = await withDatabase(async client => (await client.query<{ sha256: string, frames: number }>('SELECT o.sha256,o.frames FROM assets a JOIN asset_objects o ON o.sha256=a.object_hash WHERE a.id=$1', [image.assetId])).rows[0])
  expect(metadata, fixture.id).toEqual({ sha256: createHash('sha256').update(rendered.body).digest('hex'), frames: fixture.expected.frames })
}

test('图片完整矩阵：44 份真实输入经公开上传处理，边界拒绝后服务仍可处理下一份', async ({ page }, testInfo) => {
  test.setTimeout(180_000)
  await loginThroughApi(page, await createUser('image-matrix'))
  await page.goto('/')
  const { csrfToken } = await (await page.request.get('/api/auth/session')).json() as { csrfToken: string }
  const rows: object[] = []
  const before = imageContainerMetrics()
  let after: ReturnType<typeof imageContainerMetrics>
  try {
    expect(deploymentImageFixtures).toHaveLength(44)
    for (const fixture of deploymentImageFixtures)
      await checkFixture(page, csrfToken, fixture, rows)
    // 最后几项也包含超限/输出膨胀拒绝，再上传普通图片证明执行槽与服务可继续使用。
    const recovered = await uploadAsset(page, 'minimum.png')
    expect((await renderAsset(page, recovered.url)).width).toBe(1)
    expect((await page.request.get('/api/health/live')).status()).toBe(200)
    after = imageContainerMetrics()
    expectHealthyImageContainer(after)
  }
  finally {
    await testInfo.attach('image-matrix-and-container-budget', { body: Buffer.from(JSON.stringify({ before, after, rows }, null, 2)), contentType: 'application/json' })
  }
})

test('图片准入：实际上传等待数据库时，账户与全局排队有界，繁忙不影响存活与释放后的恢复', async ({ page, playwright }, testInfo) => {
  await loginThroughApi(page, await createUser('image-admission-owner'))
  await uploadAsset(page, 'minimum.png')
  const contexts: APIRequestContext[] = []
  const accounts: { request: APIRequestContext, csrfToken: string }[] = []
  const owner = { request: page.request, csrfToken: (await (await page.request.get('/api/auth/session')).json() as { csrfToken: string }).csrfToken }
  const fixture = deploymentImageFixtures.find(row => row.id === 'at-pixels')
  expect(fixture).toBeDefined()
  const bytes = deploymentImageBytes(fixture!)
  interface Outcome { group: string, status: number, code?: string, retry?: string, id?: string, error?: string }
  const outcomes: Outcome[] = []
  const pending: Promise<Outcome>[] = []
  const before = imageContainerMetrics()
  let after: ReturnType<typeof imageContainerMetrics>
  const start = (account: typeof owner, group: string): void => {
    const result = account.request.post('/api/assets', { data: bytes, headers: { 'origin': e2eOrigin(), 'x-csrf-token': account.csrfToken, 'content-type': 'image/png', 'x-asset-extension': 'png' } }).then(async (response): Promise<Outcome> => {
      const body: unknown = await response.json()
      return response.status() === 201
        ? { group, status: 201, id: assetUploadResponseSchema.parse(body).assetId }
        : { group, status: response.status(), code: errorResponseSchema.parse(body).error.code, retry: response.headers()['retry-after'] }
    }).catch((error: unknown): Outcome => ({ group, status: 0, error: error instanceof Error ? error.message : '请求未完成' })).then((outcome) => {
      outcomes.push(outcome)
      return outcome
    })
    pending.push(result)
  }
  try {
    for (let index = 0; index < 4; index++) {
      const credentials = await createUser('image-admission-other')
      const context = await playwright.request.newContext({ baseURL: e2eOrigin(), ignoreHTTPSErrors: true })
      contexts.push(context)
      expect((await context.post('/api/auth/login', { data: { username: credentials.username, password: credentials.password }, headers: { origin: e2eOrigin() } })).status()).toBe(200)
      accounts.push({ request: context, csrfToken: (await (await context.get('/api/auth/session')).json() as { csrfToken: string }).csrfToken })
    }
    await withDatabase(async (client) => {
      await client.query('BEGIN')
      try {
        await client.query('SELECT 1 FROM asset_quota WHERE id=1 FOR UPDATE')
        const blocker = (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid
        start(owner, 'owner')
        await expect.poll(async () => withDatabase(async other => Number((await other.query<{ count: string }>('SELECT count(*) FROM pg_stat_activity WHERE application_name=\'nerve-office-api\' AND $1=ANY(pg_blocking_pids(pid))', [blocker])).rows[0]?.count)), { timeout: 15_000 }).toBe(1)
        // 第一份确实在执行中，接下来本人只容纳一份等待，四份立即繁忙。
        for (let index = 0; index < 5; index++)
          start(owner, 'owner')
        await expect.poll(() => outcomes.filter(row => row.group === 'owner' && row.status === 503).length).toBe(4)
        // 已有一份本人等待，其他四人只容纳三份，达到全局四份等待上限。
        for (const account of accounts)
          start(account, 'other')
        await expect.poll(() => outcomes.filter(row => row.group === 'other' && row.status === 503).length).toBe(1)
        expect(outcomes.every(row => row.status === 503 && row.code === 'ASSET_BUSY' && row.retry === '10')).toBe(true)
        expect((await page.request.get('/api/health/live')).status()).toBe(200)
      }
      finally {
        await client.query('ROLLBACK')
        await Promise.all(pending)
      }
    })
    expect(outcomes).toHaveLength(10)
    expect(outcomes.filter(row => row.status === 201)).toHaveLength(5)
    expect(outcomes.filter(row => row.status === 503)).toHaveLength(5)
    expect(outcomes.filter(row => row.group === 'owner' && row.status === 201)).toHaveLength(2)
    expect(new Set(outcomes.flatMap(row => row.id === undefined ? [] : [row.id])).size).toBe(5)
    expect((await uploadAsset(page, 'minimum.png')).width).toBe(1)
    after = imageContainerMetrics()
    expectHealthyImageContainer(after)
  }
  finally {
    await Promise.all(contexts.map(async context => context.dispose()))
    await testInfo.attach('image-admission-and-container-budget', { body: Buffer.from(JSON.stringify({ before, after, outcomes }, null, 2)), contentType: 'application/json' })
  }
})

test('图片持久化：真实保存引用后强制重启（容器模式另重建），正文、关系和图片字节均保持', async ({ page, request }, testInfo) => {
  await loginThroughApi(page, await createUser('image-restart'))
  await page.goto('/')
  const image = await uploadAsset(page)
  const documentId = await createSheetThroughApi(page)
  const original = (await savedContent(page, documentId)).snapshot
  await saveAssetSnapshot(page, documentId, JSON.stringify({ ...original, extra: { image: image.url } }))
  // 去掉上传者 24 小时临时可读窗口；重开后必须由真实当前引用授权。
  await withDatabase(async client => client.query('UPDATE assets SET created_at=now()-interval \'25 hours\' WHERE id=$1', [image.assetId]))
  const confirmed = await savedContent(page, documentId)
  const read = await renderAsset(page, image.url)
  await expectAssetHeaders(read.response, 200, image.mimeType)
  const metadata = async () => withDatabase(async client => (await client.query<{ id: string, object_hash: string, storage_key: string, bytes: number, width: number, height: number, frames: number, document_id: string }>('SELECT a.id,a.object_hash,o.storage_key,o.bytes,o.width,o.height,o.frames,l.document_id FROM assets a JOIN asset_objects o ON o.sha256=a.object_hash JOIN document_asset_links l ON l.asset_id=a.id WHERE a.id=$1 AND l.document_id=$2', [image.assetId, documentId])).rows)
  const before = await metadata()
  expect(before).toHaveLength(1)
  const metricsBefore = imageContainerMetrics()
  await restartApi(request, { recreateContainer: true })
  const reopened = await savedContent(page, documentId)
  expect({ text: reopened.text, revision: reopened.revision }).toEqual({ text: confirmed.text, revision: confirmed.revision })
  expect(await metadata()).toEqual(before)
  const after = await renderAsset(page, image.url)
  await expectAssetHeaders(after.response, 200, image.mimeType)
  expect(after.body).toEqual(read.body)
  expect({ width: after.width, height: after.height }).toEqual({ width: image.width, height: image.height })
  // 匿名不能从鉴权地址或对象键直达文件；Web 根没有静态旁路。
  expect((await request.get(image.url)).status()).toBe(401)
  const storageKey: unknown = before[0]?.storage_key
  expect(typeof storageKey).toBe('string')
  for (const path of [`/assets/${String(storageKey)}`, `/var/lib/nerve-office/assets/${String(storageKey)}`]) {
    const response = await request.get(path)
    expect(response.headers()['content-type']).not.toBe(image.mimeType)
    expect(await response.body()).not.toEqual(read.body)
  }
  await testInfo.attach('image-restart-persistence', { body: Buffer.from(JSON.stringify({ documentId, assetId: image.assetId, sha256: createHash('sha256').update(read.body).digest('hex'), revision: reopened.revision, metricsBefore, metricsAfter: imageContainerMetrics() }, null, 2)), contentType: 'application/json' })
})

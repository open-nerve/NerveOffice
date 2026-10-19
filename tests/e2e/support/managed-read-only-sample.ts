import type { TestUser } from './database.ts'
import { Buffer } from 'node:buffer'
import { assetUploadResponseSchema } from '@nerve-office/contracts'
import { request } from '@playwright/test'
import { saveAssetSnapshot } from './asset-protocol.ts'
import { e2eOrigin } from './environment.ts'
import { expect } from './fixtures.ts'
import { loginThroughApi } from './session.ts'

/** 只重写已上传的两张自制样本图；保留位置、尺寸、键序及其他正文。 */
function replaceSources(value: unknown, sources: ReadonlyMap<string, string>): void {
  if (typeof value !== 'object' || value === null)
    return
  const record = value as Record<string, unknown>
  const source = typeof record.source === 'string' ? sources.get(record.source) : undefined
  if (source !== undefined) {
    record.source = source
    record.imageSourceType = 'URL'
  }
  for (const child of Object.values(record))
    replaceSources(child, sources)
}

/**
 * M5 的正常编辑对照必须使用受管图片。历史 data: 夹具仍保留给旧格式反例；
 * 此处经真实上传/保存建立引用，使查看者也能读取，不能把占位图当作可编辑图片。
 */
export async function materializeReadOnlyImages(author: TestUser, documentId: string, snapshot: string): Promise<1 | 2> {
  const originals = [...new Set(snapshot.match(/data:image\/png;base64,[A-Z0-9+/=]+/gi) ?? [])]
  if (originals.length === 0)
    return 1
  const context = await request.newContext({ baseURL: e2eOrigin() })
  const session = { request: context }
  try {
    await loginThroughApi(session, author)
    const { csrfToken } = await (await context.get('/api/auth/session')).json() as { csrfToken: string }
    const sources = new Map<string, string>()
    for (const source of originals) {
      const response = await context.post('/api/assets', {
        data: Buffer.from(source.slice('data:image/png;base64,'.length), 'base64'),
        headers: { 'origin': e2eOrigin(), 'x-csrf-token': csrfToken, 'content-type': 'image/png', 'X-Asset-Extension': 'png' },
      })
      expect(response.status(), await response.text()).toBe(201)
      sources.set(source, assetUploadResponseSchema.parse(await response.json()).url)
    }
    const workbook = JSON.parse(snapshot) as { resources: { name: string, data: string }[] }
    replaceSources(workbook, sources)
    for (const resource of workbook.resources) {
      if (resource.name === 'SHEET_DRAWING_PLUGIN') {
        const drawings: unknown = JSON.parse(resource.data)
        replaceSources(drawings, sources)
        resource.data = JSON.stringify(drawings)
      }
    }
    const managed = JSON.stringify(workbook)
    expect(managed).not.toContain('data:image/')
    await saveAssetSnapshot(session, documentId, managed)
    return 2
  }
  finally {
    await context.dispose()
  }
}

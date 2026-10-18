import { describe, expect, it } from 'vitest'
import { isPlatformAssetAddress } from '../documents/asset-address.ts'
import { errorStatus } from '../errors/error-codes.ts'
import { assetExtensionSchema, assetIdSchema, assetInvalidDetailsSchema, assetQuotaDetailsSchema, assetUploadResponseSchema, assetUrl } from './assets.ts'

const ID = '0192d4c3-7a1b-7c2d-8e3f-0123456789ab'
const response = { assetId: ID, url: `/api/assets/${ID}`, mimeType: 'image/png', width: 8, height: 6, bytes: 120 }

describe('图片上传契约', () => {
  it.each(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])('四种正式输出 %s，响应丢弃未来字段', (mimeType) => {
    expect(assetUploadResponseSchema.parse({ ...response, mimeType, future: true })).toEqual({ ...response, mimeType })
  })
  it('响应地址只指向返回的 assetId', () => {
    for (const url of ['https://docs.example.com/a.png', `${response.url}?v=1`, '/api/assets/0192d4c3-7a1b-7c2d-8e3f-0123456789ac'])
      expect(assetUploadResponseSchema.safeParse({ ...response, url }).success, url).toBe(false)
  })
  it.each([
    { assetId: ID.toUpperCase() },
    { assetId: 'not-an-id' },
    { mimeType: 'image/svg+xml' },
    { width: 0 },
    { height: -1 },
    { width: 1.5 },
    { width: 8193 },
    { width: 4001, height: 4000 },
    { bytes: 0 },
    { bytes: 5 * 1024 * 1024 + 1 },
    { bytes: 1.5 },
  ])('拒绝不可能的成功响应 %j', (patch) => {
    expect(assetUploadResponseSchema.safeParse({ ...response, ...patch }).success).toBe(false)
  })
  it('ID 输入规范化，生成的地址与既有平台规则一致', () => {
    expect(assetIdSchema.parse(ID.toUpperCase())).toBe(ID)
    expect(assetUrl(ID.toUpperCase())).toBe(response.url)
    expect(isPlatformAssetAddress(assetUrl(ID), '')).toBe(true)
    expect(() => assetUrl('../other')).toThrow()
  })
  it.each([['PNG', 'png'], ['JPEG', 'jpeg'], ['jpg', 'jpg'], ['webp', 'webp'], ['gif', 'gif']])('规范化后缀 %s → %s', (input, expected) => {
    expect(assetExtensionSchema.parse(input)).toBe(expected)
  })
  it.each([undefined, null, '', '.png', 'photo.png', '../png', 'png\u0000', ' png', 'svg', 'tif'])('不接收文件名/路径或未知后缀 %j', (value) => {
    expect(assetExtensionSchema.safeParse(value).success).toBe(false)
  })
  it('已知错误详情可识别，未来规则/缺少规则退回通用提示', () => {
    for (const rule of ['type', 'corrupt', 'dimensions', 'pixels', 'frames', 'animation', 'output', 'too-complex'])
      expect(assetInvalidDetailsSchema.parse({ rule, source: 'discarded' })).toEqual({ rule })
    expect(assetInvalidDetailsSchema.parse({ rule: 'future-rule' })).toEqual({ rule: undefined })
    expect(assetInvalidDetailsSchema.parse({})).toEqual({})
    expect(assetQuotaDetailsSchema.parse({ kind: 'bytes' })).toEqual({ kind: 'bytes' })
    expect(assetQuotaDetailsSchema.parse({ kind: 'count' })).toEqual({ kind: 'count' })
    expect(assetQuotaDetailsSchema.parse({ kind: 'future' })).toEqual({ kind: undefined })
  })
  it('区分输入拒绝、暂时繁忙和配额不足', () => {
    expect(errorStatus('ASSET_INVALID')).toBe(422)
    expect(errorStatus('ASSET_BUSY')).toBe(503)
    expect(errorStatus('ASSET_QUOTA_EXCEEDED')).toBe(409)
  })
})

// 平台的图片地址：IMAGE() 的限制（web）与服务端的图片规则共用（从 web 的 editor/image-function/platform-asset.ts 移来，用例照旧）
import { describe, expect, it } from 'vitest'
import { isPlatformAssetAddress } from './asset-address.ts'

const ORIGIN = 'https://docs.example.com'
const ASSET = '/api/assets/0192d4c3-7a1b-7c2d-8e3f-0123456789ab'

describe('平台的图片地址', () => {
  it.each([
    ASSET,
    `${ORIGIN}${ASSET}`,
  ])('接受 %s', (value) => {
    expect(isPlatformAssetAddress(value, ORIGIN)).toBe(true)
  })

  it.each([
    'https://evil.example/a.png',
    'data:image/png;base64,AAAA',
    'blob:https://docs.example.com/0192d4c3-7a1b-7c2d-8e3f-0123456789ab',
    `${ASSET}?w=1`,
    `${ASSET}#x`,
    `${ASSET}/`,
    `${ASSET}/extra`,
    '/api/assets/0192D4C3-7A1B-7C2D-8E3F-0123456789AB',
    '/api/assets/not-a-uuid',
    '/api/assets/../users',
    `//docs.example.com${ASSET}`,
    `https://docs.example.com.evil.example${ASSET}`,
    `http://docs.example.com${ASSET}`,
    ` ${ASSET}`,
    `${ASSET} `,
    'api/assets/0192d4c3-7a1b-7c2d-8e3f-0123456789ab',
    '',
  ])('拒绝 %j', (value) => {
    expect(isPlatformAssetAddress(value, ORIGIN)).toBe(false)
  })

  it('不透明源与空源没有本站的绝对地址，相对地址照常接受（服务端不传本站的源时只认相对地址）', () => {
    expect(isPlatformAssetAddress(`null${ASSET}`, 'null')).toBe(false)
    expect(isPlatformAssetAddress(`${ORIGIN}${ASSET}`, '')).toBe(false)
    expect(isPlatformAssetAddress(ASSET, 'null')).toBe(true)
    expect(isPlatformAssetAddress(ASSET, '')).toBe(true)
  })
})

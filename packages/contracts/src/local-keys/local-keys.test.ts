import { describe, expect, it } from 'vitest'
import { LOCAL_KEY_BYTES } from './local-key-format.ts'
import { localKeySchema, localKeySummarySchema, localKeyVersionSchema } from './local-keys.ts'

/** 32 字节（0x0b、0x30、0x55……）的标准 base64：任意取的测试值，不是任何环境的密钥 */
const KEY = 'CzBVep/E6Q4zWH2ix+wRNluApcrvFDleg6jN8hc8YYY='
const AT = '2026-10-08T03:00:00.000Z'

describe('本机密钥的契约（M3-P6 设计 §3.5）', () => {
  it('取用的响应：版本与 32 字节的标准 base64；多出的字段被丢弃', () => {
    expect(LOCAL_KEY_BYTES).toBe(32)
    expect(localKeySchema.parse({ version: 1, key: KEY })).toEqual({ version: 1, key: KEY })
    expect(localKeySchema.parse({ version: 3, key: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=', wrappedKey: 'x' })).toEqual({ version: 3, key: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' })
  })

  it.each([
    ['31 字节', 'BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBw=='],
    ['33 字节', 'BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcH'],
    ['缺填充', KEY.slice(0, -1)],
    ['base64url 的写法', KEY.replace('/', '_').replace('+', '-')],
    ['非规范的尾位（第 43 个字符的低 2 位不是 0）', `${KEY.slice(0, 42)}Z=`],
    ['首尾空白', ` ${KEY}`],
    ['十六进制', '0b30557a9fc4e90e33587da2c7ec11365b80a5caef14395e83a8cdf2173c6186'],
    ['空', ''],
  ])('取用的响应：密钥不是 32 字节的规范 base64 时拒绝（%s）', (_case, key) => {
    expect(localKeySchema.safeParse({ version: 1, key }).success).toBe(false)
  })

  it('版本从 1 起的整数：0、负数、小数与文本都拒绝；两项都要', () => {
    expect(localKeyVersionSchema.parse(1)).toBe(1)
    for (const version of [0, -1, 1.5, '1'])
      expect(localKeySchema.safeParse({ version, key: KEY }).success, String(version)).toBe(false)
    expect(localKeySchema.safeParse({ key: KEY }).success).toBe(false)
    expect(localKeySchema.safeParse({ version: 1 }).success).toBe(false)
  })

  it('管理界面的摘要：只有版本与生成的时刻，密钥材料即使混进来也被丢弃', () => {
    expect(localKeySummarySchema.parse({ version: 2, createdAt: AT, key: KEY, wrappedKey: 'x', masterKeyId: 'y' })).toEqual({ version: 2, createdAt: AT })
    expect(localKeySummarySchema.safeParse({ version: 0, createdAt: AT }).success).toBe(false)
    expect(localKeySummarySchema.safeParse({ version: 2, createdAt: '昨天' }).success).toBe(false)
    expect(localKeySummarySchema.safeParse({ version: 2 }).success).toBe(false)
  })
})

import { inspect } from 'node:util'
import { describe, expect, it } from 'vitest'
import { REDACTED, Secret } from './secret.ts'

describe('Secret', () => {
  const secret = new Secret('postgres://nerve:s3cret@db/app')

  it('只有 reveal() 取得出明文', () => {
    expect(secret.reveal()).toBe('postgres://nerve:s3cret@db/app')
  })

  it('转 JSON、转字符串、打印时都是脱敏值', () => {
    expect(JSON.stringify({ database: { url: secret } })).toBe(`{"database":{"url":"${REDACTED}"}}`)
    expect(String(secret)).toBe(REDACTED)
    expect(inspect({ url: secret })).not.toContain('s3cret')
  })
})

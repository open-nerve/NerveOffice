import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { createdPayloadDigest, savedPayloadDigest } from './payload-digest.ts'

describe('负载摘要', () => {
  it('新建：sha256("created\\n" + 类型 + "\\n" + 标题)', () => {
    expect(createdPayloadDigest('sheet', '周报')).toEqual(createHash('sha256').update('created\nsheet\n周报').digest())
    expect(createdPayloadDigest('sheet', '周报')).toHaveLength(32)
  })

  it('保存：sha256("saved\\n" + 基准修订号 + "\\n" + 解压后的字节)', () => {
    const raw = Buffer.from('{"id":"u"}', 'utf8')
    expect(savedPayloadDigest(3, raw)).toEqual(createHash('sha256').update('saved\n3\n{"id":"u"}').digest())
  })

  it('负载的任何一项不同，摘要就不同', () => {
    const raw = Buffer.from('{"id":"u"}', 'utf8')
    expect(savedPayloadDigest(3, raw)).not.toEqual(savedPayloadDigest(4, raw))
    expect(savedPayloadDigest(3, raw)).not.toEqual(savedPayloadDigest(3, Buffer.from('{"id":"v"}', 'utf8')))
    expect(createdPayloadDigest('sheet', '周报')).not.toEqual(createdPayloadDigest('sheet', '周报 '))
  })

  it('新建与保存的摘要不会相同（以种类开头）', () => {
    expect(createdPayloadDigest('sheet', '')).not.toEqual(savedPayloadDigest(1, Buffer.alloc(0)))
  })
})

import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { createdPayloadDigest, savedPayloadDigest } from './payload-digest.ts'

describe('负载摘要', () => {
  it('新建：sha256("created\\n" + 类型 + "\\n" + 标题)', () => {
    expect(createdPayloadDigest('sheet', '周报')).toEqual(createHash('sha256').update('created\nsheet\n周报').digest())
    expect(createdPayloadDigest('sheet', '周报')).toHaveLength(32)
  })

  it('新建到指定的空间：末尾加上空间 id（按小写计）；没有指定时与 M1 相同', () => {
    const spaceId = '0199A2C4-1F2E-7A3B-8C4D-5E6F7A8B9C0E'
    expect(createdPayloadDigest('sheet', '周报', spaceId)).toEqual(createHash('sha256').update(`created\nsheet\n周报\n${spaceId.toLowerCase()}`).digest())
    expect(createdPayloadDigest('sheet', '周报', spaceId)).toEqual(createdPayloadDigest('sheet', '周报', spaceId.toLowerCase()))
    expect(createdPayloadDigest('sheet', '周报', undefined)).toEqual(createdPayloadDigest('sheet', '周报'))
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

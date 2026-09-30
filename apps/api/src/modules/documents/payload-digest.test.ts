import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { createdPayloadDigest, savedPayloadDigest } from './payload-digest.ts'

describe('负载摘要', () => {
  it('新建：sha256("created\\n" + 类型 + "\\n" + 标题)', () => {
    expect(createdPayloadDigest('sheet', '周报')).toEqual(createHash('sha256').update('created\nsheet\n周报').digest())
    expect(createdPayloadDigest('sheet', '周报')).toHaveLength(32)
  })

  it('新建到指定的空间：末尾加上空间 id；没有指定时与 M1 相同', () => {
    const spaceId = '0199a2c4-1f2e-7a3b-8c4d-5e6f7a8b9c0e'
    expect(createdPayloadDigest('sheet', '周报', spaceId)).toEqual(createHash('sha256').update(`created\nsheet\n周报\n${spaceId}`).digest())
    expect(createdPayloadDigest('sheet', '周报', undefined)).toEqual(createdPayloadDigest('sheet', '周报'))
  })

  it('新建到指定的文件夹：末尾再加上文件夹 id；没有指定空间时空间那一段留空，与只指定空间分得开', () => {
    const spaceId = '0199a2c4-1f2e-7a3b-8c4d-5e6f7a8b9c0e'
    const folderId = '0199a2c4-1f2e-7a3b-8c4d-5e6f7a8b9c0f'
    expect(createdPayloadDigest('sheet', '周报', spaceId, folderId)).toEqual(createHash('sha256').update(`created\nsheet\n周报\n${spaceId}\n${folderId}`).digest())
    expect(createdPayloadDigest('sheet', '周报', undefined, folderId)).toEqual(createHash('sha256').update(`created\nsheet\n周报\n\n${folderId}`).digest())
    // 位置的四种组合两两不同：同一个 requestId 换了位置就不是同一个请求
    const digests = [
      createdPayloadDigest('sheet', '周报'),
      createdPayloadDigest('sheet', '周报', spaceId),
      createdPayloadDigest('sheet', '周报', undefined, folderId),
      createdPayloadDigest('sheet', '周报', spaceId, folderId),
    ]
    expect(new Set(digests.map(digest => digest.toString('hex'))).size).toBe(4)
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

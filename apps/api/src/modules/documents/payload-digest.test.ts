import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { conflictCopyPayloadDigest, copiedPayloadDigest, createdPayloadDigest, folderCreatedPayloadDigest, savedPayloadDigest } from './payload-digest.ts'

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

  it('保存的"公式待更新"（M3-P3 设计 §3.8）：有标记时开头一行是 saved-formulas-pending；没有标记时与 P3 之前的写法逐字节相同（旧页面在升级之后重试照样是重放）', () => {
    const raw = Buffer.from('{"id":"u"}', 'utf8')
    expect(savedPayloadDigest(3, raw, true)).toEqual(createHash('sha256').update('saved-formulas-pending\n3\n{"id":"u"}').digest())
    expect(savedPayloadDigest(3, raw, false)).toEqual(savedPayloadDigest(3, raw))
    expect(savedPayloadDigest(3, raw, true)).not.toEqual(savedPayloadDigest(3, raw))
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

  it('新建文件夹（M2 Codex 评审 CX6）：sha256("folder-created\\n" + 空间 + "\\n" + 父文件夹（没有时留空）+ "\\n" + 名称)，与迁移 0021 回填的写法相同', () => {
    const spaceId = '0199a2c4-1f2e-7a3b-8c4d-5e6f7a8b9c0e'
    const parentId = '0199a2c4-1f2e-7a3b-8c4d-5e6f7a8b9c0f'
    expect(folderCreatedPayloadDigest(spaceId, parentId, '资料 甲')).toEqual(createHash('sha256').update(`folder-created\n${spaceId}\n${parentId}\n资料 甲`, 'utf8').digest())
    expect(folderCreatedPayloadDigest(spaceId, undefined, '资料')).toEqual(createHash('sha256').update(`folder-created\n${spaceId}\n\n资料`, 'utf8').digest())
    // 每一项都算数：换了空间、父文件夹、名称就不是同一个请求；与新建文档的摘要也分得开
    const digests = [
      folderCreatedPayloadDigest(spaceId, undefined, '资料'),
      folderCreatedPayloadDigest(spaceId, parentId, '资料'),
      folderCreatedPayloadDigest(parentId, undefined, '资料'),
      folderCreatedPayloadDigest(spaceId, undefined, '资料2'),
      createdPayloadDigest('sheet', '资料', spaceId),
    ]
    expect(new Set(digests.map(digest => digest.toString('hex'))).size).toBe(digests.length)
  })

  it('另存为副本（M3-P2）：sha256("conflict-copied\\n" + 原文档 + "\\n" + 标题 + "\\n" + 解压后的字节)；放在哪里不算进来', () => {
    const sourceId = '0199a2c4-1f2e-7a3b-8c4d-5e6f7a8b9c0e'
    const raw = Buffer.from('{"id":"u"}', 'utf8')
    expect(conflictCopyPayloadDigest(sourceId, '周报（冲突副本 2026-10-04 14:30）', raw))
      .toEqual(createHash('sha256').update(`conflict-copied\n${sourceId}\n周报（冲突副本 2026-10-04 14:30）\n{"id":"u"}`, 'utf8').digest())
    // 原文档、标题、内容任何一项不同就不是同一个请求；与保存同样的字节、与复制同样的源与标题都分得开
    const digests = [
      conflictCopyPayloadDigest(sourceId, '周报', raw),
      conflictCopyPayloadDigest('0199a2c4-1f2e-7a3b-8c4d-5e6f7a8b9c0f', '周报', raw),
      conflictCopyPayloadDigest(sourceId, '月报', raw),
      conflictCopyPayloadDigest(sourceId, '周报', Buffer.from('{"id":"v"}', 'utf8')),
      savedPayloadDigest(1, raw),
      copiedPayloadDigest(sourceId, sourceId, undefined, '周报'),
      // "公式待更新"不同也是另一个请求（M3-P3 设计 §3.8）
      conflictCopyPayloadDigest(sourceId, '周报', raw, true),
    ]
    expect(new Set(digests.map(digest => digest.toString('hex'))).size).toBe(digests.length)
    expect(conflictCopyPayloadDigest(sourceId, '周报', raw, true))
      .toEqual(createHash('sha256').update(`conflict-copied-formulas-pending\n${sourceId}\n周报\n{"id":"u"}`, 'utf8').digest())
    expect(conflictCopyPayloadDigest(sourceId, '周报', raw, false)).toEqual(conflictCopyPayloadDigest(sourceId, '周报', raw))
  })
})

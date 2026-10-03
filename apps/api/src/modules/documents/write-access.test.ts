// 收回写入权的范围（M2-P2 设计 §3.7，M2-P5 设计 §3.4(3)）：每种范围涉及谁、哪些文档，逐种核对。
// 接上租约的实现（结束谁的租约、代次加一）在 lease-write-access.test.ts。
import type { DocumentWriter, WriteAccessScope } from './write-access.ts'
import { describe, expect, it } from 'vitest'
import { coversWriter } from './write-access.ts'

const AMY = '0199a2c4-0000-7000-8000-00000000000a'
const BEN = '0199a2c4-0000-7000-8000-00000000000b'
const SPACE = '0199a2c4-0000-7000-8000-0000000000c1'
const OTHER_SPACE = '0199a2c4-0000-7000-8000-0000000000c2'
const SHARED = '0199a2c4-0000-7000-8000-0000000000d1'
const ALSO_SHARED = '0199a2c4-0000-7000-8000-0000000000d2'
const ELSEWHERE = '0199a2c4-0000-7000-8000-0000000000d3'

/** 两个人 × 三份文档：前两份在 SPACE，第三份在 OTHER_SPACE */
const WRITERS: readonly DocumentWriter[] = [AMY, BEN].flatMap(userId => [
  { userId, documentId: SHARED, spaceId: SPACE },
  { userId, documentId: ALSO_SHARED, spaceId: SPACE },
  { userId, documentId: ELSEWHERE, spaceId: OTHER_SPACE },
])

/** 范围涉及的写入，写成"人/文档"，便于逐个比较 */
function covered(scope: WriteAccessScope): string[] {
  const name = (id: string): string => ({ [AMY]: 'amy', [BEN]: 'ben', [SHARED]: 'shared', [ALSO_SHARED]: 'also', [ELSEWHERE]: 'elsewhere' })[id] ?? id
  return WRITERS.filter(writer => coversWriter(scope, writer)).map(writer => `${name(writer.userId)}/${name(writer.documentId)}`)
}

describe('收回写入权的范围：涉及谁、哪些文档（各种范围的含义只在 coversWriter 一处）', () => {
  it('userDocuments（取消或降低单独授权，M2-P5）：只有这个人在这些文档上的写入，别人在同样这些文档上的不涉及', () => {
    expect(covered({ kind: 'userDocuments', userId: BEN, documentIds: [SHARED] })).toEqual(['ben/shared'])
    expect(covered({ kind: 'userDocuments', userId: BEN, documentIds: [SHARED, ALSO_SHARED] })).toEqual(['ben/shared', 'ben/also'])
    expect(covered({ kind: 'userDocuments', userId: AMY, documentIds: [ELSEWHERE] })).toEqual(['amy/elsewhere'])
    expect(covered({ kind: 'userDocuments', userId: BEN, documentIds: [] })).toEqual([])
  })

  it('documents（跨空间移动、删除、转移）：这些文档上的所有人——所以不能拿它来取消一个人的授权', () => {
    expect(covered({ kind: 'documents', documentIds: [SHARED] })).toEqual(['amy/shared', 'ben/shared'])
    expect(covered({ kind: 'documents', documentIds: [SHARED] })).not.toEqual(covered({ kind: 'userDocuments', userId: BEN, documentIds: [SHARED] }))
  })

  it('原有的四种范围的含义不变：某人（停用）、某人在某个空间（移出、调整角色）、整个空间（归档）、这些文档上的所有人', () => {
    expect(covered({ kind: 'user', userId: BEN })).toEqual(['ben/shared', 'ben/also', 'ben/elsewhere'])
    expect(covered({ kind: 'membership', userId: BEN, spaceId: SPACE })).toEqual(['ben/shared', 'ben/also'])
    expect(covered({ kind: 'space', spaceId: SPACE })).toEqual(['amy/shared', 'amy/also', 'ben/shared', 'ben/also'])
    expect(covered({ kind: 'documents', documentIds: [SHARED, ELSEWHERE] })).toEqual(['amy/shared', 'amy/elsewhere', 'ben/shared', 'ben/elsewhere'])
  })
})

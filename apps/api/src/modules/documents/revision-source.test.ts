// 一次修订的来源给谁看（M3-P1 复验 C4）：只给保存它的那个人本人。申请的响应与修订号冲突的详情都经它，各自的用例在
// edit-lease.service.test.ts、document-content.service.test.ts 与集成测试（documents/edit-leases.test.ts）。
import type { RevisionRow } from './document-revisions.repository.ts'
import { Buffer } from 'node:buffer'
import { describe, expect, it } from 'vitest'
import { revisionSourceFor } from './revision-source.ts'

const AMY = '0199a2c4-0000-7000-8000-00000000000a'
const BEN = '0199a2c4-0000-7000-8000-00000000000b'
const TAB = '0199a2c4-0000-7000-8000-0000000000f1'

function revision(overrides: Partial<RevisionRow> = {}): RevisionRow {
  return {
    documentId: '0199a2c4-0000-7000-8000-0000000000d1',
    revision: 4,
    kind: 'saved',
    payloadDigest: Buffer.alloc(32),
    savedBy: AMY,
    createdAt: new Date('2026-10-04T08:00:00.000Z'),
    source: { clientInstanceId: TAB, localSeq: 3 },
    ...overrides,
  }
}

describe('revisionSourceFor', () => {
  it('保存它的人本人：给出来源（不论他现在用的是哪个标签页，页面再按标签页比较）', () => {
    expect(revisionSourceFor(revision(), AMY)).toEqual({ clientInstanceId: TAB, localSeq: 3 })
  })

  it('别人：null（标签页标识是页面自报的，给了别人就能被照着伪造）', () => {
    expect(revisionSourceFor(revision(), BEN)).toBeNull()
  })

  it('没有这一条修订记录、新建出来的（没有来源）：null', () => {
    expect(revisionSourceFor(undefined, AMY)).toBeNull()
    expect(revisionSourceFor(revision({ kind: 'created', source: null }), AMY)).toBeNull()
  })
})

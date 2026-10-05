import type { RevisionRow } from './document-revisions.repository.ts'
import type { ReceiptRow } from './document-save-receipts.repository.ts'
import { Buffer } from 'node:buffer'
import { describe, expect, it } from 'vitest'
import { replayedSave } from './save-outcomes.ts'

const DOCUMENT = '0199a2c4-0000-7000-8000-0000000000d1'
const OTHER_DOCUMENT = '0199a2c4-0000-7000-8000-0000000000d2'
const AMY = '0199a2c4-0000-7000-8000-00000000000a'
const BEN = '0199a2c4-0000-7000-8000-00000000000b'
const DIGEST = Buffer.alloc(32, 1)
const AT = new Date('2026-10-05T08:00:00.000Z')

const REVISION: RevisionRow = { documentId: DOCUMENT, revision: 4, kind: 'saved', payloadDigest: DIGEST, savedBy: AMY, createdAt: AT, source: { clientInstanceId: 'tab', localSeq: 3 } }
const RECEIPT: ReceiptRow = { requestId: 'r', documentId: DOCUMENT, revision: 6, payloadDigest: DIGEST, savedBy: AMY, savedAt: AT }

describe('保存的 requestId 幂等（M3-P3 设计 §3.7）', () => {
  it('修订记录：同一个人对同一份文档的同一次保存（摘要一致）给出原来的结果，修订号增加了', () => {
    expect(replayedSave({ revision: REVISION, receipt: undefined }, AMY, DOCUMENT, DIGEST)).toEqual({ revision: 4, savedAt: AT.toISOString(), unchanged: false })
  })

  it('回执：给出原来的确认（当时的当前修订与它的时间），unchanged 为真', () => {
    expect(replayedSave({ revision: undefined, receipt: RECEIPT }, AMY, DOCUMENT, DIGEST)).toEqual({ revision: 6, savedAt: AT.toISOString(), unchanged: true })
  })

  it('别人的、别的文档的、摘要不同的、新建（种类不是保存）的：不是这一次，没有结果', () => {
    const other = Buffer.alloc(32, 2)
    for (const recorded of [
      { revision: REVISION, receipt: undefined },
      { revision: undefined, receipt: RECEIPT },
    ]) {
      expect(replayedSave(recorded, BEN, DOCUMENT, DIGEST)).toBeUndefined()
      expect(replayedSave(recorded, AMY, OTHER_DOCUMENT, DIGEST)).toBeUndefined()
      expect(replayedSave(recorded, AMY, DOCUMENT, other)).toBeUndefined()
    }
    expect(replayedSave({ revision: { ...REVISION, kind: 'created' }, receipt: undefined }, AMY, DOCUMENT, DIGEST)).toBeUndefined()
  })
})

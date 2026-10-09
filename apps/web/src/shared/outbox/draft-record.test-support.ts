// 发件箱记录的样例（单元测试共用）：字段齐全、每一项都是合法的值，用例按需覆盖其中几项
import type { DraftMeta, StoredDraft, WriterRecord } from './draft-record.ts'
import { DRAFT_RECORD_VERSION } from './draft-record.ts'

export const USER_ID = '0199b0c4-7d3e-7a3b-9c4e-2f1a5b6c7d8e'
export const OTHER_USER_ID = '0199b0c4-7d3e-7a3b-9c4e-2f1a5b6c7d8f'
export const DOCUMENT_ID = '0199b0c4-7d3e-7a3b-9c4e-00000000d0c1'
export const WRITER_ID = '6f1c2a3b-4d5e-4f60-8172-8394a5b6c7d8'
export const OTHER_WRITER_ID = '6f1c2a3b-4d5e-4f60-8172-8394a5b6c7d9'
export const CLIENT_INSTANCE_ID = '0199b0c4-7d3e-7a3b-9c4e-0000000c1e01'

/** 2026-10-09T08:00:00.000Z */
export const NOW = Date.UTC(2026, 9, 9, 8, 0, 0)

export function sampleMeta(overrides: Partial<DraftMeta> = {}): DraftMeta {
  return {
    userId: USER_ID,
    documentId: DOCUMENT_ID,
    recordVersion: DRAFT_RECORD_VERSION,
    draftSeq: 7,
    baseRevision: 12,
    writeEpoch: 3,
    writerId: WRITER_ID,
    writtenBy: CLIENT_INSTANCE_ID,
    format: { clientBuild: '0.1.0+abc1234', univerVersion: '0.12.4', profile: 'sheet-v1', formatVersion: 1 },
    formulasPending: false,
    keyVersion: 2,
    inFlight: { requestId: '0199b0c4-7d3e-7a3b-9c4e-0000000e0001', clientInstanceId: CLIENT_INSTANCE_ID, localSeq: 7, sentAt: NOW - 1_000 },
    rawBytes: 4_096,
    updatedAt: NOW,
    ...overrides,
  }
}

/** 12 字节的 IV 与 17 字节的"密文"（形状合法即可，解不开） */
export function sampleStoredDraft(overrides: Partial<StoredDraft> = {}): StoredDraft {
  return {
    ...sampleMeta(),
    iv: new Uint8Array(12).fill(0xA0),
    ciphertext: new Uint8Array(17).fill(0x5C),
    ...overrides,
  }
}

export function sampleWriter(overrides: Partial<WriterRecord> = {}): WriterRecord {
  return {
    userId: USER_ID,
    documentId: DOCUMENT_ID,
    writeEpoch: 3,
    writerId: WRITER_ID,
    lastDraftSeq: 7,
    registeredAt: NOW - 60_000,
    ...overrides,
  }
}

/**
 * 每个明文字段（含 format 与 inFlight 的每一项）各改一处得到的元数据，label 是字段的路径：AAD 的"任何一项改动都不同"与
 * 编解码的"逐个字段改动之后解不开"共用（用例另核对它覆盖了字段表的每一项）
 */
export function metaVariants(base: DraftMeta): readonly { readonly label: string, readonly meta: DraftMeta }[] {
  const inFlight = base.inFlight
  if (inFlight === null)
    throw new Error('样例要带在途的保存')
  return [
    { label: 'userId', meta: { ...base, userId: `${base.userId}0` } },
    { label: 'documentId', meta: { ...base, documentId: `${base.documentId}0` } },
    { label: 'recordVersion', meta: { ...base, recordVersion: base.recordVersion + 1 } },
    { label: 'draftSeq', meta: { ...base, draftSeq: base.draftSeq + 1 } },
    { label: 'baseRevision', meta: { ...base, baseRevision: base.baseRevision + 1 } },
    { label: 'writeEpoch', meta: { ...base, writeEpoch: base.writeEpoch + 1 } },
    { label: 'writerId', meta: { ...base, writerId: `${base.writerId}0` } },
    { label: 'writtenBy', meta: { ...base, writtenBy: `${base.writtenBy}0` } },
    { label: 'format.clientBuild', meta: { ...base, format: { ...base.format, clientBuild: '0.1.1' } } },
    { label: 'format.univerVersion', meta: { ...base, format: { ...base.format, univerVersion: '0.12.5' } } },
    { label: 'format.profile', meta: { ...base, format: { ...base.format, profile: 'sheet-v2' } } },
    { label: 'format.formatVersion', meta: { ...base, format: { ...base.format, formatVersion: base.format.formatVersion + 1 } } },
    { label: 'formulasPending', meta: { ...base, formulasPending: !base.formulasPending } },
    { label: 'keyVersion', meta: { ...base, keyVersion: base.keyVersion + 1 } },
    { label: 'keyVersion', meta: { ...base, keyVersion: base.keyVersion - 1 } },
    { label: 'inFlight', meta: { ...base, inFlight: null } },
    { label: 'inFlight.requestId', meta: { ...base, inFlight: { ...inFlight, requestId: `${inFlight.requestId}0` } } },
    { label: 'inFlight.clientInstanceId', meta: { ...base, inFlight: { ...inFlight, clientInstanceId: `${inFlight.clientInstanceId}0` } } },
    { label: 'inFlight.localSeq', meta: { ...base, inFlight: { ...inFlight, localSeq: inFlight.localSeq + 1 } } },
    { label: 'inFlight.sentAt', meta: { ...base, inFlight: { ...inFlight, sentAt: inFlight.sentAt + 1 } } },
    { label: 'rawBytes', meta: { ...base, rawBytes: base.rawBytes + 1 } },
    { label: 'updatedAt', meta: { ...base, updatedAt: base.updatedAt + 1 } },
  ]
}

import type { DocumentHistoryDetail, SessionResponse } from '@nerve-office/contracts'
import { UNIVER_SDK_VERSION } from '@nerve-office/contracts'

export const HISTORY_DOCUMENT_ID = '0199a2c4-0000-7000-8000-0000000000d1'
export const HISTORY_SESSION: SessionResponse = {
  user: { id: '0199a2c4-0000-7000-8000-00000000000a', username: 'amy', displayName: '艾米', systemRole: 'member' },
  personalSpace: { id: '0199a2c4-0000-7000-8000-0000000000a1', name: '艾米' },
  csrfToken: 'csrf-history',
  features: { localDraftsEnabled: true },
}
export function historyItem(patch: Partial<DocumentHistoryDetail> = {}): DocumentHistoryDetail {
  return {
    id: '0199a2c4-0000-7000-8000-0000000000e1',
    title: '历史周报',
    type: 'sheet',
    revision: 2,
    savedAt: '2026-10-22T08:00:00.000Z',
    createdAt: '2026-10-22T08:00:00.000Z',
    expiresAt: '2026-10-29T08:00:00.000Z',
    savedBy: { id: HISTORY_SESSION.user.id, username: 'amy', displayName: '艾米' },
    profile: 'sheet@1',
    formatVersion: 1,
    sdkVersion: UNIVER_SDK_VERSION,
    clientBuild: null,
    formulasPending: false,
    rawBytes: 200,
    storedBytes: 120,
    compatibility: 'supported',
    ...patch,
  }
}

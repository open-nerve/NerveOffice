import type { CreatedDocument, SessionResponse } from '@nerve-office/contracts'
import type { CsvTable } from '../../shared/csv/index.ts'
import { vi } from 'vitest'
import { createCsvCreation } from './csv-create-controller.ts'

export const CSV_CREATOR: SessionResponse = {
  user: { id: '0199a2c4-0000-7000-8000-000000000001', username: 'amy', displayName: '艾米', systemRole: 'member' },
  personalSpace: { id: '0199a2c4-0000-7000-8000-000000000002', name: '艾米' },
  csrfToken: 'csrf-csv-creation',
  features: { localDraftsEnabled: true },
}
export const CSV_CREATED: CreatedDocument = {
  id: '0199a2c4-0000-7000-8000-000000000003',
  title: '未命名表格',
  type: 'sheet',
  createdAt: '2026-11-01T10:00:00.000Z',
  updatedAt: '2026-11-01T10:00:00.000Z',
  spaceId: CSV_CREATOR.personalSpace.id,
  space: { id: CSV_CREATOR.personalSpace.id, type: 'personal' },
  folderId: null,
  accessVia: 'space',
  revision: 1,
  profile: 'sheet@1',
  formatVersion: 1,
  sdkVersion: '1.0.1',
  formulasPending: false,
  replayed: false,
  permissions: { canEdit: true, canViewHistory: true, canClearHistory: true, canRename: true, canMoveWithinSpace: true, canMoveAcrossSpaces: true, canCopy: true, canDelete: true, canShare: true, canTakeOver: true },
}

/** 仅替换网络、页面宿主与浏览器信号；使用真实 parser、候选容量及 requestId ledger。 */
export function csvCreationFixture() {
  const state = { online: true }
  const applied: CsvTable[] = []
  const host = {
    apply: vi.fn(async (table: CsvTable, current: () => boolean) => {
      if (!current())
        return false
      applied.push(table)
      return true
    }),
    dispose: vi.fn(),
  }
  const api = {
    session: vi.fn(async (): Promise<SessionResponse> => CSV_CREATOR),
    access: vi.fn(async () => ({ spaceName: '我的空间' })),
    create: vi.fn(async (): Promise<CreatedDocument> => CSV_CREATED),
    adopt: vi.fn(),
    openCreated: vi.fn(async () => host),
  }
  let sequence = 0
  const controller = createCsvCreation({
    location: { spaceId: CSV_CREATOR.personalSpace.id },
    ...api,
    online: () => state.online,
    newId: () => `0199a2c4-0000-7000-8000-${String(++sequence).padStart(12, '0')}`,
  })
  return { controller, api, host, applied, state }
}

// documents 模块单元测试的假仓储：按内存里的记录实现仓储的接口，事务直接执行。
import type { Buffer } from 'node:buffer'
import type { AuditEvent, AuditService } from '../audit/index.ts'
import type { Transaction, TransactionRunner } from '../database/index.ts'
import type { SpacesService } from '../spaces/index.ts'
import type { AccessTarget, DocumentAccess, DocumentAccessPolicy } from './document-access-policy.ts'
import type { CurrentContent, DocumentContentsRepository, StoredSnapshot } from './document-contents.repository.ts'
import type { DocumentRevisionsRepository, NewRevision, RevisionRow } from './document-revisions.repository.ts'
import type { DocumentRow, DocumentsRepository, NewDocument } from './documents.repository.ts'
import { vi } from 'vitest'

export const ALICE = '0199a2c4-0000-7000-8000-00000000000a'
export const BOB = '0199a2c4-0000-7000-8000-00000000000b'
export const ALICE_SPACE = '0199a2c4-0000-7000-8000-0000000000a1'
export const BOB_SPACE = '0199a2c4-0000-7000-8000-0000000000b1'

const TRANSACTION = { transaction: true } as unknown as Transaction
const NOW = new Date('2026-09-27T08:00:00.000Z')

export class FakeStore {
  readonly documents = new Map<string, DocumentRow>()
  readonly contents = new Map<string, StoredSnapshot>()
  readonly revisions: (RevisionRow & { requestId: string })[] = []
  readonly audits: AuditEvent[] = []
  /** 各用户能访问的空间与权限 */
  readonly access = new Map<string, DocumentAccess>([[`${ALICE}:${ALICE_SPACE}`, 'owner'], [`${BOB}:${BOB_SPACE}`, 'owner']])
  private sequence = 0

  addDocument(overrides: Partial<DocumentRow> = {}): DocumentRow {
    this.sequence += 1
    const id = `0199a2c4-0000-7000-8000-${String(this.sequence).padStart(12, '0')}`
    const row: DocumentRow = { id, spaceId: ALICE_SPACE, type: 'sheet', title: '周报', createdAt: NOW, updatedAt: NOW, position: NOW.toISOString(), revision: 1, unitId: `unit-${id}`, profile: 'sheet@1', formatVersion: 1, ...overrides }
    this.documents.set(id, row)
    return row
  }

  readonly repositories = {
    documents: {
      findById: vi.fn(async (id: string) => this.documents.get(id)),
      lockById: vi.fn(async (id: string) => this.documents.get(id)),
      insert: vi.fn(async (document: NewDocument) => this.addDocument({ ...document, revision: 1 })),
      advanceRevision: vi.fn(async (id: string, revision: number) => {
        const row = this.documents.get(id)
        if (row?.revision !== revision - 1)
          throw new Error('修订号没有前进')
        this.documents.set(id, { ...row, revision })
      }),
    },
    contents: {
      insert: vi.fn(async (documentId: string, content: StoredSnapshot) => {
        this.contents.set(documentId, content)
      }),
      replace: vi.fn(async (documentId: string, content: StoredSnapshot) => {
        if (!this.contents.has(documentId))
          return false
        this.contents.set(documentId, content)
        return true
      }),
      findCurrent: vi.fn(async (documentId: string): Promise<CurrentContent | undefined> => {
        const content = this.contents.get(documentId)
        const document = this.documents.get(documentId)
        return content === undefined || document === undefined ? undefined : { revision: document.revision, snapshot: content.snapshot }
      }),
    },
    revisions: {
      lockCreateRequest: vi.fn(async () => {}),
      findByRequestId: vi.fn(async (requestId: string) => this.revisions.find(revision => revision.requestId === requestId)),
      findByRevision: vi.fn(async (documentId: string, revision: number) => this.revisions.find(row => row.documentId === documentId && row.revision === revision)),
      insert: vi.fn(async (revision: NewRevision): Promise<RevisionRow | undefined> =>
        this.revisions.some(row => row.requestId === revision.requestId) ? undefined : this.addRevision(revision)),
    },
  }

  readonly transactions = { run: vi.fn(async <T>(work: (transaction: Transaction) => Promise<T>) => work(TRANSACTION)) }
  readonly policy = { accessOf: vi.fn(async (userId: string, target: AccessTarget) => this.access.get(`${userId}:${target.spaceId}`)) }
  readonly spaces = { personalSpaceOf: vi.fn(async (userId: string) => ({ id: userId === ALICE ? ALICE_SPACE : BOB_SPACE, name: '个人空间' })) }
  readonly audit = {
    record: vi.fn(async (event: AuditEvent) => {
      this.audits.push(event)
    }),
  }

  get deps() {
    return {
      transactions: this.transactions as unknown as TransactionRunner,
      documents: this.repositories.documents as unknown as DocumentsRepository,
      contents: this.repositories.contents as unknown as DocumentContentsRepository,
      revisions: this.repositories.revisions as unknown as DocumentRevisionsRepository,
      policy: this.policy as unknown as DocumentAccessPolicy,
      spaces: this.spaces as unknown as SpacesService,
      audit: this.audit as unknown as AuditService,
    }
  }

  addRevision(revision: NewRevision & { createdAt?: Date }): RevisionRow {
    const row = { ...revision, createdAt: revision.createdAt ?? NOW }
    this.revisions.push(row)
    return row
  }

  contentOf(documentId: string): Buffer | undefined {
    return this.contents.get(documentId)?.snapshot
  }
}

export const HTTP_ORIGIN = { source: 'http', requestId: 'req-1', clientIp: '127.0.0.1' } as const

// documents 模块单元测试的假仓储：按内存里的记录实现仓储的接口，事务直接执行。
// 访问策略用真实的实现（EffectiveAccessPolicy），它依赖的空间事实由内存里的空间与成员算出：测试覆盖的是真实的权限规则。
import type { SpaceRole, SpaceStatus, SpaceType } from '@nerve-office/contracts'
import type { Buffer } from 'node:buffer'
import type { AuditEvent, AuditService } from '../audit/index.ts'
import type { Transaction, TransactionRunner } from '../database/index.ts'
import type { SpaceFacts, SpacesService } from '../spaces/index.ts'
import type { Actor } from './document-access-policy.ts'
import type { CurrentContent, DocumentContentsRepository, StoredSnapshot } from './document-contents.repository.ts'
import type { DocumentRevisionsRepository, NewRevision, RevisionRow } from './document-revisions.repository.ts'
import type { AccessibleScope, DocumentRow, DocumentsRepository, NewDocument } from './documents.repository.ts'
import { vi } from 'vitest'
import { EffectiveAccessPolicy } from './document-access-policy.ts'

export const ALICE = '0199a2c4-0000-7000-8000-00000000000a'
export const BOB = '0199a2c4-0000-7000-8000-00000000000b'
export const ALICE_SPACE = '0199a2c4-0000-7000-8000-0000000000a1'
export const BOB_SPACE = '0199a2c4-0000-7000-8000-0000000000b1'
/** 团队空间：一开始没有成员，测试按需加 */
export const TEAM_SPACE = '0199a2c4-0000-7000-8000-0000000000c1'

const TRANSACTION = { transaction: true } as unknown as Transaction
const NOW = new Date('2026-09-27T08:00:00.000Z')

/** 普通成员作为调用者 */
export function member(userId: string): Actor {
  return { userId, systemAdmin: false }
}

interface FakeSpace {
  readonly type: SpaceType
  readonly name: string
  status: SpaceStatus
  visibleToAll: boolean
  readonly owner?: string
  readonly members: Map<string, SpaceRole>
}

export class FakeStore {
  readonly documents = new Map<string, DocumentRow>()
  readonly contents = new Map<string, StoredSnapshot>()
  readonly revisions: (RevisionRow & { requestId: string })[] = []
  readonly audits: AuditEvent[] = []
  /** 空间与成员：访问策略据此算出有效权限 */
  readonly spaceRecords = new Map<string, FakeSpace>([
    [ALICE_SPACE, { type: 'personal', name: '爱丽丝', status: 'active', visibleToAll: false, owner: ALICE, members: new Map() }],
    [BOB_SPACE, { type: 'personal', name: '鲍勃', status: 'active', visibleToAll: false, owner: BOB, members: new Map() }],
    [TEAM_SPACE, { type: 'team', name: '市场部', status: 'active', visibleToAll: false, members: new Map() }],
  ])

  private sequence = 0

  addDocument(overrides: Partial<DocumentRow> = {}): DocumentRow {
    this.sequence += 1
    const id = `0199a2c4-0000-7000-8000-${String(this.sequence).padStart(12, '0')}`
    const row: DocumentRow = { id, spaceId: ALICE_SPACE, type: 'sheet', title: '周报', createdAt: NOW, updatedAt: NOW, position: NOW.toISOString(), revision: 1, unitId: `unit-${id}`, profile: 'sheet@1', formatVersion: 1, ...overrides }
    this.documents.set(id, row)
    return row
  }

  /** 团队空间的成员与角色；role 为 undefined 时移出 */
  setMember(spaceId: string, userId: string, role: SpaceRole | undefined): void {
    const space = this.spaceRecords.get(spaceId)
    if (space === undefined)
      throw new Error(`没有空间 ${spaceId}`)
    if (role === undefined)
      space.members.delete(userId)
    else
      space.members.set(userId, role)
  }

  space(spaceId: string): FakeSpace {
    const space = this.spaceRecords.get(spaceId)
    if (space === undefined)
      throw new Error(`没有空间 ${spaceId}`)
    return space
  }

  private factsOf(userId: string, spaceId: string): SpaceFacts | undefined {
    const space = this.spaceRecords.get(spaceId)
    if (space === undefined)
      return undefined
    return { id: spaceId, type: space.type, name: space.name, status: space.status, visibleToAll: space.visibleToAll, owned: space.owner === userId, memberRole: space.members.get(userId) ?? null }
  }

  readonly repositories = {
    documents: {
      findById: vi.fn(async (id: string) => this.documents.get(id)),
      lockById: vi.fn(async (id: string) => this.documents.get(id)),
      listAccessible: vi.fn(async (scope: AccessibleScope, limit: number) =>
        [...this.documents.values()].filter(row => scope.spaceIds.includes(row.spaceId)).slice(0, limit)),
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
  readonly spaces = {
    personalSpaceOf: vi.fn(async (userId: string) => {
      const entry = [...this.spaceRecords.entries()].find(([, space]) => space.type === 'personal' && space.owner === userId)
      return entry === undefined ? undefined : { id: entry[0], name: entry[1].name }
    }),
    // 访问策略每判断一次，就是这里的一次查询：测试据此核对"不存在"与"看不到"的查询序列相同
    accessFactsOf: vi.fn(async (userId: string, spaceId: string) => this.factsOf(userId, spaceId)),
    visibleSpacesOf: vi.fn(async (userId: string) => [...this.spaceRecords.keys()].flatMap(id => this.factsOf(userId, id) ?? [])),
    lockShared: vi.fn(async () => {}),
  }

  /** 真实的访问策略 */
  readonly policy = new EffectiveAccessPolicy(this.spaces as unknown as SpacesService)
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
      policy: this.policy,
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

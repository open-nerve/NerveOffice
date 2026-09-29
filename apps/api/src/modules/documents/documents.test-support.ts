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
import type { AccessibleScope, CopiedDocument, DocumentRow, DocumentsRepository, ListOptions, NewDocument } from './documents.repository.ts'
import type { FolderRow, FoldersRepository, NewFolder, SubtreeMove, SubtreeSummary } from './folders.repository.ts'
import type { SpaceTreeRepository } from './space-tree.repository.ts'
import type { WriteAccessRevocation, WriteAccessScope } from './write-access.ts'
import { FOLDER_LIST_MAX_ITEMS } from '@nerve-office/contracts'
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
  readonly folders = new Map<string, FolderRow & { requestId: string }>()
  readonly contents = new Map<string, StoredSnapshot>()
  readonly revisions: (RevisionRow & { requestId: string })[] = []
  readonly audits: AuditEvent[] = []
  /** 取过的空间树锁：按取锁的先后记下，用例据此核对锁的顺序 */
  readonly treeLocks: string[][] = []
  /** 每份文档的写入代次（不在 DocumentRow 里）：跨空间移动加一，用例据此核对空间内移动不加 */
  readonly writeEpochs = new Map<string, number>()
  /** 收回写入权的调用：跨空间移动要在同一个事务里调一次（M2-P2 设计 §3.7） */
  readonly revocations: WriteAccessScope[] = []
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
    const row: DocumentRow = { id, spaceId: ALICE_SPACE, type: 'sheet', title: '周报', createdAt: NOW, updatedAt: NOW, position: NOW.toISOString(), revision: 1, unitId: `unit-${id}`, profile: 'sheet@1', formatVersion: 1, ...overrides, folderId: overrides.folderId ?? null }
    this.documents.set(id, row)
    return row
  }

  /** 建一个文件夹（层数按父文件夹算好） */
  addFolder(overrides: Partial<FolderRow> & { requestId?: string } = {}): FolderRow {
    this.sequence += 1
    const id = `0199a2c4-0000-7000-8000-${String(this.sequence).padStart(12, '0')}`
    const parentId = overrides.parentId ?? null
    const parent = parentId === null ? undefined : this.folders.get(parentId)
    const row = {
      id,
      spaceId: parent?.spaceId ?? ALICE_SPACE,
      parentId,
      name: '资料',
      createdBy: ALICE,
      depth: parent === undefined ? 1 : parent.depth + 1,
      createdAt: NOW,
      updatedAt: NOW,
      requestId: `request-${id}`,
      ...overrides,
    }
    this.folders.set(id, row)
    return row
  }

  /** 一棵子树（含根）里的全部文件夹 */
  private descendants(rootId: string): FolderRow[] {
    const found = [...this.folders.values()].filter(row => row.parentId === rootId)
    return found.flatMap(row => [row, ...this.descendants(row.id)])
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
      listAccessible: vi.fn(async (scope: AccessibleScope, options: ListOptions) =>
        [...this.documents.values()].filter(row => scope.spaceIds.includes(row.spaceId)).slice(0, options.limit)),
      insert: vi.fn(async (document: NewDocument) => this.addDocument({ ...document, revision: 1 })),
      rename: vi.fn(async (id: string, title: string) => this.updateDocument(id, { title })),
      moveToFolder: vi.fn(async (id: string, folderId: string | null) => this.updateDocument(id, { folderId })),
      /**
       * 跨空间移动：改所属空间，写入代次加一（代次不在 DocumentRow 里，记在 writeEpochs 上，用例据此核对）。
       * folderId 为 undefined 表示位置不变（跟着所在的文件夹换空间）
       */
      moveToSpace: vi.fn(async (ids: readonly string[], spaceId: string, folderId: string | null | undefined) => ids.map((id) => {
        this.writeEpochs.set(id, (this.writeEpochs.get(id) ?? 0) + 1)
        return this.updateDocument(id, folderId === undefined ? { spaceId } : { spaceId, folderId })
      })),
      /** 这些文件夹里的文档（不按状态过滤，与真实仓储一致），按 id 排序 */
      lockInFolders: vi.fn(async (folderIds: readonly string[], spaceId: string) => [...this.documents.values()]
        .filter(row => row.folderId !== null && folderIds.includes(row.folderId) && row.spaceId === spaceId)
        .map(row => row.id)
        .toSorted()),
      /** 按源文档建一份副本：类型、unitId、档案与格式版本原样复制，修订号 1，新的 id */
      copyFrom: vi.fn(async (sourceId: string, copy: CopiedDocument): Promise<DocumentRow | undefined> => {
        const source = this.documents.get(sourceId)
        if (source === undefined)
          return undefined
        const { id: _id, ...columns } = source
        return this.addDocument({ ...columns, ...copy, revision: 1 })
      }),
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
      copyFrom: vi.fn(async (sourceId: string, targetId: string) => {
        const content = this.contents.get(sourceId)
        if (content === undefined)
          return false
        // 原样搬过去：同一个 Buffer，用例据此核对副本与源逐字节一致
        this.contents.set(targetId, content)
        return true
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
    /** 内存里的目录树：层数与父子关系与真实仓储一致，SQL 本身由集成测试覆盖 */
    folders: {
      findById: vi.fn(async (id: string) => this.folders.get(id)),
      findByRequestId: vi.fn(async (requestId: string) => [...this.folders.values()].find(row => row.requestId === requestId)),
      listChildren: vi.fn(async (spaceId: string, parentId: string | null) => [...this.folders.values()]
        .filter(row => row.spaceId === spaceId && row.parentId === parentId)
        .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()) || a.id.localeCompare(b.id))
        .slice(0, FOLDER_LIST_MAX_ITEMS + 1)),
      insert: vi.fn(async (folder: NewFolder): Promise<FolderRow | undefined> =>
        [...this.folders.values()].some(row => row.requestId === folder.requestId) ? undefined : this.addFolder(folder)),
      rename: vi.fn(async (id: string, name: string) => this.updateFolder(id, { name })),
      summarizeSubtree: vi.fn(async (rootId: string, candidateParentId: string | null): Promise<SubtreeSummary> => {
        const root = this.folders.get(rootId)
        if (root === undefined)
          throw new Error(`展开子树时文件夹不在了：${rootId}`)
        const rows = [root, ...this.descendants(rootId)]
        return {
          maxDepth: Math.max(...rows.map(row => row.depth)),
          containsCandidate: candidateParentId !== null && rows.some(row => row.id === candidateParentId),
          ids: rows.map(row => row.id),
        }
      }),
      /** 整棵子树换位置：层数一起加差值，给了 spaceId 时所属空间也一起换（只有根换父文件夹） */
      moveSubtree: vi.fn(async (move: SubtreeMove) => {
        const { rootId, parentId, depthDelta, spaceId } = move
        for (const row of this.descendants(rootId))
          this.updateFolder(row.id, { depth: row.depth + depthDelta, ...(spaceId === undefined ? {} : { spaceId }) })
        const root = this.folders.get(rootId)
        if (root === undefined)
          throw new Error(`移动时文件夹不在了：${rootId}`)
        return this.updateFolder(rootId, { parentId, depth: root.depth + depthDelta, ...(spaceId === undefined ? {} : { spaceId }) })
      }),
    },
  }

  /** 空间树的 advisory lock：只记下取过哪些空间的锁 */
  readonly tree = {
    lock: vi.fn(async (spaceIds: readonly string[]) => {
      this.treeLocks.push([...spaceIds])
    }),
  }

  /** 收回写入权的入口：只记下调用（M2 的真实实现也什么都不做，M3 接租约） */
  readonly writeAccess = {
    revoke: vi.fn(async (scope: WriteAccessScope) => {
      this.revocations.push(scope)
    }),
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
    // 取哪个空间的行：用例据此核对多个空间时的取锁顺序
    holdSpace: vi.fn(async (_spaceId: string): Promise<unknown> => undefined),
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
      folders: this.repositories.folders as unknown as FoldersRepository,
      tree: this.tree as unknown as SpaceTreeRepository,
      policy: this.policy,
      spaces: this.spaces as unknown as SpacesService,
      audit: this.audit as unknown as AuditService,
      writeAccess: this.writeAccess as unknown as WriteAccessRevocation,
    }
  }

  /** 改一份文档的几列并返回新的行 */
  private updateDocument(id: string, changes: Partial<DocumentRow>): DocumentRow {
    const row = this.documents.get(id)
    if (row === undefined)
      throw new Error(`没有文档 ${id}`)
    const next = { ...row, ...changes }
    this.documents.set(id, next)
    return next
  }

  /** 改一个文件夹的几列并返回新的行 */
  private updateFolder(id: string, changes: Partial<FolderRow>): FolderRow {
    const row = this.folders.get(id)
    if (row === undefined)
      throw new Error(`没有文件夹 ${id}`)
    const next = { ...row, ...changes, updatedAt: new Date(NOW.getTime() + 1000) }
    this.folders.set(id, next)
    return next
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

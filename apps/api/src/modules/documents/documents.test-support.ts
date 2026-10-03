// documents 模块单元测试的假仓储：按内存里的记录实现仓储的接口，事务直接执行。
// 访问策略用真实的实现（EffectiveAccessPolicy），它依赖的空间事实由内存里的空间与成员算出、单独授权由内存里的授权给出（M2-P5）：
// 测试覆盖的是真实的权限规则。
import type { GrantRole, SpaceRole, SpaceStatus, SpaceType } from '@nerve-office/contracts'
import type { AuditEvent, AuditService } from '../audit/index.ts'
import type { SessionService } from '../auth/index.ts'
import type { Transaction, TransactionRunner } from '../database/index.ts'
import type { SpaceFacts, SpaceFactsWithOwner, SpacesService } from '../spaces/index.ts'
import type { Actor } from './document-access-policy.ts'
import type { CurrentContent, DocumentContentsRepository, StoredSnapshot } from './document-contents.repository.ts'
import type { DocumentGrantsRepository, GrantRow, NewGrant } from './document-grants.repository.ts'
import type { DocumentRevisionsRepository, NewRevision, RevisionRow } from './document-revisions.repository.ts'
import type { AccessibleScope, CopiedDocument, DocumentRow, DocumentsRepository, GrantedDocumentRow, ListOptions, NewDocument, PageOptions, SearchOptions, SearchRow } from './documents.repository.ts'
import type { EditLeaseRow, EditLeasesRepository, NewEditLease, ObservedEditLease } from './edit-leases.repository.ts'
import type { CreatedFolderRow, FolderAncestorRow, FolderRow, FoldersRepository, NewFolder, SubtreeMove, SubtreeSummary } from './folders.repository.ts'
import type { SpaceTreeRepository } from './space-tree.repository.ts'
import type { NewTrashEntry, TrashEntriesRepository, TrashEntryRow } from './trash-entries.repository.ts'
import type { WriteAccessRevocation, WriteAccessScope } from './write-access.ts'
import { Buffer } from 'node:buffer'
import { EDIT_LEASE_TTL_SECONDS, FOLDER_LIST_MAX_ITEMS, TRASH_RETENTION_DAYS } from '@nerve-office/contracts'
import { vi } from 'vitest'
import { parseAuditEvent } from '../audit/index.ts'
import { EffectiveAccessPolicy } from './document-access-policy.ts'

export const ALICE = '0199a2c4-0000-7000-8000-00000000000a'
export const BOB = '0199a2c4-0000-7000-8000-00000000000b'
export const ALICE_SPACE = '0199a2c4-0000-7000-8000-0000000000a1'
export const BOB_SPACE = '0199a2c4-0000-7000-8000-0000000000b1'
/** 团队空间：一开始没有成员，测试按需加 */
export const TEAM_SPACE = '0199a2c4-0000-7000-8000-0000000000c1'

/** 假的事务：事务与只读快照都直接执行，用例据此核对传给仓储的是调用方开的那一个 */
export const TRANSACTION = { transaction: true } as unknown as Transaction
const NOW = new Date('2026-09-27T08:00:00.000Z')
/** 假仓储里分享写入的"数据库时间"：比 NOW 晚，用例据此核对新建与调整更新了设置的时间、没有变化时没更新 */
export const GRANT_WRITTEN_AT = new Date('2026-09-27T09:00:00.000Z')

/** 普通成员作为调用者 */
export function member(userId: string): Actor {
  return { userId, systemAdmin: false }
}

/**
 * 假仓储把 LIKE 的模式还原成关键词：去掉前后的通配符与转义符。
 * 内存里按"标题包含关键词、不区分大小写"匹配，正是这条模式要表达的语义；
 * PostgreSQL 的 LIKE 与 ESCAPE 本身由集成测试对着数据库覆盖
 */
function keywordOf(pattern: string): string {
  return pattern.slice(1, -1).replace(/\\(.)/gu, '$1').toLowerCase()
}

interface FakeSpace {
  readonly type: SpaceType
  readonly name: string
  status: SpaceStatus
  visibleToAll: boolean
  readonly owner?: string
  readonly members: Map<string, SpaceRole>
}

/** 内存里的一个文件夹：行，连同新建时的 requestId 与请求摘要（M2 Codex 评审 CX6） */
export type StoredFolder = FolderRow & { readonly requestId: string, readonly payloadDigest: Buffer }

export class FakeStore {
  readonly documents = new Map<string, DocumentRow>()
  /** 文件夹连同新建时的 requestId 与请求摘要（直接建的没有对应的请求，摘要是全零，与任何请求都对不上） */
  readonly folders = new Map<string, StoredFolder>()
  /** 回收站里的删除单元（M2-P4 S3）：id → 行 */
  readonly trashEntries = new Map<string, TrashEntryRow>()
  /** 文档与文件夹所属的删除单元（状态不在行类型里）：不在这里就是正常状态 */
  readonly documentEntries = new Map<string, string>()
  readonly folderEntries = new Map<string, string>()
  readonly contents = new Map<string, StoredSnapshot>()
  readonly revisions: (RevisionRow & { requestId: string })[] = []
  readonly audits: AuditEvent[] = []
  /** 取过的空间树锁：按取锁的先后记下，用例据此核对锁的顺序 */
  readonly treeLocks: string[][] = []
  /** 收回写入权的调用：跨空间移动要在同一个事务里调一次（M2-P2 设计 §3.7） */
  readonly revocations: WriteAccessScope[] = []
  /** 单独授权（M2-P5）：键是"文档 id 与账户 id"，访问策略与"可访问文档"的授权那一半据此判断 */
  readonly grantRecords = new Map<string, GrantRow>()
  /** 空间与成员：访问策略据此算出有效权限 */
  readonly spaceRecords = new Map<string, FakeSpace>([
    [ALICE_SPACE, { type: 'personal', name: '爱丽丝', status: 'active', visibleToAll: false, owner: ALICE, members: new Map() }],
    [BOB_SPACE, { type: 'personal', name: '鲍勃', status: 'active', visibleToAll: false, owner: BOB, members: new Map() }],
    [TEAM_SPACE, { type: 'team', name: '市场部', status: 'active', visibleToAll: false, members: new Map() }],
  ])

  private sequence = 0

  /**
   * 写入代次不为 0 的文档与它们的代次：代次记在行上（DocumentRow.writeEpoch，新建与复制是 0），这里按行算出来，
   * 用例据此核对哪些操作加了一（跨空间移动、删除），哪些没加（空间内移动、改名、恢复）
   */
  get writeEpochs(): ReadonlyMap<string, number> {
    return new Map([...this.documents.values()].flatMap(row => row.writeEpoch === 0 ? [] : [[row.id, row.writeEpoch] as const]))
  }

  addDocument(overrides: Partial<DocumentRow> = {}): DocumentRow {
    this.sequence += 1
    const id = `0199a2c4-0000-7000-8000-${String(this.sequence).padStart(12, '0')}`
    const row: DocumentRow = { id, spaceId: ALICE_SPACE, type: 'sheet', title: '周报', createdBy: ALICE, createdAt: NOW, updatedAt: NOW, position: NOW.toISOString(), revision: 1, unitId: `unit-${id}`, profile: 'sheet@1', formatVersion: 1, writeEpoch: 0, ...overrides, folderId: overrides.folderId ?? null }
    this.documents.set(id, row)
    return row
  }

  /** 建一个文件夹（层数按父文件夹算好） */
  addFolder(overrides: Partial<StoredFolder> = {}): StoredFolder {
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
      payloadDigest: Buffer.alloc(32),
      ...overrides,
    }
    this.folders.set(id, row)
    return row
  }

  /** 一棵子树（不含根）里的全部文件夹 */
  private descendants(rootId: string): FolderRow[] {
    const found = [...this.folders.values()].filter(row => row.parentId === rootId)
    return found.flatMap(row => [row, ...this.descendants(row.id)])
  }

  /** 一份文档现在属于哪个删除单元；正常状态时为空 */
  entryOfDocument(id: string): string | null {
    return this.documentEntries.get(id) ?? null
  }

  /** 一个文件夹现在属于哪个删除单元；正常状态时为空 */
  entryOfFolder(id: string): string | null {
    return this.folderEntries.get(id) ?? null
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

  /** 单独授权；role 为 undefined 时取消。设置人默认是另一个人（真实的表上有"被授权人不是设置人"的 CHECK） */
  setGrant(documentId: string, userId: string, role: GrantRole | undefined, grantedBy: string = userId === ALICE ? BOB : ALICE): void {
    if (role === undefined)
      this.grantRecords.delete(grantKey(documentId, userId))
    else
      this.grantRecords.set(grantKey(documentId, userId), { documentId, userId, role, grantedBy, createdAt: NOW, updatedAt: NOW })
  }

  /** 这个人在这份文档上的授权（整行），没有时为 undefined */
  grantOf(documentId: string, userId: string): GrantRow | undefined {
    return this.grantRecords.get(grantKey(documentId, userId))
  }

  /** "可访问文档"的范围（与真实仓储的 accessible 同一个条件）：正常状态，并且在给定的空间里、或者（要授权那一半时）这个人有授权 */
  private inScope(row: DocumentRow, scope: AccessibleScope): boolean {
    if (this.entryOfDocument(row.id) !== null)
      return false
    return scope.spaceIds.includes(row.spaceId) || (scope.grantsOf !== undefined && this.grantRecords.has(grantKey(row.id, scope.grantsOf)))
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

  /** 一批空间的事实连同所有者（与真实的 accessFactsOfMany 一样：不存在的不在结果里，重复的只算一次） */
  private factsWithOwnerOf(userId: string, spaceIds: readonly string[]): ReadonlyMap<string, SpaceFactsWithOwner> {
    return new Map([...new Set(spaceIds)].flatMap((spaceId) => {
      const facts = this.factsOf(userId, spaceId)
      return facts === undefined ? [] : [[spaceId, { ...facts, ownerUserId: this.space(spaceId).owner ?? null }] as const]
    }))
  }

  /** 按位置从新到旧排序、从游标之后开始（与真实仓储的 keyset 一致） */
  private static page<T extends DocumentRow>(rows: readonly T[], options: PageOptions): T[] {
    const { after } = options
    return rows
      .toSorted((a, b) => b.position.localeCompare(a.position) || b.id.localeCompare(a.id))
      .filter(row => after === undefined || row.position < after.position || (row.position === after.position && row.id < after.id))
      .slice(0, options.limit)
  }

  readonly repositories = {
    documents: {
      findById: vi.fn(async (id: string) => this.activeDocument(id)),
      lockById: vi.fn(async (id: string) => this.activeDocument(id)),
      /** 共享锁持住（复制的源文档）：假仓储里与 findById 相同，用例据此核对取锁的顺序 */
      holdById: vi.fn(async (id: string) => this.activeDocument(id)),
      /** 可访问文档：范围见 inScope（与真实仓储的 accessible 一样，状态不是参数） */
      listAccessible: vi.fn(async (scope: AccessibleScope, options: ListOptions) =>
        [...this.documents.values()]
          .filter(row => this.inScope(row, scope))
          .slice(0, options.limit)),
      /**
       * 按标题搜索：范围与状态同上，再按关键词过滤，按位置从新到旧排序并从游标之后开始；
       * 每行带"这个人有授权"的标志（与真实仓储一样与行同一次读出，要了授权那一半时才可能为真）
       */
      searchByTitle: vi.fn(async (scope: AccessibleScope, options: SearchOptions): Promise<SearchRow[]> => {
        const keyword = keywordOf(options.titlePattern)
        const grantsOf = scope.grantsOf
        const rows = [...this.documents.values()]
          .filter(row => this.inScope(row, scope))
          .filter(row => row.title.toLowerCase().includes(keyword))
          .map(row => ({ ...row, granted: grantsOf !== undefined && this.grantRecords.has(grantKey(row.id, grantsOf)) }))
        return FakeStore.page(rows, options)
      }),
      /** "与我共享"：只要授权那一半（与真实仓储同一个范围），每行带授权角色，排序与分页同上 */
      listGranted: vi.fn(async (userId: string, options: PageOptions): Promise<GrantedDocumentRow[]> => {
        const rows = [...this.documents.values()]
          .filter(row => this.inScope(row, { spaceIds: [], grantsOf: userId }))
          .map(row => ({ ...row, grantRole: this.grantOf(row.id, userId)?.role ?? null }))
        return FakeStore.page(rows, options)
      }),
      insert: vi.fn(async (document: NewDocument) => this.addDocument({ ...document, revision: 1 })),
      rename: vi.fn(async (id: string, title: string) => this.updateDocument(id, { title })),
      moveToFolder: vi.fn(async (id: string, folderId: string | null) => this.updateDocument(id, { folderId })),
      /**
       * 跨空间移动：改所属空间，写入代次加一（用例经 writeEpochs 核对）。
       * folderId 为 undefined 表示位置不变（跟着所在的文件夹换空间）
       */
      moveToSpace: vi.fn(async (ids: readonly string[], spaceId: string, folderId: string | null | undefined) => ids.map((id) => {
        const writeEpoch = this.epochAfterAdvance(id)
        return this.updateDocument(id, folderId === undefined ? { spaceId, writeEpoch } : { spaceId, folderId, writeEpoch })
      })),
      /** 这些文件夹里的文档（state 省略时不按状态过滤，与真实仓储一致），按 id 排序 */
      lockInFolders: vi.fn(async (folderIds: readonly string[], spaceId: string, _transaction: Transaction, state?: 'active' | 'trashed') => [...this.documents.values()]
        .filter(row => row.folderId !== null && folderIds.includes(row.folderId) && row.spaceId === spaceId)
        .filter(row => state === undefined || (this.entryOfDocument(row.id) === null) === (state === 'active'))
        .map(row => ({ id: row.id, trashEntryId: this.entryOfDocument(row.id) }))
        .toSorted((a, b) => a.id.localeCompare(b.id))),
      /** 属于这些删除单元的文档，按 id 排序 */
      lockInEntries: vi.fn(async (entryIds: readonly string[]) => [...this.documents.values()]
        .flatMap((row) => {
          const entry = this.entryOfDocument(row.id)
          return entry !== null && entryIds.includes(entry) ? [{ id: row.id, trashEntryId: entry }] : []
        })
        .toSorted((a, b) => a.id.localeCompare(b.id))),
      /** 这个空间里、这些文件夹下正常状态的文档有多少份（与真实仓储一致：条件与 lockInFolders 同形） */
      countActiveInFolders: vi.fn(async (folderIds: readonly string[], spaceId: string) => [...this.documents.values()]
        .filter(row => row.folderId !== null && folderIds.includes(row.folderId) && row.spaceId === spaceId && this.entryOfDocument(row.id) === null)
        .length),
      /** 这些文件夹里正常状态的、不是这个人创建的文档有多少份 */
      countCreatedByOthers: vi.fn(async (folderIds: readonly string[], spaceId: string, userId: string) => [...this.documents.values()]
        .filter(row => row.folderId !== null && folderIds.includes(row.folderId) && row.spaceId === spaceId)
        .filter(row => this.entryOfDocument(row.id) === null && row.createdBy !== userId)
        .length),
      /** 放进回收站：写入代次加一 */
      trash: vi.fn(async (ids: readonly string[], trashEntryId: string) => {
        for (const id of ids) {
          this.documentEntries.set(id, trashEntryId)
          this.updateDocument(id, { writeEpoch: this.epochAfterAdvance(id) })
        }
        return ids.length
      }),
      /** 整单恢复：代次不变；folderId 为 undefined 表示位置不变 */
      restoreInEntry: vi.fn(async (trashEntryId: string, folderId: string | null | undefined) => {
        const ids = [...this.documentEntries.entries()].flatMap(([id, entry]) => entry === trashEntryId ? [id] : [])
        for (const id of ids) {
          this.documentEntries.delete(id)
          if (folderId !== undefined)
            this.updateDocument(id, { folderId })
        }
        return ids.length
      }),
      countByTrashEntries: vi.fn(async (entryIds: readonly string[]) => {
        const counts = new Map<string, number>()
        for (const entry of this.documentEntries.values()) {
          if (entryIds.includes(entry))
            counts.set(entry, (counts.get(entry) ?? 0) + 1)
        }
        return counts
      }),
      deleteMany: vi.fn(async (ids: readonly string[]) => {
        for (const id of ids) {
          this.documents.delete(id)
          this.documentEntries.delete(id)
          this.contents.delete(id)
        }
        return ids.length
      }),
      /** 按源文档建一份副本：类型、unitId、档案与格式版本原样复制，修订号 1、代次 0（与真实仓储一样用列的默认值），新的 id */
      copyFrom: vi.fn(async (sourceId: string, copy: CopiedDocument): Promise<DocumentRow | undefined> => {
        const source = this.documents.get(sourceId)
        if (source === undefined)
          return undefined
        const { id: _id, ...columns } = source
        return this.addDocument({ ...columns, ...copy, revision: 1, writeEpoch: 0 })
      }),
      advanceRevision: vi.fn(async (id: string, revision: number) => {
        const row = this.documents.get(id)
        if (row?.revision !== revision - 1)
          throw new Error('修订号没有前进')
        this.documents.set(id, { ...row, revision })
      }),
      /** 写入代次加一（M3-P1），返回加一之后的代次；更新时间不变 */
      advanceWriteEpoch: vi.fn(async (id: string) => this.updateDocument(id, { writeEpoch: this.epochAfterAdvance(id) }).writeEpoch),
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
      findById: vi.fn(async (id: string) => this.entryOfFolder(id) === null ? this.folders.get(id) : undefined),
      /** 与真实仓储一样，回收站里的也找出来，带上现在的状态（M2 Codex 评审第二轮复验的一般 4） */
      findByRequestId: vi.fn(async (requestId: string): Promise<CreatedFolderRow | undefined> => {
        const row = [...this.folders.values()].find(stored => stored.requestId === requestId)
        return row === undefined ? undefined : { ...row, status: this.entryOfFolder(row.id) === null ? 'active' : 'trashed' }
      }),
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
      /** 这棵子树（含根）里正常状态的文件夹：递归只走正常状态的行 */
      activeSubtreeIds: vi.fn(async (rootId: string) => {
        if (this.entryOfFolder(rootId) !== null)
          return []
        const walk = (id: string): string[] => [id, ...[...this.folders.values()]
          .filter(row => row.parentId === id && this.entryOfFolder(row.id) === null)
          .flatMap(row => walk(row.id))]
        return walk(rootId)
      }),
      /** 这些文件夹里正常状态的有几个 */
      countActive: vi.fn(async (ids: readonly string[]) => ids.filter(id => this.folders.has(id) && this.entryOfFolder(id) === null).length),
      /** 这些文件夹分属哪些删除单元（去重，正常状态的不算） */
      trashEntryIdsIn: vi.fn(async (folderIds: readonly string[]) =>
        [...new Set(folderIds.flatMap(id => this.entryOfFolder(id) ?? []))]),
      /** 属于这个删除单元的全部文件夹，按层数从浅到深 */
      listInEntry: vi.fn(async (trashEntryId: string) => [...this.folders.values()]
        .filter(row => this.entryOfFolder(row.id) === trashEntryId)
        .toSorted((a, b) => a.depth - b.depth || a.id.localeCompare(b.id))),
      /** 这些文件夹连同它们的全部祖先，只取看得到的空间里的（与真实仓储一样，父链在别的空间里就断在那里） */
      ancestorsOf: vi.fn(async (ids: readonly string[], spaceIds: readonly string[]): Promise<FolderAncestorRow[]> => {
        const found = new Map<string, FolderAncestorRow>()
        for (const id of ids) {
          let current = this.folders.get(id)
          while (current !== undefined && spaceIds.includes(current.spaceId) && !found.has(current.id)) {
            found.set(current.id, { id: current.id, parentId: current.parentId, name: current.name })
            current = current.parentId === null ? undefined : this.folders.get(current.parentId)
          }
        }
        return [...found.values()]
      }),
      /** 这些文件夹里正常状态的那些的名称 */
      activeNamesOf: vi.fn(async (ids: readonly string[], spaceId: string) => new Map([...this.folders.values()]
        .filter(row => ids.includes(row.id) && row.spaceId === spaceId && this.entryOfFolder(row.id) === null)
        .map(row => [row.id, row.name] as const)) as ReadonlyMap<string, string>),
      countByTrashEntries: vi.fn(async (entryIds: readonly string[]) => {
        const counts = new Map<string, number>()
        for (const entry of this.folderEntries.values()) {
          if (entryIds.includes(entry))
            counts.set(entry, (counts.get(entry) ?? 0) + 1)
        }
        return counts
      }),
      /** 整棵子树进回收站：层数不变 */
      trashMany: vi.fn(async (ids: readonly string[], trashEntryId: string) => {
        for (const id of ids)
          this.folderEntries.set(id, trashEntryId)
        return ids.length
      }),
      /**
       * 整单恢复（与真实仓储同形）：范围是根的整棵递归子树（不看状态），层数一起加差值——
       * 留在回收站里、属于别的删除单元的子孙也跟着降层（审查 A2）；回到正常状态只对这一单的行生效；只有根换父文件夹
       */
      restoreInEntry: vi.fn(async (trashEntryId: string, rootId: string, parentId: string | null, depthDelta: number) => {
        const root = this.folders.get(rootId)
        const subtree = root === undefined ? [] : [root, ...this.descendants(rootId)]
        for (const row of subtree) {
          if (this.entryOfFolder(row.id) === trashEntryId)
            this.folderEntries.delete(row.id)
          this.updateFolder(row.id, { depth: row.depth + depthDelta, ...(row.id === rootId ? { parentId } : {}) })
        }
        return subtree.length
      }),
      deleteMany: vi.fn(async (ids: readonly string[]) => {
        for (const id of ids) {
          this.folders.delete(id)
          this.folderEntries.delete(id)
        }
        return ids.length
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

  /** 回收站的删除单元：只有 TrashEntriesRepository 读写 trash_entries */
  readonly entries = {
    insert: vi.fn(async (entry: NewTrashEntry): Promise<TrashEntryRow> => {
      this.sequence += 1
      const id = `0199a2c4-0000-7000-8000-${String(this.sequence).padStart(12, '0')}`
      const row: TrashEntryRow = {
        id,
        ...entry,
        deletedAt: NOW,
        // 游标用的位置：与数据库算出来的一样保留微秒（time-cursor 的格式校验要求六位）
        position: `${NOW.toISOString().slice(0, -1)}000Z`,
        expiresAt: new Date(NOW.getTime() + TRASH_RETENTION_DAYS * 24 * 3600 * 1000),
      }
      this.trashEntries.set(id, row)
      return row
    }),
    findById: vi.fn(async (id: string) => this.trashEntries.get(id)),
    lockById: vi.fn(async (id: string) => this.trashEntries.get(id)),
    /** 到这个时刻为止已经到期的，最早到期的在前（M2-P4 S4）；except 里的不取（定时清理暂缓重试的那些） */
    listExpired: vi.fn(async (now: Date, limit: number, except: readonly string[] = []) => [...this.trashEntries.values()]
      .filter(row => row.expiresAt <= now && !except.includes(row.id))
      .toSorted((a, b) => a.expiresAt.getTime() - b.expiresAt.getTime() || a.id.localeCompare(b.id))
      .slice(0, limit)),
    listBySpace: vi.fn(async (spaceId: string, options: { limit: number }) => [...this.trashEntries.values()]
      .filter(row => row.spaceId === spaceId)
      .toSorted((a, b) => b.id.localeCompare(a.id))
      .slice(0, options.limit)),
    moveToSpace: vi.fn(async (ids: readonly string[], spaceId: string) => {
      for (const id of ids) {
        const row = this.trashEntries.get(id)
        if (row !== undefined)
          this.trashEntries.set(id, { ...row, spaceId })
      }
      return ids.length
    }),
    deleteMany: vi.fn(async (ids: readonly string[]) => {
      for (const id of ids)
        this.trashEntries.delete(id)
      return ids.length
    }),
  }

  /** 空间树的 advisory lock：只记下取过哪些空间的锁 */
  readonly tree = {
    lock: vi.fn(async (spaceIds: readonly string[]) => {
      this.treeLocks.push([...spaceIds])
    }),
  }

  /**
   * 单独授权的仓储（M2-P5）：访问策略每判断一次文档，就是这里的一次查询（用例据此核对"不存在"时照样查一次）；
   * 分享的写入经 find、insert、updateRole、delete（写入的时间是 GRANT_WRITTEN_AT，代替数据库的当前时间）
   */
  readonly grants = {
    roleOf: vi.fn(async (documentId: string, userId: string): Promise<GrantRole | undefined> => this.grantOf(documentId, userId)?.role),
    find: vi.fn(async (documentId: string, userId: string): Promise<GrantRow | undefined> => this.grantOf(documentId, userId)),
    listFor: vi.fn(async (documentId: string): Promise<GrantRow[]> => [...this.grantRecords.values()].filter(row => row.documentId === documentId)),
    insert: vi.fn(async (grant: NewGrant): Promise<GrantRow> => {
      if (this.grantRecords.has(grantKey(grant.documentId, grant.userId)))
        throw new Error('授权已经存在（真实的表上是主键冲突）')
      const row = { ...grant, createdAt: GRANT_WRITTEN_AT, updatedAt: GRANT_WRITTEN_AT }
      this.grantRecords.set(grantKey(grant.documentId, grant.userId), row)
      return row
    }),
    updateRole: vi.fn(async (documentId: string, userId: string, role: GrantRole, grantedBy: string): Promise<GrantRow> => {
      const row = this.grantOf(documentId, userId)
      if (row === undefined)
        throw new Error(`调整授权时授权不在了：${documentId}`)
      const next = { ...row, role, grantedBy, updatedAt: GRANT_WRITTEN_AT }
      this.grantRecords.set(grantKey(documentId, userId), next)
      return next
    }),
    delete: vi.fn(async (documentId: string, userId: string): Promise<GrantRow | undefined> => {
      const row = this.grantOf(documentId, userId)
      this.grantRecords.delete(grantKey(documentId, userId))
      return row
    }),
  }

  /** 收回写入权的入口：只记下调用（M2 的真实实现也什么都不做，M3 接租约） */
  readonly writeAccess = {
    revoke: vi.fn(async (scope: WriteAccessScope) => {
      this.revocations.push(scope)
    }),
  }

  /** 编辑租约（M3-P1）：文档 id → 租约行 */
  readonly leaseRecords = new Map<string, EditLeaseRow>()
  /**
   * 假仓储里数据库的 now()（事务开始的时刻）：读出的租约行带着它，写下的时间也是它。
   * 用例改它模拟时间过去，不等真实的时间（与集成测试改写租约行的时间同一个意思）
   */
  databaseNow: Date = NOW
  /** 仍然有效的登录：auth 的 SessionService.isActive 的假实现按它回答 */
  readonly activeSessions = new Set<string>()

  /**
   * 编辑租约的仓储（M3-P1）：与真实仓储同样的语义——每份文档至多一行，改写为新的一代时清掉明确结束，
   * 续租时最后活动夹在申请的时间与 now 之间，明确结束不覆盖先记下的原因。SQL 本身由集成测试覆盖
   */
  readonly leases = {
    findByDocument: vi.fn(async (documentId: string) => this.observedLease(documentId)),
    lockByDocument: vi.fn(async (documentId: string) => this.observedLease(documentId)),
    replace: vi.fn(async (lease: NewEditLease): Promise<ObservedEditLease> => {
      const now = this.databaseNow
      const row: EditLeaseRow = { ...lease, acquiredAt: now, renewedAt: now, lastActiveAt: now, expiresAt: this.expiryFrom(now), endedAt: null, endReason: null }
      this.leaseRecords.set(lease.documentId, row)
      return { ...row, now }
    }),
    renew: vi.fn(async (documentId: string, idleSeconds: number): Promise<ObservedEditLease> => {
      const row = this.leaseRecords.get(documentId)
      if (row === undefined)
        throw new Error(`续租时租约不在了：${documentId}`)
      const now = this.databaseNow
      const lastActiveAt = new Date(Math.min(Math.max(now.getTime() - idleSeconds * 1000, row.acquiredAt.getTime()), now.getTime()))
      const renewed = { ...row, renewedAt: now, expiresAt: this.expiryFrom(now), lastActiveAt }
      this.leaseRecords.set(documentId, renewed)
      return { ...renewed, now }
    }),
    end: vi.fn(async (documentId: string, reason: NonNullable<EditLeaseRow['endReason']>) => {
      const row = this.leaseRecords.get(documentId)
      if (row === undefined || row.endedAt !== null)
        return false
      this.leaseRecords.set(documentId, { ...row, endedAt: this.databaseNow, endReason: reason })
      return true
    }),
  }

  /** auth 的会话服务（M3-P1：判断别人的租约绑定的登录还在不在） */
  readonly sessions = {
    isActive: vi.fn(async (sessionId: string) => this.activeSessions.has(sessionId)),
  }

  readonly transactions = {
    run: vi.fn(async <T>(work: (transaction: Transaction) => Promise<T>) => work(TRANSACTION)),
    readSnapshot: vi.fn(async <T>(work: (transaction: Transaction) => Promise<T>) => work(TRANSACTION)),
  }

  readonly spaces = {
    personalSpaceOf: vi.fn(async (userId: string) => {
      const entry = [...this.spaceRecords.entries()].find(([, space]) => space.type === 'personal' && space.owner === userId)
      return entry === undefined ? undefined : { id: entry[0], name: entry[1].name }
    }),
    // 访问策略每判断一次，就是这里的一次查询：测试据此核对"不存在"与"看不到"的查询序列相同
    accessFactsOf: vi.fn(async (userId: string, spaceId: string) => this.factsOf(userId, spaceId)),
    // 一批空间的事实连同所有者（"与我共享"与搜索）：用例据此核对一页只查一次
    accessFactsOfMany: vi.fn(async (userId: string, spaceIds: readonly string[]) => this.factsWithOwnerOf(userId, spaceIds)),
    visibleSpacesOf: vi.fn(async (userId: string) => [...this.spaceRecords.keys()].flatMap(id => this.factsOf(userId, id) ?? [])),
    // 取哪个空间的行：用例据此核对多个空间时的取锁顺序
    holdSpace: vi.fn(async (_spaceId: string): Promise<unknown> => undefined),
  }

  /** 真实的访问策略 */
  readonly policy = new EffectiveAccessPolicy(this.spaces as unknown as SpacesService, this.grants as unknown as DocumentGrantsRepository)
  /** 与真实的 AuditService 一样按严格的结构校验（明细多一个键，例如标题，就抛出，M2-P6 复核 M-1），记下原样的事件 */
  readonly audit = {
    record: vi.fn(async (event: AuditEvent) => {
      parseAuditEvent(event)
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
      entries: this.entries as unknown as TrashEntriesRepository,
      tree: this.tree as unknown as SpaceTreeRepository,
      policy: this.policy,
      spaces: this.spaces as unknown as SpacesService,
      grants: this.grants as unknown as DocumentGrantsRepository,
      audit: this.audit as unknown as AuditService,
      writeAccess: this.writeAccess as unknown as WriteAccessRevocation,
      leases: this.leases as unknown as EditLeasesRepository,
      sessions: this.sessions as unknown as SessionService,
    }
  }

  /** 正常状态的一份文档（回收站里的对普通接口不存在） */
  private activeDocument(id: string): DocumentRow | undefined {
    return this.entryOfDocument(id) === null ? this.documents.get(id) : undefined
  }

  /** 读出的租约行带着此刻的"数据库时间"（与真实仓储一样，与行出自同一条语句） */
  private observedLease(documentId: string): ObservedEditLease | undefined {
    const row = this.leaseRecords.get(documentId)
    return row === undefined ? undefined : { ...row, now: this.databaseNow }
  }

  /** 到期的时刻：now 加有效期 */
  private expiryFrom(now: Date): Date {
    return new Date(now.getTime() + EDIT_LEASE_TTL_SECONDS * 1000)
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

  /** 这份文档的写入代次加一之后的值（与真实仓储的 write_epoch + 1 一样，只增不减） */
  private epochAfterAdvance(id: string): number {
    const row = this.documents.get(id)
    if (row === undefined)
      throw new Error(`没有文档 ${id}`)
    return row.writeEpoch + 1
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

/** 授权表的键：一个人在一份文档上至多一条（与真实表的主键相同） */
function grantKey(documentId: string, userId: string): string {
  return `${documentId}\n${userId}`
}

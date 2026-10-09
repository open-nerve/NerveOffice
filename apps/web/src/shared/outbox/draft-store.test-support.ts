// 测试用：照 DraftStore 的接口写的内存存储（M4-P1 设计 §3.2）。判定一律用 writer-fence.ts 的函数——与 IndexedDB 的实现同一组，
// 不另写一套；每个操作在一段同步代码里读、判定、写（与事务里不 await 别的异步同一个样子）。记录按结构化克隆存取：库里存的是一份拷贝，
// 读出的是另一份；写进去之前照样过形状核对（形状不对的不写）。
// 另有故障与交错：下一次某个操作交回指定的问题（写满、库用不了、出错），或者停在开始之前、等测试放行（确定的交错）
import type { DraftKey, StoredDraft } from './draft-record.ts'
import type { DraftStore, ListedDraft, PurgedDraft, StoreProblem } from './draft-store.ts'
import type { RecoveryNotice } from './recovery-notice.ts'
import type { WriterIdentity } from './writer-fence.ts'
import { draftMetaOf, readableUpdatedAt, readStoredDraft, readWriterRecord } from './draft-record.ts'
import { readRecoveryNotice } from './recovery-notice.ts'
import { decideConfirm, decideRegistration, decideRemove, decideReplace, decideRestore, decideWrite, isNoticeExpired, isRetired, isSameWriter, restoredWriterOf, retiredWriterOf, shouldPurgeDraft, writerRetention } from './writer-fence.ts'

export type StoreOperation = Exclude<keyof DraftStore, 'close'>

export interface HeldOperation {
  /** 操作已经开始、停在判定之前 */
  readonly reached: Promise<void>
  readonly release: () => void
}

export interface FakeDraftStore {
  readonly store: DraftStore
  /** 库里这份文档的草稿（一份拷贝，没经过形状核对）；没有为 undefined */
  readonly rawDraft: (key: DraftKey) => unknown
  readonly rawWriter: (key: DraftKey) => unknown
  /** 库里这份文档的提示（S9） */
  readonly rawNotice: (key: DraftKey) => unknown
  /** 直接改库：模拟别的标签页、别的写入者，或者被改过的记录（undefined 是删掉） */
  readonly putRaw: (table: 'drafts' | 'writers' | 'notices', key: DraftKey, value: unknown) => void
  /** 每个操作开始时记下名字（按调用的先后） */
  readonly calls: readonly StoreOperation[]
  /** 下一次 operation 交回 problem，不判定、不改库（只一次） */
  readonly failNext: (operation: StoreOperation, problem: StoreProblem) => void
  /** 下一次 operation 停在判定之前，直到 release */
  readonly holdNext: (operation: StoreOperation) => HeldOperation
  /** close 被调用的次数 */
  readonly closed: () => number
}

function idOf(key: DraftKey): string {
  return JSON.stringify([key.userId, key.documentId])
}

function keyOf(record: DraftKey): DraftKey {
  return { userId: record.userId, documentId: record.documentId }
}

export function fakeDraftStore(): FakeDraftStore {
  const drafts = new Map<string, unknown>()
  const writers = new Map<string, unknown>()
  const notices = new Map<string, unknown>()
  const calls: StoreOperation[] = []
  const failures = new Map<StoreOperation, StoreProblem>()
  const holds = new Map<StoreOperation, { reached: () => void, released: Promise<void> }>()
  let closeCount = 0

  /** 开始一个操作：记下名字；要停就停在这里；要出问题就交回问题（之后的判定与写入都不做） */
  async function begin(operation: StoreOperation): Promise<StoreProblem | undefined> {
    calls.push(operation)
    const hold = holds.get(operation)
    if (hold !== undefined) {
      holds.delete(operation)
      hold.reached()
      await hold.released
    }
    const failure = failures.get(operation)
    failures.delete(operation)
    return failure
  }

  const existingOf = (id: string) => {
    const raw = drafts.get(id)
    return raw === undefined ? undefined : readStoredDraft(structuredClone(raw))
  }
  const writerOf = (id: string) => readWriterRecord(writers.get(id))
  const raiseHighWater = (draft: StoredDraft, identity: WriterIdentity): void => {
    const current = writerOf(idOf(draft))
    if (current !== undefined && isSameWriter(current, identity))
      writers.set(idOf(draft), { ...current, lastDraftSeq: Math.max(current.lastDraftSeq, draft.draftSeq) })
  }
  const notice = (key: DraftKey, kind: RecoveryNotice['kind'], at: number): RecoveryNotice => ({ ...keyOf(key), kind, at })
  /** 属于这个用户的键（JSON 的 [userId, documentId]） */
  const ownedBy = (id: string, userId: string): boolean => (JSON.parse(id) as [string, string])[0] === userId
  const documentOf = (id: string): string => (JSON.parse(id) as [string, string])[1]
  /** 存进去的一律读得回来：形状不对的不写（与 IndexedDB 的实现同一个约定） */
  const unwritable = (draft: StoredDraft): StoreProblem | undefined =>
    readStoredDraft(draft).kind === 'draft' ? undefined : { kind: 'failed', error: new TypeError('形状不对的草稿不写') }

  const store: DraftStore = {
    async registerWriter(key, writer, options) {
      const problem = await begin('registerWriter') ?? (isRetired(writer) ? { kind: 'failed', error: new TypeError('墓碑保留的 writerId 不能登记') } as const : undefined)
      if (problem !== undefined)
        return problem
      const id = idOf(key)
      const existing = existingOf(id)
      const verdict = decideRegistration(writerOf(id), existing, writer, options.force)
      if (verdict.kind === 'superseded')
        return verdict
      writers.set(id, { ...keyOf(key), writeEpoch: writer.writeEpoch, writerId: writer.writerId, lastDraftSeq: verdict.lastDraftSeq, registeredAt: options.now })
      return { kind: 'registered', lastDraftSeq: verdict.lastDraftSeq, existing }
    },
    async writeDraft(draft, options) {
      const problem = await begin('writeDraft') ?? unwritable(draft)
      if (problem !== undefined)
        return problem
      const id = idOf(draft)
      const verdict = decideWrite(writerOf(id), existingOf(id), { writeEpoch: draft.writeEpoch, writerId: draft.writerId, draftSeq: draft.draftSeq, adoptSeq: options?.adoptSeq })
      if (verdict === 'duplicate')
        return { kind: 'written' }
      if (verdict !== 'ok')
        return { kind: 'fenced', reason: verdict }
      drafts.set(id, structuredClone(draft))
      raiseHighWater(draft, draft)
      return { kind: 'written' }
    },
    async replaceDraft(draft) {
      const problem = await begin('replaceDraft') ?? unwritable(draft)
      if (problem !== undefined)
        return problem
      const id = idOf(draft)
      const verdict = decideReplace(writerOf(id), existingOf(id), { writeEpoch: draft.writeEpoch, writerId: draft.writerId, expectedSeq: draft.draftSeq })
      if (verdict !== 'ok')
        return { kind: 'fenced', reason: verdict }
      drafts.set(id, structuredClone(draft))
      return { kind: 'written' }
    },
    async confirmDraft(key, writer, confirmedSeq, rebased) {
      const problem = await begin('confirmDraft') ?? (rebased === undefined ? undefined : unwritable(rebased))
      if (problem !== undefined)
        return problem
      const id = idOf(key)
      const existing = existingOf(id)
      const verdict = decideConfirm(writerOf(id), existing, { ...writer, confirmedSeq })
      switch (verdict) {
        case 'delete':
          drafts.delete(id)
          return { kind: 'deleted' }
        case 'rebase':
          // 换进去的必须就是库里现在这一份的重封：同一个写入者、同一个序号（库里的序号在判定里已经比确认的大）
          if (rebased === undefined || existing?.kind !== 'draft' || !isSameWriter(rebased, writer) || rebased.draftSeq !== existing.draft.draftSeq)
            return { kind: 'needs-rebase' }
          drafts.set(id, structuredClone(rebased))
          return { kind: 'rebased' }
        case 'absent':
          return { kind: 'absent' }
        case 'not-writer':
        case 'foreign-draft':
          return { kind: 'fenced', reason: verdict }
      }
    },
    async readDraft(key) {
      const problem = await begin('readDraft')
      if (problem !== undefined)
        return problem
      return existingOf(idOf(key)) ?? { kind: 'absent' }
    },
    async listDrafts(userId) {
      const problem = await begin('listDrafts')
      if (problem !== undefined)
        return problem
      const listed: ListedDraft[] = []
      for (const [id, raw] of drafts) {
        const [owner, documentId] = JSON.parse(id) as [string, string]
        if (owner !== userId)
          continue
        const read = readStoredDraft(structuredClone(raw))
        const key = { userId: owner, documentId }
        listed.push(read.kind === 'draft' ? { kind: 'draft', meta: draftMetaOf(read.draft) } : read.kind === 'newer-format' ? { kind: 'newer-format', key, recordVersion: read.recordVersion } : { kind: 'malformed', key })
      }
      return { kind: 'listed', drafts: listed }
    },
    async removeDraft(key, expectedSeq) {
      const problem = await begin('removeDraft')
      if (problem !== undefined)
        return problem
      const id = idOf(key)
      const verdict = decideRemove(existingOf(id), expectedSeq)
      if (verdict === 'remove') {
        drafts.delete(id)
        notices.delete(id)
        return { kind: 'removed' }
      }
      return { kind: verdict }
    },
    async removeUserData(userId, options) {
      const problem = await begin('removeUserData')
      if (problem !== undefined)
        return problem
      const retire = new Set(options?.retire ?? [])
      for (const table of [drafts, writers, notices]) {
        for (const id of [...table.keys()]) {
          if (ownedBy(id, userId) && !retire.has(documentOf(id)))
            table.delete(id)
        }
      }
      // 留下的几份：写入者换成墓碑（没有写入者的也立一块）
      for (const documentId of retire) {
        const key = { userId, documentId }
        writers.set(idOf(key), retiredWriterOf(key, writerOf(idOf(key)), existingOf(idOf(key)), options?.now ?? 0))
      }
      return { kind: 'cleared' }
    },
    async purgeExpired(now) {
      const problem = await begin('purgeExpired')
      if (problem !== undefined)
        return problem
      // 与 IndexedDB 的实现同一个口径：按记录里读得出的更新时间，不论格式；交回的键标明是哪一种
      const purged: PurgedDraft[] = []
      for (const [id, raw] of [...drafts]) {
        if (shouldPurgeDraft(readableUpdatedAt(raw), now)) {
          drafts.delete(id)
          const [userId, documentId] = JSON.parse(id) as [string, string]
          purged.push({ key: { userId, documentId }, record: readStoredDraft(structuredClone(raw)).kind })
        }
      }
      for (const [id, raw] of [...writers]) {
        const writer = readWriterRecord(raw)
        switch (writerRetention(writer, drafts.has(id), now)) {
          case 'delete':
            writers.delete(id)
            break
          case 'retire': {
            const [userId, documentId] = JSON.parse(id) as [string, string]
            writers.set(id, retiredWriterOf({ userId, documentId }, writer, undefined, now))
            break
          }
          case 'keep':
            break
        }
      }
      for (const [id, raw] of [...notices]) {
        const read = readRecoveryNotice(raw)
        if (read === undefined || isNoticeExpired(read, now))
          notices.delete(id)
      }
      return { kind: 'purged', drafts: purged }
    },
    async restoreDraft(draft, { now }) {
      const problem = await begin('restoreDraft') ?? unwritable(draft)
      if (problem !== undefined)
        return problem
      const id = idOf(draft)
      const current = writerOf(id)
      const verdict = decideRestore(current, existingOf(id), draft, now)
      if (verdict.kind === 'skip')
        return { kind: 'kept', reason: verdict.reason }
      drafts.set(id, structuredClone(draft))
      writers.set(id, structuredClone(restoredWriterOf(current, draft, verdict.writer, now)))
      notices.set(id, notice(draft, 'restored', now))
      return { kind: 'restored' }
    },
    async retireWriter(key, { now }) {
      const problem = await begin('retireWriter')
      if (problem !== undefined)
        return problem
      writers.set(idOf(key), retiredWriterOf(keyOf(key), writerOf(idOf(key)), existingOf(idOf(key)), now))
      return { kind: 'retired' }
    },
    async listTombstones() {
      const problem = await begin('listTombstones')
      if (problem !== undefined)
        return problem
      const keys: DraftKey[] = []
      for (const [id, raw] of [...writers].sort(([a], [b]) => a.localeCompare(b))) {
        const writer = readWriterRecord(raw)
        if (writer !== undefined && isRetired(writer)) {
          const [userId, documentId] = JSON.parse(id) as [string, string]
          keys.push({ userId, documentId })
        }
      }
      return { kind: 'tombstones', keys }
    },
    async dropTombstones(keys) {
      const problem = await begin('dropTombstones')
      if (problem !== undefined)
        return problem
      for (const key of keys) {
        const writer = writerOf(idOf(key))
        if (writer !== undefined && isRetired(writer))
          writers.delete(idOf(key))
      }
      return { kind: 'dropped' }
    },
    async recordLost(key, { now }) {
      const problem = await begin('recordLost')
      if (problem !== undefined)
        return problem
      const id = idOf(key)
      // 与 IndexedDB 的实现同一个口径：形状不对的写入者当作没有，草稿不论认不认得出都算有
      if (writerOf(id) !== undefined || drafts.has(id))
        return { kind: 'kept' }
      notices.set(id, notice(key, 'lost', now))
      return { kind: 'noted' }
    },
    async listNotices(userId) {
      const problem = await begin('listNotices')
      if (problem !== undefined)
        return problem
      const listed: RecoveryNotice[] = []
      for (const [id, raw] of [...notices].sort(([a], [b]) => a.localeCompare(b))) {
        const read = readRecoveryNotice(structuredClone(raw))
        if (ownedBy(id, userId) && read !== undefined)
          listed.push(read)
      }
      return { kind: 'notices', notices: listed }
    },
    async clearNotice(key, expectedAt) {
      const problem = await begin('clearNotice')
      if (problem !== undefined)
        return problem
      const id = idOf(key)
      const raw = notices.get(id)
      if (raw === undefined)
        return { kind: 'absent' }
      const read = readRecoveryNotice(raw)
      if (expectedAt !== undefined && read !== undefined && read.at !== expectedAt)
        return { kind: 'changed' }
      notices.delete(id)
      return { kind: 'cleared' }
    },
    close() {
      closeCount += 1
    },
  }

  return {
    store,
    rawDraft: key => structuredClone(drafts.get(idOf(key))),
    rawWriter: key => structuredClone(writers.get(idOf(key))),
    rawNotice: key => structuredClone(notices.get(idOf(key))),
    putRaw(table, key, value) {
      const target = table === 'drafts' ? drafts : table === 'writers' ? writers : notices
      if (value === undefined)
        target.delete(idOf(key))
      else
        target.set(idOf(key), structuredClone(value))
    },
    calls,
    failNext(operation, problem) {
      failures.set(operation, problem)
    },
    holdNext(operation) {
      let reached: () => void = () => {}
      let release: () => void = () => {}
      const reachedPromise = new Promise<void>((resolve) => {
        reached = resolve
      })
      const released = new Promise<void>((resolve) => {
        release = resolve
      })
      holds.set(operation, { reached, released })
      return { reached: reachedPromise, release }
    },
    closed: () => closeCount,
  }
}

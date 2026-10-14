// 本机草稿的清理（M4-P1 设计 §3.4.7、§3.8）：库（草稿、写入者、提示）与 OPFS 镜像的目录一起清——"两份一起清"只写在这里。
// 页面里用（退出登录、账户停用与保留期；本机草稿页按完整观察走 RecoveryReader.remove）：不拿同步访问句柄；经 getFile 读取槽位、核对元数据与密文结构后删目录
// （mirror-directory.ts）。P4 的本机草稿页列出与清理之前先比对（draft-recovery.ts 的 pageReconciliation 与 reconcileAll，审查 A18），
// 删库之后只在镜像里的草稿先写回库，列出、清理就都看得见。编辑器页放弃自己正写着的草稿走 DraftWriter.remove（发件箱 Worker 拿着句柄，
// 截断两个槽位，之后接着写）。
//
// 镜像目录有句柄开着（编辑器页的发件箱 Worker 正写着这份文档）时删不了，也可能一时出错：这一次跳过它，结果里的 pending 列出没清掉的文档。
// 跳过的那几份把写入者换成墓碑（审查 A1、A6，writer-fence.ts 的 RETIRED_WRITER_ID）：高水位留着，那一页之后的写入、重封、确认一律
// not-writer（它的 Worker 随之放开句柄、页面经服务端核对再决定），比对时库里有墓碑就不从镜像写回。
// - 按用户清理：先在库里把这个人每份文档的写入者换成墓碑（一个事务，复验 C5）——之后那一页写不进去、它的发件箱 Worker 不再写镜像，
//   删镜像目录与清库之间不会把目录重建出来；再列出、删掉他的镜像目录；最后清库，跳过的那几份草稿、提示与墓碑留着。之后凭同一清理许可再调 removeUser
//   接着清；每轮在同源锁下核对持久 clearing，重新登录先换代时旧清理不能碰主库或镜像。全部清完才转入 cleared，保留代次。
// - 放弃：库里的草稿与提示照删，写入者换成墓碑；不必再调 abandon（再调会删掉那一页之后新写的）：镜像在下一次比对时被截断（墓碑挡住写回），
//   目录与墓碑由保留期回收。
// - 保留期：主库保留键保护对应镜像；非空槽位全部可识别且过期才回收，未知格式/时间/读取结果保留。
//   空目录仍看两槽文件时间（审查 A9），刚截断的留给下次编辑；删不掉的下一次再删，目录不在后回收墓碑。
// 发件箱 Worker 不引用这个文件（Worker 里镜像的句柄由 draft-mirror.ts 管）；不引用 zod
import type { DraftMaintenanceStore } from './draft-maintenance-store.ts'
import type { DraftKey } from './draft-record.ts'
import type { DraftStore, PurgedDraft, StoreProblem } from './draft-store.ts'
import type { MirrorDirectory, MirrorProblem, SlotFileInfo } from './mirror-directory.ts'
import type { DraftSessionPermit, UserCleanupCause, UserCleanupPermit } from './session-fence.ts'
import type { SessionStore } from './session-store.ts'
import { parseSlot } from './mirror-slot.ts'
import { withOutboxLock } from './outbox-lock.ts'
import { readDraftSessionPermit, readUserCleanupPermit } from './session-fence.ts'
import { LOCAL_DRAFT_RETENTION_MS, shouldPurgeDraft } from './writer-fence.ts'

/** 按用户清理：pending 列出未清掉的文档；用户目录仍忙时也可能为空。只有 kind 为 cleared 才表示全部完成。 */
export type UserCleanupOutcome = { readonly kind: 'cleared' | 'pending', readonly pending: readonly DraftKey[] } | { readonly kind: 'invalidated' } | Exclude<StoreProblem, { readonly kind: 'session-invalid' }>

/**
 * 放弃一份：库里删了（或者本来就没有）；pending 里有它时是镜像目录这一次没删掉（写入者换成了墓碑，不必再调，见文件开头）；
 * changed 是库里已经不是那一份
 */
export type AbandonOutcome
  = | { readonly kind: 'removed' | 'absent', readonly pending: readonly DraftKey[] }
    | { readonly kind: 'changed' }
    | StoreProblem

/**
 * 保留期：drafts 是主库或独有镜像里实际删掉的草稿（同一键只报一次）；pending 是这一次没删掉的镜像目录（下一次保留期再删）；
 * mirror 是之后镜像目录与墓碑那一段做完了没有（审查 A5：库那一段已经删了，后一段出了问题也照样交回删了哪几份，下一次再做）
 */
export interface PurgeReport {
  readonly kind: 'purged'
  readonly drafts: readonly PurgedDraft[]
  readonly pending: readonly DraftKey[]
  readonly mirror: { readonly kind: 'done' } | { readonly kind: 'failed', readonly error: unknown }
}

export type PurgeOutcome = PurgeReport | StoreProblem

export interface LocalCleanup {
  /** 用户已确认退出或已核实停用之后调用；只持久化清理资格，不请求服务端。 */
  readonly beginUser: (permit: DraftSessionPermit, cause: UserCleanupCause) => ReturnType<SessionStore['beginUserCleanup']>
  /** 按用户清理（退出登录、账户停用）：这个人的草稿、写入者（含墓碑）、提示与镜像目录；先立墓碑、再删镜像目录、最后清库 */
  readonly removeUser: (permit: UserCleanupPermit) => Promise<UserCleanupOutcome>
  /** 已有低层放弃入口（草稿页不使用；草稿页必须带完整原件观察）：带 expectedSeq 时只删那一份；草稿、提示与镜像目录（写入者留着，镜像目录删不掉时换成墓碑） */
  readonly abandon: (key: DraftKey, expectedSeq?: number) => Promise<AbandonOutcome>
  /**
   * 保留期（不论属于谁）：库里超过 14 天的草稿、提示，登记超过 14 天又没有草稿的写入者换成墓碑（draft-store.ts 的 purgeExpired）；
   * 主库未保留、槽位可识别且都到期的镜像与旧空目录，空用户目录，以及目录已经不在的墓碑。now 是墙上时间
   */
  readonly purgeExpired: (now: number) => Promise<PurgeOutcome>
}

export interface LocalCleanupOptions {
  readonly store: Pick<DraftStore, 'removeDraft'> & DraftMaintenanceStore
  readonly sessions: Pick<SessionStore, 'beginUserCleanup' | 'finishUserCleanup'>
  readonly directory: MirrorDirectory
  /** 墙上时间（毫秒）：墓碑的时刻 */
  readonly now: () => number
}

/** 列目录时的问题折成库那一侧的 failed（写满也一样：列目录不该写满，出现了就当作出错） */
function listingFailed(problem: Exclude<MirrorProblem, { readonly kind: 'unsupported' }>): { readonly kind: 'failed', readonly error: unknown } {
  return { kind: 'failed', error: problem.kind === 'failed' ? problem.error : new DOMException('列出镜像的目录时写满', 'QuotaExceededError') }
}

/**
 * 一个槽位文件没用了（审查 A9）：不在，或者超过保留期没动过（改动时刻在将来——时钟往回拨过——不算）。空的而刚截断过的不算：
 * 留给下一次编辑接着用，免得每次编辑都重建目录、碰 OPFS 的目录库
 */
function isStale(file: SlotFileInfo | undefined, now: number): boolean {
  return Number.isSafeInteger(now) && now >= 0 && (file === undefined || now - file.lastModified > LOCAL_DRAFT_RETENTION_MS)
}

function idOf(key: DraftKey): string {
  return JSON.stringify([key.userId, key.documentId])
}

export function createLocalCleanup(options: LocalCleanupOptions): LocalCleanup {
  const { store, directory, now } = options

  async function exclusive<T>(task: () => Promise<T>): Promise<T | StoreProblem> {
    try {
      return await withOutboxLock(task)
    }
    catch (error) {
      return { kind: 'failed', error }
    }
  }

  /** 删掉这份文档的镜像目录：删了（或者本来就不在、没有 OPFS）为真；句柄开着、出错为假（这一次跳过） */
  async function removeMirror(key: DraftKey): Promise<boolean> {
    const outcome = await directory.removeDocument(key)
    return outcome.kind === 'removed' || outcome.kind === 'unsupported'
  }

  /**
   * 镜像那一段的保留期：回收没用的文档目录与什么也不剩的用户目录。交回删不掉的文档、还有目录的文档（墓碑留着）；列不出时交回问题
   */
  async function expiredMirror(key: DraftKey, files: readonly (SlotFileInfo | undefined)[], at: number): Promise<'keep' | 'empty' | 'draft' | 'pending'> {
    if (!files.every(file => isStale(file, at)))
      return 'keep'
    if (files.every(file => file === undefined || file.size === 0))
      return 'empty'
    try {
      const read = await directory.readSlots(key)
      if (read.kind !== 'bytes')
        return 'pending'
      const slots = await Promise.all(read.files.map(async file => file === undefined ? { kind: 'empty' as const } : parseSlot(file, key)))
      // 新格式、损坏的非空内容、时间无法判断：文件时间不能代替记录的到期事实。
      if (!slots.every(slot => slot.kind === 'empty' || (slot.kind === 'valid' && shouldPurgeDraft(slot.record.updatedAt, at))))
        return 'keep'
      return slots.some(slot => slot.kind === 'valid') ? 'draft' : 'empty'
    }
    catch {
      return 'pending'
    }
  }

  async function purgeMirror(at: number, retained: ReadonlySet<string>, alreadyPurged: ReadonlySet<string>): Promise<{ readonly kind: 'done', readonly drafts: readonly PurgedDraft[], readonly pending: readonly DraftKey[], readonly remaining: ReadonlySet<string> } | { readonly kind: 'unsupported', readonly drafts: readonly PurgedDraft[] } | { readonly kind: 'failed', readonly error: unknown, readonly drafts: readonly PurgedDraft[], readonly pending: readonly DraftKey[] }> {
    const users = await directory.listUsers()
    if (users.kind === 'unsupported')
      return { kind: 'unsupported', drafts: [] }
    if (users.kind !== 'listed')
      return { ...listingFailed(users), drafts: [], pending: [] }
    const drafts: PurgedDraft[] = []
    const pending: DraftKey[] = []
    const remaining = new Set<string>()
    for (const userId of users.userIds) {
      const listed = await directory.listDocuments(userId)
      if (listed.kind === 'unsupported')
        continue
      if (listed.kind !== 'listed')
        return { ...listingFailed(listed), drafts, pending }
      let left = listed.documentIds.length
      for (const documentId of listed.documentIds) {
        const key = { userId, documentId }
        if (retained.has(idOf(key))) {
          remaining.add(idOf(key))
          continue
        }
        const files = await directory.slotFiles(key)
        if (files.kind === 'absent' || files.kind === 'unsupported') {
          left -= 1
          continue
        }
        const expiry = files.kind === 'files' ? await expiredMirror(key, files.files, at) : 'pending'
        if ((expiry === 'empty' || expiry === 'draft') && await removeMirror(key)) {
          left -= 1
          if (expiry === 'draft' && !alreadyPurged.has(idOf(key))) {
            drafts.push({ key, record: 'draft' })
            const notice = await store.recordExpiredMirror(key, at)
            if (notice.kind !== 'recorded' && notice.kind !== 'skipped')
              return { kind: 'failed', error: notice.kind === 'failed' ? notice.error : notice, drafts, pending }
          }
          continue
        }
        // 还在用的、句柄开着删不掉的、读不出的：目录还在（墓碑留着）；后两种下一次再删
        remaining.add(idOf(key))
        if (expiry !== 'keep')
          pending.push(key)
      }
      // 这个人在镜像里什么也不剩了：用户目录一并删（又有了新的文档、句柄开着时删不掉，下一次再删）
      if (left === 0)
        await directory.removeUser(userId)
    }
    return { kind: 'done', drafts, pending, remaining }
  }

  /** 整轮都在同源锁内；两次主库变更还各自在事务里核对同一清理资格。 */
  async function removeUser(permit: UserCleanupPermit): Promise<UserCleanupOutcome | StoreProblem> {
    const { userId } = permit
    const retired = await store.retireUser(permit, { now: now() })
    if (retired.kind !== 'retired')
      return retired
    const listed = await directory.listDocuments(userId)
    if (listed.kind === 'quota' || listed.kind === 'failed')
      return listingFailed(listed)
    const pending: DraftKey[] = []
    for (const documentId of listed.kind === 'listed' ? listed.documentIds : []) {
      const key = { userId, documentId }
      if (!await removeMirror(key))
        pending.push(key)
    }
    const cleared = await store.removeUserData(permit, { retire: pending.map(key => key.documentId), now: now() })
    if (cleared.kind !== 'cleared')
      return cleared
    if (pending.length > 0)
      return { kind: 'pending', pending }
    const removed = await directory.removeUser(userId)
    if (removed.kind === 'busy')
      return { kind: 'pending', pending: [] }
    if (removed.kind !== 'removed' && removed.kind !== 'unsupported')
      return removed
    const finished = await options.sessions.finishUserCleanup(permit)
    return finished.kind === 'cleared' ? { kind: 'cleared', pending: [] } : finished
  }

  return {
    beginUser: async (permit, cause) => {
      const fixed = readDraftSessionPermit(permit)
      if (fixed === undefined)
        return { kind: 'session-invalid' }
      return exclusive(async () => options.sessions.beginUserCleanup(fixed, cause))
    },
    removeUser: async (permit) => {
      const fixed = readUserCleanupPermit(permit)
      if (fixed === undefined)
        return { kind: 'invalidated' }
      const result = await exclusive(async () => removeUser(fixed))
      return result.kind === 'session-invalid' ? { kind: 'invalidated' } : result
    },

    abandon: async (key, expectedSeq) => exclusive(async (): Promise<AbandonOutcome> => {
      const removed = await store.removeDraft(key, expectedSeq)
      switch (removed.kind) {
        case 'changed':
          return { kind: 'changed' }
        case 'removed':
        case 'absent': {
          if (await removeMirror(key)) {
            // 镜像目录没了：早先因为它删不掉而立的墓碑一并删（删不掉就留着，保留期再删）
            await store.dropTombstones([key])
            return { kind: removed.kind, pending: [] }
          }
          // 镜像目录删不掉（编辑器页的发件箱 Worker 正拿着句柄）：写入者换成墓碑，那一页写不进去，镜像里的也写不回来
          const retired = await store.retireWriter(key, { now: now() })
          return retired.kind === 'retired' ? { kind: removed.kind, pending: [key] } : retired
        }
        case 'quota':
        case 'session-invalid':
        case 'unavailable':
        case 'failed':
          return removed
      }
    }),

    purgeExpired: async at => exclusive(async (): Promise<PurgeOutcome> => {
      const purged = await store.purgeExpired(at)
      if (purged.kind !== 'purged')
        return purged
      const mirrored = await purgeMirror(at, new Set(purged.retained.map(idOf)), new Set(purged.drafts.map(draft => idOf(draft.key))))
      const drafts = [...purged.drafts, ...mirrored.drafts]
      if (mirrored.kind === 'failed')
        return { kind: 'purged', drafts, pending: mirrored.pending, mirror: { kind: 'failed', error: mirrored.error } }
      // 墓碑：这份文档的镜像目录已经不在了（没有 OPFS 时一律不在）就删掉
      const tombstones = await store.listTombstones()
      const remaining = mirrored.kind === 'done' ? mirrored.remaining : new Set<string>()
      const pending = mirrored.kind === 'done' ? mirrored.pending : []
      if (tombstones.kind !== 'tombstones')
        return { kind: 'purged', drafts, pending, mirror: { kind: 'failed', error: tombstones.kind === 'failed' ? tombstones.error : tombstones } }
      const dropped = await store.dropTombstones(tombstones.keys.filter(key => !remaining.has(idOf(key))))
      if (dropped.kind !== 'dropped')
        return { kind: 'purged', drafts, pending, mirror: { kind: 'failed', error: dropped.kind === 'failed' ? dropped.error : dropped } }
      return { kind: 'purged', drafts, pending, mirror: { kind: 'done' } }
    }),
  }
}

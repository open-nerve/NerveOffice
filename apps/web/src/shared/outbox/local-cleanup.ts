// 本机草稿的清理（M4-P1 设计 §3.4.7、§3.8）：库（草稿、写入者、提示）与 OPFS 镜像的目录一起清——"两份一起清"只写在这里。
// 页面里用（P4 只调它：退出登录、账户停用、本机草稿页的放弃、保留期）：不拿同步访问句柄，只删目录、经 getFile 看槽位文件的大小与改动时刻
// （mirror-directory.ts）。P4 的本机草稿页列出与清理之前先比对（draft-recovery.ts 的 pageReconciliation 与 reconcileAll，审查 A18），
// 删库之后只在镜像里的草稿先写回库，列出、清理就都看得见。编辑器页放弃自己正写着的草稿走 DraftWriter.remove（发件箱 Worker 拿着句柄，
// 截断两个槽位，之后接着写）。
//
// 镜像目录有句柄开着（编辑器页的发件箱 Worker 正写着这份文档）时删不了，也可能一时出错：这一次跳过它，结果里的 pending 列出没清掉的文档。
// 跳过的那几份把写入者换成墓碑（审查 A1、A6，writer-fence.ts 的 RETIRED_WRITER_ID）：高水位留着，那一页之后的写入、重封、确认一律
// not-writer（它的 Worker 随之放开句柄、页面经服务端核对再决定），比对时库里有墓碑就不从镜像写回。
// - 按用户清理：跳过的那几份草稿与提示留着、写入者换成墓碑；之后再调 removeUser 接着清（连墓碑一起删）——只在这个人仍是退出的时候
//   （同一个人又登录了就不再清，他的草稿照常用）。
// - 放弃：库里的草稿与提示照删，写入者换成墓碑；不必再调 abandon（再调会删掉那一页之后新写的）：镜像在下一次比对时被截断（墓碑挡住写回），
//   目录与墓碑由保留期回收。
// - 保留期：只回收没用的目录（两个槽位都超过 14 天没动过，或者文件不在：审查 A9，刚截断的空目录留给下一次编辑，平时不碰 OPFS 的目录库），
//   删不掉的下一次再删；镜像目录已经不在的文档，墓碑一并删掉。随时可以再调。
// 发件箱 Worker 不引用这个文件（Worker 里镜像的句柄由 draft-mirror.ts 管）；不引用 zod
import type { DraftKey } from './draft-record.ts'
import type { DraftStore, PurgedDraft, StoreProblem } from './draft-store.ts'
import type { MirrorDirectory, MirrorProblem, SlotFileInfo } from './mirror-directory.ts'
import { LOCAL_DRAFT_RETENTION_MS } from './writer-fence.ts'

/** 按用户清理：pending 是这一次没清掉的文档（草稿与提示留着、写入者换成了墓碑），之后再调接着清；空的就是清完了 */
export type UserCleanupOutcome = { readonly kind: 'cleared', readonly pending: readonly DraftKey[] } | StoreProblem

/**
 * 放弃一份：库里删了（或者本来就没有）；pending 里有它时是镜像目录这一次没删掉（写入者换成了墓碑，不必再调，见文件开头）；
 * changed 是库里已经不是那一份
 */
export type AbandonOutcome
  = | { readonly kind: 'removed' | 'absent', readonly pending: readonly DraftKey[] }
    | { readonly kind: 'changed' }
    | StoreProblem

/**
 * 保留期：drafts 是库里删掉的草稿（属于当前用户的由 P4 说明）；pending 是这一次没删掉的镜像目录（下一次保留期再删）；
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
  /** 按用户清理（退出登录、账户停用）：这个人的草稿、写入者（含墓碑）、提示与镜像目录 */
  readonly removeUser: (userId: string) => Promise<UserCleanupOutcome>
  /** 放弃一份（本机草稿页，用户的决定）：带 expectedSeq 时只删那一份；草稿、提示与镜像目录（写入者留着，镜像目录删不掉时换成墓碑） */
  readonly abandon: (key: DraftKey, expectedSeq?: number) => Promise<AbandonOutcome>
  /**
   * 保留期（不论属于谁）：库里超过 14 天的草稿、提示，登记超过 14 天又没有草稿的写入者换成墓碑（draft-store.ts 的 purgeExpired）；
   * 镜像里没用的文档目录（两个槽位都超过 14 天没动过，或者文件不在），什么也不剩的用户目录；镜像目录已经不在的文档的墓碑。now 是墙上时间
   */
  readonly purgeExpired: (now: number) => Promise<PurgeOutcome>
}

export interface LocalCleanupOptions {
  readonly store: DraftStore
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
  return file === undefined || now - file.lastModified > LOCAL_DRAFT_RETENTION_MS
}

function idOf(key: DraftKey): string {
  return JSON.stringify([key.userId, key.documentId])
}

export function createLocalCleanup(options: LocalCleanupOptions): LocalCleanup {
  const { store, directory, now } = options

  /** 删掉这份文档的镜像目录：删了（或者本来就不在、没有 OPFS）为真；句柄开着、出错为假（这一次跳过） */
  async function removeMirror(key: DraftKey): Promise<boolean> {
    const outcome = await directory.removeDocument(key)
    return outcome.kind === 'removed' || outcome.kind === 'unsupported'
  }

  /**
   * 镜像那一段的保留期：回收没用的文档目录与什么也不剩的用户目录。交回删不掉的文档、还有目录的文档（墓碑留着）；列不出时交回问题
   */
  async function purgeMirror(at: number): Promise<{ readonly kind: 'done', readonly pending: readonly DraftKey[], readonly remaining: ReadonlySet<string> } | { readonly kind: 'unsupported' } | { readonly kind: 'failed', readonly error: unknown, readonly pending: readonly DraftKey[] }> {
    const users = await directory.listUsers()
    if (users.kind === 'unsupported')
      return { kind: 'unsupported' }
    if (users.kind !== 'listed')
      return { ...listingFailed(users), pending: [] }
    const pending: DraftKey[] = []
    const remaining = new Set<string>()
    for (const userId of users.userIds) {
      const listed = await directory.listDocuments(userId)
      if (listed.kind === 'unsupported')
        continue
      if (listed.kind !== 'listed')
        return { ...listingFailed(listed), pending }
      let left = listed.documentIds.length
      for (const documentId of listed.documentIds) {
        const key = { userId, documentId }
        const files = await directory.slotFiles(key)
        if (files.kind === 'absent' || files.kind === 'unsupported') {
          left -= 1
          continue
        }
        if (files.kind === 'files' && files.files.every(file => isStale(file, at)) && await removeMirror(key)) {
          left -= 1
          continue
        }
        // 还在用的、句柄开着删不掉的、读不出的：目录还在（墓碑留着）；后两种下一次再删
        remaining.add(idOf(key))
        if (files.kind !== 'files' || files.files.every(file => isStale(file, at)))
          pending.push(key)
      }
      // 这个人在镜像里什么也不剩了：用户目录一并删（又有了新的文档、句柄开着时删不掉，下一次再删）
      if (left === 0)
        await directory.removeUser(userId)
    }
    return { kind: 'done', pending, remaining }
  }

  return {
    removeUser: async (userId) => {
      const listed = await directory.listDocuments(userId)
      if (listed.kind === 'quota' || listed.kind === 'failed')
        return listingFailed(listed)
      const pending: DraftKey[] = []
      for (const documentId of listed.kind === 'listed' ? listed.documentIds : []) {
        const key = { userId, documentId }
        if (!await removeMirror(key))
          pending.push(key)
      }
      // 镜像目录删不掉的那几份：草稿与提示留着、写入者换成墓碑（那一页之后写不进去，比对时也不从镜像写回）
      const cleared = await store.removeUserData(userId, { retire: pending.map(key => key.documentId), now: now() })
      if (cleared.kind !== 'cleared')
        return cleared
      if (pending.length === 0)
        await directory.removeUser(userId)
      return { kind: 'cleared', pending }
    },

    abandon: async (key, expectedSeq) => {
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
        case 'unavailable':
        case 'failed':
          return removed
      }
    },

    purgeExpired: async (at) => {
      const purged = await store.purgeExpired(at)
      if (purged.kind !== 'purged')
        return purged
      const mirrored = await purgeMirror(at)
      if (mirrored.kind === 'failed')
        return { kind: 'purged', drafts: purged.drafts, pending: mirrored.pending, mirror: { kind: 'failed', error: mirrored.error } }
      // 墓碑：这份文档的镜像目录已经不在了（没有 OPFS 时一律不在）就删掉
      const tombstones = await store.listTombstones()
      const remaining = mirrored.kind === 'done' ? mirrored.remaining : new Set<string>()
      const pending = mirrored.kind === 'done' ? mirrored.pending : []
      if (tombstones.kind !== 'tombstones')
        return { kind: 'purged', drafts: purged.drafts, pending, mirror: { kind: 'failed', error: tombstones.kind === 'failed' ? tombstones.error : tombstones } }
      const dropped = await store.dropTombstones(tombstones.keys.filter(key => !remaining.has(idOf(key))))
      if (dropped.kind !== 'dropped')
        return { kind: 'purged', drafts: purged.drafts, pending, mirror: { kind: 'failed', error: dropped.kind === 'failed' ? dropped.error : dropped } }
      return { kind: 'purged', drafts: purged.drafts, pending, mirror: { kind: 'done' } }
    },
  }
}

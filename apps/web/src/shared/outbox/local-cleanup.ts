// 本机草稿的清理（M4-P1 设计 §3.4.7、§3.8）：库（草稿、写入者、提示）与 OPFS 镜像的目录一起清——"两份一起清"只写在这里。
// 页面里用（P4 只调它：退出登录、账户停用、本机草稿页的放弃、保留期）：不拿同步访问句柄，只删目录、看槽位文件的大小与改动时刻
// （mirror-directory.ts）。编辑器页的发件箱 Worker 放弃自己正写着的草稿走 DraftWriter.remove（它拿着句柄，截断两个槽位，之后接着写）。
//
// 镜像的目录有句柄开着（别的标签页、发件箱 Worker 正拿着）时删不了，也可能一时出错：这一次跳过它，结果里的 pending 列出没清掉的文档，
// 由调用方之后再清。为免把该删的写回来，三个操作各自这样处理：
// - 按用户清理：删不掉镜像目录的那几份文档，库里的草稿、写入者与提示也留着（库里删了、镜像还在的话，这个人下一次登录时比对会把它写回来）；
//   之后再调 removeUser 接着清——只在这个人仍是退出的时候（同一个人又登录了就不再清，他的草稿照常用）。
// - 放弃：库里照删（写入者留着，它的高水位挡住镜像里那一份被写回：decideRestore 的 seen），镜像目录删不掉的不必再调：下一次比对时
//   截断它（draft-writer.ts），之后保留期回收空了的目录。
// - 保留期：只删没用的目录（两个槽位都空，或者都超过保留期没动过），删不掉的下一次保留期再删；随时可以再调。
// 发件箱 Worker 不引用这个文件（Worker 里镜像的句柄由 draft-mirror.ts 管）；不引用 zod
import type { DraftKey } from './draft-record.ts'
import type { DraftStore, PurgedDraft, StoreProblem } from './draft-store.ts'
import type { MirrorDirectory, MirrorProblem, SlotFileInfo } from './mirror-directory.ts'
import { LOCAL_DRAFT_RETENTION_MS } from './writer-fence.ts'

/** 按用户清理：pending 是这一次没清掉的文档（库里与镜像里都还留着），之后再调接着清；空的就是清完了 */
export type UserCleanupOutcome = { readonly kind: 'cleared', readonly pending: readonly DraftKey[] } | StoreProblem

/** 放弃一份：库里删了（或者本来就没有），pending 里有它时是镜像目录这一次没删掉（不必再调，见文件开头）；changed 是库里已经不是那一份 */
export type AbandonOutcome
  = | { readonly kind: 'removed' | 'absent', readonly pending: readonly DraftKey[] }
    | { readonly kind: 'changed' }
    | StoreProblem

/** 保留期：drafts 是库里删掉的草稿（属于当前用户的由 P4 说明）；pending 是这一次没删掉的镜像目录（下一次保留期再删） */
export type PurgeOutcome = { readonly kind: 'purged', readonly drafts: readonly PurgedDraft[], readonly pending: readonly DraftKey[] } | StoreProblem

export interface LocalCleanup {
  /** 按用户清理（退出登录、账户停用）：这个人的草稿、写入者、提示与镜像目录 */
  readonly removeUser: (userId: string) => Promise<UserCleanupOutcome>
  /** 放弃一份（本机草稿页，用户的决定）：带 expectedSeq 时只删那一份；草稿、提示与镜像目录（写入者留着） */
  readonly abandon: (key: DraftKey, expectedSeq?: number) => Promise<AbandonOutcome>
  /**
   * 保留期（不论属于谁）：库里超过 14 天的草稿、写入者与提示（draft-store.ts 的 purgeExpired），以及镜像里没用的文档目录——两个槽位都空
   * （确认删掉、放弃、截断过的），或者都超过 14 天没动过；镜像里什么也不剩的用户目录一并删。now 是墙上时间（毫秒）
   */
  readonly purgeExpired: (now: number) => Promise<PurgeOutcome>
}

export interface LocalCleanupOptions {
  readonly store: DraftStore
  readonly directory: MirrorDirectory
}

/** 列目录时的问题折成库那一侧的 failed（写满也一样：列目录不该写满，出现了就当作出错） */
function listingFailed(problem: Exclude<MirrorProblem, { readonly kind: 'unsupported' }>): StoreProblem {
  return { kind: 'failed', error: problem.kind === 'failed' ? problem.error : new DOMException('列出镜像的目录时写满', 'QuotaExceededError') }
}

/** 一个槽位文件没用了：不在、空的（截断为 0）、超过保留期没动过（改动时刻在将来——时钟往回拨过——不算） */
function isUseless(file: SlotFileInfo | undefined, now: number): boolean {
  return file === undefined || file.size === 0 || now - file.lastModified > LOCAL_DRAFT_RETENTION_MS
}

export function createLocalCleanup(options: LocalCleanupOptions): LocalCleanup {
  const { store, directory } = options

  /** 删掉这份文档的镜像目录：删了（或者本来就不在、没有 OPFS）为真；句柄开着、出错为假（这一次跳过） */
  async function removeMirror(key: DraftKey): Promise<boolean> {
    const outcome = await directory.removeDocument(key)
    return outcome.kind === 'removed' || outcome.kind === 'unsupported'
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
      // 镜像目录删不掉的那几份，库里的也留着：库里删了、镜像还在的话，下一次比对会把它写回来
      const cleared = await store.removeUserData(userId, { keepDocumentIds: pending.map(key => key.documentId) })
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
        case 'absent':
          return { kind: removed.kind, pending: await removeMirror(key) ? [] : [key] }
        case 'quota':
        case 'unavailable':
        case 'failed':
          return removed
      }
    },

    purgeExpired: async (now) => {
      const purged = await store.purgeExpired(now)
      if (purged.kind !== 'purged')
        return purged
      const users = await directory.listUsers()
      if (users.kind === 'quota' || users.kind === 'failed')
        return listingFailed(users)
      const pending: DraftKey[] = []
      for (const userId of users.kind === 'listed' ? users.userIds : []) {
        const listed = await directory.listDocuments(userId)
        if (listed.kind === 'quota' || listed.kind === 'failed')
          return listingFailed(listed)
        if (listed.kind !== 'listed')
          continue
        let remaining = listed.documentIds.length
        for (const documentId of listed.documentIds) {
          const key = { userId, documentId }
          const files = await directory.slotFiles(key)
          if (files.kind === 'absent' || files.kind === 'unsupported') {
            remaining -= 1
            continue
          }
          if (files.kind !== 'files') {
            pending.push(key)
            continue
          }
          if (!files.files.every(file => isUseless(file, now)))
            continue
          if (await removeMirror(key))
            remaining -= 1
          else
            pending.push(key)
        }
        // 这个人在镜像里什么也不剩了：用户目录一并删（又有了新的文档、句柄开着时删不掉，下一次再删）
        if (remaining === 0)
          await directory.removeUser(userId)
      }
      return { kind: 'purged', drafts: purged.drafts, pending }
    },
  }
}

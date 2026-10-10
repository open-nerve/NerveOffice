// 比对 OPFS 镜像与库（M4-P1 设计 §3.8；审查 A19 从写入管道拆出：写入管道只负责写，比对的策略在这里）。
// - 谁胜出（审查 A2 与它的订正）：镜像里最新写的那一份（代号最大的合格槽位，不按代次）与库里比，判定在存储的事务里（writer-fence.ts 的
//   decideRestore：按库里写入者的高水位与代次——库里的写入者看过它（序号不大于高水位）就不写回，库丢了更新的那次登记就写回并换成它的写入者，
//   墓碑挡住写回）；这里先按库里的草稿与镜像里那一份判断要不要交给存储（reconcileAction），常见的"两边是同一版本"不开读写的事务。
// - 写回之外：库里是墓碑时截断镜像；镜像过时（库里的写入者看过它、超过保留期）而库里有草稿时，本页是写入者就补写（镜像跟上库），不是就截断；
//   库里没有草稿时截断（不让确认删掉、放弃过的在删库之后复活）；库里的胜出、而本页是写入者（拿着句柄）时补写镜像；两个槽位都不合格、
//   库里连草稿带写入者都没了时留下 lost 提示，之后截断这两个没用的槽位。
// - 读草稿、登记时交回哪一份（versionsToOpen，审查 A3）：写回了就是写回的那一份，否则库里的，库用不了时镜像里最新写的；同一个版本在库与
//   镜像里各有一份时都交回（解不开的那一份换同一版本的另一份），不退回更旧的版本。
// - 槽位里有更新的页面写的（部署回滚之后，复验 C2）：整个镜像按认不出处理——不写回、不留 lost、不截断、不补写，读时也不拿它顶替库。
// - 比对没做完（unfinishedOf，复验 C1）：写回、核对丢失时库出了问题，读库出了问题而镜像里有要比对的，读镜像出错。登记与比对一份时
//   如实交回、不往下做（draft-writer.ts）；读草稿照旧交回能读出的那一份。
// 依赖经接口注入：发件箱 Worker 里是镜像（draft-mirror.ts：同步访问句柄，能截断、补写）；平台页面（P4 的本机草稿页列出与清理之前先比对，
// 审查 A18）是只读的镜像（pageMirror：经 getFile 读，不截断、不补写——截断留给编辑器页的比对，没用的目录由保留期回收），只写回、不留
// lost（截断不了槽位，留了之后每次比对都会再留一遍；lost 由编辑器页的发件箱 Worker 留下）。
// 打开平台时一份一份地比对（reconcileAll，审查 A13）：每份一个请求，一份出错不拖累别的。发件箱 Worker 也引用这个文件：不引用 zod
import type { MirrorRead, MirrorStatus } from './draft-mirror.ts'
import type { DraftKey, StoredDraft } from './draft-record.ts'
import type { DraftStore, StoreProblem, StoreReadOutcome } from './draft-store.ts'
import type { FailureDescription } from './failure.ts'
import type { MirrorDirectory } from './mirror-directory.ts'
import { describeFailure } from './failure.ts'
import { hasNewerFormatSlot, parseSlot } from './mirror-slot.ts'
import { withOutboxLock } from './outbox-lock.ts'
import { compareDrafts, isSameWriter } from './writer-fence.ts'

/** 比对用到的镜像：读两个槽位（记录核对是这份文档的）、截断、补写（拿着句柄时；没拿着交回 undefined） */
export interface RecoveryMirror {
  readonly read: (key: DraftKey) => Promise<MirrorRead>
  readonly clear: (key: DraftKey) => Promise<MirrorStatus>
  readonly backfill: (record: StoredDraft) => Promise<MirrorStatus | undefined>
}

/** 比对用到的存储 */
export type RecoveryStore = Pick<DraftStore, 'readDraft' | 'restoreDraft' | 'recordLost'>

/**
 * 比对之后：镜像读出的样子（截断了的为 undefined：里面的不再算数）、写回库的那一份（没写回为 undefined）；写回、核对丢失时库出了问题
 * （写满、用不了）时带上它——读草稿如实交回，不拿镜像里的那一份顶替（它胜不胜出要库里的写入者来定）；读库出了问题、镜像里却有要比对的
 * 时带上 unread（读草稿交回镜像里最新写的那一份顶替：读得出总比读不出好；登记、比对一份时算没做完）
 */
export interface Reconciled {
  readonly mirror: MirrorRead | undefined
  readonly restored: StoredDraft | undefined
  readonly problem?: StoreProblem
  readonly unread?: StoreProblem
}

export interface DraftRecovery {
  /** 比对这份文档（读草稿、登记之前；打开平台、本机草稿页列出之前）。stored：已经读出的库里那一条（读草稿时；不再读一次） */
  readonly reconcile: (key: DraftKey, stored?: StoreReadOutcome) => Promise<Reconciled>
}

export interface DraftRecoveryOptions {
  readonly store: RecoveryStore
  readonly mirror: RecoveryMirror
  /** 墙上时间（毫秒）：保留期、提示的时刻 */
  readonly now: () => number
  /** 无法恢复时留不留 lost（默认留；平台页面只读比对，不留） */
  readonly noteLost?: boolean
}

/** 两个槽位里合格的记录，最新写的（代号大的）在前；有更新的页面写的槽位时没有（整个镜像认不出：不拿更旧的顶替，复验 C2） */
export function mirroredRecords(read: MirrorRead | undefined): readonly StoredDraft[] {
  if (read?.kind !== 'slots' || hasNewerFormatSlot(read.slots))
    return []
  return read.slots
    .flatMap(slot => (slot.kind === 'valid' ? [slot] : []))
    .sort((a, b) => b.header.generation - a.header.generation)
    .map(slot => slot.record)
}

/** 有没有写一半、对不上的槽位（更新的页面写的不算：审查 A8、A10；有它时整个镜像认不出，比对之前就交回了） */
function hasTornSlot(read: Extract<MirrorRead, { readonly kind: 'slots' }>): boolean {
  return read.slots.some(slot => slot.kind === 'invalid' && slot.reason !== 'newer-format')
}

/** 同一个版本：同一个写入者、先后相等（同一份内容的同一次封装，库与镜像各存一份） */
function isSameVersion(a: StoredDraft, b: StoredDraft): boolean {
  return isSameWriter(a, b) && compareDrafts(a, b) === 0
}

/**
 * 比对要做什么（只看库里的草稿与镜像里最新写的那一份；要不要写回最终由存储按库里当前的写入者判定）：
 * - none：库用不了、库里那一条认不出（更新的页面写的、形状不对：不动它）；两边是同一个版本；镜像里没有合格的、库里也没有草稿、
 *   也没有写一半的槽位；
 * - restore：库里没有草稿；同一个写入者而镜像的更新；或者是别的写入者写的（交给存储按库里当前的写入者判定，多半是 foreign）；
 * - backfill：库里那一份胜出——镜像里没有合格的，或者同一个写入者而镜像的更旧；
 * - lost：镜像里没有合格的、有写一半或对不上的槽位、库里没有草稿（交给存储核对连写入者都没了）
 */
export type ReconcileAction = 'none' | 'restore' | 'backfill' | 'lost'

export function reconcileAction(stored: StoreReadOutcome, latest: StoredDraft | undefined, torn: boolean): ReconcileAction {
  switch (stored.kind) {
    case 'quota':
    case 'unavailable':
    case 'failed':
    case 'newer-format':
    case 'malformed':
      return 'none'
    case 'absent':
      if (latest !== undefined)
        return 'restore'
      return torn ? 'lost' : 'none'
    case 'draft': {
      if (latest === undefined)
        return 'backfill'
      if (!isSameWriter(stored.draft, latest))
        return 'restore'
      const order = compareDrafts(latest, stored.draft)
      if (order === 0)
        return 'none'
      return order > 0 ? 'restore' : 'backfill'
    }
  }
}

/**
 * 比对没做完（复验 C1）：写回、核对丢失时库出了问题；读库出了问题而镜像里有要比对的；读镜像出错（交回 MirrorUnreadable，名字与
 * 消息里带着原来的错误）。没做完时登记不往下做——新登记的写入者继承的高水位没看过镜像里那一份，草稿序号这条线就分叉了；比对一份也
 * 如实交回（之后再比对它）。镜像被占着（busy）、不在、用不了不算：见 draft-writer.ts 的 register
 */
export function unfinishedOf(reconciled: Reconciled): StoreProblem | undefined {
  if (reconciled.problem !== undefined)
    return reconciled.problem
  if (reconciled.unread !== undefined)
    return reconciled.unread
  if (reconciled.mirror?.kind === 'failed') {
    const { name, message } = reconciled.mirror.error
    return { kind: 'failed', error: { name: 'MirrorUnreadable', message: `读不出镜像（${name}：${message}）` } }
  }
  return undefined
}

/** 只打开选定版本：恢复成功的优先，否则库里的优先；同一版本的镜像可补主库坏掉的密文，不退回旧版本。 */
export function versionsToOpen(stored: StoreReadOutcome, reconciled: Reconciled): readonly StoredDraft[] {
  const mirrored = mirroredRecords(reconciled.mirror)
  let primary: StoredDraft | undefined
  if (reconciled.restored !== undefined)
    primary = reconciled.restored
  else if (stored.kind === 'draft')
    primary = stored.draft
  else if (stored.kind === 'quota' || stored.kind === 'unavailable' || stored.kind === 'failed')
    primary = mirrored[0]
  if (primary === undefined)
    return []
  const version = primary
  return [version, ...mirrored.filter(record => record !== version && isSameVersion(record, version))]
}

export function createDraftRecovery(options: DraftRecoveryOptions): DraftRecovery {
  const { store, mirror, now } = options
  const noteLost = options.noteLost ?? true

  /** 补写：拿着句柄（本页是写入者）时为真（写成没写成都算：镜像这一次落后着，下一次写入、登记照常追上） */
  async function backfill(record: StoredDraft): Promise<boolean> {
    try {
      return await mirror.backfill(record) !== undefined
    }
    catch {
      return true
    }
  }

  /** 截断镜像：里面的不再算数 */
  async function clear(key: DraftKey): Promise<Reconciled> {
    await mirror.clear(key)
    return { mirror: undefined, restored: undefined }
  }

  return {
    reconcile: async (key, stored) => {
      const read = await mirror.read(key)
      if (read.kind !== 'slots')
        return { mirror: read, restored: undefined }
      // 更新的页面写的槽位（复验 C2）：整个镜像认不出，不动它（不读库）
      if (hasNewerFormatSlot(read.slots))
        return { mirror: read, restored: undefined }
      const latest = mirroredRecords(read)[0]
      const torn = hasTornSlot(read)
      // 镜像里什么也没有（空的槽位）：不读库
      if (latest === undefined && !torn)
        return { mirror: read, restored: undefined }
      const current = stored ?? await store.readDraft(key)
      if (current.kind === 'quota' || current.kind === 'unavailable' || current.kind === 'failed')
        return { mirror: read, restored: undefined, unread: current }
      const kept: Reconciled = { mirror: read, restored: undefined }
      switch (reconcileAction(current, latest, torn)) {
        case 'none':
          return kept
        case 'backfill':
          if (current.kind === 'draft')
            await backfill(current.draft)
          return kept
        case 'restore': {
          if (latest === undefined)
            return kept
          const outcome = await store.restoreDraft(latest, { now: now(), noteLost })
          if (outcome.kind === 'restored')
            return { mirror: read, restored: latest }
          if (outcome.kind !== 'kept')
            return { ...kept, problem: outcome }
          // 库里是墓碑：镜像里的是该删的，截断它
          if (outcome.reason === 'retired')
            return clear(key)
          // 库里的胜出：本页是写入者时补写，镜像跟上库
          if (current.kind === 'draft' && await backfill(current.draft))
            return kept
          // 镜像过时（库里的写入者看过它、超过保留期）：截断它，里面的不再算数——库里没有草稿时不让确认删掉、放弃过的在删库之后复活。
          // 别的（foreign、unseen——库里已留下 lost 提示——、not-newer）不截断：镜像里那一份留给库里的写入者写镜像时盖掉
          if (outcome.reason === 'seen' || outcome.reason === 'expired')
            return clear(key)
          return kept
        }
        case 'lost': {
          if (!noteLost)
            return kept
          const lost = await store.recordLost(key, { now: now() })
          if (lost.kind !== 'noted' && lost.kind !== 'kept')
            return { ...kept, problem: lost }
          // 核对过了（留下了 lost，或者草稿是被删掉的）：截断这两个没用的槽位，之后不再重复核对、重复留提示
          return clear(key)
        }
      }
    },
  }
}

/**
 * 平台页面里用的只读镜像（P4 的本机草稿页列出与清理之前比对，审查 A18）：经 getFile 读两个槽位（发件箱 Worker 正写着时读到写一半的，
 * 按格式校验落选），不截断（交回 not-mirrored：截断留给编辑器页的比对，没用的目录由保留期回收）、不补写
 */
export function pageMirror(directory: MirrorDirectory): RecoveryMirror {
  return {
    read: async (key) => {
      const outcome = await directory.readSlots(key)
      switch (outcome.kind) {
        case 'bytes': {
          const [a, b] = outcome.files
          return { kind: 'slots', slots: [a === undefined ? { kind: 'empty' } : await parseSlot(a, key), b === undefined ? { kind: 'empty' } : await parseSlot(b, key)] }
        }
        case 'absent':
        case 'busy':
        case 'unsupported':
          return { kind: outcome.kind }
        case 'quota':
          return { kind: 'failed', error: { name: 'QuotaExceededError', message: '读镜像时写满' } }
        case 'failed':
          return { kind: 'failed', error: describeFailure(outcome.error) }
      }
    },
    clear: async () => ({ kind: 'not-mirrored', reason: 'unsupported' }),
    backfill: async () => undefined,
  }
}

/**
 * 一份一份地比对：列出这个人在镜像里的文档、比对一份（DraftWriter 就是一个；发件箱 Worker 的客户端里各是一个请求）。
 * 比对的结果不是 reconciled 的都算这一份出了错（写满、库用不了、出错）
 */
export interface MirroredDocuments {
  readonly mirroredDocuments: (userId: string) => Promise<{ readonly kind: 'listed', readonly documentIds: readonly string[] } | { readonly kind: 'failed', readonly error: FailureDescription }>
  readonly reconcile: (key: DraftKey) => Promise<{ readonly kind: string }>
}

/** 比对了几份；哪几份出了错（一份出错不拖累别的，之后再比对它们）；列不出镜像里的文档时是 failed */
export type ReconcileAllOutcome
  = | { readonly kind: 'reconciled', readonly documents: number, readonly failed: readonly DraftKey[] }
    | { readonly kind: 'failed', readonly error: FailureDescription }

/**
 * 打开平台、本机草稿页列出之前，比对这个人在镜像里的每份文档（审查 A13）：一份一份地来，每份一个请求（各有各的看门狗时限），
 * 一份出错照样比对别的
 */
export async function reconcileAll(source: MirroredDocuments, userId: string): Promise<ReconcileAllOutcome> {
  const listed = await source.mirroredDocuments(userId)
  if (listed.kind === 'failed')
    return listed
  const failed: DraftKey[] = []
  for (const documentId of listed.documentIds) {
    const key = { userId, documentId }
    if ((await source.reconcile(key)).kind !== 'reconciled')
      failed.push(key)
  }
  return { kind: 'reconciled', documents: listed.documentIds.length, failed }
}

/**
 * 平台页面里的比对来源（P4）：存储与只读的镜像组成的比对（pageMirror），列出用镜像的目录。比对没做完（unfinishedOf）的那一份算出错，
 * 比对时出的意外折成 failed，不抛出
 */
export function pageReconciliation(options: { readonly store: RecoveryStore, readonly directory: MirrorDirectory, readonly now: () => number }): MirroredDocuments {
  const recovery = createDraftRecovery({ store: options.store, mirror: pageMirror(options.directory), now: options.now, noteLost: false })
  return {
    mirroredDocuments: async (userId) => {
      const listed = await options.directory.listDocuments(userId)
      switch (listed.kind) {
        case 'listed':
          return listed
        case 'unsupported':
          return { kind: 'listed', documentIds: [] }
        case 'quota':
          return { kind: 'failed', error: { name: 'QuotaExceededError', message: '列出镜像的文档时写满' } }
        case 'failed':
          return { kind: 'failed', error: describeFailure(listed.error) }
      }
    },
    reconcile: async (key) => {
      try {
        return await withOutboxLock(async () => unfinishedOf(await recovery.reconcile(key)) ?? { kind: 'reconciled' })
      }
      catch (error) {
        return { kind: 'failed', error: describeFailure(error) }
      }
    },
  }
}

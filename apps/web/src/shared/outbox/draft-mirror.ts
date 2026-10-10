// OPFS 的镜像（M4-P1 设计 §3.8）：IndexedDB 仍是主存储，每次在它里面写成之后，同一份记录再写进这份文档的两个槽位之一，作为崩溃之后的备份
// （Chromium 崩溃重开时可能删掉整个来源的 IndexedDB，S7 的调查）。
// - 句柄由写入者持有：登记时建好两个槽位文件、拿着它们的同步访问句柄（attach），失去写入者身份、页面离开时放开（detach、close）；
//   别的标签页占着时拿不到（busy），按退避再试，期间镜像暂缺——写入照旧写 IndexedDB，结果里带上"镜像没写成"。
// - 两个槽位轮流写：每次写在"现在不是最新那一份"的槽位上，原地改写：截断 → 写内容 → 写头 → flush（槽位格式见 mirror-slot.ts）。
//   写一半（被结束、写满、出错）的那一个校验不过、落选，另一个槽位上的上一份还在。
// - 草稿删掉时两个都截断为 0（clear）；读时两个都读、都校验（read），由写入管道与 IndexedDB 那一份比较、取最新的。
// - 补写（backfill）：镜像在 IndexedDB 提交之后才写，被结束在两者之间时镜像落后一份；写入者登记时库里那一份不是镜像里最新写的那一份
//   （别的写入者的、同一个写入者更旧的、没有），就补写它（审查 A2：库里有当前的写入者时库是准的）。
// - 读出的记录核对是这份文档的（审查 A4）。
// - 槽位里有更新的页面写的（槽位或记录的格式更新：部署回滚之后，复验 C2）：这一页认不出，这份文档不写、不补写、不截断镜像，
//   结果如实带上 newer-format，不盖掉更新的页面写的那一份（放开句柄之后再登记时重新看）。
// 跨边界不抛异常：结果都带 kind；未知的错误折成名字与消息。只在发件箱 Worker 里用（同步访问句柄只在专用 Worker 里有）；不引用 zod
import type { DraftKey, DraftMeta, StoredDraft } from './draft-record.ts'
import type { FailureDescription } from './failure.ts'
import type { MirrorDirectory, SlotHandle } from './mirror-directory.ts'
import type { SlotRead } from './mirror-slot.ts'
import { describeFailure } from './failure.ts'
import { encodeSlot, hasNewerFormatSlot, newestSlot, parseSlot, SLOT_HEADER_BYTES } from './mirror-slot.ts'
import { compareDrafts, isSameWriter } from './writer-fence.ts'

/**
 * 镜像这一次写成了没有：
 * - mirrored：写成了（截断也算）；
 * - off：这个宿主不做镜像（进程内放置：Worker 起不来时的退路，设计 §3.8 的"放置"一条）；
 * - not-mirrored：别的标签页占着句柄（busy）、写满、OPFS 用不了、槽位里有更新的页面写的（newer-format：这一页不动它，复验 C2）、
 *   出错——IndexedDB 那一份不受影响
 */
export type MirrorStatus
  = | { readonly kind: 'mirrored' }
    | { readonly kind: 'off' }
    | { readonly kind: 'not-mirrored', readonly reason: 'busy' | 'quota' | 'unsupported' | 'newer-format' }
    | { readonly kind: 'not-mirrored', readonly reason: 'failed', readonly error: FailureDescription }

/** 读出的两个槽位；文件不在；别的标签页占着；OPFS 用不了；出错 */
export type MirrorRead
  = | { readonly kind: 'slots', readonly slots: readonly [SlotRead, SlotRead] }
    | { readonly kind: 'absent' }
    | { readonly kind: 'busy' }
    | { readonly kind: 'unsupported' }
    | { readonly kind: 'failed', readonly error: FailureDescription }

export type MirrorDocuments
  = | { readonly kind: 'listed', readonly documentIds: readonly string[] }
    | { readonly kind: 'unsupported' }
    | { readonly kind: 'failed', readonly error: FailureDescription }

export interface DraftMirror {
  /**
   * 这份文档的写入者登记了：建好两个槽位文件、拿着句柄；读出两个槽位，记下哪一个是最新写的、代号到了多少。槽位里有更新的页面写的：
   * 放开句柄、记下，之后这份文档不写（newer-format）
   */
  readonly attach: (key: DraftKey) => Promise<MirrorStatus>
  /** IndexedDB 提交之后写镜像：手里没有句柄时先拿（退避期间不拿，交回 busy） */
  readonly write: (record: StoredDraft) => Promise<MirrorStatus>
  /**
   * 补写：拿着这份文档的句柄（是写入者）时，record（库里那一份）不是镜像里最新写的那一份（最新写的是别的写入者的、或者同一个写入者
   * 更旧的、或者一份合格的也没有）就写它，否则 mirrored；没拿着句柄时什么也不做，交回 undefined（不是写入者的不动）；
   * 登记时看出槽位里有更新的页面写的：不写，交回 newer-format
   */
  readonly backfill: (record: StoredDraft) => Promise<MirrorStatus | undefined>
  /**
   * 草稿删掉之后：两个槽位截断为 0。手里没有句柄时临时拿一下、截断、放开；文件不在时什么也不做；槽位里有更新的页面写的时不截断
   * （newer-format）
   */
  readonly clear: (key: DraftKey) => Promise<MirrorStatus>
  /** 读两个槽位并校验。手里没有句柄时临时拿一下、读完放开；不建文件 */
  readonly read: (key: DraftKey) => Promise<MirrorRead>
  /** 放开这份文档的句柄（失去写入者身份） */
  readonly detach: (key: DraftKey) => void
  /** 这个用户在镜像里有哪些文档（打开平台时的比对） */
  readonly documents: (userId: string) => Promise<MirrorDocuments>
  /** 放开全部句柄（页面离开、Worker 结束）；之后一律 failed */
  readonly close: () => void
}

export interface DraftMirrorOptions {
  readonly directory: MirrorDirectory
  /** 单调的时钟（毫秒）：退避用 */
  readonly clock: { readonly now: () => number }
  /** 拿不到句柄（别的标签页占着、写满、出错）之后多久再试：从 initialMs 起每次翻倍，至多 maxMs */
  readonly retry?: { readonly initialMs: number, readonly maxMs: number }
}

const DEFAULT_RETRY = { initialMs: 500, maxMs: 30_000 }

const CLOSED: FailureDescription = { name: 'InvalidStateError', message: '镜像已关闭' }

/** 补写时比较用的：写入者（代次与 writerId）与先后（compareDrafts） */
type Ordering = Pick<DraftMeta, 'writeEpoch' | 'writerId' | 'draftSeq' | 'updatedAt'>

/** 拿着的两个句柄：哪一个是最新写的（都不合格时没有）、代号到了多少，各自存着的合格的那一份的写入者与先后（补写时比较；不合格、空的为 undefined） */
interface Held {
  readonly kind: 'held'
  readonly slots: readonly [SlotHandle, SlotHandle]
  newest: 0 | 1 | undefined
  generation: number
  records: [Ordering | undefined, Ordering | undefined]
}

/** 上一次没拿到：到 retryAt 之前不再去拿，交回上一次的原因 */
interface Waiting {
  readonly kind: 'waiting'
  readonly retryAt: number
  readonly delayMs: number
  readonly status: MirrorStatus
}

/** 登记时看出槽位里有更新的页面写的（复验 C2）：句柄已放开，这份文档不写、不补写、不截断，直到 detach 之后再登记时重新看 */
interface Newer {
  readonly kind: 'newer'
}

const NEWER_FORMAT: MirrorStatus = { kind: 'not-mirrored', reason: 'newer-format' }

function idOf(key: DraftKey): string {
  return JSON.stringify([key.userId, key.documentId])
}

function errorName(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'name' in error && typeof error.name === 'string' ? error.name : undefined
}

function failed(error: unknown): MirrorStatus {
  return { kind: 'not-mirrored', reason: 'failed', error: describeFailure(error) }
}

/** 写满在写的时候也会出现（QuotaExceededError）；别的照原样 */
function writeFailure(error: unknown): MirrorStatus {
  return errorName(error) === 'QuotaExceededError' ? { kind: 'not-mirrored', reason: 'quota' } : failed(error)
}

/** 句柄从 at 起写完整个 bytes：写的字节数不够也算出错（写一半的槽位校验不过） */
function writeAll(handle: SlotHandle, bytes: Uint8Array, at: number): void {
  const written = handle.write(bytes, { at })
  if (written !== bytes.byteLength)
    throw new DOMException(`只写了 ${written} / ${bytes.byteLength} 字节`, 'UnknownError')
}

/** 读整个槽位文件 */
function readWhole(handle: SlotHandle): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(handle.getSize())
  const read = handle.read(bytes, { at: 0 })
  return read === bytes.byteLength ? bytes : bytes.slice(0, read)
}

/**
 * 读出两个槽位并校验（整个文件都校验，不只看头：头合格、内容却被截掉的槽位当作不合格，写在它上面，不碰另一个合格的）
 */
async function readSlots(slots: readonly [SlotHandle, SlotHandle], key: DraftKey): Promise<readonly [SlotRead, SlotRead]> {
  return [await parseSlot(readWhole(slots[0]), key), await parseSlot(readWhole(slots[1]), key)]
}

function orderingOf(record: Ordering): Ordering {
  return { writeEpoch: record.writeEpoch, writerId: record.writerId, draftSeq: record.draftSeq, updatedAt: record.updatedAt }
}

function closeQuietly(slots: readonly SlotHandle[]): void {
  for (const handle of slots) {
    try {
      handle.close()
    }
    catch {
      // 已经关了：不管
    }
  }
}

export function createDraftMirror(options: DraftMirrorOptions): DraftMirror {
  const { directory, clock } = options
  const retry = options.retry ?? DEFAULT_RETRY
  const states = new Map<string, Held | Waiting | Newer>()
  let unsupported = false
  let closed = false

  /** 没拿到：记下原因，按退避再试（上一次也没拿到时翻倍，至多 maxMs） */
  function wait(id: string, status: MirrorStatus): MirrorStatus {
    const previous = states.get(id)
    const delayMs = previous?.kind === 'waiting' ? Math.min(previous.delayMs * 2, retry.maxMs) : retry.initialMs
    states.set(id, { kind: 'waiting', retryAt: clock.now() + delayMs, delayMs, status })
    return status
  }

  async function attach(key: DraftKey): Promise<MirrorStatus> {
    if (closed)
      return failed(new DOMException(CLOSED.message, CLOSED.name))
    if (unsupported)
      return { kind: 'not-mirrored', reason: 'unsupported' }
    const id = idOf(key)
    const state = states.get(id)
    if (state?.kind === 'held')
      return { kind: 'mirrored' }
    if (state?.kind === 'newer')
      return NEWER_FORMAT
    if (state?.kind === 'waiting' && clock.now() < state.retryAt)
      return state.status
    const opened = await directory.openSlots(key, true)
    switch (opened.kind) {
      case 'opened': {
        if (closed) {
          closeQuietly(opened.slots)
          return failed(new DOMException(CLOSED.message, CLOSED.name))
        }
        try {
          const reads = await readSlots(opened.slots, key)
          // 更新的页面写的：不盖掉它（放开句柄，这份文档不写）
          if (hasNewerFormatSlot(reads)) {
            closeQuietly(opened.slots)
            states.set(id, { kind: 'newer' })
            return NEWER_FORMAT
          }
          const valid = reads.map(read => (read.kind === 'valid' ? read : undefined))
          const newest = newestSlot(valid.map(slot => slot?.header))
          states.set(id, {
            kind: 'held',
            slots: opened.slots,
            newest: newest === 0 || newest === 1 ? newest : undefined,
            generation: Math.max(0, ...valid.map(slot => slot?.header.generation ?? 0)),
            records: [valid[0] === undefined ? undefined : orderingOf(valid[0].record), valid[1] === undefined ? undefined : orderingOf(valid[1].record)],
          })
          return { kind: 'mirrored' }
        }
        catch (error) {
          closeQuietly(opened.slots)
          return wait(id, failed(error))
        }
      }
      case 'unsupported':
        unsupported = true
        return { kind: 'not-mirrored', reason: 'unsupported' }
      case 'busy':
        return wait(id, { kind: 'not-mirrored', reason: 'busy' })
      case 'quota':
        return wait(id, { kind: 'not-mirrored', reason: 'quota' })
      case 'absent':
        return wait(id, failed(new DOMException('建了槽位文件却找不到', 'NotFoundError')))
      case 'failed':
        return wait(id, failed(opened.error))
    }
  }

  /** 拿着句柄就用它；没有时临时拿一下（不建文件），用完放开 */
  async function withSlots<T>(key: DraftKey, action: (slots: readonly [SlotHandle, SlotHandle], held: Held | undefined) => Promise<T>, otherwise: (outcome: { readonly kind: 'absent' | 'busy' | 'unsupported' } | { readonly kind: 'failed', readonly error: FailureDescription }) => T): Promise<T> {
    if (closed)
      return otherwise({ kind: 'failed', error: CLOSED })
    const state = states.get(idOf(key))
    if (state?.kind === 'held')
      return action(state.slots, state)
    const opened = await directory.openSlots(key, false)
    switch (opened.kind) {
      case 'opened':
        try {
          return await action(opened.slots, undefined)
        }
        finally {
          closeQuietly(opened.slots)
        }
      case 'absent':
      case 'busy':
      case 'unsupported':
        return otherwise({ kind: opened.kind })
      case 'quota':
        return otherwise({ kind: 'failed', error: { name: 'QuotaExceededError', message: '打开槽位时写满' } })
      case 'failed':
        return otherwise({ kind: 'failed', error: describeFailure(opened.error) })
    }
  }

  async function write(record: StoredDraft): Promise<MirrorStatus> {
    const status = await attach(record)
    const held = states.get(idOf(record))
    if (status.kind !== 'mirrored' || held?.kind !== 'held')
      return status
    const target = held.newest === 0 ? 1 : 0
    const generation = held.generation + 1
    let slot: Awaited<ReturnType<typeof encodeSlot>>
    try {
      slot = await encodeSlot(record, generation)
    }
    catch (error) {
      return failed(error)
    }
    const handle = held.slots[target]
    try {
      handle.truncate(0)
      writeAll(handle, slot.content, SLOT_HEADER_BYTES)
      writeAll(handle, slot.header, 0)
      handle.flush()
    }
    catch (error) {
      // 正在写的这个槽位写了一半、落选；最新的那一个不动，下一次照样写在这一个上
      held.records[target] = undefined
      return writeFailure(error)
    }
    held.newest = target
    held.generation = generation
    held.records[target] = orderingOf(record)
    return { kind: 'mirrored' }
  }

  return {
    attach,

    write,

    backfill: async (record) => {
      // 关掉之后 states 已清空：同样什么也不做
      const held = states.get(idOf(record))
      if (held?.kind === 'newer')
        return NEWER_FORMAT
      if (held?.kind !== 'held')
        return undefined
      // 镜像里最新写的那一份就是这个写入者写的、不比它旧：不用补（更新的那一份由比对写回库，这里不拿库里旧的盖掉它）
      const latest = held.newest === undefined ? undefined : held.records[held.newest]
      if (latest !== undefined && isSameWriter(latest, record) && compareDrafts(record, latest) <= 0)
        return { kind: 'mirrored' }
      return write(record)
    },

    clear: async key => states.get(idOf(key))?.kind === 'newer'
      ? NEWER_FORMAT
      : withSlots<MirrorStatus>(key, async (slots, held) => {
          try {
            // 临时拿到的句柄：槽位里有更新的页面写的就不动它（拿着的句柄登记时已经看过）
            if (held === undefined && hasNewerFormatSlot(await readSlots(slots, key)))
              return NEWER_FORMAT
            for (const handle of slots) {
              handle.truncate(0)
              handle.flush()
            }
          }
          catch (error) {
            return writeFailure(error)
          }
          if (held !== undefined) {
            held.newest = undefined
            held.records = [undefined, undefined]
          }
          return { kind: 'mirrored' }
        }, (outcome) => {
          switch (outcome.kind) {
            case 'absent':
              return { kind: 'mirrored' }
            case 'busy':
            case 'unsupported':
              return { kind: 'not-mirrored', reason: outcome.kind }
            case 'failed':
              return { kind: 'not-mirrored', reason: 'failed', error: outcome.error }
          }
        }),

    read: async key => withSlots<MirrorRead>(key, async (slots) => {
      try {
        return { kind: 'slots', slots: await readSlots(slots, key) }
      }
      catch (error) {
        return { kind: 'failed', error: describeFailure(error) }
      }
    }, outcome => outcome),

    detach: (key) => {
      const id = idOf(key)
      const state = states.get(id)
      if (state?.kind === 'held')
        closeQuietly(state.slots)
      states.delete(id)
    },

    documents: async (userId) => {
      const listed = await directory.listDocuments(userId)
      switch (listed.kind) {
        case 'listed':
          return listed
        case 'unsupported':
          return { kind: 'unsupported' }
        case 'quota':
          return { kind: 'failed', error: { name: 'QuotaExceededError', message: '列出镜像的文档时写满' } }
        case 'failed':
          return { kind: 'failed', error: describeFailure(listed.error) }
      }
    },

    close: () => {
      closed = true
      for (const state of states.values()) {
        if (state.kind === 'held')
          closeQuietly(state.slots)
      }
      states.clear()
    },
  }
}

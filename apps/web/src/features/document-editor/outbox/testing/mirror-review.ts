// 真实浏览器复核里 OPFS 镜像那一段的量法（M4-P1 设计 §3.6 第 11 项；§3.8 的镜像合并进来之后补上的）：只在测试构建里，由
// ./mirror-review.worker.ts 在专用 Worker 里用（同步访问句柄只在专用 Worker 里有）。调用生产的 createDraftMirror（两个槽位轮流写：截断 →
// 写内容 → 写头 → flush；读两个槽位并校验），只在目录交出的句柄外面包一层、记下各个操作用了多久，不改生产的写法：
// - write：先登记（attach：拿句柄、读两个槽位并校验；第一次另要建目录与文件），再生产的整个写入（编码——内容与头的 SHA-256——、截断、
//   写内容、写头、flush），截断与写、flush 各自计（flush 单独计）；
// - read：先放开句柄（打开平台、登记之前比对时手里没有句柄），再生产的读（临时拿句柄、读两个槽位、校验、放开），拿句柄的那一段另计；
//   比对：两个槽位里合格的那几份按生产的 compareDrafts 取最新、与库里那一份比（写入管道比对时的同一个判定）；另核对最新的那一份就是
//   库里那一份（复核自己的核对，不计时）。
// 时钟注入（Worker 里是 performance.now()，单元测试里是假的）；交回的都是普通的值，不交出内容
import type { MirrorRead, MirrorStatus } from '../../../../shared/outbox/draft-mirror.ts'
import type { StoredDraft } from '../../../../shared/outbox/draft-record.ts'
import type { MirrorDirectory, SlotHandle } from '../../../../shared/outbox/mirror-directory.ts'
import type { SlotRead } from '../../../../shared/outbox/mirror-slot.ts'
import { createDraftMirror } from '../../../../shared/outbox/draft-mirror.ts'
import { compareDrafts } from '../../../../shared/outbox/writer-fence.ts'

/** 镜像写一次：结果与各段的毫秒（没写成的那几段为 null） */
export interface MirrorWriteTimes {
  /** 生产的镜像这一次的结果（statusText）：mirrored、not-mirrored:<原因>、off */
  readonly status: string
  /** 登记：拿句柄、读两个槽位并校验（第一次另有建目录与文件） */
  readonly attachMs: number | null
  /** 生产的整个写入：编码、截断、写内容、写头、flush */
  readonly writeMs: number | null
  /** 其中截断、写内容、写头 */
  readonly ioMs: number | null
  /** 其中 flush */
  readonly flushMs: number | null
}

/** 镜像读一次并与库里那一份比对 */
export interface MirrorReadTimes {
  /** 读的结果（readText）：slots、absent、busy、unsupported、failed:<错误的名字> */
  readonly read: string
  /** 生产的读：临时拿句柄、读两个槽位、校验、放开 */
  readonly readMs: number | null
  /** 其中拿句柄 */
  readonly openMs: number | null
  /** 比对：取最新、与库里那一份比 */
  readonly compareMs: number | null
  /** 两个槽位读出的种类（slotText，例如 valid+empty） */
  readonly slots: string | null
  /** 镜像里最新的那一份比库里的新（比对时要写回） */
  readonly newer: boolean
  /** 镜像里最新的合格那一份就是库里那一份（sameDraft） */
  readonly same: boolean
}

export interface MirrorReview {
  readonly write: (record: StoredDraft) => Promise<MirrorWriteTimes>
  /** stored：库里那一份（比对的另一方）；按它的用户与文档读 */
  readonly read: (stored: StoredDraft) => Promise<MirrorReadTimes>
  /** 放开全部句柄 */
  readonly close: () => void
}

/** 生产的镜像结果写成一个词：失败时带上错误的名字 */
export function statusText(status: MirrorStatus): string {
  if (status.kind !== 'not-mirrored')
    return status.kind
  return status.reason === 'failed' ? `not-mirrored:failed:${status.error.name}` : `not-mirrored:${status.reason}`
}

/** 生产的读的结果写成一个词 */
export function readText(read: MirrorRead): string {
  return read.kind === 'failed' ? `failed:${read.error.name}` : read.kind
}

/** 一个槽位读出的种类 */
export function slotText(slot: SlotRead): string {
  return slot.kind === 'invalid' ? `invalid:${slot.reason}` : slot.kind
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.byteLength === b.byteLength && a.every((byte, index) => byte === b[index])
}

/** 两份记录是同一份：文档、写入者、序号、更新时间、密钥版本、IV 与密文都相同 */
export function sameDraft(a: StoredDraft, b: StoredDraft): boolean {
  return a.userId === b.userId && a.documentId === b.documentId && a.writeEpoch === b.writeEpoch && a.writerId === b.writerId
    && a.draftSeq === b.draftSeq && a.updatedAt === b.updatedAt && a.keyVersion === b.keyVersion
    && sameBytes(a.iv, b.iv) && sameBytes(a.ciphertext, b.ciphertext)
}

/**
 * 这一次镜像那一段有没有走完（页面只核对"跑完、数据齐"）：写成了、读出两个槽位、最新的就是库里那一份为走完；这个上下文没有 OPFS
 * （unsupported：Playwright 的 WebKit 默认上下文）不算没走完（记作事实）；库里那一份没读出来（read 为 undefined）时由库那一段报
 */
export function mirrorProblemOf(write: MirrorWriteTimes, read: MirrorReadTimes | undefined): string | undefined {
  if (write.status === 'not-mirrored:unsupported')
    return undefined
  if (write.status !== 'mirrored')
    return `镜像没写成：${write.status}`
  if (read === undefined)
    return undefined
  if (read.read !== 'slots')
    return `镜像读不出：${read.read}`
  return read.same ? undefined : `镜像里最新的那一份不是库里那一份（槽位 ${read.slots ?? '—'}）`
}

/** 各段累计的毫秒：拿句柄、截断与写、flush */
interface Tally {
  open: number
  io: number
  flush: number
}

/** 目录交出的句柄外面包一层计时（读与取大小不计：读的那一段整个计） */
function timedDirectory(directory: MirrorDirectory, now: () => number, tally: Tally): MirrorDirectory {
  const timed = <T>(field: 'io' | 'flush', action: () => T): T => {
    const started = now()
    try {
      return action()
    }
    finally {
      tally[field] += now() - started
    }
  }
  const wrap = (handle: SlotHandle): SlotHandle => ({
    read: (buffer, options) => handle.read(buffer, options),
    write: (buffer, options) => timed('io', () => handle.write(buffer, options)),
    truncate: size => timed('io', () => handle.truncate(size)),
    getSize: () => handle.getSize(),
    flush: () => timed('flush', () => handle.flush()),
    close: () => handle.close(),
  })
  return {
    ...directory,
    openSlots: async (key, create) => {
      const started = now()
      const opened = await directory.openSlots(key, create)
      tally.open += now() - started
      return opened.kind === 'opened' ? { kind: 'opened', slots: [wrap(opened.slots[0]), wrap(opened.slots[1])] } : opened
    },
  }
}

/** 量的时候不等退避：拿不到句柄的下一次照样去拿 */
const NO_RETRY_DELAY = { initialMs: 0, maxMs: 0 }

export function createMirrorReview(directory: MirrorDirectory, now: () => number): MirrorReview {
  const tally: Tally = { open: 0, io: 0, flush: 0 }
  const mirror = createDraftMirror({ directory: timedDirectory(directory, now, tally), clock: { now }, retry: NO_RETRY_DELAY })
  const reset = (): void => {
    tally.open = 0
    tally.io = 0
    tally.flush = 0
  }
  return {
    write: async (record) => {
      const a0 = now()
      const attached = await mirror.attach(record)
      const a1 = now()
      if (attached.kind !== 'mirrored')
        return { status: statusText(attached), attachMs: null, writeMs: null, ioMs: null, flushMs: null }
      reset()
      const w0 = now()
      const written = await mirror.write(record)
      const w1 = now()
      if (written.kind !== 'mirrored')
        return { status: statusText(written), attachMs: a1 - a0, writeMs: null, ioMs: null, flushMs: null }
      return { status: 'mirrored', attachMs: a1 - a0, writeMs: w1 - w0, ioMs: tally.io, flushMs: tally.flush }
    },
    read: async (stored) => {
      mirror.detach(stored)
      reset()
      const r0 = now()
      const read = await mirror.read(stored)
      const r1 = now()
      if (read.kind !== 'slots')
        return { read: readText(read), readMs: null, openMs: null, compareMs: null, slots: null, newer: false, same: false }
      const c0 = now()
      const newest = read.slots.flatMap(slot => (slot.kind === 'valid' ? [slot.record] : [])).sort((a, b) => compareDrafts(b, a))[0]
      const newer = newest !== undefined && compareDrafts(stored, newest) < 0
      const c1 = now()
      return { read: 'slots', readMs: r1 - r0, openMs: tally.open, compareMs: c1 - c0, slots: read.slots.map(slotText).join('+'), newer, same: newest !== undefined && sameDraft(newest, stored) }
    },
    close: () => mirror.close(),
  }
}

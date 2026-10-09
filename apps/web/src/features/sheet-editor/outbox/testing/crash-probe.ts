// 写入中途结束整棵浏览器进程时的原子性（M4-P1 设计 §3.7、§3.8，S7 与 S9 第 5 项）接到生产代码的探针：只在测试构建里。编辑器页的组装处
// （start.tsx）在测试构建、地址带 crashProbe 时动态引入它，挂在 window.__nerveCrashProbe 上；生产构建里这个分支与它的分块都被去掉
// （门禁 artifacts 按来源、分块名与名字核对）。
// 发件箱的浏览器层探针（outbox-probe.ts）测存储、编解码与镜像的各个操作；这里只做崩溃用例要的：用生产的写入管道反复写一份约 5 MiB 的内容，
// 测试进程按时机冻住、结束整棵浏览器进程（tests/e2e/support/browser-crash.ts），以同一个目录重开之后读回、取走比对镜像留在库里的提示。
// - 两种放置：
//   - 进程内：生产的写入管道（draft-writer.ts 的 createDraftWriter）配 IndexedDB 的存储，没有镜像（同步访问句柄只在 Worker 里有）；
//   - Worker：生产的 Worker 客户端（outbox-worker-client.ts）配崩溃用例的测试 Worker（crash-probe.worker.ts：先包住 Worker 里的开事务与
//     镜像的同步访问句柄的操作、经以 Worker 的名字为名的 BroadcastChannel 报给页面，再引入生产的入口——管道、存储、OPFS 的镜像都是生产的）。
// - 结束的信号（start 的 signal）：
//   - put："写入之前"——进程内时存储包一层，交给存储之前；Worker 时 Worker 开写入的事务（readwrite、含草稿的仓库）报来时；
//   - mirror："写镜像之前"——Worker 里镜像开始写（IndexedDB 已经提交，截断槽位）报来时；进程内没有镜像，不会来；
//   - after-truncate、after-content、after-header、after-flush：写镜像的那一步之后 Worker 停住（mirror-recorder.ts 忙等）、报来时——写 3.8 MiB
//     只要几毫秒，按时机冻不到半途，这样槽位就停在那一步写完的样子。开始写之前先把要停的那一步告诉 Worker、等它回"收到"。
//   信号一到就调用测试进程的绑定函数（不等它回来；写入接着往下走，或者 Worker 停在那里），测试进程收到就冻住浏览器。
// - 内容由序号决定（xorshift32 生成的 base64 字符：gzip 之后约为原来的 3/4，几乎压不动），读回时经管道解开（Worker 时管道在库与两个槽位
//   里取最新、解得开的那一份）、解压，按记录的序号重新生成、逐字节比较；写入者的高水位另从库里直接读（与草稿在同一个事务里写、
//   从镜像写回时连同写入者），两个仓库是否一致一眼看得出。
// 交回的都是能经 page.evaluate 传回的普通值；密钥由测试进程给出原始字节（重开之后用同一把），导入成不可导出的。只引用发件箱自己的模块
import type { DraftKey, WriterRecord } from '../../../../shared/outbox/draft-record.ts'
import type { DraftStore } from '../../../../shared/outbox/draft-store.ts'
import type { DraftWriter } from '../../../../shared/outbox/draft-writer.ts'
import type { RecoveryNotice } from '../../../../shared/outbox/recovery-notice.ts'
import type { WriterIdentity } from '../../../../shared/outbox/writer-fence.ts'
import type { OutboxWorkerClient } from '../outbox-worker-client.ts'
import type { MirrorPausePoint, ProbeMirrorOperation, ProbeMirrorPause } from './mirror-recorder.ts'
import type { ProbeWorkerTransaction } from './pipeline-probe.ts'
import { draftKeyPath, DRAFTS_STORE, OUTBOX_DATABASE_NAME, WRITERS_STORE } from '../../../../shared/outbox/database.ts'
import { gunzipBytes } from '../../../../shared/outbox/draft-codec.ts'
import { readWriterRecord } from '../../../../shared/outbox/draft-record.ts'
import { createDraftStore } from '../../../../shared/outbox/draft-store.ts'
import { createDraftWriter } from '../../../../shared/outbox/draft-writer.ts'
import { createOutboxWorkerClient } from '../outbox-worker-client.ts'

/** 挂在 window 上的名字（门禁的禁用关键字里登记了它：生产构建里连名字都不能有） */
export const CRASH_PROBE_NAME = '__nerveCrashProbe'

/** 写入管道放在哪：进程内（没有镜像），或发件箱 Worker（带 OPFS 的镜像） */
export type CrashProbePlacement = 'in-process' | 'worker'

/** 开始写的时候要不要发信号、在哪一刻发（见文件开头） */
export type CrashProbeSignal = 'none' | 'put' | 'mirror' | MirrorPausePoint

const PAUSE_POINTS: readonly string[] = ['after-truncate', 'after-content', 'after-header', 'after-flush'] satisfies readonly MirrorPausePoint[]

/** Worker 回"收到要停住的那一步"的时限（毫秒） */
const ARM_TIMEOUT_MS = 5_000

/** 每次启动交给探针的：放置、草稿的键、写入者（重开之后还是同一个，草稿就不是"别的写入者留下的"）、本机密钥、内容的长度、信号的绑定函数名 */
export interface CrashProbeSetup {
  readonly placement: CrashProbePlacement
  readonly key: DraftKey
  readonly writer: WriterIdentity
  readonly localKey: { readonly version: number, readonly rawHex: string }
  readonly contentChars: number
  readonly signalBinding: string
}

/**
 * 打开之前看一眼库（不建它）：在不在；不在、浏览器要建它时，Chromium 在升级事件上说明是不是因为存储损坏丢了数据（非标准的 dataLoss、
 * dataLossMessage）——只有删库重建之后这个来源里第一个打开的拿到 total，编辑器页里先打开的是 Univer 自己的库，这里看到的一般是 none
 */
export interface CrashProbePeek {
  readonly existed: boolean
  readonly dataLoss?: string
  readonly dataLossMessage?: string
}

/** 登记的结果：登记了（高水位、镜像拿到句柄没有、库与镜像里已有的那一份的种类）；别的结果（含 Worker 起不来）只交回说明。都带上打开之前看到的库 */
export type CrashProbeRegistered
  = | { readonly kind: 'registered', readonly lastDraftSeq: number, readonly mirror: string, readonly existing: string, readonly peek: CrashProbePeek }
    | { readonly kind: 'not-registered', readonly outcome: string, readonly peek: CrashProbePeek }

/** 读回的一份 */
export type CrashProbeRead
  = | { readonly kind: 'draft', readonly seq: number, readonly writerSeq: number | null, readonly bytes: number, readonly intact: boolean }
    | { readonly kind: 'absent', readonly writerSeq: number | null }
  /** 解不开（已吊销、已损坏）、更新的页面写的、形状不对、没有密钥、存储的问题：都不算"能解开" */
    | { readonly kind: 'not-readable', readonly outcome: string }

/** 取走的提示；读不出、清不掉时是说明 */
export type CrashProbeNotices
  = | { readonly kind: 'notices', readonly notices: readonly RecoveryNotice[] }
    | { readonly kind: 'failed', readonly outcome: string }

/** 最近一次写入；时刻都从这次写入开始算（毫秒，performance.now；Worker 报来的按报到页面的时刻） */
export interface CrashProbeWrite {
  readonly seq: number
  /** writing：还没有结果；否则是管道交回的结果的种类（written 才算写成） */
  readonly phase: string
  /** 写成时镜像写成了没有（mirrored、off、not-mirrored:原因） */
  readonly mirror?: string
  /** 交给存储（进程内）或 Worker 报来开了写入的事务（put 信号在这一刻发出） */
  readonly putAtMs?: number
  /** Worker 报来镜像开始写（截断槽位；mirror 信号在这一刻发出） */
  readonly mirrorAtMs?: number
  /** Worker 报来镜像的 flush 返回 */
  readonly mirrorFlushedAtMs?: number
  /** Worker 报来停在了写镜像的那一步之后 */
  readonly mirrorPausedAtMs?: number
  /** 管道交回结果 */
  readonly settledAtMs?: number
}

export interface CrashProbe {
  /** 每次启动调用一次：导入密钥、按放置建写入管道（Worker 时等握手）、交密钥、登记写入者（登记之前管道先比对镜像，删库之后从镜像写回） */
  readonly prepare: (setup: CrashProbeSetup) => Promise<CrashProbeRegistered>
  /** 写序号 seq 的一份，等它写完：交回管道的结果的种类 */
  readonly write: (seq: number) => Promise<string>
  /** 开始写序号 seq 的一份、不等（在下一个任务里开始）；按 signal 发信号。要停在写镜像的某一步时先告诉 Worker、等它回"收到" */
  readonly start: (seq: number, signal: CrashProbeSignal) => Promise<void>
  readonly read: () => Promise<CrashProbeRead>
  readonly last: () => CrashProbeWrite | undefined
  /**
   * 取走这个用户的提示（比对镜像与库留在库里的 restored、lost，recovery-notice.ts）：读出之后按读出的时刻逐条清除，交回读出的那几条；
   * 读不出、清不掉时交回说明（不抛出）
   */
  readonly takeNotices: () => Promise<CrashProbeNotices>
  /** 放开镜像的句柄（之后才能经发件箱探针的 OPFS Worker 读、改槽位文件）；下一次写入时管道自己再拿 */
  readonly release: () => Promise<void>
  /** 关掉写入管道（Worker 随之终止、句柄放开）：用例收尾删镜像目录之前 */
  readonly dispose: () => void
}

declare global {
  interface Window {
    [CRASH_PROBE_NAME]?: CrashProbe
  }
}

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/** Worker 客户端每个请求等回应的时限（毫秒）：约 5 MiB 的去重、压缩、加密、写库与写镜像，慢的机器上也远小于它 */
const WORKER_REQUEST_TIMEOUT_MS = 60_000

/** 页面里的计时器（Worker 客户端的看门狗） */
const pageClock = {
  schedule: (callback: () => void, delayMs: number): (() => void) => {
    const timer = setTimeout(callback, delayMs)
    return () => clearTimeout(timer)
  },
}

/** 序号 seq 的内容：xorshift32（种子由序号决定、不为 0），每个 32 位的数给出 4 个 base64 字符 */
function contentOf(seq: number, chars: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(chars)
  let x = (Math.imul(seq, 0x9E3779B1) ^ 0x5BD1E995) >>> 0 || 1
  for (let index = 0; index < chars; index += 1) {
    if (index % 4 === 0) {
      x ^= x << 13
      x ^= x >>> 17
      x ^= x << 5
      x >>>= 0
    }
    bytes[index] = BASE64_ALPHABET.charCodeAt((x >>> ((index % 4) * 6)) & 63)
  }
  return bytes
}

function fromHex(text: string): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(text.length / 2)
  for (let index = 0; index < bytes.length; index += 1)
    bytes[index] = Number.parseInt(text.slice(index * 2, index * 2 + 2), 16)
  return bytes
}

/** 打开之前看一眼库（见 CrashProbePeek）：不带版本打开，库不在时中止升级（不建它，留给存储去建） */
async function peekDatabase(): Promise<CrashProbePeek> {
  return new Promise((resolve) => {
    let peek: CrashProbePeek = { existed: true }
    const opening = indexedDB.open(OUTBOX_DATABASE_NAME)
    opening.onupgradeneeded = (event) => {
      const loss = event as IDBVersionChangeEvent & { readonly dataLoss?: unknown, readonly dataLossMessage?: unknown }
      peek = { existed: false, ...(typeof loss.dataLoss === 'string' ? { dataLoss: loss.dataLoss } : {}), ...(typeof loss.dataLossMessage === 'string' && loss.dataLossMessage !== '' ? { dataLossMessage: loss.dataLossMessage } : {}) }
      opening.transaction?.abort()
    }
    opening.onsuccess = () => {
      opening.result.close()
      resolve(peek)
    }
    opening.onerror = () => resolve(peek)
  })
}

/** 库里这份文档的写入者（直接读，不经存储：存储不交出写入者）；库不存在、没有时为 undefined */
async function writerRecordOf(key: DraftKey): Promise<WriterRecord | undefined> {
  return new Promise((resolve, reject) => {
    const opening = indexedDB.open(OUTBOX_DATABASE_NAME)
    opening.onupgradeneeded = () => opening.transaction?.abort()
    opening.onerror = () => {
      if (opening.error?.name === 'AbortError')
        resolve(undefined)
      else
        reject(opening.error ?? new Error('打不开发件箱的库'))
    }
    opening.onsuccess = () => {
      const db = opening.result
      const reading = db.transaction(WRITERS_STORE, 'readonly').objectStore(WRITERS_STORE).get(draftKeyPath(key))
      reading.onsuccess = () => {
        db.close()
        const value: unknown = reading.result
        resolve(value === undefined ? undefined : readWriterRecord(value))
      }
      reading.onerror = () => {
        db.close()
        reject(reading.error ?? new Error('读不出写入者'))
      }
    }
  })
}

/** 两段字节逐个相同 */
function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength)
    return false
  for (let index = 0; index < a.byteLength; index += 1) {
    if (a[index] !== b[index])
      return false
  }
  return true
}

/** 镜像写成了没有，折成一个词（mirrored、off、not-mirrored:原因） */
function mirrorWord(status: { readonly kind: string, readonly reason?: string }): string {
  return status.reason === undefined ? status.kind : `${status.kind}:${status.reason}`
}

export function installCrashProbe(target: Window): CrashProbe {
  let setup: CrashProbeSetup | undefined
  let writer: DraftWriter | undefined
  /** Worker 的放置时听着 Worker 报来的事务与镜像的操作 */
  let channel: BroadcastChannel | undefined
  let last: CrashProbeWrite | undefined
  /** 这次写入要发的信号（发过就清掉） */
  let armed: CrashProbeSignal = 'none'
  /** 这次写入的开始时刻（performance.now） */
  let startedAt = 0
  /** 等 Worker 回"收到要停住的那一步" */
  let onArmed: (() => void) | undefined

  function ready(): { readonly setup: CrashProbeSetup, readonly writer: DraftWriter } {
    if (setup === undefined || writer === undefined)
      throw new Error('探针还没准备：先 prepare')
    return { setup, writer }
  }

  /** 调用测试进程的绑定函数（不等它回来） */
  function notify(seq: number): void {
    const binding = setup?.signalBinding
    const call = binding === undefined ? undefined : (target as unknown as Record<string, ((seq: number) => Promise<void>) | undefined>)[binding]
    void call?.(seq)
  }

  /** 这次写入到了某一刻：记下时刻（只记第一次）；正等着这一刻的信号时发出 */
  function reached(moment: 'putAtMs' | 'mirrorAtMs' | 'mirrorFlushedAtMs' | 'mirrorPausedAtMs', signal: CrashProbeSignal | undefined): void {
    if (last === undefined || last[moment] !== undefined)
      return
    last = { ...last, [moment]: performance.now() - startedAt }
    if (signal !== undefined && armed === signal) {
      armed = 'none'
      notify(last.seq)
    }
  }

  /** 进程内的放置：存储包一层，交给存储之前（紧接着写） */
  function signalling(store: DraftStore): DraftStore {
    return {
      ...store,
      writeDraft: async (draft, options) => {
        if (last?.seq === draft.draftSeq)
          reached('putAtMs', 'put')
        return store.writeDraft(draft, options)
      },
    }
  }

  /**
   * Worker 的放置：崩溃用例的测试 Worker 以它的名字为频道名报来每个事务与镜像的每个操作。写入的事务（readwrite、含草稿的仓库）报来时
   * 是"写入之前"；之后镜像的截断报来时是"写镜像之前"；flush 返回时记下。只看这次写入开始之后报来的（登记时建槽位不算：那时没在写）
   */
  function workerPipeline(): OutboxWorkerClient {
    const name = `nerve-crash-probe-${crypto.randomUUID()}`
    const listening = new BroadcastChannel(name)
    listening.onmessage = (event: MessageEvent<ProbeWorkerTransaction | ProbeMirrorOperation>) => {
      const data = event.data
      if ('mirror' in data && data.mirror === 'armed') {
        onArmed?.()
        return
      }
      if (last === undefined)
        return
      if ('mirror' in data) {
        if (data.mirror === 'paused')
          reached('mirrorPausedAtMs', data.point)
        else if (data.mirror === 'truncate' && last.putAtMs !== undefined)
          reached('mirrorAtMs', 'mirror')
        else if (data.mirror === 'flushed' && last.mirrorAtMs !== undefined)
          reached('mirrorFlushedAtMs', undefined)
        return
      }
      if (data.mode === 'readwrite' && data.stores.includes(DRAFTS_STORE) && last.phase === 'writing')
        reached('putAtMs', 'put')
    }
    channel = listening
    return createOutboxWorkerClient({
      create: () => new Worker(new URL('./crash-probe.worker.ts', import.meta.url), { type: 'module', name }),
      clock: pageClock,
      requestTimeoutMs: WORKER_REQUEST_TIMEOUT_MS,
    })
  }

  /** 告诉 Worker 下一次写镜像时停在哪一步之后，等它回"收到"（只有 Worker 的放置有镜像） */
  async function armPause(point: MirrorPausePoint): Promise<void> {
    const target = channel
    if (target === undefined)
      throw new Error('进程内的放置没有镜像，停不到写镜像的那一步')
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${ARM_TIMEOUT_MS} ms 里 Worker 没回"收到要停住的那一步"`)), ARM_TIMEOUT_MS)
      onArmed = () => {
        clearTimeout(timer)
        onArmed = undefined
        resolve()
      }
      const request: ProbeMirrorPause = { pauseMirror: point }
      target.postMessage(request)
    })
  }

  function dispose(): void {
    writer?.dispose()
    writer = undefined
    channel?.close()
    channel = undefined
  }

  async function write(seq: number, signal: CrashProbeSignal): Promise<string> {
    const current = ready()
    startedAt = performance.now()
    last = { seq, phase: 'writing' }
    armed = signal
    const { key, writer: identity, contentChars } = current.setup
    const outcome = await current.writer.write({
      key,
      writer: identity,
      draftSeq: seq,
      baseRevision: 1,
      writtenBy: `crash-probe-${identity.writerId}`,
      format: { clientBuild: 'crash-probe', univerVersion: 'crash-probe', profile: 'sheet-v1', formatVersion: 1 },
      formulasPending: false,
      inFlight: null,
      bytes: contentOf(seq, contentChars),
      dedupe: false,
    })
    last = { ...last, phase: outcome.kind, ...(outcome.kind === 'written' ? { mirror: mirrorWord(outcome.mirror) } : {}), settledAtMs: performance.now() - startedAt }
    return outcome.kind
  }

  const probe: CrashProbe = {
    prepare: async (next) => {
      dispose()
      setup = next
      last = undefined
      const peek = await peekDatabase()
      const raw = fromHex(next.localKey.rawHex)
      const key = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt'])
      raw.fill(0)
      let pipeline: DraftWriter
      if (next.placement === 'worker') {
        const client = workerPipeline()
        writer = client
        pipeline = client
        const handshake = await client.ready()
        if (handshake.kind !== 'ready')
          return { kind: 'not-registered', outcome: `发件箱 Worker 起不来：${handshake.failure}`, peek }
      }
      else {
        pipeline = createDraftWriter({ store: signalling(createDraftStore({ blockedTimeoutMs: 1000 })), now: () => Date.now() })
        writer = pipeline
      }
      const change = await pipeline.setKey({ version: next.localKey.version, key })
      const registered = await pipeline.register(next.key, next.writer, false)
      if (registered.kind !== 'registered')
        return { kind: 'not-registered', outcome: `${JSON.stringify(registered)}（交密钥：${JSON.stringify(change)}）`, peek }
      return { kind: 'registered', lastDraftSeq: registered.lastDraftSeq, mirror: mirrorWord(registered.mirror), existing: registered.existing?.kind ?? 'none', peek }
    },
    write: async seq => write(seq, 'none'),
    start: async (seq, signal) => {
      if (PAUSE_POINTS.includes(signal))
        await armPause(signal as MirrorPausePoint)
      setTimeout(() => {
        write(seq, signal).catch(() => undefined)
      }, 0)
    },
    read: async () => {
      const current = ready()
      const read = await current.writer.read(current.setup.key)
      const writerSeq = (await writerRecordOf(current.setup.key))?.lastDraftSeq ?? null
      if (read.kind === 'absent')
        return { kind: 'absent', writerSeq }
      if (read.kind !== 'draft')
        return { kind: 'not-readable', outcome: JSON.stringify(read) }
      const content = await gunzipBytes(read.gzip)
      return { kind: 'draft', seq: read.meta.draftSeq, writerSeq, bytes: content.byteLength, intact: sameBytes(content, contentOf(read.meta.draftSeq, current.setup.contentChars)) }
    },
    last: () => last,
    takeNotices: async () => {
      const current = ready()
      const listed = await current.writer.notices(current.setup.key.userId)
      if (listed.kind !== 'notices')
        return { kind: 'failed', outcome: `读不出提示：${JSON.stringify(listed)}` }
      for (const notice of listed.notices) {
        const cleared = await current.writer.clearNotice({ userId: notice.userId, documentId: notice.documentId }, notice.at)
        if (cleared.kind !== 'cleared')
          return { kind: 'failed', outcome: `清不掉提示：${JSON.stringify(cleared)}` }
      }
      return { kind: 'notices', notices: listed.notices }
    },
    release: async () => {
      const current = ready()
      await current.writer.release(current.setup.key)
    },
    dispose,
  }
  target[CRASH_PROBE_NAME] = probe
  return probe
}

// 写入中途结束整棵浏览器进程时的原子性（M4-P1 设计 §3.7、S7）接到生产代码的探针：只在测试构建里。编辑器页的组装处（start.tsx）在测试构建、
// 地址带 crashProbe 时动态引入它，挂在 window.__nerveCrashProbe 上；生产构建里这个分支与它的分块都被去掉（门禁 artifacts 按来源、分块名与名字核对）。
// 发件箱的浏览器层探针（outbox-probe.ts）测存储与编解码的各个操作；这里只做崩溃用例要的一件事：用生产的写入管道反复写一份约 5 MiB 的内容，
// 测试进程按时机冻住、结束整棵浏览器进程（tests/e2e/support/browser-crash.ts），以同一个目录重开之后读回。
// - 放置：进程内——生产的写入管道（draft-writer.ts 的 createDraftWriter）配 IndexedDB 的存储（draft-store.ts 的 createDraftStore）；
//   Worker 的放置等发件箱 Worker 的入口合并之后接上（同一组用例）。
// - "写入之前"的信号：存储包一层，交给存储之前调用测试进程的绑定函数（不等它回来，紧接着写），测试进程收到就冻住浏览器；
// - 内容由序号决定（xorshift32 生成的 base64 字符：gzip 之后约为原来的 3/4，几乎压不动），读回时经管道解开、解压，按记录的序号重新生成、
//   逐字节比较；写入者的高水位另从库里直接读（与草稿在同一个事务里写），两个仓库是否同时提交一眼看得出。
// 交回的都是能经 page.evaluate 传回的普通值；密钥由测试进程给出原始字节（重开之后用同一把），导入成不可导出的。只引用发件箱自己的模块
import type { DraftKey, WriterRecord } from '../../../../shared/outbox/draft-record.ts'
import type { DraftStore } from '../../../../shared/outbox/draft-store.ts'
import type { DraftWriter } from '../../../../shared/outbox/draft-writer.ts'
import type { WriterIdentity } from '../../../../shared/outbox/writer-fence.ts'
import { draftKeyPath, OUTBOX_DATABASE_NAME, WRITERS_STORE } from '../../../../shared/outbox/database.ts'
import { gunzipBytes } from '../../../../shared/outbox/draft-codec.ts'
import { readWriterRecord } from '../../../../shared/outbox/draft-record.ts'
import { createDraftStore } from '../../../../shared/outbox/draft-store.ts'
import { createDraftWriter } from '../../../../shared/outbox/draft-writer.ts'

/** 挂在 window 上的名字（门禁的禁用关键字里登记了它：生产构建里连名字都不能有） */
export const CRASH_PROBE_NAME = '__nerveCrashProbe'

/** 每次启动交给探针的：草稿的键、写入者（重开之后还是同一个，草稿就不是"别的写入者留下的"）、本机密钥、内容的长度、信号的绑定函数名 */
export interface CrashProbeSetup {
  readonly key: DraftKey
  readonly writer: WriterIdentity
  readonly localKey: { readonly version: number, readonly rawHex: string }
  readonly contentChars: number
  readonly signalBinding: string
}

/**
 * 打开之前看一眼库（不建它）：在不在；不在、浏览器要建它时，Chromium 在升级事件上说明是不是因为存储损坏丢了数据（非标准的 dataLoss、dataLossMessage：
 * 被结束之后重开、浏览器认定库损坏、整个删掉重建时为 total）
 */
export interface CrashProbePeek {
  readonly existed: boolean
  readonly dataLoss?: string
  readonly dataLossMessage?: string
}

/** 登记的结果：登记了（高水位）；别的结果只交回种类。都带上打开之前看到的库 */
export type CrashProbeRegistered
  = | { readonly kind: 'registered', readonly lastDraftSeq: number, readonly peek: CrashProbePeek }
    | { readonly kind: 'not-registered', readonly outcome: string, readonly peek: CrashProbePeek }

/** 读回的一份 */
export type CrashProbeRead
  = | { readonly kind: 'draft', readonly seq: number, readonly writerSeq: number | null, readonly bytes: number, readonly intact: boolean }
    | { readonly kind: 'absent', readonly writerSeq: number | null }
  /** 解不开（已吊销、已损坏）、更新的页面写的、形状不对、没有密钥、存储的问题：都不算"能解开" */
    | { readonly kind: 'not-readable', readonly outcome: string }

/** 最近一次写入；时刻都从这次写入开始算（毫秒，performance.now） */
export interface CrashProbeWrite {
  readonly seq: number
  /** writing：还没有结果；否则是管道交回的结果的种类（written 才算写成） */
  readonly phase: string
  /** 交给存储（"写入之前"的信号在这一刻发出） */
  readonly putAtMs?: number
  /** 管道交回结果 */
  readonly settledAtMs?: number
}

export interface CrashProbe {
  /** 每次启动调用一次：导入密钥、建写入管道（进程内的放置）、登记写入者 */
  readonly prepare: (setup: CrashProbeSetup) => Promise<CrashProbeRegistered>
  /** 写序号 seq 的一份，等它写完：交回管道的结果的种类 */
  readonly write: (seq: number) => Promise<string>
  /** 开始写序号 seq 的一份、不等（在下一个任务里开始，evaluate 先返回）；signal 为 true 时交给存储之前发"写入之前"的信号 */
  readonly start: (seq: number, signal: boolean) => void
  readonly read: () => Promise<CrashProbeRead>
  readonly last: () => CrashProbeWrite | undefined
}

declare global {
  interface Window {
    [CRASH_PROBE_NAME]?: CrashProbe
  }
}

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

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

export function installCrashProbe(target: Window): CrashProbe {
  let setup: CrashProbeSetup | undefined
  let writer: DraftWriter | undefined
  let last: CrashProbeWrite | undefined
  /** 下一次交给存储之前要发信号 */
  let armed = false
  /** 这次写入的开始时刻（performance.now） */
  let startedAt = 0

  function ready(): { readonly setup: CrashProbeSetup, readonly writer: DraftWriter } {
    if (setup === undefined || writer === undefined)
      throw new Error('探针还没准备：先 prepare')
    return { setup, writer }
  }

  /** 存储包一层：交给存储之前记下时刻；要发信号时调用测试进程的绑定函数（不等它回来，紧接着写） */
  function signalling(store: DraftStore, binding: string): DraftStore {
    return {
      ...store,
      writeDraft: async (draft, options) => {
        if (last !== undefined && last.seq === draft.draftSeq)
          last = { ...last, putAtMs: performance.now() - startedAt }
        if (armed) {
          armed = false
          const notify = (target as unknown as Record<string, ((seq: number) => Promise<void>) | undefined>)[binding]
          void notify?.(draft.draftSeq)
        }
        return store.writeDraft(draft, options)
      },
    }
  }

  async function write(seq: number, signal: boolean): Promise<string> {
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
    last = { ...last, phase: outcome.kind, settledAtMs: performance.now() - startedAt }
    return outcome.kind
  }

  const probe: CrashProbe = {
    prepare: async (next) => {
      writer?.dispose()
      setup = next
      const peek = await peekDatabase()
      const raw = fromHex(next.localKey.rawHex)
      const key = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt'])
      raw.fill(0)
      writer = createDraftWriter({ store: signalling(createDraftStore({ blockedTimeoutMs: 1000 }), next.signalBinding), now: () => Date.now() })
      await writer.setKey({ version: next.localKey.version, key })
      const registered = await writer.register(next.key, next.writer, false)
      return registered.kind === 'registered' ? { kind: 'registered', lastDraftSeq: registered.lastDraftSeq, peek } : { kind: 'not-registered', outcome: JSON.stringify(registered), peek }
    },
    write: async seq => write(seq, false),
    start: (seq, signal) => {
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
  }
  target[CRASH_PROBE_NAME] = probe
  return probe
}

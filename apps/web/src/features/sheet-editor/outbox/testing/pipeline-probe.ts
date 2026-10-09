// 写入管道的浏览器层探针（M4-P1 设计 §4 的浏览器层一行）：只在测试构建里，挂在发件箱探针（outbox-probe.ts）的 pipeline 上。
// 同一组操作跑在两种宿主上——进程内（shared/outbox/draft-writer.ts 的 createDraftWriter，配生产的 IndexedDB 存储）与发件箱 Worker
// （outbox-worker-client.ts 的客户端）：编辑器页（P2）只依赖 DraftWriter，两种宿主应当给出同样的结果。Worker 有三种脚本：
// - production：生产的 Worker 脚本（createOutboxWorker）；
// - recording：记下事务的测试脚本（outbox-probe.worker.ts：先包住 Worker 里的开事务、经 BroadcastChannel 报给这里，再引入生产的入口）；
// - missing：不存在的脚本（加载失败）。
// 交回的都是能经 page.evaluate 传回的普通值：gzip 只交回字节数与 SHA-256、解压之后的内容（长的只交回长度与 SHA-256）；不交出密钥。
// OPFS 的镜像（S9）：放开句柄、比对、读出与清除提示交给管道；槽位文件经测试构建的另一个 Worker（opfs-probe.worker.ts）读出、改坏，在页面里
// 按生产的格式（mirror-slot.ts）校验；库与镜像合一的清理（local-cleanup.ts）在页面里调，与 P4 一样；用完按用户删掉镜像的目录。
// 不引用编辑器页的时钟模块（它带着请求层与 zod，见 outbox-probe.ts 开头的说明）：看门狗用这里的计时器
import type { LocalKeyHandle } from '../../../../shared/outbox/draft-codec.ts'
import type { DraftKey, DraftMeta, InFlightSave } from '../../../../shared/outbox/draft-record.ts'
import type { DraftStore } from '../../../../shared/outbox/draft-store.ts'
import type { CaptureToWrite, CaptureWritten, ClearNoticeResult, ConfirmResult, DedupeKey, DraftRead, DraftWriter, KeyChange, NoticesResult, ReconcileResult, RegisterResult, RemoveResult, ResealResult, WriterProblem } from '../../../../shared/outbox/draft-writer.ts'
import type { FailureDescription } from '../../../../shared/outbox/failure.ts'
import type { AbandonOutcome, PurgeOutcome, UserCleanupOutcome } from '../../../../shared/outbox/local-cleanup.ts'
import type { MirrorRemoveOutcome } from '../../../../shared/outbox/mirror-directory.ts'
import type { WriterIdentity } from '../../../../shared/outbox/writer-fence.ts'
import type { OutboxWorkerFailure, OutboxWorkerReady, WorkerLike } from '../outbox-worker-client.ts'
import type { OpfsProbeCall, OpfsProbeReply } from './opfs-probe.worker.ts'
import { gunzipBytes, openDraft, sha256Hex } from '../../../../shared/outbox/draft-codec.ts'
import { draftMetaOf } from '../../../../shared/outbox/draft-record.ts'
import { createDraftStore } from '../../../../shared/outbox/draft-store.ts'
import { createDraftWriter } from '../../../../shared/outbox/draft-writer.ts'
import { describeFailure } from '../../../../shared/outbox/failure.ts'
import { createLocalCleanup } from '../../../../shared/outbox/local-cleanup.ts'
import { opfsMirrorDirectory, SLOT_FILE_NAMES } from '../../../../shared/outbox/mirror-directory.ts'
import { parseSlot } from '../../../../shared/outbox/mirror-slot.ts'
import { createOutboxWorker, createOutboxWorkerClient } from '../outbox-worker-client.ts'

export type ProbeHost = 'in-process' | 'worker'
export type ProbeWorkerScript = 'production' | 'recording' | 'missing'

export interface ProbePipelineOptions {
  readonly host: ProbeHost
  /** Worker 的脚本（默认 production）；进程内不看 */
  readonly script?: ProbeWorkerScript
  /** 客户端每个请求的看门狗（毫秒，默认 15 秒）；进程内不看 */
  readonly requestTimeoutMs?: number
  /** 空定时器（默认开着）；进程内不看 */
  readonly keepAlive?: boolean
}

/** Worker 里开的一个事务（记事务的脚本经 BroadcastChannel 报来）：仓库、模式与要求的持久性 */
export interface ProbeWorkerTransaction {
  readonly stores: readonly string[]
  readonly mode: string
  readonly durability: string | undefined
}

/** gzip 的摘要：字节数与 SHA-256；解压之后的内容（不长于 TEXT_LIMIT 时）与它的长度、UTF-8 字节的 SHA-256 */
export interface ProbeGzip {
  readonly bytes: number
  readonly sha256: string
  readonly text: string | undefined
  readonly textLength: number
  readonly textSha256: string
}

/** 结果里的字节换成摘要 */
export type Summarized<T> = T extends Uint8Array ? ProbeGzip : T extends readonly (infer U)[] ? readonly Summarized<U>[] : T extends object ? { readonly [K in keyof T]: Summarized<T[K]> } : T

/** 要写的一次捕获：字节换成文字（或随机的 base64，几乎压不动） */
export type ProbeCapture = Omit<CaptureToWrite, 'bytes'> & { readonly content: string | { readonly randomBase64Chars: number } }

/** 库里这份草稿（用探针当前的密钥解开）的 gzip 与元数据，与管道交回的比 */
export type ProbeStoredGzip
  = | { readonly kind: 'gzip', readonly meta: DraftMeta, readonly gzip: ProbeGzip }
    | { readonly kind: 'unreadable', readonly meta: DraftMeta, readonly reason: 'revoked' | 'corrupted' }
    | { readonly kind: 'absent' | 'newer-format' | 'malformed' | 'no-key' }
    | WriterProblem

/** 镜像的一个槽位文件：不在、空的、不合格（原因与字节数）、合格（头里的写入者、序号与代号，内容里的元数据） */
export type ProbeSlot
  = | { readonly kind: 'missing' }
    | { readonly kind: 'empty' }
    | { readonly kind: 'invalid', readonly reason: string, readonly size: number }
    | { readonly kind: 'valid', readonly generation: number, readonly meta: DraftMeta, readonly size: number }

/** 把槽位改坏：截成 size 字节（写一半）；整个换成 size 个 value（垃圾） */
export type ProbeCorruption = { readonly truncate: number } | { readonly fill: number, readonly value: number }

export interface ProbePipeline {
  /** 建一个管道：交回编号与握手的结果（Worker 等握手；进程内一律 ready） */
  readonly create: (options: ProbePipelineOptions) => Promise<{ readonly id: number, readonly ready: OutboxWorkerReady }>
  /** 交给管道的密钥：探针当前的密钥（chooseKey 选的那一把；Worker 经结构化克隆拿到它），或者 none（丢掉密钥） */
  readonly setKey: (id: number, key: 'probe' | 'none') => Promise<Summarized<KeyChange>>
  readonly register: (id: number, key: DraftKey, writer: WriterIdentity, force: boolean) => Promise<Summarized<RegisterResult>>
  readonly write: (id: number, capture: ProbeCapture) => Promise<Summarized<CaptureWritten>>
  readonly markInFlight: (id: number, key: DraftKey, writer: WriterIdentity, inFlight: InFlightSave) => Promise<ResealResult>
  readonly confirm: (id: number, key: DraftKey, writer: WriterIdentity, confirmedSeq: number, revision: number) => Promise<ConfirmResult>
  readonly read: (id: number, key: DraftKey) => Promise<Summarized<DraftRead>>
  readonly remove: (id: number, key: DraftKey, expectedSeq?: number) => Promise<RemoveResult>
  readonly seedDigest: (id: number, key: DraftKey, seed: DedupeKey | undefined) => Promise<void>
  /** Worker 坏了的原因（没坏、进程内为 undefined） */
  readonly broken: (id: number) => OutboxWorkerFailure | undefined
  readonly dispose: (id: number) => void
  /**
   * 写入途中关掉：开始一次写入，delayMs 毫秒之后（0：发出之后立即）dispose 这个管道（Worker 随之终止）；交回那次写入的结果、
   * dispose 之后多久它才结束（毫秒，不挂住），与这次内容的 SHA-256（结果失败时据此认库里留下的是不是它）
   */
  readonly writeThenDispose: (id: number, capture: ProbeCapture, delayMs: number) => Promise<{ readonly result: Summarized<CaptureWritten>, readonly settledAfterDisposeMs: number, readonly contentSha256: string }>
  /** 库里这份草稿解开之后的 gzip（经探针自己的存储与当前的密钥） */
  readonly storedGzip: (key: DraftKey) => Promise<ProbeStoredGzip>
  /** 记事务的 Worker 脚本报来的事务（按报来的先后） */
  readonly workerTransactions: (id: number) => readonly ProbeWorkerTransaction[]
  /** 这一页不再是写入者：放开镜像的句柄（S9） */
  readonly release: (id: number, key: DraftKey) => Promise<void>
  /** 打开平台时的比对（S9） */
  readonly reconcile: (id: number, userId: string) => Promise<ReconcileResult>
  /** 这个用户的提示（S9：比对镜像与库留下的，存在库里） */
  readonly notices: (id: number, userId: string) => Promise<NoticesResult>
  /** 清除一条提示 */
  readonly clearNotice: (id: number, key: DraftKey, expectedAt?: number) => Promise<ClearNoticeResult>
  /** 库与镜像合一的清理（S9，local-cleanup.ts）：在页面里调（与 P4 一样），用探针的存储与生产的镜像目录；出错折成名字与消息 */
  readonly cleanupUser: (userId: string) => Promise<Plain<UserCleanupOutcome>>
  readonly cleanupAbandon: (key: DraftKey, expectedSeq?: number) => Promise<Plain<AbandonOutcome>>
  readonly cleanupExpired: (now: number) => Promise<Plain<PurgeOutcome>>
  /** 镜像的两个槽位文件（a、b）读出来的样子：要先让发件箱 Worker 放开句柄 */
  readonly mirrorSlots: (key: DraftKey) => Promise<readonly [ProbeSlot, ProbeSlot]>
  /** 把一个槽位改坏（同样要先放开句柄） */
  readonly corruptSlot: (key: DraftKey, slot: 0 | 1, corruption: ProbeCorruption) => Promise<void>
  /** 删掉这个用户的镜像目录（用例收尾：WebKit 在 macOS 上把 OPFS 放在共用的目录里）；先 disposeAll 放开句柄 */
  readonly removeMirror: (userId: string) => Promise<MirrorRemoveOutcome>
  /** 删掉一份文档的镜像目录（P4 的保留期用的那一个，页面里调） */
  readonly removeMirrorDocument: (key: DraftKey) => Promise<MirrorRemoveOutcome>
  /** 关掉这一页的全部管道（Worker 随之终止、句柄放开）与 OPFS 的探针 Worker */
  readonly disposeAll: () => void
}

/** 探针给管道的：它当前的密钥与存储（storedGzip 用它读库） */
export interface PipelineProbeDeps {
  readonly key: () => LocalKeyHandle | undefined
  readonly store: () => DraftStore
}

/** 清理的结果里库的 failed 带着原样的错误：折成名字与消息，才能经 page.evaluate 交回 */
export type Plain<T> = T extends { readonly kind: 'failed', readonly error: unknown } ? { readonly kind: 'failed', readonly error: FailureDescription } : T

function plain<T extends { readonly kind: string }>(outcome: T): Plain<T> {
  return ('error' in outcome && outcome.kind === 'failed' ? { kind: 'failed', error: describeFailure(outcome.error) } : outcome) as Plain<T>
}

/** 不存在的 Worker 脚本：服务端对带扩展名、找不到的文件统一回 404 */
const MISSING_WORKER_SCRIPT = '/assets/outbox-probe-missing.worker.js'

/** 解压之后的内容不长于它时才交回原文 */
const TEXT_LIMIT = 4096

/** 页面里的计时器（客户端的看门狗） */
const pageClock = {
  schedule: (callback: () => void, delayMs: number): (() => void) => {
    const timer = setTimeout(callback, delayMs)
    return () => clearTimeout(timer)
  },
}

async function gzipSummary(gzip: Uint8Array<ArrayBuffer>): Promise<ProbeGzip> {
  const raw = await gunzipBytes(new Uint8Array(gzip))
  const text = new TextDecoder().decode(raw)
  return { bytes: gzip.byteLength, sha256: await sha256Hex(new Uint8Array(gzip)), text: text.length <= TEXT_LIMIT ? text : undefined, textLength: text.length, textSha256: await sha256Hex(raw) }
}

/** 结果里的字节（交回的 gzip）换成摘要；按内部的类型标签认字节（Worker 交回的属于另一个 realm 也认得出） */
async function summarize<T>(value: T): Promise<Summarized<T>> {
  if (Object.prototype.toString.call(value) === '[object Uint8Array]')
    return await gzipSummary(value as Uint8Array<ArrayBuffer>) as Summarized<T>
  if (Array.isArray(value))
    return await Promise.all(value.map(async item => summarize(item as unknown))) as Summarized<T>
  if (typeof value === 'object' && value !== null)
    return Object.fromEntries(await Promise.all(Object.entries(value).map(async ([name, field]) => [name, await summarize(field as unknown)] as const))) as Summarized<T>
  return value as Summarized<T>
}

/** 随机的 base64 文字（几乎压不动）：getRandomValues 一次最多 65536 字节，分段取 */
function randomBase64(chars: number): string {
  const bytes = new Uint8Array(Math.ceil(chars * 3 / 4))
  for (let offset = 0; offset < bytes.length; offset += 65_536)
    crypto.getRandomValues(bytes.subarray(offset, offset + 65_536))
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
  return btoa(binary).slice(0, chars)
}

function captureOf(capture: ProbeCapture): CaptureToWrite {
  const { content, ...rest } = capture
  return { ...rest, bytes: new TextEncoder().encode(typeof content === 'string' ? content : randomBase64(content.randomBase64Chars)) }
}

interface Pipeline {
  readonly writer: DraftWriter
  readonly broken: () => OutboxWorkerFailure | undefined
  readonly transactions: ProbeWorkerTransaction[]
  readonly channel: BroadcastChannel | undefined
}

export function createPipelineProbe(deps: PipelineProbeDeps): ProbePipeline {
  const localCleanup = () => createLocalCleanup({ store: deps.store(), directory: opfsMirrorDirectory() })
  const pipelines = new Map<number, Pipeline>()
  let nextId = 1
  let opfsWorker: Worker | undefined
  let opfsRequestId = 0
  const opfsReplies = new Map<number, (reply: OpfsProbeReply) => void>()

  /** 经测试构建的 OPFS Worker 读、改槽位文件 */
  async function opfs(request: OpfsProbeCall): Promise<Uint8Array<ArrayBuffer> | null> {
    if (opfsWorker === undefined) {
      opfsWorker = new Worker(new URL('./opfs-probe.worker.ts', import.meta.url), { type: 'module', name: 'nerve-opfs-probe' })
      opfsWorker.addEventListener('message', (event: MessageEvent<OpfsProbeReply>) => {
        opfsReplies.get(event.data.id)?.(event.data)
        opfsReplies.delete(event.data.id)
      })
    }
    opfsRequestId += 1
    const id = opfsRequestId
    const target = opfsWorker
    const reply = await new Promise<OpfsProbeReply>((resolve) => {
      opfsReplies.set(id, resolve)
      target.postMessage({ ...request, id })
    })
    if (!reply.ok)
      throw new Error(`OPFS 的探针 Worker 出错：${reply.error.name} ${reply.error.message}`)
    return reply.bytes
  }

  function pathOf(key: DraftKey, slot: 0 | 1): readonly string[] {
    return [key.userId, key.documentId, SLOT_FILE_NAMES[slot]]
  }

  async function slotOf(key: DraftKey, slot: 0 | 1): Promise<ProbeSlot> {
    const bytes = await opfs({ op: 'read', path: pathOf(key, slot) })
    if (bytes === null)
      return { kind: 'missing' }
    const read = await parseSlot(bytes)
    switch (read.kind) {
      case 'empty':
        return { kind: 'empty' }
      case 'invalid':
        return { kind: 'invalid', reason: read.reason, size: bytes.byteLength }
      case 'valid':
        return { kind: 'valid', generation: read.header.generation, meta: draftMetaOf(read.record), size: bytes.byteLength }
    }
  }

  function pipelineOf(id: number): Pipeline {
    const pipeline = pipelines.get(id)
    if (pipeline === undefined)
      throw new Error(`没有编号为 ${id} 的管道`)
    return pipeline
  }

  function workerFor(script: ProbeWorkerScript, name: string): () => WorkerLike {
    switch (script) {
      case 'production':
        return createOutboxWorker
      case 'recording':
        return () => new Worker(new URL('./outbox-probe.worker.ts', import.meta.url), { type: 'module', name })
      case 'missing':
        return () => new Worker(MISSING_WORKER_SCRIPT, { type: 'module', name })
    }
  }

  return {
    create: async (options) => {
      const id = nextId
      nextId += 1
      if (options.host === 'in-process') {
        const writer = createDraftWriter({ store: createDraftStore({ blockedTimeoutMs: 3_000 }), now: () => Date.now() })
        pipelines.set(id, { writer, broken: () => undefined, transactions: [], channel: undefined })
        return { id, ready: { kind: 'ready' } }
      }
      const script = options.script ?? 'production'
      const name = `nerve-outbox-probe-${crypto.randomUUID()}`
      const transactions: ProbeWorkerTransaction[] = []
      // 记事务的脚本以 Worker 的名字为频道名报来；先听着，再建 Worker
      const channel = script === 'recording' ? new BroadcastChannel(name) : undefined
      if (channel !== undefined)
        channel.onmessage = event => transactions.push(event.data as ProbeWorkerTransaction)
      const client = createOutboxWorkerClient({ create: workerFor(script, name), clock: pageClock, requestTimeoutMs: options.requestTimeoutMs ?? 15_000, keepAlive: options.keepAlive ?? true })
      pipelines.set(id, { writer: client, broken: client.broken, transactions, channel })
      return { id, ready: await client.ready() }
    },
    setKey: async (id, choice) => {
      const key = choice === 'probe' ? deps.key() : undefined
      if (choice === 'probe' && key === undefined)
        throw new Error('探针还没有密钥：先 chooseKey')
      return summarize(await pipelineOf(id).writer.setKey(key))
    },
    register: async (id, key, writer, force) => summarize(await pipelineOf(id).writer.register(key, writer, force)),
    write: async (id, capture) => summarize(await pipelineOf(id).writer.write(captureOf(capture))),
    markInFlight: async (id, key, writer, inFlight) => pipelineOf(id).writer.markInFlight(key, writer, inFlight),
    confirm: async (id, key, writer, confirmedSeq, revision) => pipelineOf(id).writer.confirm(key, writer, confirmedSeq, revision),
    read: async (id, key) => summarize(await pipelineOf(id).writer.read(key)),
    remove: async (id, key, expectedSeq) => pipelineOf(id).writer.remove(key, expectedSeq),
    seedDigest: async (id, key, seed) => pipelineOf(id).writer.seedDigest(key, seed),
    broken: id => pipelineOf(id).broken(),
    dispose: (id) => {
      const pipeline = pipelineOf(id)
      pipeline.writer.dispose()
      pipeline.channel?.close()
    },
    writeThenDispose: async (id, capture, delayMs) => {
      const pipeline = pipelineOf(id)
      const toWrite = captureOf(capture)
      // 先算内容的摘要：交给 Worker 之后字节随之转移走
      const contentSha256 = await sha256Hex(toWrite.bytes)
      const writing = pipeline.writer.write(toWrite)
      await new Promise(resolve => setTimeout(resolve, delayMs))
      const disposedAt = performance.now()
      pipeline.writer.dispose()
      const result = await writing
      const settledAfterDisposeMs = performance.now() - disposedAt
      return { result: await summarize(result), settledAfterDisposeMs, contentSha256 }
    },
    storedGzip: async (key) => {
      const read = await deps.store().readDraft(key)
      switch (read.kind) {
        case 'absent':
        case 'newer-format':
        case 'malformed':
          return { kind: read.kind }
        case 'quota':
          return { kind: 'quota' }
        case 'unavailable':
          return { kind: 'unavailable', reason: read.reason }
        case 'failed':
          return { kind: 'failed', error: describeFailure(read.error) }
        case 'draft': {
          const handle = deps.key()
          if (handle === undefined)
            return { kind: 'no-key' }
          const meta = draftMetaOf(read.draft)
          const opened = await openDraft(handle, read.draft)
          return opened.kind === 'opened' ? { kind: 'gzip', meta, gzip: await gzipSummary(opened.gzip) } : { kind: 'unreadable', meta, reason: opened.reason }
        }
      }
    },
    workerTransactions: id => [...pipelineOf(id).transactions],
    release: async (id, key) => pipelineOf(id).writer.release(key),
    reconcile: async (id, userId) => pipelineOf(id).writer.reconcile(userId),
    notices: async (id, userId) => pipelineOf(id).writer.notices(userId),
    clearNotice: async (id, key, expectedAt) => pipelineOf(id).writer.clearNotice(key, expectedAt),
    cleanupUser: async userId => plain(await localCleanup().removeUser(userId)),
    cleanupAbandon: async (key, expectedSeq) => plain(await localCleanup().abandon(key, expectedSeq)),
    cleanupExpired: async now => plain(await localCleanup().purgeExpired(now)),
    mirrorSlots: async key => [await slotOf(key, 0), await slotOf(key, 1)],
    corruptSlot: async (key, slot, corruption) => {
      await opfs('truncate' in corruption ? { op: 'truncate', path: pathOf(key, slot), size: corruption.truncate } : { op: 'fill', path: pathOf(key, slot), size: corruption.fill, value: corruption.value })
    },
    removeMirror: async userId => opfsMirrorDirectory().removeUser(userId),
    removeMirrorDocument: async key => opfsMirrorDirectory().removeDocument(key),
    disposeAll: () => {
      for (const pipeline of pipelines.values()) {
        pipeline.writer.dispose()
        pipeline.channel?.close()
      }
      pipelines.clear()
      opfsWorker?.terminate()
      opfsWorker = undefined
    },
  }
}

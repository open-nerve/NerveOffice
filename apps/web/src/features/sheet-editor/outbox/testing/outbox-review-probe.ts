// 真实浏览器复核里生产的那一部分（M4-P1 设计 §3.6 第 9 项的生产 Worker、第 11 项；主会话把 S8 的第二轮并进 S1 的这一轮）：只在测试构建里。
// 页面自检的挂接（../../selftest-hook.ts）在复核的场景要用时动态引入它，交给 editor/testing 的场景（editor/testing 不能引用 features）：
// - 生产的发件箱 Worker（createOutboxWorker + createOutboxWorkerClient，带 100 ms 的空定时器，与 P2 的编辑器页同一个写法）：交密钥（生产的
//   交法，keyTransferOf）、登记写入者，之后每次写一份——字节转移过去、不去重，Worker 里依次 SHA-256 → gzip → 加密 → 写入（strict）→ OPFS 的
//   镜像（§3.8：IndexedDB 提交之后写进两个槽位之一）——交回往返与镜像写成了没有；
// - 进程内的各段（主线程、生产的存储，磁盘上）：SHA-256、gzip、封（AES-GCM 带 AAD）、写入（生产存储的写法：栅栏的判定与写在同一个 strict 事务里），
//   接着 OPFS 的镜像（同步访问句柄只在专用 Worker 里有：经测试 Worker ./mirror-review.worker.ts 调用生产的镜像，flush 单独计），另把同一份记录
//   直接写进同一个库各一次 strict、default（只差 durability，看 strict 的开销）；恢复：读（存储）、解开、解压、解析，镜像那边读两个槽位并
//   与库里那一份比对。各次写同一份文档（登记一次，序号递增：编辑时的样子，库与镜像都是改写）。
// 不改甲、乙的探针（outbox-probe.ts、pipeline-probe.ts、opfs-probe.worker.ts），只引用生产模块。用自己的用户与文档（随机），收尾时按用户删掉
// 库里的与 OPFS 里的镜像目录。交回的都是普通的值（毫秒、字节数、种类），不交出密钥与内容。
// 不引用编辑器页的时钟模块（它带着请求层与 zod，见 outbox-probe.ts 开头的说明）：看门狗用这里的计时器
import type { OutboxConnection } from '../../../../shared/outbox/database.ts'
import type { LocalKeyHandle } from '../../../../shared/outbox/draft-codec.ts'
import type { ContentFormat, DraftKey, DraftMeta, StoredDraft } from '../../../../shared/outbox/draft-record.ts'
import type { DraftStore } from '../../../../shared/outbox/draft-store.ts'
import type { CaptureToWrite } from '../../../../shared/outbox/draft-writer.ts'
import type { WriterIdentity } from '../../../../shared/outbox/writer-fence.ts'
import type { MirrorReadTimes, MirrorWriteTimes } from './mirror-review.ts'
import type { MirrorReviewCall, MirrorReviewReply, MirrorReviewRequest } from './mirror-review.worker.ts'
import { browserIndexedDb, DRAFTS_STORE, openOutboxDatabase } from '../../../../shared/outbox/database.ts'
import { gunzipBytes, gzipBytes, openDraft, sealDraft, sha256Hex } from '../../../../shared/outbox/draft-codec.ts'
import { DRAFT_RECORD_VERSION } from '../../../../shared/outbox/draft-record.ts'
import { createDraftStore } from '../../../../shared/outbox/draft-store.ts'
import { describeFailure } from '../../../../shared/outbox/failure.ts'
import { importLocalKey } from '../../../../shared/outbox/local-key-import.ts'
import { opfsMirrorDirectory } from '../../../../shared/outbox/mirror-directory.ts'
import { createOutboxWorker, createOutboxWorkerClient } from '../outbox-worker-client.ts'
import { mirrorProblemOf, statusText } from './mirror-review.ts'

/**
 * 生产的发件箱 Worker 的一次写入：结果的种类、页面这一侧的往返（毫秒）、交回的 gzip 的字节数（没有时 null）、OPFS 的镜像
 * （写成时：mirrored、not-mirrored:<原因>；没写成时 null）
 */
export interface ReviewWrite {
  readonly kind: string
  readonly roundTripMs: number
  readonly gzipBytes: number | null
  readonly mirror: string | null
}

/** 一个生产的发件箱 Worker：握手的结果（ready 或坏了的原因）、登记时镜像拿到句柄了没有、写一份、关掉 */
export interface ReviewWorker {
  readonly ready: string
  readonly registerMirror: string | null
  /** 写一份：字节归 Worker（转移过去，调用方那一份随之清空） */
  readonly write: (bytes: Uint8Array<ArrayBuffer>) => Promise<ReviewWrite>
  readonly dispose: () => void
}

/** 进程内走一遍生产的写入与恢复，各段的毫秒与核对 */
export interface ReviewSegments {
  readonly rawBytes: number
  readonly gzipBytes: number
  readonly digestMs: number
  readonly gzipMs: number
  readonly sealMs: number
  /** 生产存储的写入（栅栏的判定与写在同一个 strict 事务里） */
  readonly storeWriteMs: number
  /** 同一份记录直接写进同一个库：strict 与 default，只差 durability */
  readonly rawStrictMs: number
  readonly rawDefaultMs: number
  /** 两次直接写入的事务实际的 durability 属性（不支持时 null） */
  readonly strictAttribute: string | null
  readonly defaultAttribute: string | null
  /** 恢复：读（存储）、解开、解压、解析 */
  readonly readMs: number
  readonly openMs: number
  readonly gunzipMs: number
  readonly parseMs: number
  /** OPFS 的镜像这一次（./mirror-review.ts 的 statusText）：mirrored；这个上下文没有 OPFS 时 not-mirrored:unsupported */
  readonly mirror: string
  /** 镜像的各段（没写成、没读的为 null）：登记（拿句柄、读两个槽位并校验）、整个写入、其中截断与写、其中 flush；读两个槽位并校验、其中拿句柄、比对 */
  readonly mirrorAttachMs: number | null
  readonly mirrorWriteMs: number | null
  readonly mirrorIoMs: number | null
  readonly mirrorFlushMs: number | null
  readonly mirrorReadMs: number | null
  readonly mirrorOpenMs: number | null
  readonly mirrorCompareMs: number | null
  /** 两个槽位读出的种类（例如 valid+valid） */
  readonly mirrorSlots: string | null
  /** 写成了、读回来解得开，解压之后与原来的字节相同（SHA-256） */
  readonly roundTrip: boolean
  /** 没走完时的原因（写入被拒、读不出、解不开、镜像没写成或读回来不是这一份……）；走完了为 undefined */
  readonly problem: string | undefined
}

export interface OutboxReview {
  /** 起一个生产的发件箱 Worker（带空定时器）、交密钥、登记写入者 */
  readonly startWorker: () => Promise<ReviewWorker>
  /** 进程内走一遍（字节在这一侧用完，不转移） */
  readonly segments: (bytes: Uint8Array<ArrayBuffer>) => Promise<ReviewSegments>
  /**
   * 收尾：关掉各个 Worker，删掉这个用户在 OPFS 里的镜像目录与库里的全部（草稿与写入者），关掉连接。交回镜像目录删成了没有：
   * removed；这个上下文没有 OPFS 时 unsupported；到点还被占着时 busy
   */
  readonly cleanup: () => Promise<string>
}

/** 页面里的计时器（客户端的看门狗） */
const pageClock = {
  schedule: (callback: () => void, delayMs: number): (() => void) => {
    const timer = setTimeout(callback, delayMs)
    return () => clearTimeout(timer)
  },
}

/** 客户端每个请求的看门狗：约 5 MiB 的写入在 CI 的慢机器上也在几秒以内；停顿约 1 秒 */
const REQUEST_TIMEOUT_MS = 30_000

/** Worker 终止之后句柄是异步放开的：删镜像目录时被占着就隔一会儿再删，至多这么久 */
const MIRROR_REMOVE_TIMEOUT_MS = 10_000
const MIRROR_REMOVE_RETRY_MS = 100

/** 复核写下的草稿标明的数据格式（只给恢复的判定看，这里不恢复） */
const REVIEW_FORMAT: ContentFormat = { clientBuild: 'selftest-review', univerVersion: '1.0.1', profile: 'sheet@1', formatVersion: 1 }

/** 一把随机的本机密钥，经生产的导入（不可导出，导入之后原始字节清零） */
async function reviewKey(): Promise<LocalKeyHandle> {
  const raw = crypto.getRandomValues(new Uint8Array(32))
  const key = btoa(String.fromCharCode(...raw))
  raw.fill(0)
  return importLocalKey({ version: 1, key })
}

function durabilityOf(transaction: IDBTransaction): string | null {
  const value: unknown = Reflect.get(transaction, 'durability')
  return typeof value === 'string' ? value : null
}

/** 直接把一条记录写进库（只差 durability），交回用时与事务实际的 durability 属性 */
async function putRaw(connection: OutboxConnection, record: object, durability: 'strict' | 'default'): Promise<{ readonly ms: number, readonly attribute: string | null }> {
  const started = performance.now()
  const transaction = connection.db.transaction(DRAFTS_STORE, 'readwrite', { durability })
  const attribute = durabilityOf(transaction)
  transaction.objectStore(DRAFTS_STORE).put(record)
  await new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onabort = () => reject(transaction.error ?? new DOMException('事务被中止', 'AbortError'))
  })
  return { ms: performance.now() - started, attribute }
}

function metaOf(key: DraftKey, writer: WriterIdentity, draftSeq: number, rawBytes: number): Omit<DraftMeta, 'keyVersion'> {
  return {
    userId: key.userId,
    documentId: key.documentId,
    recordVersion: DRAFT_RECORD_VERSION,
    draftSeq,
    baseRevision: 1,
    writeEpoch: writer.writeEpoch,
    writerId: writer.writerId,
    writtenBy: 'selftest-review',
    format: REVIEW_FORMAT,
    formulasPending: false,
    inFlight: null,
    rawBytes,
    updatedAt: Date.now(),
  }
}

/** 量 OPFS 镜像的测试 Worker（./mirror-review.worker.ts）：一问一答，带看门狗；Worker 出错、关掉之后的请求都失败 */
interface MirrorWorker {
  readonly write: (record: StoredDraft) => Promise<MirrorWriteTimes>
  readonly read: (stored: StoredDraft) => Promise<MirrorReadTimes>
  /** 放开全部句柄、终止 Worker */
  readonly close: () => Promise<void>
}

function startMirrorWorker(): MirrorWorker {
  const worker = new Worker(new URL('./mirror-review.worker.ts', import.meta.url), { type: 'module', name: 'nerve-mirror-review' })
  const pending = new Map<number, { readonly resolve: (reply: MirrorReviewReply) => void, readonly reject: (error: Error) => void }>()
  let nextId = 0
  let broken: Error | undefined
  const breakAll = (error: Error): void => {
    broken ??= error
    for (const entry of pending.values())
      entry.reject(error)
    pending.clear()
  }
  worker.addEventListener('message', (event: MessageEvent<MirrorReviewReply>) => {
    const entry = pending.get(event.data.id)
    pending.delete(event.data.id)
    entry?.resolve(event.data)
  })
  worker.addEventListener('error', (event) => {
    event.preventDefault()
    breakAll(new Error(`量镜像的 Worker 出错：${event.message || '加载失败'}`))
  })
  worker.addEventListener('messageerror', () => breakAll(new Error('量镜像的 Worker 的回复读不出')))
  const call = async (request: MirrorReviewCall): Promise<MirrorReviewReply> => {
    if (broken !== undefined)
      throw broken
    nextId += 1
    const id = nextId
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`量镜像的 Worker ${REQUEST_TIMEOUT_MS} ms 没有回应（${request.op}）`))
      }, REQUEST_TIMEOUT_MS)
      pending.set(id, {
        resolve: (reply) => {
          clearTimeout(timer)
          resolve(reply)
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        },
      })
      worker.postMessage({ ...request, id } satisfies MirrorReviewRequest)
    })
  }
  const unexpected = (reply: MirrorReviewReply, op: string): Error => new Error(reply.op === 'error'
    ? `量镜像的 Worker 里出错（${op}）：${reply.error.name}: ${reply.error.message}`
    : `量镜像的 Worker 回错了（要 ${op}，回的是 ${reply.op}）`)
  return {
    write: async (record) => {
      const reply = await call({ op: 'write', record })
      if (reply.op !== 'write')
        throw unexpected(reply, 'write')
      return reply.result
    },
    read: async (stored) => {
      const reply = await call({ op: 'read', stored })
      if (reply.op !== 'read')
        throw unexpected(reply, 'read')
      return reply.result
    },
    close: async () => {
      // 坏了也照样终止
      await call({ op: 'close' }).catch(() => undefined)
      breakAll(new Error('量镜像的 Worker 已经关掉'))
      worker.terminate()
    },
  }
}

/** 删掉这个用户的镜像目录（页面里删，不用同步访问句柄）：被占着（Worker 刚终止、句柄还没放开）时隔一会儿再删，至多 MIRROR_REMOVE_TIMEOUT_MS */
async function removeMirrorOf(userId: string): Promise<string> {
  const directory = opfsMirrorDirectory()
  const deadline = performance.now() + MIRROR_REMOVE_TIMEOUT_MS
  let removed = await directory.removeUser(userId)
  while (removed.kind !== 'removed' && removed.kind !== 'unsupported' && performance.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, MIRROR_REMOVE_RETRY_MS))
    removed = await directory.removeUser(userId)
  }
  return removed.kind === 'failed' ? `failed:${describeFailure(removed.error).name}` : removed.kind
}

/** 进程内各段写的那一份文档：登记一次，之后序号递增 */
interface SegmentsDocument {
  readonly key: DraftKey
  readonly writer: WriterIdentity
  seq: number
}

export function createOutboxReview(): OutboxReview {
  const userId = `selftest-review-${crypto.randomUUID()}`
  const workers: ReviewWorker[] = []
  let key: Promise<LocalKeyHandle> | undefined
  let store: DraftStore | undefined
  let connection: OutboxConnection | undefined
  let segmentsDocument: Promise<SegmentsDocument> | undefined
  let mirror: MirrorWorker | undefined
  const keyOnce = async (): Promise<LocalKeyHandle> => {
    key ??= reviewKey()
    return key
  }
  const storeOnce = (): DraftStore => {
    store ??= createDraftStore({ blockedTimeoutMs: 3_000 })
    return store
  }
  const connectionOnce = async (): Promise<OutboxConnection> => {
    if (connection !== undefined && !connection.isClosed())
      return connection
    const opened = await openOutboxDatabase({ factory: browserIndexedDb, blockedTimeoutMs: 3_000 })
    if (opened.kind !== 'connected')
      throw new Error(`发件箱的库打不开：${opened.reason}`)
    connection = opened
    return opened
  }
  /** 登记没成时序号从 0 起，写入被栅栏拒绝，按"没走完"交回 */
  const segmentsDocumentOnce = async (): Promise<SegmentsDocument> => {
    segmentsDocument ??= (async () => {
      const documentKey: DraftKey = { userId, documentId: `segments-${crypto.randomUUID()}` }
      const writer: WriterIdentity = { writeEpoch: 1, writerId: crypto.randomUUID() }
      const registered = await storeOnce().registerWriter(documentKey, writer, { now: Date.now(), force: false })
      return { key: documentKey, writer, seq: registered.kind === 'registered' ? registered.lastDraftSeq : 0 }
    })()
    return segmentsDocument
  }
  const mirrorOnce = (): MirrorWorker => {
    mirror ??= startMirrorWorker()
    return mirror
  }

  return {
    startWorker: async () => {
      const client = createOutboxWorkerClient({ create: createOutboxWorker, clock: pageClock, requestTimeoutMs: REQUEST_TIMEOUT_MS, keepAlive: true })
      const ready = await client.ready()
      const documentKey: DraftKey = { userId, documentId: `worker-${crypto.randomUUID()}` }
      const writer: WriterIdentity = { writeEpoch: 1, writerId: crypto.randomUUID() }
      let draftSeq = 0
      let registerMirror: string | null = null
      if (ready.kind === 'ready') {
        await client.setKey(await keyOnce())
        const registered = await client.register(documentKey, writer, false)
        draftSeq = registered.kind === 'registered' ? registered.lastDraftSeq : 0
        registerMirror = registered.kind === 'registered' ? statusText(registered.mirror) : null
      }
      const worker: ReviewWorker = {
        ready: ready.kind === 'ready' ? 'ready' : ready.failure,
        registerMirror,
        write: async (bytes) => {
          draftSeq += 1
          const capture: CaptureToWrite = { key: documentKey, writer, draftSeq, baseRevision: 1, writtenBy: 'selftest-review', format: REVIEW_FORMAT, formulasPending: false, inFlight: null, bytes, dedupe: false }
          const started = performance.now()
          const result = await client.write(capture)
          const roundTripMs = performance.now() - started
          const gzip = 'gzip' in result ? result.gzip : null
          return { kind: result.kind, roundTripMs, gzipBytes: gzip === null ? null : gzip.byteLength, mirror: result.kind === 'written' ? statusText(result.mirror) : null }
        },
        dispose: () => client.dispose(),
      }
      workers.push(worker)
      return worker
    },
    segments: async (bytes) => {
      const handle = await keyOnce()
      const drafts = storeOnce()
      const document = await segmentsDocumentOnce()
      document.seq += 1
      const t0 = performance.now()
      const digest = await sha256Hex(bytes)
      const t1 = performance.now()
      const gzip = await gzipBytes(bytes)
      const t2 = performance.now()
      const sealed = await sealDraft(handle, metaOf(document.key, document.writer, document.seq, bytes.byteLength), gzip)
      const t3 = performance.now()
      const written = await drafts.writeDraft(sealed)
      const t4 = performance.now()
      // 生产的管道在 IndexedDB 提交之后写镜像（§3.8）；没写成库里那一份的不写
      const mirrorWorker = mirrorOnce()
      const mirrored: MirrorWriteTimes = written.kind === 'written'
        ? await mirrorWorker.write(sealed)
        : { status: 'not-written', attachMs: null, writeMs: null, ioMs: null, flushMs: null }
      const database = await connectionOnce()
      const rawStrict = await putRaw(database, { ...sealed, documentId: `${document.key.documentId}-strict` }, 'strict')
      const rawDefault = await putRaw(database, { ...sealed, documentId: `${document.key.documentId}-default` }, 'default')
      const r0 = performance.now()
      const read = await drafts.readDraft(document.key)
      const r1 = performance.now()
      const opened = read.kind === 'draft' ? await openDraft(handle, read.draft) : undefined
      const r2 = performance.now()
      const restored = opened?.kind === 'opened' ? await gunzipBytes(opened.gzip) : undefined
      const r3 = performance.now()
      let parsed = false
      if (restored !== undefined) {
        JSON.parse(new TextDecoder().decode(restored))
        parsed = true
      }
      const r4 = performance.now()
      const roundTrip = restored !== undefined && await sha256Hex(restored) === digest
      // 打开、登记之前的比对（§3.8）：读两个槽位、与库里那一份比；镜像没写成的不读
      const compared = mirrored.status === 'mirrored' && read.kind === 'draft' ? await mirrorWorker.read(read.draft) : undefined
      const problem = written.kind !== 'written'
        ? `写入：${written.kind}`
        : read.kind !== 'draft'
          ? `读回：${read.kind}`
          : opened?.kind !== 'opened'
            ? `解开：${opened?.reason ?? '没有'}`
            : !parsed || !roundTrip ? '解压之后与原来的字节不同' : mirrorProblemOf(mirrored, compared)
      return {
        rawBytes: bytes.byteLength,
        gzipBytes: gzip.byteLength,
        digestMs: t1 - t0,
        gzipMs: t2 - t1,
        sealMs: t3 - t2,
        storeWriteMs: t4 - t3,
        rawStrictMs: rawStrict.ms,
        rawDefaultMs: rawDefault.ms,
        strictAttribute: rawStrict.attribute,
        defaultAttribute: rawDefault.attribute,
        readMs: r1 - r0,
        openMs: r2 - r1,
        gunzipMs: r3 - r2,
        parseMs: r4 - r3,
        mirror: mirrored.status,
        mirrorAttachMs: mirrored.attachMs,
        mirrorWriteMs: mirrored.writeMs,
        mirrorIoMs: mirrored.ioMs,
        mirrorFlushMs: mirrored.flushMs,
        mirrorReadMs: compared?.readMs ?? null,
        mirrorOpenMs: compared?.openMs ?? null,
        mirrorCompareMs: compared?.compareMs ?? null,
        mirrorSlots: compared?.slots ?? null,
        roundTrip,
        problem,
      }
    },
    cleanup: async () => {
      for (const worker of workers.splice(0))
        worker.dispose()
      await mirror?.close()
      mirror = undefined
      // 句柄都放开之后才删得掉镜像目录；直接写进库的两条（-strict、-default）没有写入者，按用户删照样删掉
      const removed = await removeMirrorOf(userId)
      await storeOnce().removeUserData(userId)
      store?.close()
      connection?.close()
      return removed
    },
  }
}

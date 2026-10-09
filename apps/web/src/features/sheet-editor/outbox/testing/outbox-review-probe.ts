import type { OutboxConnection } from '../../../../shared/outbox/database.ts'
// 真实浏览器复核里生产的那一部分（M4-P1 设计 §3.6 第 9 项的生产 Worker、第 11 项；主会话把 S8 的第二轮并进 S1 的这一轮）：只在测试构建里。
// 页面自检的挂接（../../selftest-hook.ts）在复核的场景要用时动态引入它，交给 editor/testing 的场景（editor/testing 不能引用 features）：
// - 生产的发件箱 Worker（createOutboxWorker + createOutboxWorkerClient，带 100 ms 的空定时器，与 P2 的编辑器页同一个写法）：交密钥（生产的
//   交法，keyTransferOf）、登记写入者，之后每次写一份——字节转移过去、不去重，Worker 里依次 SHA-256 → gzip → 加密 → 写入（strict）——交回往返；
// - 进程内的各段（主线程、生产的存储，磁盘上）：SHA-256、gzip、封（AES-GCM 带 AAD）、写入（生产存储的写法：栅栏的判定与写在同一个 strict 事务里），
//   另把同一份记录直接写进同一个库各一次 strict、default（只差 durability，看 strict 的开销）；恢复：读（存储）、解开、解压、解析。
// 不改甲、乙的探针（outbox-probe.ts、pipeline-probe.ts），只引用生产模块。用自己的用户与文档（随机），收尾时按用户删掉。
// 交回的都是普通的值（毫秒、字节数、种类），不交出密钥与内容。
// 不引用编辑器页的时钟模块（它带着请求层与 zod，见 outbox-probe.ts 开头的说明）：看门狗用这里的计时器
import type { LocalKeyHandle } from '../../../../shared/outbox/draft-codec.ts'
import type { ContentFormat, DraftKey, DraftMeta } from '../../../../shared/outbox/draft-record.ts'
import type { DraftStore } from '../../../../shared/outbox/draft-store.ts'
import type { CaptureToWrite } from '../../../../shared/outbox/draft-writer.ts'
import type { WriterIdentity } from '../../../../shared/outbox/writer-fence.ts'
import { browserIndexedDb, DRAFTS_STORE, openOutboxDatabase } from '../../../../shared/outbox/database.ts'
import { gunzipBytes, gzipBytes, openDraft, sealDraft, sha256Hex } from '../../../../shared/outbox/draft-codec.ts'
import { DRAFT_RECORD_VERSION } from '../../../../shared/outbox/draft-record.ts'
import { createDraftStore } from '../../../../shared/outbox/draft-store.ts'
import { importLocalKey } from '../../../../shared/outbox/local-key-import.ts'
import { createOutboxWorker, createOutboxWorkerClient } from '../outbox-worker-client.ts'

/** 生产的发件箱 Worker 的一次写入：结果的种类、页面这一侧的往返（毫秒）、交回的 gzip 的字节数（没有时 null） */
export interface ReviewWrite {
  readonly kind: string
  readonly roundTripMs: number
  readonly gzipBytes: number | null
}

/** 一个生产的发件箱 Worker：握手的结果（ready 或坏了的原因）、写一份、关掉 */
export interface ReviewWorker {
  readonly ready: string
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
  /** 写成了、读回来解得开，解压之后与原来的字节相同（SHA-256） */
  readonly roundTrip: boolean
  /** 没走完时的原因（写入被拒、读不出、解不开……）；走完了为 undefined */
  readonly problem: string | undefined
}

export interface OutboxReview {
  /** 起一个生产的发件箱 Worker（带空定时器）、交密钥、登记写入者 */
  readonly startWorker: () => Promise<ReviewWorker>
  /** 进程内走一遍（字节在这一侧用完，不转移） */
  readonly segments: (bytes: Uint8Array<ArrayBuffer>) => Promise<ReviewSegments>
  /** 收尾：删掉这个用户在库里的全部（草稿与写入者），关掉连接 */
  readonly cleanup: () => Promise<void>
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

export function createOutboxReview(): OutboxReview {
  const userId = `selftest-review-${crypto.randomUUID()}`
  const workers: ReviewWorker[] = []
  let key: Promise<LocalKeyHandle> | undefined
  let store: DraftStore | undefined
  let connection: OutboxConnection | undefined
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

  return {
    startWorker: async () => {
      const client = createOutboxWorkerClient({ create: createOutboxWorker, clock: pageClock, requestTimeoutMs: REQUEST_TIMEOUT_MS, keepAlive: true })
      const ready = await client.ready()
      const documentKey: DraftKey = { userId, documentId: `worker-${crypto.randomUUID()}` }
      const writer: WriterIdentity = { writeEpoch: 1, writerId: crypto.randomUUID() }
      let draftSeq = 0
      if (ready.kind === 'ready') {
        await client.setKey(await keyOnce())
        const registered = await client.register(documentKey, writer, false)
        draftSeq = registered.kind === 'registered' ? registered.lastDraftSeq : 0
      }
      const worker: ReviewWorker = {
        ready: ready.kind === 'ready' ? 'ready' : ready.failure,
        write: async (bytes) => {
          draftSeq += 1
          const capture: CaptureToWrite = { key: documentKey, writer, draftSeq, baseRevision: 1, writtenBy: 'selftest-review', format: REVIEW_FORMAT, formulasPending: false, inFlight: null, bytes, dedupe: false }
          const started = performance.now()
          const result = await client.write(capture)
          const roundTripMs = performance.now() - started
          const gzip = 'gzip' in result ? result.gzip : null
          return { kind: result.kind, roundTripMs, gzipBytes: gzip === null ? null : gzip.byteLength }
        },
        dispose: () => client.dispose(),
      }
      workers.push(worker)
      return worker
    },
    segments: async (bytes) => {
      const handle = await keyOnce()
      const drafts = storeOnce()
      const documentKey: DraftKey = { userId, documentId: `segments-${crypto.randomUUID()}` }
      const writer: WriterIdentity = { writeEpoch: 1, writerId: crypto.randomUUID() }
      const registered = await drafts.registerWriter(documentKey, writer, { now: Date.now(), force: false })
      const draftSeq = registered.kind === 'registered' ? registered.lastDraftSeq + 1 : 1
      const t0 = performance.now()
      const digest = await sha256Hex(bytes)
      const t1 = performance.now()
      const gzip = await gzipBytes(bytes)
      const t2 = performance.now()
      const sealed = await sealDraft(handle, metaOf(documentKey, writer, draftSeq, bytes.byteLength), gzip)
      const t3 = performance.now()
      const written = await drafts.writeDraft(sealed)
      const t4 = performance.now()
      const database = await connectionOnce()
      const rawStrict = await putRaw(database, { ...sealed, documentId: `${documentKey.documentId}-strict` }, 'strict')
      const rawDefault = await putRaw(database, { ...sealed, documentId: `${documentKey.documentId}-default` }, 'default')
      const r0 = performance.now()
      const read = await drafts.readDraft(documentKey)
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
      const problem = written.kind !== 'written'
        ? `写入：${written.kind}`
        : read.kind !== 'draft'
          ? `读回：${read.kind}`
          : opened?.kind !== 'opened'
            ? `解开：${opened?.reason ?? '没有'}`
            : !parsed || !roundTrip ? '解压之后与原来的字节不同' : undefined
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
        roundTrip,
        problem,
      }
    },
    cleanup: async () => {
      for (const worker of workers.splice(0))
        worker.dispose()
      // 直接写进去的两条（-strict、-default）没有写入者，按用户删照样删掉
      await storeOnce().removeUserData(userId)
      store?.close()
      connection?.close()
    },
  }
}

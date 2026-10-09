// 本机发件箱的浏览器层探针（M4-P1 设计 §3.1、§4）：只在测试构建里。编辑器页的组装处（start.tsx）在测试构建、地址带 outboxProbe 时
// 动态引入它，挂在 window.__nerveOutboxProbe 上；生产构建里这个分支与它的分块都被去掉（门禁 artifacts 按来源、分块名与名字核对）。
// E2E 经 page.evaluate 调用生产的存储（createDraftStore）、编解码与列表索引，在真实的 IndexedDB 上核对事务、栅栏、写满、清理与保留期；
// 另有直接看库、改库（绕过存储与 AAD）与扮演别的页面（更新的页面升级、挡住升级、删库）的几样。
// 交回的都是能经 page.evaluate 传回的普通值：字节写成十六进制，错误只带名字与消息；不交出密钥。
// 只引用发件箱自己的、不带 zod 的模块：不引用请求层（shared/api）、zod 与带 zod 的契约模块——引用了，测试构建里平台页面与编辑器页的入口分块
// 就与生产的不同（M3-P2 复核 B4）；S6 实测探针经 local-key.ts 引用请求层时，请求层连同 zod 与契约的结构被拆进一个新的共享分块，
// 先于关掉 zod 的 JIT（shared/lib/zod-jitless.ts）求值。所以取本机密钥的请求由探针自己发（取会话里的 CSRF 令牌、POST），导入用生产的
// importLocalKey；请求层的写法（自动带 CSRF、按契约校验）由 local-key.ts 的单元测试覆盖。
// 写入管道（进程内与发件箱 Worker 两种宿主）的那一部分在 pipeline-probe.ts，挂在 pipeline 上
import type { LocalKeyHandle } from '../../../../shared/outbox/draft-codec.ts'
import type { DraftKey, DraftMeta, ReadDraft } from '../../../../shared/outbox/draft-record.ts'
import type { DraftStore, ListedDraft, StoreProblem } from '../../../../shared/outbox/draft-store.ts'
import type { WriterIdentity } from '../../../../shared/outbox/writer-fence.ts'
import type { ProbePipeline } from './pipeline-probe.ts'
import { browserIndexedDb, DRAFTS_STORE, openOutboxDatabase, OUTBOX_DATABASE_NAME, OUTBOX_DATABASE_VERSION, OUTBOX_KEY_PATH, WRITERS_STORE } from '../../../../shared/outbox/database.ts'
import { gunzipBytes, gzipBytes, openDraft, sealDraft } from '../../../../shared/outbox/draft-codec.ts'
import { draftDocumentIds } from '../../../../shared/outbox/draft-index.ts'
import { createDraftStore } from '../../../../shared/outbox/draft-store.ts'
import { importLocalKey } from '../../../../shared/outbox/local-key-import.ts'
import { createPipelineProbe } from './pipeline-probe.ts'

/** 挂在 window 上的名字（门禁的禁用关键字里登记了它：生产构建里连名字都不能有） */
export const OUTBOX_PROBE_NAME = '__nerveOutboxProbe'

/** 错误只带名字与消息 */
export interface ProbeError {
  readonly name: string
  readonly message: string
}

/** 存储的结果里的错误换成 ProbeError（failed 的 error） */
export type Plain<T> = T extends { readonly kind: 'failed', readonly error: unknown } ? { readonly kind: 'failed', readonly error: ProbeError } : T

/** 要写的一份：元数据（密钥版本取自探针当前的密钥，解压后的字节数按内容算）与内容；内容可以是随机的 base64（写满的用例，几乎压不动） */
export interface ProbeDraftInput {
  readonly meta: Omit<DraftMeta, 'keyVersion' | 'rawBytes'>
  readonly content: string | { readonly randomBase64Chars: number }
}

/** 读出的一份：解开了给出内容，解不开给出原因；探针还没有密钥时 no-key */
export type ProbeOpened
  = | { readonly kind: 'opened', readonly content: string }
    | { readonly kind: 'unreadable', readonly reason: 'revoked' | 'corrupted' }
    | { readonly kind: 'no-key' }

export type ProbeRead
  = | { readonly kind: 'draft', readonly meta: DraftMeta, readonly ivHex: string, readonly ciphertextBytes: number, readonly opened: ProbeOpened }
    | { readonly kind: 'newer-format', readonly recordVersion: number }
    | { readonly kind: 'malformed' }

export type ProbeRegisterOutcome
  = | { readonly kind: 'registered', readonly lastDraftSeq: number, readonly existing: ProbeRead | undefined }
    | { readonly kind: 'superseded', readonly currentEpoch: number, readonly sameEpoch: boolean }
    | Plain<StoreProblem>

/** 库的结构：版本、各仓库的键路径与索引（库不存在时为 null） */
export interface ProbeDatabaseShape {
  readonly version: number
  readonly stores: readonly { readonly name: string, readonly keyPath: string | readonly string[] | null, readonly indexes: readonly string[] }[]
}

/** 记下的一次开事务：仓库、模式与要求的持久性 */
export interface ProbeTransaction {
  readonly stores: readonly string[]
  readonly mode: string
  readonly durability: string | undefined
}

/** 取本机密钥的结果：版本与导入出的密钥的事实（可不可导出、用途、算法、导出被拒的错误名），或者失败的错误 */
export type ProbeLocalKey
  = | { readonly kind: 'fetched', readonly version: number, readonly extractable: boolean, readonly usages: readonly string[], readonly algorithm: { readonly name: string, readonly length: number }, readonly exportRejected: string }
    | { readonly kind: 'failed', readonly error: ProbeError & { readonly status?: number, readonly code?: string } }

/** 存储的选项：工厂可以换成没有（unsupported）或取的时候抛出（denied） */
export interface ProbeStoreOptions {
  readonly blockedTimeoutMs?: number
  readonly factory?: 'browser' | 'missing' | 'throws'
}

export interface OutboxProbe {
  readonly names: { readonly database: string, readonly version: number, readonly drafts: string, readonly writers: string }
  /** 这个标签页之后封、开草稿用的密钥：rawHex（32 字节的十六进制）给出时导入它，否则随机生成一把；都不可导出 */
  readonly chooseKey: (version: number, rawHex?: string) => Promise<void>
  /** 换一个新的存储（关掉原来的连接） */
  readonly resetStore: (options?: ProbeStoreOptions) => void
  readonly register: (key: DraftKey, writer: WriterIdentity, options: { readonly now: number, readonly force: boolean }) => Promise<ProbeRegisterOutcome>
  readonly write: (input: ProbeDraftInput, options?: { readonly adoptSeq?: number }) => Promise<Plain<Awaited<ReturnType<DraftStore['writeDraft']>>>>
  /** 开始一次写入、不等它：交回编号，之后经 settled 取结果（两个标签页的竞争） */
  readonly startWrite: (input: ProbeDraftInput) => number
  readonly settled: (operation: number) => Promise<Plain<Awaited<ReturnType<DraftStore['writeDraft']>>>>
  readonly replace: (input: ProbeDraftInput) => Promise<Plain<Awaited<ReturnType<DraftStore['replaceDraft']>>>>
  readonly confirm: (key: DraftKey, writer: WriterIdentity, confirmedSeq: number, rebased?: ProbeDraftInput) => Promise<Plain<Awaited<ReturnType<DraftStore['confirmDraft']>>>>
  readonly read: (key: DraftKey) => Promise<ProbeRead | { readonly kind: 'absent' } | Plain<StoreProblem>>
  readonly list: (userId: string) => Promise<{ readonly kind: 'listed', readonly drafts: readonly ListedDraft[] } | Plain<StoreProblem>>
  readonly remove: (key: DraftKey, expectedSeq?: number) => Promise<Plain<Awaited<ReturnType<DraftStore['removeDraft']>>>>
  readonly removeUser: (userId: string) => Promise<Plain<Awaited<ReturnType<DraftStore['removeUserData']>>>>
  readonly purge: (now: number) => Promise<Plain<Awaited<ReturnType<DraftStore['purgeExpired']>>>>
  readonly close: () => void
  /** 列表的标记（draft-index.ts） */
  readonly draftIds: (userId: string) => Promise<readonly string[]>
  /** 直接看库、改库，扮演别的页面 */
  readonly database: {
    readonly describe: () => Promise<ProbeDatabaseShape | null>
    /** 库里的原样记录（字节写成十六进制）；没有时为 null */
    readonly getRaw: (store: string, key: DraftKey) => Promise<Record<string, unknown> | null>
    /** 绕过存储与 AAD，直接改一条草稿的字段（字段值原样写进去；iv、ciphertext 按十六进制给出） */
    readonly patchDraft: (key: DraftKey, patch: Readonly<Record<string, unknown>>) => Promise<void>
    /** 直接写一条原样的记录（形状不对、更新的格式） */
    readonly putRaw: (store: string, value: Readonly<Record<string, unknown>>) => Promise<void>
    /** 扮演更新的页面：以 version 打开（升级时加一个仓库），等到打开或被挡住；打开了就关掉 */
    readonly upgrade: (version: number, waitMs: number) => Promise<'upgraded' | 'blocked' | ProbeError>
    /** 扮演不理会 versionchange 的旧页面：以 version 打开、一直开着（挡住别人的升级与删库），交回编号 */
    readonly hold: (version: number) => Promise<number>
    readonly release: (held: number) => void
    /** 生产的打开（openOutboxDatabase）以 version 打开：交回结果的种类，打开了就关掉 */
    readonly openWith: (version: number, blockedTimeoutMs: number) => Promise<string>
    /** 删库：等到删掉或被挡住 */
    readonly remove: (waitMs: number) => Promise<'deleted' | 'blocked' | ProbeError>
    /** 库在不在（indexedDB.databases()） */
    readonly exists: () => Promise<boolean>
    /**
     * 开一个两个仓库上的读写事务、用请求循环撑着不让它提交，交回编号：之后建的事务都在它后面、按建的先后排队（确定的交错）。
     * 要库已经存在
     */
    readonly holdTransaction: () => Promise<number>
    /** 放开撑着的事务，等它提交 */
    readonly releaseTransaction: (held: number) => Promise<void>
  }
  /** 本机密钥：探针自己发请求取（会话里的 CSRF 令牌），用生产的 importLocalKey 导入；只交回事实，不交出密钥 */
  readonly localKey: {
    readonly fetch: () => Promise<ProbeLocalKey>
    /** 用最近一次取到的密钥加密（AES-GCM，不带 AAD）：E2E 用服务端给的原始字节独立解开，核对就是那一把 */
    readonly encryptHex: (plainHex: string, ivHex: string) => Promise<string>
  }
  /** 从现在起记下每一次开事务（包住 IDBDatabase.prototype.transaction），核对读写的事务都要求 strict */
  readonly recordTransactions: () => void
  /** 接下来的 count 次开事务都抛出名为 name 的 DOMException（例如连接正在关闭时的 InvalidStateError）：核对存储重开一次再试 */
  readonly failTransactions: (count: number, name: string) => void
  /** 写一份形状不对的草稿（封好之后把 IV 截成 11 字节）：核对存储不写它 */
  readonly writeMalformed: (input: ProbeDraftInput) => Promise<Plain<Awaited<ReturnType<DraftStore['writeDraft']>>>>
  readonly transactions: () => readonly ProbeTransaction[]
  /** 写入管道：进程内与发件箱 Worker 两种宿主跑同一组操作（pipeline-probe.ts） */
  readonly pipeline: ProbePipeline
}

declare global {
  interface Window {
    [OUTBOX_PROBE_NAME]?: OutboxProbe
  }
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
}

function fromHex(text: string): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(text.length / 2)
  for (let index = 0; index < bytes.length; index += 1)
    bytes[index] = Number.parseInt(text.slice(index * 2, index * 2 + 2), 16)
  return bytes
}

function probeError(error: unknown): ProbeError {
  if (typeof error === 'object' && error !== null && 'name' in error && 'message' in error)
    return { name: String(error.name), message: String(error.message) }
  return { name: 'Error', message: String(error) }
}

function plain<T extends { readonly kind: string }>(outcome: T): Plain<T> {
  if (outcome.kind === 'failed' && 'error' in outcome)
    return { kind: 'failed', error: probeError(outcome.error) } as Plain<T>
  return outcome as Plain<T>
}

/** 随机的 base64 文字：几乎压不动，写满的用例按它估算大小。getRandomValues 一次最多 65536 字节，分段取 */
function randomBase64(chars: number): string {
  const bytes = new Uint8Array(Math.ceil(chars * 3 / 4))
  for (let offset = 0; offset < bytes.length; offset += 65_536)
    crypto.getRandomValues(bytes.subarray(offset, offset + 65_536))
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
  return btoa(binary).slice(0, chars)
}

async function request<T>(open: () => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const pending = open()
    pending.onsuccess = () => resolve(pending.result)
    pending.onerror = () => reject(pending.error ?? new Error('请求失败'))
  })
}

/** 请求失败：HTTP 状态与错误码 */
class ProbeHttpError extends Error {
  override readonly name = 'ProbeHttpError'
  readonly status: number
  readonly code: string | undefined

  constructor(status: number, code: string | undefined) {
    super(`HTTP ${status}${code === undefined ? '' : ` ${code}`}`)
    this.status = status
    this.code = code
  }
}

async function jsonOf(response: Response): Promise<unknown> {
  return response.json().catch(() => undefined) as Promise<unknown>
}

/** 错误响应里的错误码（{ error: { code } }） */
function errorCodeOf(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null || !('error' in body))
    return undefined
  const error: unknown = body.error
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string' ? error.code : undefined
}

/** 会话里的 CSRF 令牌（GET /api/auth/session）：取不到时抛出 */
async function sessionCsrfToken(): Promise<string> {
  const session = await fetch('/api/auth/session', { credentials: 'same-origin', headers: { accept: 'application/json' } })
  const body = await jsonOf(session)
  if (!session.ok)
    throw new ProbeHttpError(session.status, errorCodeOf(body))
  if (typeof body !== 'object' || body === null || !('csrfToken' in body) || typeof body.csrfToken !== 'string')
    throw new TypeError('GET /api/auth/session 的响应里没有 csrfToken')
  return body.csrfToken
}

/**
 * 取本机密钥的请求（与请求层发出的相同：同源、带 CSRF 令牌、不带请求体）。令牌取一次之后留着（像请求层一样只在内存里）：
 * 登录之后失效时，这个请求本身就被服务端拒绝（401），而不是在取令牌时就失败
 */
async function requestLocalKey(csrfToken: string): Promise<{ readonly version: number, readonly key: string }> {
  const response = await fetch('/api/local-key', { method: 'POST', credentials: 'same-origin', headers: { 'accept': 'application/json', 'x-csrf-token': csrfToken } })
  const body = await jsonOf(response)
  if (!response.ok)
    throw new ProbeHttpError(response.status, errorCodeOf(body))
  if (typeof body !== 'object' || body === null || !('version' in body) || !('key' in body) || typeof body.version !== 'number' || typeof body.key !== 'string')
    throw new TypeError('POST /api/local-key 的响应不是 { version, key }')
  return { version: body.version, key: body.key }
}

/** 不带版本打开（不建库：库不存在时中止升级） */
async function openExisting(): Promise<IDBDatabase | null> {
  return new Promise((resolve, reject) => {
    const pending = indexedDB.open(OUTBOX_DATABASE_NAME)
    pending.onupgradeneeded = () => pending.transaction?.abort()
    pending.onsuccess = () => resolve(pending.result)
    pending.onerror = () => {
      if (pending.error?.name === 'AbortError')
        resolve(null)
      else
        reject(pending.error ?? new Error('打不开'))
    }
  })
}

async function withExisting<T>(action: (db: IDBDatabase) => Promise<T>): Promise<T> {
  const db = await openExisting()
  if (db === null)
    throw new Error('库不存在')
  try {
    return await action(db)
  }
  finally {
    db.close()
  }
}

/** 原样的记录里的字节写成十六进制，别的照抄 */
function rawOf(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null)
    return null
  return Object.fromEntries(Object.entries(value).map(([field, item]) => [field, ArrayBuffer.isView(item) ? { hex: hex(new Uint8Array(item.buffer, item.byteOffset, item.byteLength)) } : item]))
}

export function installOutboxProbe(target: Window): OutboxProbe {
  let key: LocalKeyHandle | undefined
  let store: DraftStore = createDraftStore({ blockedTimeoutMs: 1000 })
  const operations = new Map<number, Promise<Plain<Awaited<ReturnType<DraftStore['writeDraft']>>>>>()
  const held = new Map<number, IDBDatabase>()
  const heldTransactions = new Map<number, { readonly release: () => void, readonly done: Promise<void>, readonly db: IDBDatabase }>()
  let fetchedKey: LocalKeyHandle | undefined
  let csrfToken: string | undefined
  let recording = false
  const recorded: ProbeTransaction[] = []
  /** 接下来几次开事务要抛出的错误名 */
  const failures: string[] = []
  let wrapped = false

  /** 包住 IDBDatabase.prototype.transaction（只包一次）：记下每一次开事务、按要求抛出 */
  function wrapTransactions(): void {
    if (wrapped)
      return
    wrapped = true
    const original: unknown = Reflect.get(IDBDatabase.prototype, 'transaction')
    if (typeof original !== 'function')
      throw new TypeError('IDBDatabase.prototype.transaction 不是函数')
    Object.defineProperty(IDBDatabase.prototype, 'transaction', {
      configurable: true,
      writable: true,
      value: function transaction(this: IDBDatabase, stores: string | string[], mode?: IDBTransactionMode, options?: IDBTransactionOptions): IDBTransaction {
        const failure = failures.shift()
        if (failure !== undefined)
          throw new DOMException(`探针：开事务时抛出 ${failure}`, failure)
        if (recording)
          recorded.push({ stores: typeof stores === 'string' ? [stores] : [...stores], mode: mode ?? 'readonly', durability: options?.durability })
        return Reflect.apply(original, this, [stores, mode, options]) as IDBTransaction
      },
    })
  }
  let nextId = 1

  function currentKey(): LocalKeyHandle {
    if (key === undefined)
      throw new Error('探针还没有密钥：先 chooseKey')
    return key
  }

  async function seal(input: ProbeDraftInput) {
    const content = typeof input.content === 'string' ? input.content : randomBase64(input.content.randomBase64Chars)
    const bytes = new TextEncoder().encode(content)
    return sealDraft(currentKey(), { ...input.meta, rawBytes: bytes.byteLength }, await gzipBytes(bytes))
  }

  async function opened(read: ReadDraft): Promise<ProbeRead> {
    if (read.kind !== 'draft')
      return read
    const { iv, ciphertext, ...meta } = read.draft
    let result: ProbeOpened = { kind: 'no-key' }
    if (key !== undefined) {
      const unsealed = await openDraft(key, read.draft)
      result = unsealed.kind === 'opened' ? { kind: 'opened', content: new TextDecoder().decode(await gunzipBytes(unsealed.gzip)) } : unsealed
    }
    return { kind: 'draft', meta, ivHex: hex(iv), ciphertextBytes: ciphertext.byteLength, opened: result }
  }

  function factoryOf(choice: ProbeStoreOptions['factory']): () => IDBFactory | undefined {
    switch (choice) {
      case 'missing':
        return () => undefined
      case 'throws':
        return () => {
          throw new DOMException('探针：取 IndexedDB 时被拒绝', 'SecurityError')
        }
      case 'browser':
      case undefined:
        return browserIndexedDb
    }
  }

  const probe: OutboxProbe = {
    names: { database: OUTBOX_DATABASE_NAME, version: OUTBOX_DATABASE_VERSION, drafts: DRAFTS_STORE, writers: WRITERS_STORE },
    chooseKey: async (version, rawHex) => {
      const raw = rawHex === undefined ? crypto.getRandomValues(new Uint8Array(32)) : fromHex(rawHex)
      key = { version, key: await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']) }
      raw.fill(0)
    },
    resetStore: (options = {}) => {
      store.close()
      store = createDraftStore({ blockedTimeoutMs: options.blockedTimeoutMs ?? 1000, factory: factoryOf(options.factory) })
    },
    register: async (draftKey, writer, options) => {
      const outcome = await store.registerWriter(draftKey, writer, options)
      if (outcome.kind !== 'registered')
        return plain(outcome)
      return { kind: 'registered', lastDraftSeq: outcome.lastDraftSeq, existing: outcome.existing === undefined ? undefined : await opened(outcome.existing) }
    },
    write: async (input, options) => plain(await store.writeDraft(await seal(input), options)),
    writeMalformed: async (input) => {
      const draft = await seal(input)
      return plain(await store.writeDraft({ ...draft, iv: draft.iv.slice(0, 11) }))
    },
    startWrite: (input) => {
      const id = nextId++
      operations.set(id, seal(input).then(async draft => plain(await store.writeDraft(draft))))
      return id
    },
    settled: async (operation) => {
      const pending = operations.get(operation)
      if (pending === undefined)
        throw new Error(`没有编号为 ${operation} 的写入`)
      operations.delete(operation)
      return pending
    },
    replace: async input => plain(await store.replaceDraft(await seal(input))),
    confirm: async (draftKey, writer, confirmedSeq, rebased) => plain(await store.confirmDraft(draftKey, writer, confirmedSeq, rebased === undefined ? undefined : await seal(rebased))),
    read: async (draftKey) => {
      const outcome = await store.readDraft(draftKey)
      switch (outcome.kind) {
        case 'draft':
        case 'newer-format':
        case 'malformed':
          return opened(outcome)
        case 'absent':
        case 'quota':
        case 'unavailable':
        case 'failed':
          return plain(outcome)
      }
    },
    list: async userId => plain(await store.listDrafts(userId)),
    remove: async (draftKey, expectedSeq) => plain(await store.removeDraft(draftKey, expectedSeq)),
    removeUser: async userId => plain(await store.removeUserData(userId)),
    purge: async now => plain(await store.purgeExpired(now)),
    close: () => store.close(),
    draftIds: async userId => [...await draftDocumentIds(userId)].sort(),
    database: {
      describe: async () => {
        const db = await openExisting()
        if (db === null)
          return null
        try {
          const names = Array.from(db.objectStoreNames)
          if (names.length === 0)
            return { version: db.version, stores: [] }
          const tx = db.transaction(names, 'readonly')
          const stores = names.map((name) => {
            const objectStore = tx.objectStore(name)
            const keyPath = objectStore.keyPath
            return { name, keyPath: Array.isArray(keyPath) ? [...keyPath] : keyPath, indexes: Array.from(objectStore.indexNames) }
          })
          return { version: db.version, stores }
        }
        finally {
          db.close()
        }
      },
      getRaw: async (store, draftKey) => withExisting(async (db) => {
        const value: unknown = await request(() => db.transaction(store, 'readonly').objectStore(store).get([draftKey.userId, draftKey.documentId]))
        return rawOf(value)
      }),
      patchDraft: async (draftKey, patch) => withExisting(async (db) => {
        const value: unknown = await request(() => db.transaction(DRAFTS_STORE, 'readonly').objectStore(DRAFTS_STORE).get([draftKey.userId, draftKey.documentId]))
        if (typeof value !== 'object' || value === null)
          throw new Error('没有这一条草稿')
        const changes = Object.fromEntries(Object.entries(patch).map(([field, item]) => [field, (field === 'iv' || field === 'ciphertext') && typeof item === 'string' ? fromHex(item) : item]))
        await request(() => db.transaction(DRAFTS_STORE, 'readwrite').objectStore(DRAFTS_STORE).put({ ...value, ...changes }))
      }),
      putRaw: async (store, value) => withExisting(async (db) => {
        await request(() => db.transaction(store, 'readwrite').objectStore(store).put(value))
      }),
      upgrade: async (version, waitMs) => new Promise((resolve) => {
        const pending = indexedDB.open(OUTBOX_DATABASE_NAME, version)
        let timer: ReturnType<typeof setTimeout> | undefined
        pending.onupgradeneeded = () => {
          const db = pending.result
          if (!db.objectStoreNames.contains(`future-v${version}`))
            db.createObjectStore(`future-v${version}`)
        }
        pending.onblocked = () => {
          timer ??= setTimeout(resolve, waitMs, 'blocked')
        }
        pending.onsuccess = () => {
          clearTimeout(timer)
          pending.result.close()
          resolve('upgraded')
        }
        pending.onerror = () => {
          clearTimeout(timer)
          resolve(probeError(pending.error))
        }
      }),
      hold: async version => new Promise((resolve, reject) => {
        const pending = indexedDB.open(OUTBOX_DATABASE_NAME, version)
        pending.onupgradeneeded = () => {
          for (const name of [DRAFTS_STORE, WRITERS_STORE]) {
            if (!pending.result.objectStoreNames.contains(name))
              pending.result.createObjectStore(name, { keyPath: [...OUTBOX_KEY_PATH] })
          }
        }
        pending.onsuccess = () => {
          // 不理会 versionchange：一直开着，挡住别人的升级与删库
          const id = nextId++
          held.set(id, pending.result)
          resolve(id)
        }
        pending.onerror = () => reject(pending.error ?? new Error('打不开'))
      }),
      release: (id) => {
        held.get(id)?.close()
        held.delete(id)
      },
      openWith: async (version, blockedTimeoutMs) => {
        const result = await openOutboxDatabase({ factory: browserIndexedDb, blockedTimeoutMs, version })
        if (result.kind === 'connected') {
          result.close()
          return 'connected'
        }
        return result.reason
      },
      remove: async waitMs => new Promise((resolve) => {
        const pending = indexedDB.deleteDatabase(OUTBOX_DATABASE_NAME)
        let timer: ReturnType<typeof setTimeout> | undefined
        pending.onblocked = () => {
          timer ??= setTimeout(resolve, waitMs, 'blocked')
        }
        pending.onsuccess = () => {
          clearTimeout(timer)
          resolve('deleted')
        }
        pending.onerror = () => {
          clearTimeout(timer)
          resolve(probeError(pending.error))
        }
      }),
      exists: async () => (await indexedDB.databases()).some(database => database.name === OUTBOX_DATABASE_NAME),
      holdTransaction: async () => {
        const db = await openExisting()
        if (db === null)
          throw new Error('库不存在：先用存储建出它')
        const tx = db.transaction([DRAFTS_STORE, WRITERS_STORE], 'readwrite')
        let released = false
        const spin = (): void => {
          if (!released)
            tx.objectStore(DRAFTS_STORE).count().onsuccess = spin
        }
        spin()
        const done = new Promise<void>((resolve) => {
          tx.oncomplete = () => resolve()
          tx.onabort = () => resolve()
        })
        const id = nextId++
        heldTransactions.set(id, { release: () => {
          released = true
        }, done, db })
        return id
      },
      releaseTransaction: async (id) => {
        const holding = heldTransactions.get(id)
        if (holding === undefined)
          throw new Error(`没有编号为 ${id} 的事务`)
        heldTransactions.delete(id)
        holding.release()
        await holding.done
        holding.db.close()
      },
    },
    localKey: {
      fetch: async () => {
        try {
          csrfToken ??= await sessionCsrfToken()
          const handle = await importLocalKey(await requestLocalKey(csrfToken))
          fetchedKey = handle
          const exportRejected = await crypto.subtle.exportKey('raw', handle.key).then(() => 'none', (error: unknown) => probeError(error).name)
          const algorithm = handle.key.algorithm as AesKeyAlgorithm
          return { kind: 'fetched', version: handle.version, extractable: handle.key.extractable, usages: [...handle.key.usages].sort(), algorithm: { name: algorithm.name, length: algorithm.length }, exportRejected }
        }
        catch (error) {
          const details = error as { readonly status?: unknown, readonly code?: unknown }
          return { kind: 'failed', error: { ...probeError(error), ...(typeof details.status === 'number' ? { status: details.status } : {}), ...(typeof details.code === 'string' ? { code: details.code } : {}) } }
        }
      },
      encryptHex: async (plainHex, ivHex) => {
        if (fetchedKey === undefined)
          throw new Error('还没有取到本机密钥')
        return hex(new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: fromHex(ivHex) }, fetchedKey.key, fromHex(plainHex))))
      },
    },
    recordTransactions: () => {
      wrapTransactions()
      recording = true
    },
    failTransactions: (count, name) => {
      wrapTransactions()
      for (let index = 0; index < count; index += 1)
        failures.push(name)
    },
    transactions: () => [...recorded],
    pipeline: createPipelineProbe({ key: () => key, store: () => store }),
  }
  target[OUTBOX_PROBE_NAME] = probe
  return probe
}

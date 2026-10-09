// 真实浏览器的前置复核（M4-P1 S1，设计 §3.6）的探针 Worker：只用浏览器的接口（IndexedDB、CompressionStream、crypto.subtle、Web Locks），
// 不依赖发件箱的生产代码。页面经 ./storage-probe-client.ts 一问一答（消息见 ./storage-probe-protocol.ts）：
// - hello：握手；keepAlive 时开一个 100 ms 的空定时器（DEF-011 的对照：M0 在 Playwright 的 WebKit 上，Worker 空闲约 1 秒之后第一次异步操作
//   偶尔多出约 1 秒，开着空定时器之后 40 次没再出现，原因没查到）；
// - pipeline：照 M0 的写入管道依次做 SHA-256 → gzip → AES-GCM（Worker 自己的密钥）→ IndexedDB 写入，各段计时（第 9 项；第 10 项的 Worker 放置）；
// - crypto：收下页面经 postMessage 交来的不可导出的 CryptoKey（结构化克隆），解开页面封的一份、AAD 改一个字段之后解不开、自己封一份交回，
//   另核对 Worker 里的 CompressionStream 与 SHA-256（第 7 项）；crypto-raw 是交不过去时的退路（原始字节转移过来、Worker 里导入、随即清零）；
// - idb-read-write、idb-upgrade：Worker 里打开页面建的库读写、以更高的版本打开（页面一侧收到 versionchange，第 6 项）；
// - lock-if-available、lock-steal：Web Locks（第 8 项；Worker 被终止时它拿着的锁随之释放，页面一侧核对）。
// 出错时回应 ok 为假与错误的名字、说明，不挂住页面（页面另有时限）
import type { CryptoOutcome, PipelineTimes, ProbeCalls, ProbeCallType, ProbeReply, ProbeRequest, SealedProbe, WorkerDatabaseOutcome, WorkerUpgradeOutcome } from './storage-probe-protocol.ts'
import { errorName, gunzipBytes, gzipBytes, openDatabase, randomBytes, requestResult, sha256Hex, transactionDone, wallNow } from './probe-bytes.ts'
import { isProbeRequest } from './storage-probe-protocol.ts'

/** Worker 的全局（页面的类型库里没有 WorkerGlobalScope：只写用到的） */
const scope = globalThis as unknown as {
  addEventListener: (type: 'message', listener: (event: MessageEvent<unknown>) => void) => void
  postMessage: (message: unknown, transfer?: Transferable[]) => void
}

/** 空定时器的间隔（DEF-011，M0 的做法） */
const KEEP_ALIVE_MS = 100

/** pipeline 写进哪个对象仓库（Worker 自己的库，hello 时建） */
const PIPELINE_STORE = 'drafts'

let keepAlive: ReturnType<typeof setInterval> | undefined
let pipelineDatabase: IDBDatabase | undefined
let pipelineKey: CryptoKey | undefined

const encoder = new TextEncoder()

async function hello(input: ProbeCalls['hello']['input']): Promise<ProbeCalls['hello']['output']> {
  if (input.keepAlive && keepAlive === undefined)
    keepAlive = setInterval(() => {}, KEEP_ALIVE_MS)
  pipelineKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
  pipelineDatabase = await openDatabase(input.database, 1, (database) => {
    database.createObjectStore(PIPELINE_STORE)
  })
  return {
    at: wallNow(),
    indexedDB: typeof indexedDB !== 'undefined',
    subtle: typeof crypto.subtle !== 'undefined',
    compression: typeof CompressionStream === 'function',
    locks: 'locks' in navigator,
  }
}

/** 写入管道（M0 的顺序）：各段计时；store 为 none 时不写 */
async function pipeline(input: ProbeCalls['pipeline']['input'], receivedAt: number): Promise<PipelineTimes> {
  const key = pipelineKey
  const database = pipelineDatabase
  if (key === undefined || database === undefined)
    throw new Error('还没有握手（hello）')
  const start = performance.now()
  await crypto.subtle.digest('SHA-256', input.bytes)
  const digested = performance.now()
  const gzip = await gzipBytes(input.bytes)
  const compressed = performance.now()
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode('probe') }, key, gzip))
  const encrypted = performance.now()
  let durability: string | null = null
  if (input.store !== 'none') {
    const transaction = database.transaction(PIPELINE_STORE, 'readwrite', { durability: input.store })
    durability = durabilityOf(transaction)
    transaction.objectStore(PIPELINE_STORE).put({ iv, ciphertext }, 'draft')
    await transactionDone(transaction)
  }
  const stored = performance.now()
  return {
    receivedAt,
    digestMs: digested - start,
    gzipMs: compressed - digested,
    encryptMs: encrypted - compressed,
    putMs: stored - encrypted,
    workerMs: wallNow() - receivedAt,
    doneAt: wallNow(),
    gzipBytes: gzip.length,
    durability,
  }
}

/** 事务的 durability 属性（规范里有；不支持的浏览器没有这个属性：null） */
function durabilityOf(transaction: IDBTransaction): string | null {
  const value: unknown = Reflect.get(transaction, 'durability')
  return typeof value === 'string' ? value : null
}

async function open(key: CryptoKey, sealed: SealedProbe, aad: string): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: sealed.iv, additionalData: encoder.encode(aad) }, key, sealed.ciphertext))
}

/** 第 7 项：收到的密钥能不能用、AAD 改一个字段之后解不开、Worker 里封一份交回；Worker 里的 gzip 与 SHA-256 */
async function checkCrypto(input: ProbeCalls['crypto']['input']): Promise<CryptoOutcome> {
  const { key, sealed } = input
  const opened = await open(key, sealed, sealed.aad)
  const openedPageSeal = await sha256Hex(opened) === sealed.digest
  let tamperedAad = '解开了'
  try {
    await open(key, sealed, input.tamperedAad)
  }
  catch (error) {
    tamperedAad = errorName(error)
  }
  const plain = randomBytes(4096)
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(sealed.aad) }, key, plain))
  const text = encoder.encode('Worker 里的 CompressionStream：'.repeat(200))
  const gzipRoundTrip = await sha256Hex(await gunzipBytes(await gzipBytes(text))) === await sha256Hex(text)
  const digestKnownAnswer = await sha256Hex(encoder.encode('abc')) === 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
  const algorithm = key.algorithm as { readonly name?: unknown, readonly length?: unknown }
  return {
    keyType: key.type,
    extractable: key.extractable,
    algorithm: `${String(algorithm.name)}-${String(algorithm.length)}`,
    usages: [...key.usages].sort().join(','),
    openedPageSeal,
    tamperedAad,
    workerSeal: { iv, ciphertext, aad: sealed.aad, digest: await sha256Hex(plain) },
    gzipRoundTrip,
    digestKnownAnswer,
  }
}

/** 第 7 项的退路：原始字节在 Worker 里导入成不可导出的密钥，导入之后立即清零，再做同样的核对 */
async function checkRawImport(input: ProbeCalls['crypto-raw']['input']): Promise<ProbeCalls['crypto-raw']['output']> {
  let key: CryptoKey
  try {
    key = await crypto.subtle.importKey('raw', input.raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
  }
  finally {
    input.raw.fill(0)
  }
  const outcome = await checkCrypto({ key, sealed: input.sealed, tamperedAad: input.tamperedAad })
  return { ...outcome, zeroed: input.raw.every(byte => byte === 0) }
}

/** 第 6 项：Worker 里打开页面建的库（不带版本，打开现有的），读页面写的一条、写一条给页面读 */
async function readWrite(input: ProbeCalls['idb-read-write']['input']): Promise<WorkerDatabaseOutcome> {
  const database = await openDatabase(input.database, undefined)
  try {
    const reading = database.transaction(input.store, 'readonly')
    const record = await requestResult(reading.objectStore(input.store).get([...input.key])) as { readonly bytes?: unknown } | undefined
    await transactionDone(reading)
    const bytes = record?.bytes
    const readDigest = bytes instanceof Uint8Array ? await sha256Hex(new Uint8Array(bytes)) : null
    const wrote = randomBytes(input.bytes)
    const writing = database.transaction(input.store, 'readwrite', { durability: 'strict' })
    writing.objectStore(input.store).put({ userId: input.wroteKey[0], documentId: input.wroteKey[1], bytes: wrote })
    await transactionDone(writing)
    return { version: database.version, stores: [...database.objectStoreNames].sort().join(','), readDigest, wroteDigest: await sha256Hex(wrote) }
  }
  finally {
    database.close()
  }
}

/** 第 6 项：以更高的版本打开页面开着的库、加一个对象仓库；页面关掉它的连接之后升级才继续 */
async function upgrade(input: ProbeCalls['idb-upgrade']['input']): Promise<WorkerUpgradeOutcome> {
  const start = performance.now()
  let blocked = false
  const database = await openDatabase(input.database, input.version, (opened) => {
    opened.createObjectStore(input.store)
  }, () => {
    blocked = true
  })
  const version = database.version
  database.close()
  return { version, blocked, ms: performance.now() - start }
}

/** 第 8 项：ifAvailable 申请（拿不到时回调收到 null） */
async function lockIfAvailable(input: ProbeCalls['lock-if-available']['input']): Promise<ProbeCalls['lock-if-available']['output']> {
  return navigator.locks.request(input.name, { ifAvailable: true }, async lock => ({ granted: lock !== null }))
}

/** 第 8 项：steal 抢过来、一直拿着（Worker 被终止时释放）：抢到的那一刻交回 */
async function lockSteal(input: ProbeCalls['lock-steal']['input']): Promise<ProbeCalls['lock-steal']['output']> {
  return new Promise((resolve, reject) => {
    navigator.locks.request(input.name, { steal: true }, async (lock) => {
      resolve({ granted: lock !== null })
      // 一直拿着：页面终止这个 Worker 之后锁随之释放
      return new Promise<void>(() => {})
    }).catch(reject)
  })
}

function close(): ProbeCalls['close']['output'] {
  pipelineDatabase?.close()
  pipelineDatabase = undefined
  if (keepAlive !== undefined)
    clearInterval(keepAlive)
  keepAlive = undefined
  return { closed: true }
}

async function handle(request: ProbeRequest, receivedAt: number): Promise<{ readonly output: unknown, readonly transfer: Transferable[] }> {
  const type: ProbeCallType = request.type
  switch (type) {
    case 'hello':
      return { output: await hello(request.input as ProbeCalls['hello']['input']), transfer: [] }
    case 'pipeline':
      return { output: await pipeline(request.input as ProbeCalls['pipeline']['input'], receivedAt), transfer: [] }
    case 'crypto': {
      const outcome = await checkCrypto(request.input as ProbeCalls['crypto']['input'])
      return { output: outcome, transfer: [outcome.workerSeal.ciphertext.buffer] }
    }
    case 'crypto-raw': {
      const outcome = await checkRawImport(request.input as ProbeCalls['crypto-raw']['input'])
      return { output: outcome, transfer: [outcome.workerSeal.ciphertext.buffer] }
    }
    case 'idb-read-write':
      return { output: await readWrite(request.input as ProbeCalls['idb-read-write']['input']), transfer: [] }
    case 'idb-upgrade':
      return { output: await upgrade(request.input as ProbeCalls['idb-upgrade']['input']), transfer: [] }
    case 'lock-if-available':
      return { output: await lockIfAvailable(request.input as ProbeCalls['lock-if-available']['input']), transfer: [] }
    case 'lock-steal':
      return { output: await lockSteal(request.input as ProbeCalls['lock-steal']['input']), transfer: [] }
    case 'close':
      return { output: close(), transfer: [] }
  }
}

scope.addEventListener('message', (event) => {
  const receivedAt = wallNow()
  const request = event.data
  if (!isProbeRequest(request))
    return
  handle(request, receivedAt).then(
    ({ output, transfer }) => scope.postMessage({ id: request.id, ok: true, output } satisfies ProbeReply, transfer),
    (error: unknown) => scope.postMessage({ id: request.id, ok: false, error: { name: errorName(error), message: error instanceof Error ? error.message : String(error) } } satisfies ProbeReply),
  )
})

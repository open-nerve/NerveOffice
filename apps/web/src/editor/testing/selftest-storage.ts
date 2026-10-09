// 真实浏览器的前置复核（M4-P1 设计 §3.6，S1 第一轮）里存储的几项：不依赖发件箱的生产代码，只用浏览器的接口与探针 Worker
// （./storage-probe-worker.ts）。页面只核对"跑完、数据齐"（每一项做完、事实记下）；是否符合预期由驱动脚本一侧的纯函数判定
// （tests/e2e/support/probe-verdicts.ts）。事实的键写成"项.名"，与判定一一对应：
// - storage（阅读）：
//   · 第 1 项持久保存：persisted → persist（新的源、没有用户激活）→ persisted；
//   · 第 2 项配额与用量：写 5 MiB 之前与之后的 estimate()；
//   · 第 6 项 IndexedDB 的基本行为：两个对象仓库（键都是 [userId, documentId]，与发件箱相同）、5 MiB 的字节写进去读回来摘要一致、升级（只做加法）
//     之后数据还在、Worker 里打开同一个库读写、Worker 以更高的版本打开时页面收到 versionchange、indexedDB.databases() 列出它、删掉之后不再列出；
//   · 第 5 项回滚（Safari 上写满的有界替代）：两个仓库的事务 put 之后 abort、put 之后违反约束——已有的记录逐字节不变、新的不在；
//   · 第 3 项 durability：事务的 durability 属性（请求 strict 时是不是 strict）；default 与 strict 交替各写 N 次约 1.3 MiB，各自的提交耗时；
//   · 第 8 项 Web Locks（页面与 Worker）：页面拿着时 Worker 以 ifAvailable 申请得到 null、query 看得到、Worker steal 之后页面的申请以 AbortError 结束、
//     终止 Worker 之后锁被释放；
// - key-transfer（阅读，第 7 项）：不可导出的 CryptoKey 经 postMessage 交给 Worker，Worker 里 AES-GCM 带 AAD 解开页面封的一份、AAD 改一个字段之后解不开、
//   自己封一份交回页面解开，Worker 里的 CompressionStream 与 SHA-256；先试退路（原始字节转移给 Worker、在 Worker 里导入、随即清零），再试交 CryptoKey——
//   WebKit 序列化 CryptoKey 可能要用钥匙串里的主密钥：失败（DataCloneError）、超时（可能停在钥匙串的提示上）都如实记下，不去点掉系统的提示；
// - storage-quota（阅读，第 4 项）：写满——一条一条地加 1 MiB 的记录到失败（最多写 QUOTA_PROBE_MAX_BYTES：配额被覆盖成 8–16 MiB 时，Playwright 的
//   Chromium 系经 CDP，在这之前写满；没被覆盖时写到上限就停，记作没写满），失败的那一条不在；再拿更大的一份覆盖已有的那一条，失败之后原记录逐字节不变、
//   能解开。页面看不出配额有没有被覆盖（estimate() 照旧报真实的配额），所以靠上限保证有界。
// 每个场景用自己的库（随机的名字），收尾时删掉；Worker 自己的库同样删掉
import type { SelftestFact } from './selftest-report.ts'
import type { Session } from './selftest-session.ts'
import { deleteDatabase, errorName, gzipBytes, openDatabase, probeDatabaseName, randomBytes, requestResult, sha256Hex, sleep, tenth, transactionDone } from './probe-bytes.ts'
import { tableJsonBytes } from './probe-measure.ts'
import { QUOTA_PROBE_MAX_BYTES } from './selftest-report.ts'
import { check, fail } from './selftest-session.ts'
import { ProbeWorkerError, startProbeWorker } from './storage-probe-client.ts'

/** 两个对象仓库，键路径与发件箱相同（P1 设计 §3.3） */
const DRAFTS = 'drafts'
const WRITERS = 'writers'
const KEY_PATH = ['userId', 'documentId']

/** 第 6 项的大记录：5 MiB 的随机字节（像密文，浏览器存的时候压不小） */
const LARGE_RECORD_BYTES = 5 * 1024 * 1024

/** 第 3 项的一次写入：约 1.3 MiB（约 5 MiB 的快照 gzip 之后的大小） */
const DURABILITY_RECORD_BYTES = Math.round(1.3 * 1024 * 1024)

/** 第 3 项每种写几次（设计 §3.6：各 10 次）；地址不带 runs 时（Playwright 的校准）各 2 次 */
function durabilityWrites(runs: number | undefined): number {
  return runs === undefined ? 2 : Math.max(2, Math.min(runs, 10))
}

/** 存储里的大项，各自一个时限：5 MiB 的写读、二十次写入在 CI 的慢机器上也要留余量 */
const STORAGE_CHECK_TIMEOUT_MS = 90_000

/** 交 CryptoKey 最多等多久（停在钥匙串的提示上时记为超时） */
const KEY_TRANSFER_TIMEOUT_MS = 20_000

/** 锁在 Worker 被终止之后多久之内应当释放 */
const LOCK_RELEASE_TIMEOUT_MS = 5_000

interface DraftRow {
  readonly userId: string
  readonly documentId: string
  readonly bytes: Uint8Array<ArrayBuffer>
}

function draftOf(documentId: string, bytes: Uint8Array<ArrayBuffer>): DraftRow {
  return { userId: 'probe-user', documentId, bytes }
}

function keyOf(documentId: string): string[] {
  return ['probe-user', documentId]
}

/** 读一条草稿的字节的 SHA-256；没有这一条时 null */
async function storedDigest(database: IDBDatabase, documentId: string): Promise<string | null> {
  const transaction = database.transaction(DRAFTS, 'readonly')
  const row = await requestResult(transaction.objectStore(DRAFTS).get(keyOf(documentId))) as DraftRow | undefined
  await transactionDone(transaction)
  return row === undefined ? null : sha256Hex(new Uint8Array(row.bytes))
}

async function storedWriterEpoch(database: IDBDatabase): Promise<number | null> {
  const transaction = database.transaction(WRITERS, 'readonly')
  const row = await requestResult(transaction.objectStore(WRITERS).get(keyOf('rollback'))) as { readonly writeEpoch?: unknown } | undefined
  await transactionDone(transaction)
  return typeof row?.writeEpoch === 'number' ? row.writeEpoch : null
}

/** 一个事务里写几条（strict），等它提交 */
async function put(database: IDBDatabase, rows: readonly { readonly store: string, readonly value: object }[]): Promise<void> {
  const stores = [...new Set(rows.map(row => row.store))]
  const transaction = database.transaction(stores, 'readwrite', { durability: 'strict' })
  for (const row of rows)
    transaction.objectStore(row.store).put(row.value)
  await transactionDone(transaction)
}

/** 事务的 durability 属性（规范里有；不支持的浏览器忽略字典里不认识的成员，属性不存在：null） */
function durabilityOf(transaction: IDBTransaction): string | null {
  const value: unknown = Reflect.get(transaction, 'durability')
  return typeof value === 'string' ? value : null
}

interface Estimate {
  readonly quota: number | null
  readonly usage: number | null
  /** Chromium 系另给的按类别的用量（usageDetails.indexedDB），别的浏览器没有：null */
  readonly indexedDB: number | null
}

async function estimate(): Promise<Estimate> {
  const result = await navigator.storage.estimate()
  const details: unknown = Reflect.get(result, 'usageDetails')
  const indexedDB: unknown = typeof details === 'object' && details !== null ? Reflect.get(details, 'indexedDB') : undefined
  return { quota: result.quota ?? null, usage: result.usage ?? null, indexedDB: typeof indexedDB === 'number' ? indexedDB : null }
}

function recordEstimate(facts: Record<string, SelftestFact>, suffix: 'before' | 'after', value: Estimate): string {
  facts[`estimate.quota-${suffix}`] = value.quota
  facts[`estimate.usage-${suffix}`] = value.usage
  facts[`estimate.idb-${suffix}`] = value.indexedDB
  return `配额 ${value.quota ?? '—'}、用量 ${value.usage ?? '—'}${value.indexedDB === null ? '' : `（IndexedDB ${value.indexedDB}）`} 字节`
}

/** indexedDB.databases() 里有没有这个库（不支持时 unsupported） */
async function listed(name: string): Promise<'listed' | 'absent' | 'unsupported'> {
  if (typeof indexedDB.databases !== 'function')
    return 'unsupported'
  return (await indexedDB.databases()).some(info => info.name === name) ? 'listed' : 'absent'
}

// ---- storage ----

async function storageScenario(session: Session): Promise<void> {
  const facts = session.facts
  const name = probeDatabaseName('storage')
  let database: IDBDatabase | undefined
  const closeDatabase = (): void => {
    database?.close()
    database = undefined
  }
  try {
    await check(session, 'storage.persist', async () => {
      const storage = navigator.storage as StorageManager | undefined
      facts['persist.supported'] = typeof storage?.persist === 'function' && typeof storage.persisted === 'function'
      if (storage === undefined || facts['persist.supported'] !== true)
        return '没有 navigator.storage.persist 与 persisted'
      const before = await storage.persisted()
      let result: boolean | string
      try {
        result = await storage.persist()
      }
      catch (error) {
        result = errorName(error)
      }
      const after = await storage.persisted()
      facts['persist.before'] = before
      facts['persist.result'] = result
      facts['persist.after'] = after
      return `persisted ${String(before)} → persist() ${String(result)} → persisted ${String(after)}（新的源，没有用户激活）`
    })

    await check(session, 'storage.estimate-before', async () => {
      facts['estimate.supported'] = typeof navigator.storage?.estimate === 'function'
      if (facts['estimate.supported'] !== true)
        return '没有 navigator.storage.estimate'
      return `写之前：${recordEstimate(facts, 'before', await estimate())}`
    })

    await check(session, 'storage.idb-basics', async () => {
      database = await openDatabase(name, 1, (created) => {
        created.createObjectStore(DRAFTS, { keyPath: KEY_PATH })
        created.createObjectStore(WRITERS, { keyPath: KEY_PATH })
      })
      facts['idb.stores'] = [...database.objectStoreNames].sort().join(',')
      const large = randomBytes(LARGE_RECORD_BYTES)
      const digest = await sha256Hex(large)
      const started = performance.now()
      await put(database, [{ store: DRAFTS, value: draftOf('large', large) }, { store: WRITERS, value: { userId: 'probe-user', documentId: 'large', writeEpoch: 1, writerId: 'w1' } }])
      facts['idb.large-write-ms'] = tenth(performance.now() - started)
      facts['idb.large-bytes'] = LARGE_RECORD_BYTES
      facts['idb.large-digest-match'] = await storedDigest(database, 'large') === digest
      // 只做加法的升级：v2 加一个对象仓库，原来的数据还在
      closeDatabase()
      database = await openDatabase(name, 2, (upgraded) => {
        upgraded.createObjectStore('meta')
      })
      facts['idb.upgrade-version'] = database.version
      facts['idb.upgrade-kept'] = await storedDigest(database, 'large') === digest
      return `两个对象仓库（${String(facts['idb.stores'])}）；5 MiB 的字节写进去 ${String(facts['idb.large-write-ms'])} ms、读回来摘要${facts['idb.large-digest-match'] === true ? '一致' : '不一致'}；升级到 v${database.version} 之后数据${facts['idb.upgrade-kept'] === true ? '还在' : '不在了'}`
    }, STORAGE_CHECK_TIMEOUT_MS)

    await check(session, 'storage.estimate-after', async () => {
      if (facts['estimate.supported'] !== true)
        return '没有 navigator.storage.estimate'
      facts['estimate.written'] = LARGE_RECORD_BYTES
      return `写了 ${LARGE_RECORD_BYTES} 字节之后：${recordEstimate(facts, 'after', await estimate())}`
    })

    await check(session, 'storage.idb-worker', async () => {
      const opened = database
      if (opened === undefined)
        fail('前一项没有建好库')
      const digest = await storedDigest(opened, 'large')
      const worker = startProbeWorker()
      try {
        const outcome = await worker.call('idb-read-write', { database: name, store: DRAFTS, key: keyOf('large'), wroteKey: keyOf('from-worker'), bytes: 64 * 1024 }, { timeoutMs: STORAGE_CHECK_TIMEOUT_MS })
        facts['idb.worker-version'] = outcome.version
        facts['idb.worker-read-match'] = outcome.readDigest !== null && outcome.readDigest === digest
        facts['idb.worker-wrote-match'] = await storedDigest(opened, 'from-worker') === outcome.wroteDigest
        return `Worker 里打开同一个库（v${outcome.version}，${outcome.stores}）：读到页面写的 5 MiB${facts['idb.worker-read-match'] === true ? '、摘要一致' : '，摘要不一致'}；Worker 写的一条页面读回来${facts['idb.worker-wrote-match'] === true ? '一致' : '不一致'}`
      }
      finally {
        worker.terminate()
      }
    }, STORAGE_CHECK_TIMEOUT_MS)

    await check(session, 'storage.versionchange', async () => {
      const opened = database
      if (opened === undefined)
        fail('前一项没有建好库')
      let seen = false
      opened.onversionchange = () => {
        seen = true
        opened.close()
        database = undefined
      }
      const worker = startProbeWorker()
      try {
        const outcome = await worker.call('idb-upgrade', { database: name, version: 3, store: 'extra' }, { timeoutMs: STORAGE_CHECK_TIMEOUT_MS })
        facts['idb.versionchange'] = seen
        facts['idb.versionchange-blocked'] = outcome.blocked
        facts['idb.versionchange-version'] = outcome.version
        return `页面开着 v2，Worker 以 v3 打开：页面${seen ? '收到 versionchange、关掉连接' : '没有收到 versionchange'}，Worker 的升级${outcome.blocked ? '先被 blocked、' : ''}在 ${tenth(outcome.ms)} ms 之后做完（v${outcome.version}）`
      }
      finally {
        worker.terminate()
        closeDatabase()
      }
    }, STORAGE_CHECK_TIMEOUT_MS)

    await check(session, 'storage.databases', async () => {
      facts['idb.databases'] = await listed(name)
      return `indexedDB.databases()：${String(facts['idb.databases'])}`
    })

    await check(session, 'storage.rollback', async () => {
      database = await openDatabase(name, undefined)
      const opened = database
      const original = randomBytes(64 * 1024)
      const digest = await sha256Hex(original)
      await put(opened, [{ store: DRAFTS, value: draftOf('rollback', original) }, { store: WRITERS, value: { userId: 'probe-user', documentId: 'rollback', writeEpoch: 1, writerId: 'w1' } }])
      // 1. 两个仓库都写了（请求成功）之后主动 abort
      const aborting = opened.transaction([DRAFTS, WRITERS], 'readwrite', { durability: 'strict' })
      const done = transactionDone(aborting).then(() => '提交了', errorName)
      aborting.objectStore(DRAFTS).put(draftOf('rollback', randomBytes(64 * 1024)))
      aborting.objectStore(DRAFTS).put(draftOf('rollback-new', randomBytes(1024)))
      await requestResult(aborting.objectStore(WRITERS).put({ userId: 'probe-user', documentId: 'rollback', writeEpoch: 2, writerId: 'w2' }))
      aborting.abort()
      facts['rollback.abort-error'] = await done
      facts['rollback.abort-kept'] = await storedDigest(opened, 'rollback') === digest
      facts['rollback.abort-new-absent'] = await storedDigest(opened, 'rollback-new') === null
      facts['rollback.abort-writer-kept'] = await storedWriterEpoch(opened) === 1
      // 2. 写了之后违反约束（add 一个已有的键）：请求出错、事务随之中止
      const violating = opened.transaction([DRAFTS, WRITERS], 'readwrite', { durability: 'strict' })
      const violated = transactionDone(violating).then(() => '提交了', errorName)
      violating.objectStore(DRAFTS).put(draftOf('rollback', randomBytes(64 * 1024)))
      violating.objectStore(WRITERS).put({ userId: 'probe-user', documentId: 'rollback', writeEpoch: 3, writerId: 'w3' })
      violating.objectStore(DRAFTS).put(draftOf('rollback-new', randomBytes(1024)))
      violating.objectStore(DRAFTS).add(draftOf('rollback', randomBytes(16)))
      facts['rollback.constraint-error'] = await violated
      facts['rollback.constraint-kept'] = await storedDigest(opened, 'rollback') === digest
      facts['rollback.constraint-new-absent'] = await storedDigest(opened, 'rollback-new') === null
      facts['rollback.constraint-writer-kept'] = await storedWriterEpoch(opened) === 1
      return `put 之后 abort（${String(facts['rollback.abort-error'])}）：原记录${facts['rollback.abort-kept'] === true ? '不变' : '变了'}、新的${facts['rollback.abort-new-absent'] === true ? '不在' : '在'}、写入者${facts['rollback.abort-writer-kept'] === true ? '不变' : '变了'}；违反约束（${String(facts['rollback.constraint-error'])}）：原记录${facts['rollback.constraint-kept'] === true ? '不变' : '变了'}、新的${facts['rollback.constraint-new-absent'] === true ? '不在' : '在'}、写入者${facts['rollback.constraint-writer-kept'] === true ? '不变' : '变了'}`
    }, STORAGE_CHECK_TIMEOUT_MS)

    await check(session, 'storage.durability', async () => {
      const opened = database
      if (opened === undefined)
        fail('前一项没有打开库')
      facts['durability.supported'] = 'durability' in IDBTransaction.prototype
      facts['durability.bytes'] = DURABILITY_RECORD_BYTES
      const writes = durabilityWrites(session.runs)
      const payloads = [randomBytes(DURABILITY_RECORD_BYTES), randomBytes(DURABILITY_RECORD_BYTES)]
      const samples: Record<'default' | 'strict', Record<string, number>> = { default: {}, strict: {} }
      // 交替写（default、strict、default……），同一个键覆盖（发件箱每份文档一条）
      for (let index = 0; index < writes * 2; index += 1) {
        const mode = index % 2 === 0 ? 'default' : 'strict'
        const started = performance.now()
        const transaction = opened.transaction(DRAFTS, 'readwrite', { durability: mode })
        facts[`durability.${mode}-attribute`] = durabilityOf(transaction)
        transaction.objectStore(DRAFTS).put(draftOf('durability', payloads[index % 2] ?? randomBytes(16)))
        await transactionDone(transaction)
        samples[mode][String(Math.floor(index / 2) + 1)] = tenth(performance.now() - started)
      }
      session.timings.push({ id: 'durability.default', ms: samples.default }, { id: 'durability.strict', ms: samples.strict })
      return `durability ${facts['durability.supported'] === true ? '在' : '不在'} IDBTransaction 上；请求 strict 时属性是 ${String(facts['durability.strict-attribute'])}；${DURABILITY_RECORD_BYTES} 字节交替各写 ${writes} 次：default ${Object.values(samples.default).join('、')} ms，strict ${Object.values(samples.strict).join('、')} ms`
    }, STORAGE_CHECK_TIMEOUT_MS)

    await check(session, 'storage.locks', async () => {
      facts['locks.supported'] = 'locks' in navigator
      if (facts['locks.supported'] !== true)
        return '没有 navigator.locks'
      const lockName = `nerve-probe-lock-${crypto.randomUUID()}`
      let release: () => void = () => {}
      const holding = navigator.locks.request(lockName, async () => new Promise<void>((resolve) => {
        release = resolve
      })).then(() => '放下了', errorName)
      const worker = startProbeWorker()
      try {
        const ifAvailable = await worker.call('lock-if-available', { name: lockName })
        facts['locks.if-available'] = ifAvailable.granted ? 'granted' : 'null'
        facts['locks.query-held'] = (await navigator.locks.query()).held?.filter(lock => lock.name === lockName).length ?? 0
        const stolen = await worker.call('lock-steal', { name: lockName })
        facts['locks.steal-granted'] = stolen.granted
        // 被抢之后页面的申请应当以 AbortError 结束；等不到时记下"还拿着"（不挂在这里：之后要终止 Worker）
        facts['locks.page-request'] = await Promise.race([holding, sleep(LOCK_RELEASE_TIMEOUT_MS).then(() => 'still-held')])
        facts['locks.query-after-steal'] = (await navigator.locks.query()).held?.filter(lock => lock.name === lockName).length ?? 0
      }
      finally {
        worker.terminate()
        release()
      }
      const started = performance.now()
      let reacquired = false
      while (!reacquired && performance.now() - started < LOCK_RELEASE_TIMEOUT_MS) {
        reacquired = await navigator.locks.request(lockName, { ifAvailable: true }, async lock => lock !== null)
        if (!reacquired)
          await sleep(20)
      }
      facts['locks.after-terminate'] = reacquired ? 'granted' : 'held'
      facts['locks.release-ms'] = tenth(performance.now() - started)
      return `页面拿着时 Worker 以 ifAvailable 申请：${String(facts['locks.if-available'])}；query 看得到 ${String(facts['locks.query-held'])} 个；Worker steal 之后页面的申请 ${String(facts['locks.page-request'])}；终止 Worker 之后 ${reacquired ? `${String(facts['locks.release-ms'])} ms 之内重新拿到` : '一直拿不到'}`
    })

    await check(session, 'storage.delete', async () => {
      closeDatabase()
      await deleteDatabase(name)
      facts['idb.deleted'] = true
      facts['idb.databases-after-delete'] = await listed(name)
      if (facts['estimate.supported'] === true)
        facts['estimate.usage-deleted'] = (await estimate()).usage
      return `删掉了这个库；之后 indexedDB.databases()：${String(facts['idb.databases-after-delete'])}`
    })
  }
  finally {
    closeDatabase()
    await deleteDatabase(name).catch(() => {})
  }
}

// ---- key-transfer ----

/** 带格式标识与固定顺序字段的 AAD（照 P1 设计 §3.3 的写法，只是探针自己的一份）；tampered 改掉文档 id 一个字段 */
function aadOf(documentId: string): string {
  return JSON.stringify(['nerve-office/outbox-draft/v1', 'probe-user', documentId, 1, 7, 3, 1, 'writer-1', 'tab-1', ['build', '1.0.1', 'sheet@1', 1], false, 2, null, 4096, 1_791_000_000_000])
}

async function seal(key: CryptoKey, plain: Uint8Array<ArrayBuffer>, aad: string): Promise<{ readonly iv: Uint8Array<ArrayBuffer>, readonly ciphertext: Uint8Array<ArrayBuffer>, readonly aad: string, readonly digest: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(aad) }, key, plain))
  return { iv, ciphertext, aad, digest: await sha256Hex(plain) }
}

/** 页面用自己的那把密钥解开 Worker 封的一份，摘要一致 */
async function opensOnPage(key: CryptoKey, sealed: { readonly iv: Uint8Array<ArrayBuffer>, readonly ciphertext: Uint8Array<ArrayBuffer>, readonly aad: string, readonly digest: string }): Promise<boolean> {
  try {
    const plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: sealed.iv, additionalData: new TextEncoder().encode(sealed.aad) }, key, sealed.ciphertext))
    return await sha256Hex(plain) === sealed.digest
  }
  catch {
    return false
  }
}

async function keyTransferScenario(session: Session): Promise<void> {
  const facts = session.facts
  const raw = randomBytes(32)
  const key = await crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
  // 退路用的原始字节：先拷一份转移给 Worker（它导入之后清零），页面这一份随即清零
  const rawForWorker = raw.slice()
  raw.fill(0)
  const plain = await gzipBytes(tableJsonBytes(64 * 1024))
  const aad = aadOf('probe-document')
  const tamperedAad = aadOf('probe-document-2')
  const sealed = await seal(key, plain, aad)
  const worker = startProbeWorker()
  try {
    await check(session, 'crypto.raw-import', async () => {
      const outcome = await worker.call('crypto-raw', { raw: rawForWorker, sealed, tamperedAad }, { transfer: [rawForWorker.buffer], timeoutMs: KEY_TRANSFER_TIMEOUT_MS })
      facts['crypto.raw-extractable'] = outcome.extractable
      facts['crypto.raw-zeroed'] = outcome.zeroed
      facts['crypto.raw-opened-page-seal'] = outcome.openedPageSeal
      facts['crypto.raw-tampered'] = outcome.tamperedAad
      facts['crypto.raw-page-opens-worker-seal'] = await opensOnPage(key, outcome.workerSeal)
      facts['crypto.raw-gzip'] = outcome.gzipRoundTrip
      facts['crypto.raw-digest'] = outcome.digestKnownAnswer
      facts['crypto.page-raw-zeroed'] = raw.every(byte => byte === 0)
      return `原始字节转移给 Worker、在那里导入（不可导出：${String(!outcome.extractable)}，导入之后清零：${String(outcome.zeroed)}）：解开页面封的${outcome.openedPageSeal ? '一致' : '不一致'}，AAD 改一个字段之后 ${outcome.tamperedAad}，Worker 封的页面解开${facts['crypto.raw-page-opens-worker-seal'] === true ? '一致' : '不一致'}`
    })
    await check(session, 'crypto.key-transfer', async () => {
      const started = performance.now()
      try {
        const outcome = await worker.call('crypto', { key, sealed, tamperedAad }, { timeoutMs: KEY_TRANSFER_TIMEOUT_MS })
        facts['crypto.key-transfer'] = 'ok'
        facts['crypto.key-type'] = outcome.keyType
        facts['crypto.key-extractable'] = outcome.extractable
        facts['crypto.key-algorithm'] = outcome.algorithm
        facts['crypto.key-usages'] = outcome.usages
        facts['crypto.key-opened-page-seal'] = outcome.openedPageSeal
        facts['crypto.key-tampered'] = outcome.tamperedAad
        facts['crypto.key-page-opens-worker-seal'] = await opensOnPage(key, outcome.workerSeal)
        facts['crypto.key-gzip'] = outcome.gzipRoundTrip
        facts['crypto.key-digest'] = outcome.digestKnownAnswer
      }
      catch (error) {
        // 交不过去（DataCloneError）、Worker 出错或超时（可能停在钥匙串的提示上）：如实记下，这一项照样算跑完
        facts['crypto.key-transfer'] = error instanceof ProbeWorkerError && error.message.includes('没有回应') ? 'timeout' : errorName(error)
        facts['crypto.key-transfer-detail'] = error instanceof Error ? error.message.slice(0, 200) : String(error)
      }
      facts['crypto.key-transfer-ms'] = tenth(performance.now() - started)
      if (facts['crypto.key-transfer'] !== 'ok')
        return `不可导出的 CryptoKey 交给 Worker：${String(facts['crypto.key-transfer'])}（${String(facts['crypto.key-transfer-detail'])}），${String(facts['crypto.key-transfer-ms'])} ms`
      return `不可导出的 CryptoKey 经 postMessage 交给 Worker（${String(facts['crypto.key-transfer-ms'])} ms）：${String(facts['crypto.key-type'])}、${String(facts['crypto.key-algorithm'])}、可导出 ${String(facts['crypto.key-extractable'])}、用途 ${String(facts['crypto.key-usages'])}；解开页面封的${facts['crypto.key-opened-page-seal'] === true ? '一致' : '不一致'}，AAD 改一个字段之后 ${String(facts['crypto.key-tampered'])}，Worker 封的页面解开${facts['crypto.key-page-opens-worker-seal'] === true ? '一致' : '不一致'}；Worker 里 gzip 往返 ${String(facts['crypto.key-gzip'])}、SHA-256 ${String(facts['crypto.key-digest'])}`
    }, KEY_TRANSFER_TIMEOUT_MS + 5_000)
  }
  finally {
    worker.terminate()
  }
}

// ---- storage-quota ----

/** 写满时一条记录多大 */
const QUOTA_RECORD_BYTES = 1024 * 1024

/** 覆盖已有记录时用多大的一份（比写满之后剩下的空间大） */
const QUOTA_OVERWRITE_BYTES = 4 * 1024 * 1024

/** 一次写入的结果：提交了，或者失败在哪里（请求上、事务的中止上）与错误的名字 */
type QuotaWrite = { readonly kind: 'committed' } | { readonly kind: 'failed', readonly at: 'request' | 'transaction', readonly error: string }

async function writeOnce(database: IDBDatabase, row: DraftRow): Promise<QuotaWrite> {
  const transaction = database.transaction(DRAFTS, 'readwrite', { durability: 'strict' })
  let requestError: string | undefined
  const request = transaction.objectStore(DRAFTS).put(row)
  request.onerror = () => {
    requestError = request.error?.name ?? 'UnknownError'
  }
  try {
    await transactionDone(transaction)
    return { kind: 'committed' }
  }
  catch (error) {
    return requestError === undefined ? { kind: 'failed', at: 'transaction', error: errorName(error) } : { kind: 'failed', at: 'request', error: requestError }
  }
}

async function storageQuotaScenario(session: Session): Promise<void> {
  const facts = session.facts
  await check(session, 'quota.fill', async () => {
    facts['quota.estimate'] = (await navigator.storage.estimate()).quota ?? null
    facts['quota.limit'] = QUOTA_PROBE_MAX_BYTES
    const name = probeDatabaseName('quota')
    const database = await openDatabase(name, 1, (created) => {
      created.createObjectStore(DRAFTS, { keyPath: KEY_PATH })
    })
    try {
      const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
      const original = await seal(key, randomBytes(256 * 1024), aadOf('original'))
      const stored = await writeOnce(database, draftOf('original', original.ciphertext))
      if (stored.kind !== 'committed')
        fail(`连第一条（256 KiB）都写不进去：${stored.error}`)
      const originalDigest = await sha256Hex(original.ciphertext)
      // 一条一条地加，直到失败；最多写到上限（有界：没被覆盖的配额写不满，到上限就停）
      const limit = Math.ceil(QUOTA_PROBE_MAX_BYTES / QUOTA_RECORD_BYTES)
      let failure: Extract<QuotaWrite, { kind: 'failed' }> | undefined
      let written = 0
      for (let index = 0; index < limit && failure === undefined; index += 1) {
        const outcome = await writeOnce(database, draftOf(`fill-${index}`, randomBytes(QUOTA_RECORD_BYTES)))
        if (outcome.kind === 'failed')
          failure = outcome
        else
          written += 1
      }
      facts['quota.records'] = written
      if (failure === undefined) {
        facts['quota.fill'] = 'not-full'
        return `加了 ${written} 条 1 MiB 都没有写满（estimate() 说配额 ${String(facts['quota.estimate'])} 字节）：配额没有被覆盖，到上限 ${QUOTA_PROBE_MAX_BYTES} 字节就停、删掉`
      }
      facts['quota.fill'] = 'filled'
      facts['quota.new-error'] = failure.error
      facts['quota.new-error-at'] = failure.at
      facts['quota.new-absent'] = await storedDigest(database, `fill-${written}`) === null
      // 覆盖已有的那一条（更大的一份）：失败之后原记录不变、能解开
      const overwrite = await writeOnce(database, draftOf('original', randomBytes(QUOTA_OVERWRITE_BYTES)))
      facts['quota.overwrite-error'] = overwrite.kind === 'failed' ? overwrite.error : 'none'
      facts['quota.original-kept'] = await storedDigest(database, 'original') === originalDigest
      const reading = database.transaction(DRAFTS, 'readonly')
      const row = await requestResult(reading.objectStore(DRAFTS).get(keyOf('original'))) as DraftRow | undefined
      await transactionDone(reading)
      facts['quota.original-opens'] = row !== undefined && await opensOnPage(key, { ...original, ciphertext: new Uint8Array(row.bytes) })
      return `加了 ${written} 条 1 MiB 之后失败（${String(facts['quota.new-error'])}，在${failure.at === 'request' ? '请求' : '事务'}上；estimate() 说配额 ${String(facts['quota.estimate'])} 字节），失败的那一条${facts['quota.new-absent'] === true ? '不在' : '在'}；拿 4 MiB 覆盖已有的一条：${String(facts['quota.overwrite-error'])}，原记录${facts['quota.original-kept'] === true ? '不变' : '变了'}、${facts['quota.original-opens'] === true ? '能解开' : '解不开'}`
    }
    finally {
      database.close()
      await deleteDatabase(name).catch(() => {})
    }
  }, STORAGE_CHECK_TIMEOUT_MS)
}

export const STORAGE_SCENARIO_RUNNERS = {
  'storage': storageScenario,
  'key-transfer': keyTransferScenario,
  'storage-quota': storageQuotaScenario,
} as const

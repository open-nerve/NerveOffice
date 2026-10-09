// 真实浏览器的前置复核（M4-P1 S1，设计 §3.6）页面与探针 Worker 共用的办法：墙上时刻、不经 Blob 的 gzip（WebKit 离线时读不了 Blob，
// M4 总设计 §6.1：存字节）、SHA-256、像密文那样的随机字节、IndexedDB 的请求与事务写成 Promise。不用 DOM（Worker 里也引用它），
// 不引用 Univer 与发件箱的生产代码（生产的发件箱还在另一位实现者手里写）；只在测试构建里（editor/testing/）

/** 现在的墙上时刻（毫秒，带小数）：页面与 Worker 的 performance.timeOrigin 不同，跨两边比先后用它 */
export function wallNow(): number {
  return performance.timeOrigin + performance.now()
}

export async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** 保留一位小数（交回的计时，地址里短一些） */
export function tenth(ms: number): number {
  return Math.round(ms * 10) / 10
}

/** 一段字节当作只有一块的流（不经 Blob） */
function streamOf(bytes: Uint8Array<ArrayBuffer>): ReadableStream<Uint8Array<ArrayBuffer>> {
  return new ReadableStream<Uint8Array<ArrayBuffer>>({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })
}

/** 读完一个流，拼成一段字节（不经 Response、Blob） */
async function collect(stream: ReadableStream<Uint8Array>): Promise<Uint8Array<ArrayBuffer>> {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done)
      break
    chunks.push(value)
    length += value.length
  }
  const out = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
}

/** gzip（CompressionStream，内存里的流） */
export async function gzipBytes(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  return collect(streamOf(bytes).pipeThrough(new CompressionStream('gzip')))
}

export async function gunzipBytes(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  return collect(streamOf(bytes).pipeThrough(new DecompressionStream('gzip')))
}

export async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
  return [...digest].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

/** 随机字节（像密文：压不小，浏览器存进 IndexedDB 时也压不小）；getRandomValues 一次最多 64 KiB */
export function randomBytes(length: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(length)
  for (let offset = 0; offset < length; offset += 65_536)
    crypto.getRandomValues(bytes.subarray(offset, Math.min(length, offset + 65_536)))
  return bytes
}

/** 一个错误的名字（DOMException 与 Error 的 name；别的写成字符串） */
export function errorName(error: unknown): string {
  if (error instanceof Error || error instanceof DOMException)
    return error.name
  return String(error)
}

// ---- IndexedDB ----

export async function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new DOMException('请求失败', 'UnknownError'))
  })
}

/** 事务结束：提交了 resolve；中止或出错 reject（错误是事务的 error，主动 abort 时是 AbortError） */
export async function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onabort = () => reject(transaction.error ?? new DOMException('事务被中止', 'AbortError'))
    transaction.onerror = (event) => {
      // 请求的错误会冒泡到事务：让它照常中止（不 preventDefault），结果由 onabort 交回
      event.stopPropagation()
    }
  })
}

/** 打开（或升级）一个库：upgrade 在 upgradeneeded 里建结构；blocked 时记下（别的连接没关） */
export async function openDatabase(name: string, version: number | undefined, upgrade?: (database: IDBDatabase, oldVersion: number) => void, onBlocked?: () => void): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = version === undefined ? indexedDB.open(name) : indexedDB.open(name, version)
    request.onupgradeneeded = (event) => {
      upgrade?.(request.result, event.oldVersion)
    }
    request.onblocked = () => onBlocked?.()
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new DOMException('打不开', 'UnknownError'))
  })
}

export async function deleteDatabase(name: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name)
    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error ?? new DOMException('删不掉', 'UnknownError'))
  })
}

/** 复核用的库名：带随机的后缀（同一个源上每次一个新库），收尾时删掉 */
export function probeDatabaseName(purpose: string): string {
  return `nerve-probe-${purpose}-${crypto.randomUUID()}`
}

// 真实浏览器的前置复核（M4-P1 S1）里页面与探针 Worker（./storage-probe-worker.ts）之间的消息：页面经 ./storage-probe-client.ts 一问一答。
// 两边都引用它；它不引用任何模块（Worker 里不能带进 DOM 与 Univer）。每个请求带 id，回应带同一个 id；Worker 里出错时回应 ok 为假、
// 带错误的名字与说明。各种请求的输入与输出在 ProbeCalls 里一一写明，客户端按它给出类型（Worker 交回的是结构化克隆的值，页面不另做形状核对：
// 只在测试构建里，形状不对时场景的检查会说出缺了什么）

/** pipeline 的写入方式：IndexedDB 事务的 durability（none 是不写，只量摘要、压缩与加密） */
export type ProbeStore = 'strict' | 'default' | 'none'

/** Worker 里的写入管道一次的各段（毫秒）与时刻（墙上时间，performance.timeOrigin + now） */
export interface PipelineTimes {
  /** Worker 收到这条消息的墙上时刻 */
  readonly receivedAt: number
  /** 第一次异步操作（SHA-256）：M0 在 WebKit 上看到的停顿就落在这一段（DEF-011） */
  readonly digestMs: number
  readonly gzipMs: number
  readonly encryptMs: number
  /** IndexedDB 的写入（put 到事务完成）；store 为 none 时是 0 */
  readonly putMs: number
  /** 收到到做完 */
  readonly workerMs: number
  /** 做完的墙上时刻（交回之前） */
  readonly doneAt: number
  readonly gzipBytes: number
  /** 这一次的事务实际的 durability 属性（不支持时没有这个属性：null） */
  readonly durability: string | null
}

/** 页面封好的一份（AES-GCM：iv、密文与 AAD 的文字），交给 Worker 解开 */
export interface SealedProbe {
  readonly iv: Uint8Array<ArrayBuffer>
  readonly ciphertext: Uint8Array<ArrayBuffer>
  readonly aad: string
  /** 明文的 SHA-256（十六进制） */
  readonly digest: string
}

/** Worker 里核对 CryptoKey 与加密的结果（第 7 项） */
export interface CryptoOutcome {
  /** 收到的密钥：类型、能不能导出、算法、用途 */
  readonly keyType: string
  readonly extractable: boolean
  readonly algorithm: string
  readonly usages: string
  /** 页面封的那一份在 Worker 里解开、摘要一致 */
  readonly openedPageSeal: boolean
  /** AAD 改一个字段之后解密的结果：应当失败（OperationError） */
  readonly tamperedAad: string
  /** Worker 用同一把密钥封的一份，交回页面解开 */
  readonly workerSeal: SealedProbe
  /** Worker 里的 CompressionStream 往返一致 */
  readonly gzipRoundTrip: boolean
  /** Worker 里的 SHA-256("abc") 对 */
  readonly digestKnownAnswer: boolean
}

/** Worker 里打开页面建的库：读到页面写的那一条、写一条给页面读 */
export interface WorkerDatabaseOutcome {
  readonly version: number
  readonly stores: string
  /** 页面写的那一条的字节的 SHA-256（读不到时 null） */
  readonly readDigest: string | null
  /** Worker 写的那一条的字节的 SHA-256 */
  readonly wroteDigest: string
}

/** Worker 以更高的版本打开页面开着的库：升级做完了没有、等的时候有没有 blocked */
export interface WorkerUpgradeOutcome {
  readonly version: number
  readonly blocked: boolean
  readonly ms: number
}

/** 各种请求的输入与输出 */
export interface ProbeCalls {
  /** 握手；keepAlive 时开一个 100 ms 的空定时器（DEF-011） */
  readonly 'hello': {
    readonly input: { readonly keepAlive: boolean, readonly database: string }
    readonly output: { readonly at: number, readonly indexedDB: boolean, readonly subtle: boolean, readonly compression: boolean, readonly locks: boolean }
  }
  /** 写入管道：SHA-256 → gzip → AES-GCM（Worker 自己的密钥）→ IndexedDB（store）；字节以 transfer 交来 */
  readonly 'pipeline': {
    readonly input: { readonly bytes: Uint8Array<ArrayBuffer>, readonly store: ProbeStore }
    readonly output: PipelineTimes
  }
  /** 收下页面交来的不可导出的 CryptoKey 与封好的一份（第 7 项） */
  readonly 'crypto': {
    readonly input: { readonly key: CryptoKey, readonly sealed: SealedProbe, readonly tamperedAad: string }
    readonly output: CryptoOutcome
  }
  /**
   * 退路（设计 §3.4.8：CryptoKey 交不过去时）：原始的 32 字节以 transfer 交来，Worker 里导入成不可导出的密钥、随即清零，同样的核对；
   * 另交回清零之后那段字节还是不是全零
   */
  readonly 'crypto-raw': {
    readonly input: { readonly raw: Uint8Array<ArrayBuffer>, readonly sealed: SealedProbe, readonly tamperedAad: string }
    readonly output: CryptoOutcome & { readonly zeroed: boolean }
  }
  /** Worker 里打开页面建的库（不带版本），读 key 那一条、写 wroteKey 一条（第 6 项） */
  readonly 'idb-read-write': {
    readonly input: { readonly database: string, readonly store: string, readonly key: readonly string[], readonly wroteKey: readonly string[], readonly bytes: number }
    readonly output: WorkerDatabaseOutcome
  }
  /** Worker 以 version 打开页面开着的库、加一个对象仓库（页面一侧收到 versionchange、关掉之后升级才继续，第 6 项） */
  readonly 'idb-upgrade': {
    readonly input: { readonly database: string, readonly version: number, readonly store: string }
    readonly output: WorkerUpgradeOutcome
  }
  /** Web Locks：ifAvailable 申请（页面拿着时应当得到 null，第 8 项） */
  readonly 'lock-if-available': {
    readonly input: { readonly name: string }
    readonly output: { readonly granted: boolean }
  }
  /** Web Locks：steal 抢过来、一直拿着（直到 Worker 被终止） */
  readonly 'lock-steal': {
    readonly input: { readonly name: string }
    readonly output: { readonly granted: boolean }
  }
  /** 关掉 Worker 自己的库的连接（终止之前，页面随后删掉它） */
  readonly 'close': {
    readonly input: Record<string, never>
    readonly output: { readonly closed: boolean }
  }
}

export type ProbeCallType = keyof ProbeCalls

export interface ProbeRequest<K extends ProbeCallType = ProbeCallType> {
  readonly id: number
  readonly type: K
  readonly input: ProbeCalls[K]['input']
}

export type ProbeReply
  = | { readonly id: number, readonly ok: true, readonly output: unknown }
    | { readonly id: number, readonly ok: false, readonly error: { readonly name: string, readonly message: string } }

/** 收到的是不是一条回应（Worker 只发回应；页面另外收到的不理） */
export function isProbeReply(data: unknown): data is ProbeReply {
  if (typeof data !== 'object' || data === null)
    return false
  const reply = data as Record<string, unknown>
  return typeof reply.id === 'number' && typeof reply.ok === 'boolean'
}

/** 收到的是不是一条请求（Worker 一侧） */
export function isProbeRequest(data: unknown): data is ProbeRequest {
  if (typeof data !== 'object' || data === null)
    return false
  const request = data as Record<string, unknown>
  return typeof request.id === 'number' && typeof request.type === 'string' && typeof request.input === 'object' && request.input !== null
}

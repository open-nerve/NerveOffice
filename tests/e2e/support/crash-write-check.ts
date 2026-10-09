// 写入中途结束整棵浏览器进程时的原子性（M4-P1 设计 §3.7、S7）：测试里自己写的最小写入，先用它把崩溃工具与断言跑通；生产的存储与写入管道
// （shared/outbox、features/sheet-editor/outbox）合并之后，同样的断言接到生产代码上（两种放置）。
// 页面一侧（installWriteCheck，经 addInitScript 挂到这个上下文的每个文档上）：库 nerve-crash-check 的两个对象仓库（drafts、writers，键路径与
// 发件箱相同），一个 strict 事务里写约 5 MiB 的字节与写入者的高水位（同一个序号）；内容由序号决定（xorshift32），读回时在页面里按记录的序号
// 重新生成、逐字节比较。"写入之前"的信号：事务开好、put 之前调用测试进程的绑定函数（不等它回来，紧接着 put），测试进程收到就冻住整个浏览器。
// 页面里执行的函数经 addInitScript、evaluate 序列化过去，不能引用外面的变量：名字与参数都经参数传入
import type { Page } from '@playwright/test'
import type { PersistentLaunch } from './browser-crash.ts'

/** 每次写的字节数：约 5 MiB（设计 §3.7，与 M0 的大表相当） */
export const WRITE_CHECK_BYTES = 5 * 1024 * 1024

const CHECK_GLOBAL = '__nerveWriteCheck'
const BEFORE_PUT_BINDING = '__nerveWriteCheckBeforePut'

/** 读回的一份 */
export interface CheckRecord {
  /** 草稿的序号；没有草稿时 null */
  readonly seq: number | null
  /** 写入者的高水位（与草稿在同一个事务里写）；没有时 null */
  readonly writerSeq: number | null
  readonly bytes: number
  /** 字节与按 seq 生成的逐字节相同 */
  readonly intact: boolean
}

/** 页面里最近一次写入的状态；时刻都从这次写入开始算（毫秒，performance.now） */
export interface WriteState {
  readonly seq: number
  readonly phase: 'writing' | 'committed' | 'failed'
  /** 字节生成好、put 之前（"写入之前"的信号在这一刻发出） */
  readonly putAtMs?: number
  /** 事务提交（complete） */
  readonly committedAtMs?: number
  readonly error?: string
}

/** 页面上的检查（window 上的那一个） */
interface PageCheck {
  readonly write: (seq: number, signal: boolean) => Promise<void>
  readonly start: (seq: number, signal: boolean) => void
  readonly read: () => Promise<CheckRecord>
  readonly last: () => WriteState | undefined
}

interface InstallOptions {
  readonly global: string
  readonly binding: string
  readonly bytes: number
}

/** 在页面里执行（addInitScript）：不能引用外面的变量 */
function installWriteCheck({ global, binding, bytes }: InstallOptions): void {
  const key = { userId: 'crash-check-user', documentId: 'crash-check-document' }
  /** 序号 seq 的内容：xorshift32，种子由序号决定（不为 0） */
  const generate = (seq: number): Uint8Array => {
    const words = new Uint32Array(bytes / 4)
    let x = (Math.imul(seq, 0x9E3779B1) ^ 0x5BD1E995) >>> 0 || 1
    for (let index = 0; index < words.length; index += 1) {
      x ^= x << 13
      x ^= x >>> 17
      x ^= x << 5
      x >>>= 0
      words[index] = x
    }
    return new Uint8Array(words.buffer)
  }
  let opening: Promise<IDBDatabase> | undefined
  const open = async (): Promise<IDBDatabase> => {
    opening ??= new Promise((resolve, reject) => {
      const request = indexedDB.open('nerve-crash-check', 1)
      request.onupgradeneeded = () => {
        request.result.createObjectStore('drafts', { keyPath: ['userId', 'documentId'] })
        request.result.createObjectStore('writers', { keyPath: ['userId', 'documentId'] })
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error ?? new Error('打不开库'))
      request.onblocked = () => reject(new Error('打开库被阻塞'))
    })
    return opening
  }
  let last: WriteState | undefined
  const write = async (seq: number, signal: boolean): Promise<void> => {
    const startedAt = performance.now()
    last = { seq, phase: 'writing' }
    let putAtMs: number | undefined
    try {
      const content = generate(seq)
      const db = await open()
      await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction(['drafts', 'writers'], 'readwrite', { durability: 'strict' })
        transaction.oncomplete = () => resolve()
        transaction.onabort = () => reject(transaction.error ?? new Error('事务中止'))
        putAtMs = performance.now() - startedAt
        last = { seq, phase: 'writing', putAtMs }
        if (signal) {
          const notify = (window as unknown as Record<string, ((seq: number) => Promise<void>) | undefined>)[binding]
          // 不等它回来：紧接着 put，测试进程收到就冻住浏览器
          void notify?.(seq)
        }
        transaction.objectStore('drafts').put({ ...key, seq, bytes: content })
        transaction.objectStore('writers').put({ ...key, lastSeq: seq })
      })
      last = { seq, phase: 'committed', putAtMs, committedAtMs: performance.now() - startedAt }
    }
    catch (error) {
      last = { seq, phase: 'failed', putAtMs, error: String(error) }
      throw error
    }
  }
  const read = async (): Promise<CheckRecord> => {
    const db = await open()
    const [draft, writer] = await new Promise<[unknown, unknown]>((resolve, reject) => {
      const transaction = db.transaction(['drafts', 'writers'], 'readonly')
      const draftRequest = transaction.objectStore('drafts').get([key.userId, key.documentId])
      const writerRequest = transaction.objectStore('writers').get([key.userId, key.documentId])
      transaction.oncomplete = () => resolve([draftRequest.result, writerRequest.result])
      transaction.onabort = () => reject(transaction.error ?? new Error('事务中止'))
    })
    const writerSeq = (writer as { lastSeq?: number } | undefined)?.lastSeq ?? null
    const record = draft as { seq?: number, bytes?: Uint8Array } | undefined
    if (record?.seq === undefined || record.bytes === undefined)
      return { seq: null, writerSeq, bytes: 0, intact: false }
    const expected = generate(record.seq)
    const stored = record.bytes
    let intact = stored.length === expected.length
    for (let index = 0; intact && index < stored.length; index += 1)
      intact = stored[index] === expected[index]
    return { seq: record.seq, writerSeq, bytes: stored.length, intact }
  }
  const check: PageCheck = {
    write,
    // 在下一个任务里开始：evaluate 先返回，延迟从写入开始之前算起
    start: (seq, signal) => {
      setTimeout(() => {
        write(seq, signal).catch(() => undefined)
      }, 0)
    },
    read,
    last: () => last,
  }
  ;(window as unknown as Record<string, PageCheck>)[global] = check
}

/** 一次启动上的写入检查 */
export interface WriteCheck {
  readonly page: Page
  /** 写序号 seq 的一份，等它提交 */
  readonly write: (seq: number) => Promise<void>
  /** 开始写序号 seq 的一份，不等（evaluate 先返回，写入在下一个任务里开始）；signal 为 true 时 put 之前发"写入之前"的信号 */
  readonly start: (seq: number, options: { readonly signal: boolean }) => Promise<void>
  readonly read: () => Promise<CheckRecord>
  /** 页面里最近一次写入的状态（put 与提交的时刻） */
  readonly lastWrite: () => Promise<WriteState | undefined>
  /** 下一次"写入之前"的信号到了就同步调用 handler（一次）：在它里面冻住浏览器 */
  readonly onBeforePut: (handler: () => void) => void
}

type CheckWindow = Record<string, PageCheck | undefined>

/** 在这次启动上挂好绑定与页面一侧，打开同源的页面（登录页：平台页面不用 IndexedDB）。每次启动调用一次（绑定只能注册一次） */
export async function openWriteCheck(launch: PersistentLaunch): Promise<WriteCheck> {
  let handler: (() => void) | undefined
  await launch.context.exposeBinding(BEFORE_PUT_BINDING, () => {
    const current = handler
    handler = undefined
    current?.()
  })
  await launch.context.addInitScript(installWriteCheck, { global: CHECK_GLOBAL, binding: BEFORE_PUT_BINDING, bytes: WRITE_CHECK_BYTES })
  const { page } = launch
  await page.goto('/login')
  await page.waitForFunction(name => (window as unknown as CheckWindow)[name] !== undefined, CHECK_GLOBAL)
  return {
    page,
    write: async (seq) => {
      await page.evaluate(async ({ name, seq }) => (window as unknown as CheckWindow)[name]?.write(seq, false), { name: CHECK_GLOBAL, seq })
    },
    start: async (seq, { signal }) => {
      await page.evaluate(({ name, seq, signal }) => (window as unknown as CheckWindow)[name]?.start(seq, signal), { name: CHECK_GLOBAL, seq, signal })
    },
    read: async () => {
      const record = await page.evaluate(async name => (window as unknown as CheckWindow)[name]?.read(), CHECK_GLOBAL)
      if (record === undefined)
        throw new Error('页面上没有写入检查')
      return record
    },
    lastWrite: async () => page.evaluate(name => (window as unknown as CheckWindow)[name]?.last(), CHECK_GLOBAL),
    onBeforePut: (next) => {
      handler = next
    },
  }
}

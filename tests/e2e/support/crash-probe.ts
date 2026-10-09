// 写入中途结束整棵浏览器进程时的原子性（M4-P1 设计 §3.7、S7）接到生产代码：编辑器页测试构建里的崩溃用例探针
// （apps/web/src/features/sheet-editor/outbox/testing/crash-probe.ts，地址带 crashProbe 时挂在 window.__nerveCrashProbe 上）。
// 探针用生产的写入管道写约 5 MiB 的内容，两种放置：进程内（createDraftWriter 配 IndexedDB 的存储）与发件箱 Worker（生产的客户端配记下事务的
// 测试 Worker）；交给存储之前（Worker 时：Worker 开写入的事务时）经这里挂上的绑定函数发"写入之前"的信号；读回时经管道解开、解压，按序号
// 逐字节比较，另读写入者的高水位。E2E 这边看不到 web 的类型，这里声明用到的部分（与探针的写法相同）。
// 打开的是一份不存在的文档：页面只确认会话、说明"内容不存在"，不建编辑器（同 support/outbox-probe.ts），所以要先登录；重开时走 Cookie 的
// restore（同一次登录接着有效）。用到它的用例打上 @test-build：外部模式测生产镜像，里面没有探针
import type { Page } from '@playwright/test'
import type { PersistentLaunch } from './browser-crash.ts'
import type { DraftKey, WriterIdentity } from './outbox-probe.ts'
import { randomBytes, randomUUID } from 'node:crypto'
import { expect } from './browser-crash.ts'

/** 每次写的内容：约 5 MiB 的字符（设计 §3.7，与 M0 的大表相当；base64 字符几乎压不动，gzip 之后约 3.8 MiB） */
export const CRASH_CONTENT_CHARS = 5 * 1024 * 1024

const CRASH_PROBE_GLOBAL = '__nerveCrashProbe'
const SIGNAL_BINDING = '__nerveCrashBeforePut'

/** 写入管道放在哪（与探针的 CrashProbePlacement 相同） */
export type CrashPlacement = 'in-process' | 'worker'

export const CRASH_PLACEMENTS: readonly CrashPlacement[] = ['in-process', 'worker']

/** 每次启动交给探针的（与探针的 CrashProbeSetup 相同） */
export interface CrashSetup {
  readonly placement: CrashPlacement
  readonly key: DraftKey
  readonly writer: WriterIdentity
  readonly localKey: { readonly version: number, readonly rawHex: string }
  readonly contentChars: number
  readonly signalBinding: string
}

/** 打开之前看到的库（与探针的 CrashProbePeek 相同）：在不在；不在时 Chromium 说明是不是因为存储损坏丢了数据（dataLoss 为 total） */
export interface CrashProbePeek {
  readonly existed: boolean
  readonly dataLoss?: string
  readonly dataLossMessage?: string
}

export type CrashProbeRegistered
  = | { readonly kind: 'registered', readonly lastDraftSeq: number, readonly peek: CrashProbePeek }
    | { readonly kind: 'not-registered', readonly outcome: string, readonly peek: CrashProbePeek }

/** 读回的一份（与探针的 CrashProbeRead 相同） */
export type CrashProbeRead
  = | { readonly kind: 'draft', readonly seq: number, readonly writerSeq: number | null, readonly bytes: number, readonly intact: boolean }
    | { readonly kind: 'absent', readonly writerSeq: number | null }
    | { readonly kind: 'not-readable', readonly outcome: string }

/** 最近一次写入（与探针的 CrashProbeWrite 相同）：时刻都从这次写入开始算 */
export interface CrashProbeWrite {
  readonly seq: number
  readonly phase: string
  readonly putAtMs?: number
  readonly settledAtMs?: number
}

interface CrashProbe {
  readonly prepare: (setup: CrashSetup) => Promise<CrashProbeRegistered>
  readonly write: (seq: number) => Promise<string>
  readonly start: (seq: number, signal: boolean) => void
  readonly read: () => Promise<CrashProbeRead>
  readonly last: () => CrashProbeWrite | undefined
}

type ProbeWindow = Record<string, CrashProbe | undefined>

/** 一次运行用的（重开之后还是这一份）：这个放置、这个用户的一份新文档、第 1 代的一个写入者、随机的一把本机密钥（测试进程记着原始字节，重开之后用同一把） */
export function crashSetupFor(userId: string, placement: CrashPlacement): CrashSetup {
  return {
    placement,
    key: { userId, documentId: randomUUID() },
    writer: { writeEpoch: 1, writerId: randomUUID() },
    localKey: { version: 1, rawHex: randomBytes(32).toString('hex') },
    contentChars: CRASH_CONTENT_CHARS,
    signalBinding: SIGNAL_BINDING,
  }
}

/** 一次启动上的探针 */
export interface CrashCheck {
  readonly page: Page
  /** 这次启动打开探针时看到的库（重开之后库在不在、是不是被浏览器当作损坏删掉重建了） */
  readonly peek: CrashProbePeek
  /** 写序号 seq 的一份，等它写完：交回管道的结果的种类（written 才算写成） */
  readonly write: (seq: number) => Promise<string>
  /** 开始写序号 seq 的一份、不等（写入在下一个任务里开始）；signal 为 true 时交给存储之前发"写入之前"的信号 */
  readonly start: (seq: number, options: { readonly signal: boolean }) => Promise<void>
  readonly read: () => Promise<CrashProbeRead>
  readonly lastWrite: () => Promise<CrashProbeWrite | undefined>
  /** 下一次"写入之前"的信号到了就同步调用 handler（一次）：在它里面冻住浏览器 */
  readonly onBeforePut: (handler: () => void) => void
}

/**
 * 在这次启动上挂好信号的绑定函数，打开编辑器页（一份不存在的文档，地址带 crashProbe），等探针挂上，交给它这次启动用的（建写入管道、登记写入者）。
 * 每次启动调用一次（绑定只能注册一次）；要已经登录
 */
export async function openCrashProbe(launch: PersistentLaunch, setup: CrashSetup): Promise<CrashCheck> {
  let handler: (() => void) | undefined
  await launch.context.exposeBinding(setup.signalBinding, () => {
    const current = handler
    handler = undefined
    current?.()
  })
  const { page } = launch
  await page.goto(`/documents/${randomUUID()}?crashProbe`)
  await expect.poll(async () => page.evaluate(name => (window as unknown as ProbeWindow)[name] !== undefined, CRASH_PROBE_GLOBAL), { message: '页面里没有崩溃用例的探针：要跑测试构建（web 的 build:e2e），地址带 crashProbe，并且已经登录' }).toBe(true)
  const registered = await page.evaluate(async ({ name, setup }) => (window as unknown as ProbeWindow)[name]?.prepare(setup), { name: CRASH_PROBE_GLOBAL, setup })
  expect(registered?.kind, `写入者没登记上：${JSON.stringify(registered)}`).toBe('registered')
  return {
    page,
    peek: registered?.peek ?? { existed: false },
    write: async seq => page.evaluate(async ({ name, seq }) => {
      const probe = (window as unknown as ProbeWindow)[name]
      if (probe === undefined)
        throw new Error('页面里没有崩溃用例的探针')
      return probe.write(seq)
    }, { name: CRASH_PROBE_GLOBAL, seq }),
    start: async (seq, { signal }) => {
      await page.evaluate(({ name, seq, signal }) => (window as unknown as ProbeWindow)[name]?.start(seq, signal), { name: CRASH_PROBE_GLOBAL, seq, signal })
    },
    read: async () => page.evaluate(async (name) => {
      const probe = (window as unknown as ProbeWindow)[name]
      if (probe === undefined)
        throw new Error('页面里没有崩溃用例的探针')
      return probe.read()
    }, CRASH_PROBE_GLOBAL),
    lastWrite: async () => page.evaluate(name => (window as unknown as ProbeWindow)[name]?.last(), CRASH_PROBE_GLOBAL),
    onBeforePut: (next) => {
      handler = next
    },
  }
}

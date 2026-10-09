// 写入中途结束整棵浏览器进程时的原子性（M4-P1 设计 §3.7、§3.8，S7 与 S9 第 5 项）接到生产代码：编辑器页测试构建里的崩溃用例探针
// （apps/web/src/features/sheet-editor/outbox/testing/crash-probe.ts，地址带 crashProbe 时挂在 window.__nerveCrashProbe 上）。
// 探针用生产的写入管道写约 5 MiB 的内容，两种放置：进程内（createDraftWriter 配 IndexedDB 的存储，没有镜像）与发件箱 Worker（生产的客户端配
// 崩溃用例的测试 Worker，带 OPFS 的镜像）；按要求在"写入之前"或"写镜像之前"经这里挂上的绑定函数发信号；读回时经管道解开（Worker 时在库与
// 两个槽位里取最新的）、解压，按序号逐字节比较，另读写入者的高水位；取走管道比对镜像留下的事件。
// 同一页另挂发件箱的浏览器层探针（地址另带 outboxProbe，support/outbox-probe.ts）：读、改镜像的槽位文件，删用例用户的镜像目录。
// E2E 这边看不到 web 的类型，这里声明用到的部分（与探针的写法相同）。
// 打开的是一份不存在的文档：页面只确认会话、说明"内容不存在"，不建编辑器（同 support/outbox-probe.ts），所以要先登录；重开时走 Cookie 的
// restore（同一次登录接着有效）。用到它的用例打上 @test-build：外部模式测生产镜像，里面没有探针
import type { Page } from '@playwright/test'
import type { PersistentLaunch } from './browser-crash.ts'
import type { DraftKey, ProbeCorruption, ProbeSlot, RecoveryEvent, WriterIdentity } from './outbox-probe.ts'
import { randomBytes, randomUUID } from 'node:crypto'
import { expect } from './browser-crash.ts'
import { probePipeline, removeMirrorOf } from './outbox-probe.ts'

/** 每次写的内容：约 5 MiB 的字符（设计 §3.7，与 M0 的大表相当；base64 字符几乎压不动，gzip 之后约 3.8 MiB） */
export const CRASH_CONTENT_CHARS = 5 * 1024 * 1024

const CRASH_PROBE_GLOBAL = '__nerveCrashProbe'
const SIGNAL_BINDING = '__nerveCrashBeforePut'

/** 写入管道放在哪（与探针的 CrashProbePlacement 相同） */
export type CrashPlacement = 'in-process' | 'worker'

export const CRASH_PLACEMENTS: readonly CrashPlacement[] = ['in-process', 'worker']

/** 写镜像时停住的那一步之后（与 mirror-recorder.ts 的 MirrorPausePoint 相同）：截断、写内容、写头、flush */
export type MirrorPausePoint = 'after-truncate' | 'after-content' | 'after-header' | 'after-flush'

export const MIRROR_PAUSE_POINTS: readonly MirrorPausePoint[] = ['after-truncate', 'after-content', 'after-header', 'after-flush']

/**
 * 开始写的时候在哪一刻发信号（与探针的 CrashProbeSignal 相同）：put 写入之前，mirror 写镜像之前；MirrorPausePoint：Worker 停在写镜像的那一步
 * 之后再发（写镜像只要几毫秒，按时机冻不到半途）。后两种只有 Worker 的放置有（镜像只在 Worker 里）
 */
export type CrashSignal = 'none' | 'put' | 'mirror' | MirrorPausePoint

/** 每次启动交给探针的（与探针的 CrashProbeSetup 相同） */
export interface CrashSetup {
  readonly placement: CrashPlacement
  readonly key: DraftKey
  readonly writer: WriterIdentity
  readonly localKey: { readonly version: number, readonly rawHex: string }
  readonly contentChars: number
  readonly signalBinding: string
}

/** 打开之前看到的库（与探针的 CrashProbePeek 相同）：在不在（不在 = 这次启动之前库没了，Chromium 删库就是这样） */
export interface CrashProbePeek {
  readonly existed: boolean
  readonly dataLoss?: string
  readonly dataLossMessage?: string
}

/** 登记的结果（与探针的 CrashProbeRegistered 相同）：mirror 是镜像拿到句柄没有（mirrored、off、not-mirrored:原因），existing 是已有的那一份的种类 */
export type CrashProbeRegistered
  = | { readonly kind: 'registered', readonly lastDraftSeq: number, readonly mirror: string, readonly existing: string, readonly peek: CrashProbePeek }
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
  readonly mirror?: string
  readonly putAtMs?: number
  readonly mirrorAtMs?: number
  readonly mirrorFlushedAtMs?: number
  readonly mirrorPausedAtMs?: number
  readonly settledAtMs?: number
}

interface CrashProbe {
  readonly prepare: (setup: CrashSetup) => Promise<CrashProbeRegistered>
  readonly write: (seq: number) => Promise<string>
  readonly start: (seq: number, signal: CrashSignal) => Promise<void>
  readonly read: () => Promise<CrashProbeRead>
  readonly last: () => CrashProbeWrite | undefined
  readonly events: () => Promise<readonly RecoveryEvent[]>
  readonly release: () => Promise<void>
  readonly dispose: () => void
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
  readonly setup: CrashSetup
  /** 这次启动登记的结果（含打开之前看到的库：重开之后库在不在） */
  readonly registered: Extract<CrashProbeRegistered, { readonly kind: 'registered' }>
  /** 写序号 seq 的一份，等它写完：交回管道的结果的种类（written 才算写成） */
  readonly write: (seq: number) => Promise<string>
  /** 开始写序号 seq 的一份、不等（写入在下一个任务里开始）；signal 不是 none 时到了那一刻发信号 */
  readonly start: (seq: number, options: { readonly signal: CrashSignal }) => Promise<void>
  readonly read: () => Promise<CrashProbeRead>
  readonly lastWrite: () => Promise<CrashProbeWrite | undefined>
  /** 取走管道比对镜像与库留下的事件 */
  readonly events: () => Promise<readonly RecoveryEvent[]>
  /** 镜像的两个槽位文件读出来的样子（先放开管道的句柄；下一次写入时管道自己再拿） */
  readonly mirrorSlots: () => Promise<readonly [ProbeSlot, ProbeSlot]>
  /** 把一个槽位改坏（先放开管道的句柄） */
  readonly corruptSlot: (slot: 0 | 1, corruption: ProbeCorruption) => Promise<void>
  /** 下一次信号到了就同步调用 handler（一次）：在它里面冻住浏览器 */
  readonly onSignal: (handler: () => void) => void
}

/**
 * 在这次启动上挂好信号的绑定函数，打开编辑器页（一份不存在的文档，地址带 crashProbe 与 outboxProbe），等两个探针挂上，交给崩溃探针这次启动用的
 * （建写入管道、登记写入者——登记之前管道先比对镜像，删库之后从镜像写回）。每次启动调用一次（绑定只能注册一次）；要已经登录
 */
export async function openCrashProbe(launch: PersistentLaunch, setup: CrashSetup): Promise<CrashCheck> {
  let handler: (() => void) | undefined
  await launch.context.exposeBinding(setup.signalBinding, () => {
    const current = handler
    handler = undefined
    current?.()
  })
  const { page } = launch
  await page.goto(`/documents/${randomUUID()}?crashProbe&outboxProbe`)
  await expect.poll(async () => page.evaluate(name => (window as unknown as ProbeWindow)[name] !== undefined && window.__nerveOutboxProbe !== undefined, CRASH_PROBE_GLOBAL), { message: '页面里没有崩溃用例与发件箱的探针：要跑测试构建（web 的 build:e2e），地址带 crashProbe 与 outboxProbe，并且已经登录' }).toBe(true)
  const registered = await page.evaluate(async ({ name, setup }) => (window as unknown as ProbeWindow)[name]?.prepare(setup), { name: CRASH_PROBE_GLOBAL, setup })
  expect(registered?.kind, `写入者没登记上：${JSON.stringify(registered)}`).toBe('registered')
  const call = async <T>(method: keyof CrashProbe, ...args: unknown[]): Promise<T> => page.evaluate(async ({ name, method, args }) => {
    const probe = (window as unknown as ProbeWindow)[name]
    if (probe === undefined)
      throw new Error('页面里没有崩溃用例的探针')
    return (probe[method] as (...values: unknown[]) => unknown)(...args)
  }, { name: CRASH_PROBE_GLOBAL, method, args }) as Promise<T>
  return {
    page,
    setup,
    registered: registered as Extract<CrashProbeRegistered, { readonly kind: 'registered' }>,
    write: async seq => call<string>('write', seq),
    start: async (seq, { signal }) => call<void>('start', seq, signal),
    read: async () => call<CrashProbeRead>('read'),
    lastWrite: async () => call<CrashProbeWrite | undefined>('last'),
    events: async () => call<readonly RecoveryEvent[]>('events'),
    mirrorSlots: async () => {
      await call<void>('release')
      return probePipeline(page, 'mirrorSlots', setup.key)
    },
    corruptSlot: async (slot, corruption) => {
      await call<void>('release')
      await probePipeline(page, 'corruptSlot', setup.key, slot, corruption)
    },
    onSignal: (next) => {
      handler = next
    },
  }
}

/**
 * 用例收尾：关掉崩溃探针的写入管道（Worker 终止、镜像的句柄放开），再删掉这个用户的 OPFS 镜像目录——Playwright 的 WebKit 在 macOS 上把持久上下文的
 * OPFS 放在共用的目录里（不在资料目录里），不删就一直留着。Worker 终止之后句柄是异步放开的：删到成功为止
 */
export async function removeCrashMirror(check: CrashCheck): Promise<void> {
  await check.page.evaluate(name => (window as unknown as ProbeWindow)[name]?.dispose(), CRASH_PROBE_GLOBAL)
  await expect.poll(async () => removeMirrorOf(check.page, check.setup.key.userId), { message: '删掉用例用户的镜像目录', timeout: 10_000 }).toBe('removed')
}

/** 槽位读出来的样子写成一个词：missing、empty、invalid:原因、seq<序号> */
export function slotWord(slot: ProbeSlot): string {
  switch (slot.kind) {
    case 'missing':
    case 'empty':
      return slot.kind
    case 'invalid':
      return `invalid:${slot.reason}`
    case 'valid':
      return `seq${slot.meta.draftSeq}`
  }
}

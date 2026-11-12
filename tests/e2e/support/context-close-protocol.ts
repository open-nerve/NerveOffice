// 测试专用补证（M5-P8，需求方 2026-11-12 批准）：固定用例所在的工作进程里，只在这条用例期间把 Playwright 与浏览器之间的协议消息接到
// 内存里的过滤器。只留与关闭页面、关闭 context 有关的命令、回复与事件（含关闭前的截图）的方法名、编号、时刻、目标类型与截短的标识，
// 各方法名的计数，以及关闭开始前后的方法名序列；参数、结果、地址、标题、Cookie、请求与回复内容不保存，原始消息不落盘、不输出。
// 接法：这个进程已经加载的 playwright-core 1.63.0 从 lib/coreBundle 导出的内部日志对象（utils.debugLogger）。Playwright 每条协议消息
// 都先问它 isEnabled，再交给它的 log；版本或形状不符就不安装，只登记原因。不发任何协议命令，不改变关闭、等待或重试。
import type { BrowserContext, TestInfo } from '@playwright/test'
import { Buffer } from 'node:buffer'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, sep } from 'node:path'
import { performance } from 'node:perf_hooks'
import process from 'node:process'
import { createExclusiveReport } from './exclusive-report.ts'

export const PROTOCOL_FILE = 'context-close-protocol.json'
export const PROTOCOL_ATTACHMENT = 'context-close-protocol'
export const PROTOCOL_INCOMPLETE = 'context-close-protocol-incomplete'
/** 接法依赖的 playwright-core 版本；升级之后单元测试会失败，提醒重新核对接法 */
export const PROTOCOL_CORE_VERSION = '1.63.0'
export const PROTOCOL_MAX_BYTES = 192 * 1024
/** 关闭开始之后整份重写的时刻（毫秒）：卡住时逐次留下当时仍在等待回复的命令 */
const CHECKPOINTS_MS = [2_000, 10_000, 30_000, 90_000, 200_000]
/** 兜底：从安装起最长记录这么久（用例时限 240 秒，另加收尾），到时释放 */
const MAX_RECORDING_MS = 330_000
/** 模块缓存里 playwright-core 的打包入口（缓存的键是实际路径） */
const CORE_BUNDLE = `${sep}playwright-core${sep}lib${sep}coreBundle.js`

const SEND = 'SEND ► '
const RECV = '◀ RECV '
const TRUNCATED = ' <<<<<( LOG TRUNCATED )>>>>> '
const HEAD_ID = /^\{"id":(\d{1,15})[,}]/
const SEND_METHOD = /^\{"id":\d{1,15},"method":"([A-Z][A-Za-z]{0,39}\.[A-Za-z]{1,60})"/
const EVENT_METHOD = /^\{"method":"([A-Z][A-Za-z]{0,39}\.[A-Za-z]{1,60})"/
const ERROR_HEAD = /^\{"id":\d{1,15},"error":(?:\{"code":(-?\d{1,9}))?/
const TAIL_SESSION = /"sessionId":"([0-9A-F]{8,64})"\}$/i
const HEX = /^[0-9A-F]{8,64}$/i
const WORD = /^[A-Z_ .-]{1,60}$/i
const HEAD_CHARS = 160
const TAIL_CHARS = 120
/** 超过这个长度的消息不整体解析（截屏帧、截图等），方法名、编号与会话照样从首尾认出 */
const PARSE_LIMIT = 256 * 1024
const MAX_TEXT = 160
const MAX_CLOSE_EVENTS = 300
const PRE_CLOSE = 100
const MAX_POST_CLOSE = 600
const MAX_METHODS = 300
const MAX_PENDING_LISTED = 50
const MAX_PENDING_TRACKED = 10_000
const MAX_TARGETS = 200
const MAX_CONTEXTS = 50
const MAX_SESSIONS = 2_000
const MAX_FILTER_ERRORS = 100
/** 快照留给状态与原因字段的余量：裁剪按上限减去它来算 */
const HEADROOM_BYTES = 1024

const CLOSE_COMMANDS: ReadonlySet<string> = new Set([
  'Target.createBrowserContext',
  'Target.disposeBrowserContext',
  'Target.createTarget',
  'Target.closeTarget',
  'Target.attachToTarget',
  'Target.detachFromTarget',
  'Page.close',
  'Page.handleJavaScriptDialog',
  'Page.startScreencast',
  'Page.stopScreencast',
  'Page.captureScreenshot',
  'Page.bringToFront',
  'Browser.close',
  'Runtime.runIfWaitingForDebugger',
])
const CLOSE_EVENTS: ReadonlySet<string> = new Set([
  'Target.targetCreated',
  'Target.targetDestroyed',
  'Target.targetCrashed',
  'Target.attachedToTarget',
  'Target.detachedFromTarget',
  'Inspector.detached',
  'Inspector.targetCrashed',
  'Page.javascriptDialogOpening',
  'Page.javascriptDialogClosed',
])
type TargetMoment = 'created' | 'attached' | 'destroyed' | 'detached' | 'crashed'
const TARGET_MOMENTS: ReadonlyMap<string, TargetMoment> = new Map([
  ['Target.targetCreated', 'created'],
  ['Target.attachedToTarget', 'attached'],
  ['Target.targetDestroyed', 'destroyed'],
  ['Target.detachedFromTarget', 'detached'],
  ['Target.targetCrashed', 'crashed'],
])

type Kind = 'S' | 'A' | 'E'
type Extra = Record<string, string | number | boolean>
/** 一条消息的轻量记录：t 是相对安装时刻的整毫秒，k 是发出（S）、回复（A）或事件（E） */
interface Light {
  t: number
  k: Kind
  m: string
  id?: number
  s?: string
  tt?: string
  code?: number
  ms?: number
}
type CloseEvent = Light & Extra
interface Pending { method: string, at: number, session: string }
interface SessionInfo { targetId?: string, type?: string, context?: string }
type TargetState = Partial<Record<TargetMoment, number>> & { type?: string, context?: string, crashStatus?: string }
interface ContextState { created?: number, disposeSent?: number, disposeDone?: number, disposeId?: number, disposeLatencyMs?: number, disposeError?: string, pendingAtDispose?: PendingItem[] }
interface PendingItem { id: number, method: string, waitedMs: number, s?: string, tt?: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function short(value: unknown): string | undefined {
  return typeof value === 'string' && HEX.test(value) ? value.slice(0, 8) : undefined
}
function word(value: unknown): string | undefined {
  return typeof value === 'string' && WORD.test(value) ? value : undefined
}
function flag(params: Record<string, unknown>, key: string): boolean | undefined {
  const value = params[key]
  return typeof value === 'boolean' ? value : undefined
}
/** 只留可打印 ASCII，截到 160 个字符：错误文字之外的内容一律不留 */
function ascii(value: unknown): string | undefined {
  if (typeof value !== 'string')
    return undefined
  return [...value.slice(0, MAX_TEXT)].map(char => char >= ' ' && char <= '~' ? char : '?').join('')
}
function compact(value: Record<string, string | number | boolean | undefined>): Extra {
  const out: Extra = {}
  for (const [key, item] of Object.entries(value)) {
    if (item !== undefined)
      out[key] = item
  }
  return out
}
function integer(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined
}
function text(extra: Extra, key: string): string | undefined {
  const value = extra[key]
  return typeof value === 'string' ? value : undefined
}

function commandExtra(method: string, params: unknown): Extra {
  if (!isRecord(params))
    return {}
  switch (method) {
    case 'Target.createTarget':
      return compact({ context: short(params.browserContextId), newWindow: flag(params, 'newWindow'), background: flag(params, 'background') })
    case 'Target.disposeBrowserContext':
      return compact({ context: short(params.browserContextId) })
    case 'Target.closeTarget':
    case 'Target.attachToTarget':
      return compact({ targetId: short(params.targetId) })
    case 'Target.detachFromTarget':
      return compact({ session: short(params.sessionId) })
    case 'Page.handleJavaScriptDialog':
      return compact({ accept: flag(params, 'accept') })
    case 'Page.captureScreenshot':
      return compact({ format: word(params.format), beyondViewport: flag(params, 'captureBeyondViewport') })
    default:
      return {}
  }
}

function targetInfo(info: unknown): Extra {
  if (!isRecord(info))
    return {}
  return compact({ targetId: short(info.targetId), type: word(info.type), context: short(info.browserContextId), attached: flag(info, 'attached'), opener: short(info.openerId) })
}

function eventExtra(method: string, params: unknown): Extra {
  if (!isRecord(params))
    return {}
  switch (method) {
    case 'Target.targetCreated':
      return targetInfo(params.targetInfo)
    case 'Target.attachedToTarget':
      return { ...targetInfo(params.targetInfo), ...compact({ session: short(params.sessionId), waiting: flag(params, 'waitingForDebugger') }) }
    case 'Target.targetDestroyed':
      return compact({ targetId: short(params.targetId) })
    case 'Target.targetCrashed':
      return compact({ targetId: short(params.targetId), status: word(params.status), errorCode: integer(params.errorCode) })
    case 'Target.detachedFromTarget':
      return compact({ session: short(params.sessionId), targetId: short(params.targetId) })
    case 'Inspector.detached':
      return compact({ reason: word(params.reason) })
    case 'Page.javascriptDialogOpening':
      return compact({ type: word(params.type), hasBrowserHandler: flag(params, 'hasBrowserHandler') })
    case 'Page.javascriptDialogClosed':
      return compact({ result: flag(params, 'result') })
    default:
      return {}
  }
}

function answerExtra(method: string, value: unknown): Extra {
  if (!isRecord(value))
    return {}
  if (value.error !== undefined) {
    const error = value.error
    return isRecord(error) ? compact({ errorCode: integer(error.code), error: ascii(error.message) }) : { error: 'unparsed' }
  }
  const result = value.result
  if (!isRecord(result))
    return {}
  switch (method) {
    case 'Target.createBrowserContext':
      return compact({ context: short(result.browserContextId) })
    case 'Target.createTarget':
      return compact({ targetId: short(result.targetId) })
    case 'Target.attachToTarget':
      return compact({ session: short(result.sessionId) })
    case 'Target.closeTarget':
      return compact({ success: flag(result, 'success') })
    default:
      return {}
  }
}

/** 过滤器的快照：所有时刻都是相对安装时刻的整毫秒 */
export interface ProtocolSnapshot {
  messages: number
  ignored: number
  unparsed: number
  unparsedBodies: number
  errors: number
  closeStartedT: number | null
  nowT: number
  contexts: Record<string, unknown>[]
  contextsDropped: number
  targets: Record<string, unknown>[]
  targetsDropped: number
  pending: PendingItem[]
  pendingTotal: number
  closeEvents: CloseEvent[]
  closeEventsDropped: number
  /** 关闭开始之前的最后 100 条（还没开始关闭时就是最近的 100 条） */
  preClose: Light[]
  /** 关闭开始之后的前 600 条 */
  postClose: Light[]
  postCloseDropped: number
  methods: Record<string, number>
  methodsOther: number
}

/** 纯过滤器：只认 Playwright 协议日志的一行（"SEND ► {…}" 或 "◀ RECV {…}"），不保存原文。 */
export class CloseProtocolFilter {
  readonly base: number
  messages = 0
  ignored = 0
  unparsed = 0
  unparsedBodies = 0
  errors = 0
  private closeAt: number | undefined
  private readonly pending = new Map<number, Pending>()
  private readonly sessions = new Map<string, SessionInfo>()
  private readonly targets = new Map<string, TargetState>()
  private readonly targetContext = new Map<string, string>()
  private readonly contexts = new Map<string, ContextState>()
  private contextsDropped = 0
  private targetsDropped = 0
  private readonly closeEvents: CloseEvent[] = []
  private closeEventsDropped = 0
  private ring: Light[] = []
  private readonly post: Light[] = []
  private postDropped = 0
  private readonly methods = new Map<string, number>()

  constructor(base = performance.now()) {
    this.base = base
  }

  feed(message: string, now = performance.now()): void {
    this.messages++
    try {
      const send = message.startsWith(SEND)
      if (!send && !message.startsWith(RECV)) {
        this.ignored++
        return
      }
      this.handle(send, message.slice(send ? SEND.length : RECV.length), now)
    }
    catch {
      this.errors++
    }
  }

  closeStarted(now = performance.now()): void {
    this.closeAt ??= now
  }

  snapshot(now = performance.now()): ProtocolSnapshot {
    const rel = (at: number | undefined) => at === undefined ? undefined : Math.round(at - this.base)
    const sorted = [...this.methods.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    const methods: Record<string, number> = {}
    let methodsOther = 0
    for (const [index, [name, count]] of sorted.entries()) {
      if (index < MAX_METHODS)
        methods[name] = count
      else
        methodsOther += count
    }
    const pending = this.pendingList(now)
    const contexts: Record<string, unknown>[] = []
    for (const [id, state] of this.contexts) {
      const item: Record<string, unknown> = compact({
        id,
        createdT: rel(state.created),
        disposeSentT: rel(state.disposeSent),
        disposeDoneT: rel(state.disposeDone),
        disposeLatencyMs: state.disposeLatencyMs,
        disposeError: state.disposeError,
        disposeWaitingMs: state.disposeSent !== undefined && state.disposeDone === undefined ? Math.round(now - state.disposeSent) : undefined,
      })
      if (state.pendingAtDispose !== undefined)
        item.pendingAtDispose = state.pendingAtDispose
      contexts.push(item)
    }
    return {
      messages: this.messages,
      ignored: this.ignored,
      unparsed: this.unparsed,
      unparsedBodies: this.unparsedBodies,
      errors: this.errors,
      closeStartedT: this.closeAt === undefined ? null : Math.round(this.closeAt - this.base),
      nowT: Math.round(now - this.base),
      contexts,
      contextsDropped: this.contextsDropped,
      targetsDropped: this.targetsDropped,
      targets: [...this.targets].map(([id, state]) => compact({
        id,
        type: state.type,
        context: state.context,
        createdT: rel(state.created),
        attachedT: rel(state.attached),
        detachedT: rel(state.detached),
        destroyedT: rel(state.destroyed),
        crashedT: rel(state.crashed),
        crashStatus: state.crashStatus,
      })),
      pending: pending.slice(0, MAX_PENDING_LISTED),
      pendingTotal: pending.length,
      closeEvents: [...this.closeEvents],
      closeEventsDropped: this.closeEventsDropped,
      preClose: [...this.ring],
      postClose: [...this.post],
      postCloseDropped: this.postDropped,
      methods,
      methodsOther,
    }
  }

  private handle(send: boolean, body: string, now: number): void {
    const head = body.slice(0, HEAD_CHARS)
    const idText = HEAD_ID.exec(head)?.[1]
    const ident = idText === undefined ? undefined : Number(idText)
    const method = (send ? SEND_METHOD : EVENT_METHOD).exec(head)?.[1]
    const session = TAIL_SESSION.exec(body.slice(-TAIL_CHARS))?.[1] ?? ''
    if (send) {
      if (ident === undefined || method === undefined) {
        this.unparsed++
        return
      }
      this.onSend(now, ident, method, session, CLOSE_COMMANDS.has(method) ? this.parse(body) : undefined)
    }
    else if (ident !== undefined && method === undefined) {
      this.onAnswer(now, ident, session, head, body)
    }
    else if (method !== undefined) {
      this.onEvent(now, method, session, CLOSE_EVENTS.has(method) ? this.parse(body) : undefined)
    }
    else {
      this.unparsed++
    }
  }

  /** 整体解析：截断或超长的不解析（只计数）；解析结果只经白名单函数取字段 */
  private parse(body: string): Record<string, unknown> | undefined {
    if (body.includes(TRUNCATED) || body.length > PARSE_LIMIT) {
      this.unparsedBodies++
      return undefined
    }
    try {
      const value: unknown = JSON.parse(body)
      return isRecord(value) ? value : undefined
    }
    catch {
      this.unparsedBodies++
      return undefined
    }
  }

  private count(name: string): void {
    this.methods.set(name, (this.methods.get(name) ?? 0) + 1)
  }

  private light(record: Light): void {
    if (this.closeAt === undefined) {
      this.ring.push(record)
      if (this.ring.length > PRE_CLOSE)
        this.ring = this.ring.slice(-PRE_CLOSE)
    }
    else if (this.post.length < MAX_POST_CLOSE) {
      this.post.push(record)
    }
    else {
      this.postDropped++
    }
  }

  private closeEvent(record: Light, extra: Extra): void {
    if (this.closeEvents.length >= MAX_CLOSE_EVENTS) {
      this.closeEventsDropped++
      return
    }
    this.closeEvents.push({ ...extra, ...record })
  }

  private record(now: number, k: Kind, m: string, session: string, more: { id?: number, code?: number, ms?: number } = {}): Light {
    const record: Light = { t: Math.round(now - this.base), k, m }
    if (more.id !== undefined)
      record.id = more.id
    const s = short(session)
    if (s !== undefined)
      record.s = s
    const tt = this.sessions.get(session)?.type
    if (tt !== undefined)
      record.tt = tt
    if (more.code !== undefined)
      record.code = more.code
    if (more.ms !== undefined)
      record.ms = more.ms
    return record
  }

  private pendingList(now: number, exclude?: number): PendingItem[] {
    const items: PendingItem[] = []
    for (const [id, entry] of [...this.pending].sort((a, b) => a[0] - b[0])) {
      if (id === exclude)
        continue
      const item: PendingItem = { id, method: entry.method, waitedMs: Math.round(now - entry.at) }
      const s = short(entry.session)
      if (s !== undefined)
        item.s = s
      const tt = this.sessions.get(entry.session)?.type
      if (tt !== undefined)
        item.tt = tt
      items.push(item)
    }
    return items
  }

  /** 超过上限的新 context 只计数，返回不保存的空状态 */
  private contextOf(name: string): ContextState {
    let state = this.contexts.get(name)
    if (state === undefined) {
      state = {}
      if (this.contexts.size < MAX_CONTEXTS)
        this.contexts.set(name, state)
      else
        this.contextsDropped++
    }
    return state
  }

  private onSend(now: number, ident: number, method: string, session: string, value: Record<string, unknown> | undefined): void {
    this.count(`send ${method}`)
    if (this.pending.size >= MAX_PENDING_TRACKED)
      this.pending.delete(Math.min(...this.pending.keys()))
    this.pending.set(ident, { method, at: now, session })
    const record = this.record(now, 'S', method, session, { id: ident })
    this.light(record)
    if (!CLOSE_COMMANDS.has(method))
      return
    const extra = commandExtra(method, value?.params)
    this.closeEvent(record, extra)
    const context = text(extra, 'context')
    if (method === 'Target.disposeBrowserContext' && context !== undefined) {
      const state = this.contextOf(context)
      state.disposeSent = now
      state.disposeId = ident
      state.pendingAtDispose = this.pendingList(now, ident).slice(0, MAX_PENDING_LISTED)
    }
  }

  private onAnswer(now: number, ident: number, session: string, head: string, body: string): void {
    const entry = this.pending.get(ident)
    this.pending.delete(ident)
    const method = entry?.method
    const errorHead = ERROR_HEAD.exec(head)
    const isError = errorHead !== null
    const code = !isError ? undefined : errorHead[1] === undefined ? 1 : Number(errorHead[1])
    this.count(`answer ${method ?? '?'}${isError ? ' (error)' : ''}`)
    const latency = entry === undefined ? undefined : Math.round(now - entry.at)
    const record = this.record(now, 'A', method ?? '?', session, { id: ident, code, ms: latency })
    this.light(record)
    if (method === undefined || !CLOSE_COMMANDS.has(method))
      return
    // 成功的截图回复带着整张图，不解析；错误回复很短，取错误码与截短的文字
    const extra = method === 'Page.captureScreenshot' && !isError ? {} : answerExtra(method, this.parse(body))
    this.closeEvent(record, extra)
    const context = text(extra, 'context')
    if (method === 'Target.createBrowserContext' && context !== undefined)
      this.contextOf(context).created = now
    if (method === 'Target.disposeBrowserContext') {
      for (const state of this.contexts.values()) {
        if (state.disposeId === ident && state.disposeDone === undefined) {
          state.disposeDone = now
          state.disposeLatencyMs = latency
          const error = text(extra, 'error')
          if (error !== undefined)
            state.disposeError = error
          break
        }
      }
    }
  }

  private onEvent(now: number, method: string, session: string, value: Record<string, unknown> | undefined): void {
    this.count(`event ${method}`)
    const record = this.record(now, 'E', method, session)
    this.light(record)
    if (!CLOSE_EVENTS.has(method))
      return
    const params = value?.params
    const extra = eventExtra(method, params)
    const targetId = text(extra, 'targetId')
    if (method === 'Target.attachedToTarget' && isRecord(params) && typeof params.sessionId === 'string' && HEX.test(params.sessionId) && this.sessions.size < MAX_SESSIONS) {
      const info: SessionInfo = {}
      if (targetId !== undefined)
        info.targetId = targetId
      const type = text(extra, 'type')
      if (type !== undefined)
        info.type = type
      const owner = text(extra, 'context')
      if (owner !== undefined)
        info.context = owner
      this.sessions.set(params.sessionId, info)
    }
    this.closeEvent(record, extra)
    let context = text(extra, 'context')
    if (targetId !== undefined && context !== undefined)
      this.targetContext.set(targetId, context)
    context ??= (targetId === undefined ? undefined : this.targetContext.get(targetId)) ?? this.sessions.get(session)?.context
    if (targetId !== undefined) {
      let target = this.targets.get(targetId)
      if (target === undefined) {
        target = {}
        if (this.targets.size < MAX_TARGETS)
          this.targets.set(targetId, target)
        else
          this.targetsDropped++
      }
      const type = text(extra, 'type')
      if (type !== undefined)
        target.type = type
      if (context !== undefined)
        target.context = context
      const moment = TARGET_MOMENTS.get(method)
      if (moment !== undefined && target[moment] === undefined)
        target[moment] = now
      const status = text(extra, 'status')
      if (method === 'Target.targetCrashed' && status !== undefined)
        target.crashStatus = status
    }
    if (context !== undefined)
      this.contextOf(context)
  }
}

/** 已接上的协议日志；release 只撤销自己装上的方法，可重复调用 */
export interface ProtocolTap { readonly release: () => void }
/** 接上协议日志：成功返回 ProtocolTap，否则返回固定原因（不抛错） */
export type ProtocolTapFactory = (onMessage: (message: string) => void) => ProtocolTap | string

interface DebugLoggerShape {
  isEnabled: (name: string) => boolean
  log: (name: string, message: string) => void
}

function isDebugLogger(value: unknown): value is DebugLoggerShape {
  return typeof value === 'object' && value !== null
    && typeof (value as Partial<DebugLoggerShape>).isEnabled === 'function'
    && typeof (value as Partial<DebugLoggerShape>).log === 'function'
}

let tapped = false

function restore(target: DebugLoggerShape, key: keyof DebugLoggerShape, ours: unknown, wasOwn: boolean, original: unknown): void {
  if (target[key] !== ours)
    return
  if (wasOwn)
    Reflect.set(target, key, original)
  else
    Reflect.deleteProperty(target, key)
}

/** 在给定的日志对象上接协议日志：只拦 protocol，其余名字原样交还；同一进程同时只接一处 */
export function tapLogger(logger: unknown, onMessage: (message: string) => void): ProtocolTap | string {
  if (!isDebugLogger(logger))
    return 'logger-unavailable'
  if (tapped)
    return 'tap-busy'
  const target = logger
  if (target.isEnabled('protocol'))
    return 'protocol-log-enabled-elsewhere'
  const ownIsEnabled = Object.hasOwn(target, 'isEnabled')
  const ownLog = Object.hasOwn(target, 'log')
  // 保存原方法，以 call 原 this 调用并原样恢复，不预先绑定
  const originalIsEnabled = target.isEnabled
  const originalLog = target.log
  const isEnabled = (name: string): boolean => name === 'protocol' || originalIsEnabled.call(target, name)
  const log = (name: string, message: string): void => {
    if (name !== 'protocol') {
      originalLog.call(target, name, message)
      return
    }
    try {
      onMessage(message)
    }
    catch { /* 过滤器自己计数异常；不能影响 Playwright 的收发 */ }
  }
  target.isEnabled = isEnabled
  target.log = log
  tapped = true
  let released = false
  return {
    release: () => {
      if (released)
        return
      released = true
      tapped = false
      restore(target, 'isEnabled', isEnabled, ownIsEnabled, originalIsEnabled)
      restore(target, 'log', log, ownLog, originalLog)
    },
  }
}

/**
 * 运行中的 Playwright 的日志对象：从 Node 的模块缓存里取这个进程已经加载的 playwright-core（只能恰好一份），版本从它旁边的
 * package.json 核对；不另行解析或加载，取到的就是测试运行器正在用的实例。支持文件按 ESM 或 CommonJS 编译都一样。
 */
export function tapPlaywrightProtocol(onMessage: (message: string) => void): ProtocolTap | string {
  let logger: unknown
  try {
    const cache = createRequire(join(process.cwd(), 'context-close-protocol.cjs')).cache
    const loaded = Object.keys(cache).filter(path => path.endsWith(CORE_BUNDLE))
    if (loaded.length !== 1)
      return loaded.length === 0 ? 'core-unavailable' : 'core-ambiguous'
    const path = loaded[0] ?? ''
    const pkg: unknown = JSON.parse(readFileSync(join(dirname(dirname(path)), 'package.json'), 'utf8'))
    if (!isRecord(pkg) || pkg.name !== 'playwright-core' || pkg.version !== PROTOCOL_CORE_VERSION)
      return 'unsupported-version'
    const core: unknown = cache[path]?.exports
    logger = isRecord(core) && isRecord(core.utils) ? core.utils.debugLogger : undefined
  }
  catch {
    return 'core-unavailable'
  }
  return tapLogger(logger, onMessage)
}

/** 让快照不超过上限：依次减半关闭后的序列、关闭前的序列、关闭相关的记录与等待中的命令；返回是否裁剪过 */
export function fitSnapshot(build: (snapshot: ProtocolSnapshot) => string, snapshot: ProtocolSnapshot, maxBytes: number): { text: string, trimmed: boolean } {
  let output = build(snapshot)
  let trimmed = false
  const lists = ['postClose', 'preClose', 'closeEvents', 'pending'] as const
  for (let round = 0; Buffer.byteLength(output) > maxBytes && round < 80; round++) {
    const list = lists.find(name => snapshot[name].length > 0)
    if (list === undefined)
      break
    snapshot[list].splice(Math.floor(snapshot[list].length / 2))
    trimmed = true
    output = build(snapshot)
  }
  return { text: output, trimmed }
}

/** 记录器的对外接口：关闭开始时由关闭阶段记录器通知 */
export interface CloseProtocolRecorder { readonly closeStarted: () => void }
type State = 'recording' | 'closing' | 'closed' | 'disconnected' | 'stopped'

/**
 * 为固定用例的一个 attempt 开始记录：独占创建 context-close-protocol.json 并登记附件，接上协议日志；context 关闭、浏览器断连
 * 或到兜底时限即释放并写下最终快照。失败只登记固定原因的注解，不影响原关闭。
 */
export function startCloseProtocolRecorder(context: BrowserContext, testInfo: TestInfo, owner: object, tap: ProtocolTapFactory): CloseProtocolRecorder | undefined {
  let annotated = false
  const incomplete = (description: string): void => {
    if (annotated)
      return
    annotated = true
    try {
      testInfo.annotations.push({ type: PROTOCOL_INCOMPLETE, description })
    }
    catch { /* 缺少完整终态同样拒绝诊断接受。 */ }
  }
  let write: (text: string) => void
  try {
    write = createExclusiveReport(testInfo, PROTOCOL_FILE, PROTOCOL_MAX_BYTES, PROTOCOL_ATTACHMENT)
  }
  catch {
    incomplete('report-unavailable')
    return undefined
  }
  const filter = new CloseProtocolFilter()
  const reasons = new Set<string>()
  const timers: ReturnType<typeof setTimeout>[] = []
  let state: State = 'recording'
  let finished = false
  let writable = true
  let trimmed = false
  let handle: ProtocolTap | undefined
  const browser = context.browser()

  const save = (): void => {
    if (!writable)
      return
    try {
      const snapshot = filter.snapshot()
      if (snapshot.errors > 0)
        reasons.add('filter-errors')
      const build = (value: ProtocolSnapshot) => JSON.stringify({
        version: 1,
        owner,
        coreVersion: PROTOCOL_CORE_VERSION,
        state,
        incomplete: state !== 'closed' || reasons.size > 0,
        reasons: [...reasons].sort(),
        trimmed,
        ...value,
      })
      const fitted = fitSnapshot(build, snapshot, PROTOCOL_MAX_BYTES - HEADROOM_BYTES)
      if (fitted.trimmed && !trimmed) {
        trimmed = true
        write(build(snapshot))
        return
      }
      write(fitted.text)
    }
    catch {
      writable = false
      reasons.add('report-unavailable')
      incomplete('report-unavailable')
    }
  }
  function onClose(): void {
    finish('closed')
  }
  function onDisconnect(): void {
    finish('disconnected')
  }
  function finish(next: State): void {
    if (finished)
      return
    finished = true
    handle?.release()
    handle = undefined
    for (const timer of timers.splice(0))
      clearTimeout(timer)
    try {
      context.off('close', onClose)
      browser?.off('disconnected', onDisconnect)
    }
    catch { reasons.add('listener-release-unavailable') }
    state = next
    save()
    if (state !== 'closed')
      incomplete(state)
    else if (reasons.size > 0)
      incomplete([...reasons].sort().join(','))
  }

  const result = tap((message) => {
    filter.feed(message)
    if (filter.errors >= MAX_FILTER_ERRORS && !finished) {
      reasons.add('filter-errors')
      finish('stopped')
    }
  })
  if (typeof result === 'string') {
    reasons.add(result)
    state = 'stopped'
    finished = true
    save()
    incomplete(result)
    return undefined
  }
  handle = result
  try {
    context.on('close', onClose)
    browser?.on('disconnected', onDisconnect)
  }
  catch {
    reasons.add('listener-unavailable')
    finish('stopped')
    return undefined
  }
  const cap = setTimeout(() => {
    reasons.add('time-limit')
    finish('stopped')
  }, MAX_RECORDING_MS)
  cap.unref()
  timers.push(cap)
  save()
  return {
    closeStarted: () => {
      if (finished || state !== 'recording')
        return
      filter.closeStarted()
      state = 'closing'
      save()
      for (const delay of CHECKPOINTS_MS) {
        const timer = setTimeout(() => {
          if (!finished)
            save()
        }, delay)
        timer.unref()
        timers.push(timer)
      }
    },
  }
}

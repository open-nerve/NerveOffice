// 协议记录的 KiB 级验证：合成的协议日志行、假的日志对象与浏览器边界；另核对运行中的 playwright-core 的日志对象接得上、撤得掉。
import type { BrowserContext, TestInfo } from '@playwright/test'
import type { ProtocolSnapshot, ProtocolTapFactory } from './context-close-protocol.ts'
import { Buffer } from 'node:buffer'
import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CloseProtocolFilter, fitSnapshot, PROTOCOL_CORE_VERSION, PROTOCOL_FILE, PROTOCOL_INCOMPLETE, PROTOCOL_MAX_BYTES, startCloseProtocolRecorder, tapLogger, tapPlaywrightProtocol } from './context-close-protocol.ts'

const CTX = `AAAAAAAA${'0'.repeat(24)}`
const OTHER_CTX = `BBBBBBBB${'0'.repeat(24)}`
const PAGE = `77777777${'0'.repeat(24)}`
const SESSION = `55555555${'0'.repeat(24)}`
const BIG_PAGE = `99999999${'0'.repeat(24)}`
const BIG_SESSION = `66666666${'0'.repeat(24)}`
const send = (value: object) => `SEND ► ${JSON.stringify(value)}`
const recv = (value: object) => `◀ RECV ${JSON.stringify(value)}`
const TRUNCATED = ' <<<<<( LOG TRUNCATED )>>>>> '

/** 按 Playwright 的键序（发出：id、method、params、sessionId；收到：照浏览器的原样）写的一段关闭卡住的协议日志，参数里放满不该留下的内容 */
function stalledClose(filter: CloseProtocolFilter): void {
  let now = 1_000
  const at = () => (now += 5)
  filter.feed(send({ id: 10, method: 'Target.createTarget', params: { url: 'about:blank#SECRET_URL', browserContextId: CTX } }), at())
  filter.feed(recv({ method: 'Target.attachedToTarget', params: { sessionId: SESSION, targetInfo: { targetId: PAGE, type: 'page', title: 'SECRET_TITLE', url: 'http://127.0.0.1/SECRET_PATH', attached: true, browserContextId: CTX }, waitingForDebugger: true } }), at())
  filter.feed(recv({ id: 10, result: { targetId: PAGE } }), at())
  filter.feed(send({ id: 11, method: 'Storage.setCookies', params: { cookies: [{ name: 'sid', value: 'SECRET_COOKIE' }], browserContextId: CTX } }), at())
  filter.feed(recv({ id: 11, result: {} }), at())
  filter.feed(recv({ method: 'Network.requestWillBeSent', params: { request: { headers: { Cookie: 'sid=SECRET_COOKIE2' }, postData: 'password=SECRET_BODY' } }, sessionId: SESSION }), at())
  filter.feed(send({ id: 12, method: 'Runtime.callFunctionOn', params: { functionDeclaration: 'SECRET_FN' }, sessionId: SESSION }), at())
  filter.feed(recv({ method: 'Page.javascriptDialogOpening', params: { url: 'SECRET_DIALOG_URL', message: 'SECRET_DIALOG_MESSAGE', type: 'beforeunload', hasBrowserHandler: true, defaultPrompt: '' }, sessionId: SESSION }), at())
  // 超长的白名单事件不整体解析（只计数），会话与方法名照样认出
  filter.feed(recv({ method: 'Target.attachedToTarget', params: { sessionId: BIG_SESSION, targetInfo: { targetId: BIG_PAGE, type: 'page', title: `SECRET_${'x'.repeat(300 * 1024)}`, browserContextId: CTX } } }), at())
  filter.feed('garbage SECRET_GARBAGE', at())
  filter.feed('SEND ► not json SECRET_NOT_JSON', at())
  filter.closeStarted(at())
  filter.feed(send({ id: 13, method: 'Page.stopScreencast', sessionId: SESSION }), at())
  filter.feed(recv({ id: 13, result: {}, sessionId: SESSION }), at())
  filter.feed(send({ id: 14, method: 'Page.captureScreenshot', params: { format: 'png', clip: { x: 0, y: 0, width: 1280, height: 720, scale: 1 }, captureBeyondViewport: false }, sessionId: SESSION }), at())
  filter.feed(recv({ id: 14, error: { code: -32000, message: 'Unable to capture screenshot – é' }, sessionId: SESSION }), at())
  filter.feed(send({ id: 15, method: 'Target.disposeBrowserContext', params: { browserContextId: CTX } }), at())
  filter.feed(recv({ method: 'Page.screencastFrame', params: { data: `SECRET_FRAME${'A'.repeat(300 * 1024)}`, sessionId: 3 }, sessionId: SESSION }), at())
  const ack = JSON.stringify({ id: 16, method: 'Page.screencastFrameAck', params: { blob: `SECRET_LONG${'B'.repeat(9000)}` }, sessionId: SESSION })
  filter.feed(`SEND ► ${ack.slice(0, 3000)}${TRUNCATED}${ack.slice(-3000)}`, at())
  filter.feed(recv({ method: 'Inspector.detached', params: { reason: 'target_closed' }, sessionId: SESSION }), at())
  filter.feed(recv({ id: 99, error: { code: -32001, message: 'Session with given id not found.' }, sessionId: SESSION }), at())
}

describe('协议过滤器', () => {
  it('只留方法名、编号、时刻、目标类型与截短的标识；关闭卡住时认出等待中的命令', () => {
    const filter = new CloseProtocolFilter(1_000)
    stalledClose(filter)
    const snapshot = filter.snapshot(1_200)
    expect(JSON.stringify(snapshot)).not.toContain('SECRET')
    expect(snapshot).toMatchObject({ messages: 20, ignored: 1, unparsed: 1, unparsedBodies: 1, errors: 0, closeStartedT: 60, nowT: 200, contextsDropped: 0, targetsDropped: 0 })
    expect(snapshot.contexts).toEqual([{
      id: 'AAAAAAAA',
      disposeSentT: 85,
      disposeWaitingMs: 115,
      pendingAtDispose: [{ id: 12, method: 'Runtime.callFunctionOn', waitedMs: 50, s: '55555555', tt: 'page' }],
    }])
    expect(snapshot.targets).toEqual([
      { id: '77777777', type: 'page', context: 'AAAAAAAA', attachedT: 10 },
    ])
    expect(snapshot.pending.map(item => [item.id, item.method])).toEqual([
      [12, 'Runtime.callFunctionOn'],
      [15, 'Target.disposeBrowserContext'],
      [16, 'Page.screencastFrameAck'],
    ])
    expect(snapshot.closeEvents.map(event => `${event.k} ${event.m}`)).toEqual([
      'S Target.createTarget',
      'E Target.attachedToTarget',
      'A Target.createTarget',
      'E Page.javascriptDialogOpening',
      'E Target.attachedToTarget',
      'S Page.stopScreencast',
      'A Page.stopScreencast',
      'S Page.captureScreenshot',
      'A Page.captureScreenshot',
      'S Target.disposeBrowserContext',
      'E Inspector.detached',
    ])
    expect(snapshot.closeEvents[3]).toMatchObject({ type: 'beforeunload', hasBrowserHandler: true, tt: 'page' })
    expect(snapshot.closeEvents[7]).toMatchObject({ format: 'png', beyondViewport: false, tt: 'page', id: 14 })
    expect(snapshot.closeEvents[8]).toMatchObject({ errorCode: -32000, error: 'Unable to capture screenshot ? ?', code: -32000, ms: 5 })
    expect(snapshot.preClose.map(item => item.m)).toContain('Storage.setCookies')
    expect(snapshot.postClose.map(item => `${item.k} ${item.m}`)).toEqual([
      'S Page.stopScreencast',
      'A Page.stopScreencast',
      'S Page.captureScreenshot',
      'A Page.captureScreenshot',
      'S Target.disposeBrowserContext',
      'E Page.screencastFrame',
      'S Page.screencastFrameAck',
      'E Inspector.detached',
      'A ?',
    ])
    expect(snapshot.methods).toMatchObject({
      'send Storage.setCookies': 1,
      'event Network.requestWillBeSent': 1,
      'event Page.screencastFrame': 1,
      'answer Page.captureScreenshot (error)': 1,
      'answer ? (error)': 1,
    })
  })

  it('关闭得到回复时记下用时与错误文字；成功的截图回复不解析', () => {
    const filter = new CloseProtocolFilter(0)
    filter.feed(send({ id: 1, method: 'Target.createBrowserContext', params: {} }), 1)
    filter.feed(recv({ id: 1, result: { browserContextId: CTX } }), 3)
    filter.closeStarted(10)
    filter.feed(send({ id: 2, method: 'Page.captureScreenshot', params: { format: 'png' }, sessionId: SESSION }), 11)
    filter.feed(recv({ id: 2, result: { data: `SECRET_IMAGE${'C'.repeat(400 * 1024)}` }, sessionId: SESSION }), 60)
    filter.feed(send({ id: 3, method: 'Target.disposeBrowserContext', params: { browserContextId: CTX } }), 70)
    filter.feed(recv({ id: 3, error: { code: -32000, message: 'Failed to find context' } }), 79)
    const snapshot = filter.snapshot(100)
    expect(JSON.stringify(snapshot)).not.toContain('SECRET')
    expect(snapshot.contexts).toEqual([{ id: 'AAAAAAAA', createdT: 3, disposeSentT: 70, disposeDoneT: 79, disposeLatencyMs: 9, disposeError: 'Failed to find context', pendingAtDispose: [] }])
    expect(snapshot.closeEvents.find(event => event.k === 'A' && event.m === 'Page.captureScreenshot')).toMatchObject({ ms: 49 })
    expect(snapshot.unparsedBodies).toBe(0)
    expect(snapshot.pending).toEqual([])
  })

  it('平稳关浏览器的 Browser.close 不经日志发出，只有回复（编号 -9999）进日志：认作 Browser.close 的回复，不计为未解析', () => {
    const filter = new CloseProtocolFilter(0)
    filter.closeStarted(10)
    filter.feed(recv({ id: -9999, result: {} }), 20)
    const snapshot = filter.snapshot(30)
    expect(snapshot.unparsed).toBe(0)
    expect(snapshot.closeEvents).toEqual([{ t: 20, k: 'A', m: 'Browser.close', id: -9999 }])
    expect(snapshot.methods).toEqual({ 'answer Browser.close': 1 })
    expect(snapshot.postClose).toEqual([{ t: 20, k: 'A', m: 'Browser.close', id: -9999 }])
  })

  it('关闭开始之后发出的 dispose 都得到回复（没有错误）才算完成；关闭开始之前别的 context 的不算', () => {
    const filter = new CloseProtocolFilter(0)
    expect(filter.disposeOutcome()).toBe('close-not-started')
    filter.feed(send({ id: 1, method: 'Target.disposeBrowserContext', params: { browserContextId: OTHER_CTX } }), 1)
    filter.feed(recv({ id: 1, result: {} }), 2)
    filter.closeStarted(10)
    expect(filter.disposeOutcome()).toBe('dispose-not-sent')
    filter.feed(send({ id: 2, method: 'Target.disposeBrowserContext', params: { browserContextId: CTX } }), 11)
    expect(filter.disposeOutcome()).toBe('dispose-unanswered')
    filter.feed(recv({ id: 2, result: {} }), 14)
    expect(filter.disposeOutcome()).toBe('answered')

    const failed = new CloseProtocolFilter(0)
    failed.closeStarted(0)
    failed.feed(send({ id: 3, method: 'Target.disposeBrowserContext', params: { browserContextId: CTX } }), 1)
    failed.feed(recv({ id: 3, error: { code: -32000, message: 'Failed to find context' } }), 2)
    expect(failed.disposeOutcome()).toBe('dispose-error')
  })

  it('各列表都有上限，超出只计数', () => {
    const letters = (value: number) => [...value.toString(26)].map(digit => String.fromCharCode(97 + Number.parseInt(digit, 26))).join('')
    const filter = new CloseProtocolFilter(0)
    for (let i = 0; i < 350; i++)
      filter.feed(recv({ method: 'Target.targetCreated', params: { targetInfo: { targetId: `${String(i).padStart(8, '0')}${'0'.repeat(24)}`, type: 'worker', browserContextId: CTX } } }), i)
    for (let i = 0; i < 350; i++)
      filter.feed(send({ id: 1_000 + i, method: `Domain.m${letters(i)}` }), 400)
    for (let i = 0; i < 60; i++)
      filter.feed(send({ id: 5_000 + i, method: 'Target.disposeBrowserContext', params: { browserContextId: `${String(i).padStart(8, '0')}${'1'.repeat(24)}` } }), 450)
    filter.closeStarted(500)
    for (let i = 0; i < 700; i++)
      filter.feed(recv({ method: 'Runtime.consoleAPICalled', params: { args: ['SECRET'] }, sessionId: SESSION }), 600)
    const snapshot = filter.snapshot(700)
    expect(snapshot.unparsed).toBe(0)
    expect(snapshot.closeEvents).toHaveLength(300)
    expect(snapshot.closeEventsDropped).toBe(110)
    // 超出时丢最早的：离关闭最近的（最后一个 dispose）留下
    expect(snapshot.closeEvents.at(-1)).toMatchObject({ k: 'S', m: 'Target.disposeBrowserContext', id: 5_059 })
    expect(snapshot.targets).toHaveLength(200)
    expect(snapshot.targetsDropped).toBe(150)
    // 第一个 context 来自 targetCreated，关闭命令又带来 60 个：留到 50 个，其余 11 个只计数
    expect(snapshot.contexts).toHaveLength(50)
    expect(snapshot.contextsDropped).toBe(11)
    expect(snapshot.preClose).toHaveLength(100)
    expect(snapshot.postClose).toHaveLength(600)
    expect(snapshot.postCloseDropped).toBe(100)
    // 350 个不同的发出、1 个关闭命令、2 个事件：留次数最多的 300 个，其余 53 个各 1 次
    expect(Object.keys(snapshot.methods)).toHaveLength(300)
    expect(snapshot.methodsOther).toBe(53)
    expect(snapshot.pending).toHaveLength(50)
    expect(snapshot.pendingTotal).toBe(410)
  })

  it('快照超过上限时依次减半序列，最后不超过上限', () => {
    const filter = new CloseProtocolFilter(0)
    filter.closeStarted(0)
    for (let i = 0; i < 600; i++)
      filter.feed(send({ id: i + 1, method: 'Runtime.callFunctionOn', sessionId: SESSION }), i)
    const snapshot: ProtocolSnapshot = filter.snapshot(700)
    const build = (value: ProtocolSnapshot) => JSON.stringify(value)
    const fitted = fitSnapshot(build, snapshot, 16 * 1024)
    expect(fitted.trimmed).toBe(true)
    expect(Buffer.byteLength(fitted.text)).toBeLessThanOrEqual(16 * 1024)
    expect(fitSnapshot(build, filter.snapshot(700), PROTOCOL_MAX_BYTES).trimmed).toBe(false)
  })

  it('裁剪时关闭后的序列留开头，关闭前的序列留离关闭最近的结尾', () => {
    const filter = new CloseProtocolFilter(0)
    for (let i = 0; i < 100; i++)
      filter.feed(send({ id: i + 1, method: 'Runtime.callFunctionOn', sessionId: SESSION }), i)
    filter.closeStarted(100)
    for (let i = 0; i < 600; i++)
      filter.feed(send({ id: 1_000 + i, method: 'Runtime.callFunctionOn', sessionId: SESSION }), 100 + i)
    const build = (value: ProtocolSnapshot) => JSON.stringify(value)
    const partly = filter.snapshot(800)
    fitSnapshot(build, partly, 30 * 1024)
    expect(partly.postClose.length).toBeGreaterThan(0)
    expect(partly.postClose.length).toBeLessThan(600)
    expect(partly.postClose[0]).toMatchObject({ id: 1_000 })
    expect(partly.preClose).toHaveLength(100)
    const tight = filter.snapshot(800)
    fitSnapshot(build, tight, 8 * 1024)
    expect(tight.postClose).toEqual([])
    expect(tight.preClose.length).toBeGreaterThan(0)
    expect(tight.preClose.length).toBeLessThan(100)
    expect(tight.preClose.at(-1)).toMatchObject({ id: 100 })
  })
})

class FakeLogger {
  readonly logged: [string, string][] = []
  protocolOn = false
  isEnabled(name: string): boolean {
    return name === 'error' || (name === 'protocol' && this.protocolOn)
  }

  log(name: string, message: string): void {
    this.logged.push([name, message])
  }
}

describe('接上日志对象', () => {
  it('只拦 protocol，其余原样交还；撤销后恢复原型上的方法，同一进程同时只接一处', () => {
    const logger = new FakeLogger()
    const messages: string[] = []
    const tap = tapLogger(logger, (message) => {
      messages.push(message)
      if (message === 'boom')
        throw new Error('filter bug')
    })
    if (typeof tap === 'string')
      throw new Error(tap)
    expect(logger.isEnabled('protocol')).toBe(true)
    expect(logger.isEnabled('error')).toBe(true)
    expect(logger.isEnabled('api')).toBe(false)
    logger.log('protocol', 'one')
    expect(() => logger.log('protocol', 'boom')).not.toThrow()
    logger.log('error', 'kept')
    expect(messages).toEqual(['one', 'boom'])
    expect(logger.logged).toEqual([['error', 'kept']])
    expect(tapLogger(new FakeLogger(), () => {})).toBe('tap-busy')
    tap.release()
    tap.release()
    expect(Object.hasOwn(logger, 'isEnabled')).toBe(false)
    expect(Object.hasOwn(logger, 'log')).toBe(false)
    expect(logger.isEnabled('protocol')).toBe(false)
    logger.log('protocol', 'after')
    expect(messages).toEqual(['one', 'boom'])
    const again = tapLogger(logger, () => {})
    expect(typeof again).toBe('object')
    if (typeof again !== 'string')
      again.release()
  })

  it('自有属性形式的方法撤销后原样放回；已开协议日志或形状不符则不接', () => {
    const isEnabled = (name: string) => name === 'error'
    const log = () => {}
    const own = { isEnabled, log }
    const tap = tapLogger(own, () => {})
    if (typeof tap === 'string')
      throw new Error(tap)
    expect(own.isEnabled).not.toBe(isEnabled)
    tap.release()
    expect(own.isEnabled).toBe(isEnabled)
    expect(own.log).toBe(log)
    const enabled = new FakeLogger()
    enabled.protocolOn = true
    expect(tapLogger(enabled, () => {})).toBe('protocol-log-enabled-elsewhere')
    expect(Object.hasOwn(enabled, 'isEnabled')).toBe(false)
    expect(tapLogger({ isEnabled }, () => {})).toBe('logger-unavailable')
    expect(tapLogger(undefined, () => {})).toBe('logger-unavailable')
  })

  it('日志对象问不了或改不动时只回原因，不留下改了一半的方法', () => {
    const throwing = { isEnabled: () => {
      throw new Error('boom')
    }, log: () => {} }
    expect(tapLogger(throwing, () => {})).toBe('tap-failed')
    const frozen = Object.freeze({ isEnabled: (name: string) => name === 'error', log: () => {} })
    const original = frozen.isEnabled
    expect(tapLogger(frozen, () => {})).toBe('tap-failed')
    expect(frozen.isEnabled).toBe(original)
    // 没接上不占位：之后照样接得上
    const after = tapLogger(new FakeLogger(), () => {})
    expect(typeof after).toBe('object')
    if (typeof after !== 'string')
      after.release()
  })

  it('运行中的 playwright-core 是约定的版本，它的日志对象接得上、撤得掉', () => {
    const fromHere = createRequire(import.meta.url)
    const fromRunner = createRequire(createRequire(fromHere.resolve('@playwright/test/package.json')).resolve('playwright/package.json'))
    expect((fromRunner('playwright-core/package.json') as { version: string }).version).toBe(PROTOCOL_CORE_VERSION)
    const logger = (fromRunner('playwright-core/lib/coreBundle') as { utils: { debugLogger: { isEnabled: (name: string) => boolean, log: (name: string, message: string) => void } } }).utils.debugLogger
    expect(logger.isEnabled('protocol')).toBe(false)
    const messages: string[] = []
    const tap = tapPlaywrightProtocol(message => messages.push(message))
    if (typeof tap === 'string')
      throw new Error(tap)
    try {
      expect(logger.isEnabled('protocol')).toBe(true)
      logger.log('protocol', 'SEND ► {"id":1,"method":"Browser.getVersion"}')
      expect(messages).toEqual(['SEND ► {"id":1,"method":"Browser.getVersion"}'])
    }
    finally {
      tap.release()
    }
    expect(logger.isEnabled('protocol')).toBe(false)
  })
})

class FakeContext extends EventEmitter {
  readonly browserEvents = new EventEmitter()
  browser() { return this.browserEvents }
}

const roots: string[] = []
function attempt() {
  const dir = mkdtempSync(join(tmpdir(), 'nerve-close-protocol-'))
  roots.push(dir)
  const context = new FakeContext()
  const attachments: TestInfo['attachments'] = []
  const annotations: TestInfo['annotations'] = []
  const info = { project: { name: 'msedge', outputDir: dir }, outputPath: (name: string) => join(dir, name), attachments, annotations } as unknown as TestInfo
  const path = join(dir, PROTOCOL_FILE)
  let feed: (message: string) => void = () => {}
  let released = 0
  const tap = (onMessage: (message: string) => void) => {
    feed = onMessage
    return { release: () => {
      released++
    } }
  }
  return {
    context,
    info,
    path,
    attachments,
    annotations,
    tap,
    feed: (message: string) => feed(message),
    released: () => released,
    start: (factory: ProtocolTapFactory = tap) => startCloseProtocolRecorder(context as unknown as BrowserContext, info, { runId: 'run', project: 'msedge', retry: 0 }, factory),
    read: () => JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>,
  }
}

afterEach(() => {
  vi.useRealTimers()
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

describe('一个 attempt 的协议记录', () => {
  it('安装即独占落档并登记；context 关闭后释放、写下最终快照、撤掉监听', () => {
    const value = attempt()
    const recorder = value.start()
    expect(recorder).toBeDefined()
    expect(value.attachments).toEqual([{ name: 'context-close-protocol', path: value.path, contentType: 'application/json' }])
    expect(statSync(value.path).mode & 0o777).toBe(0o600)
    expect(value.read()).toMatchObject({ version: 1, state: 'recording', incomplete: true, coreVersion: PROTOCOL_CORE_VERSION, owner: { project: 'msedge' } })
    recorder?.closeStarted()
    expect(value.read()).toMatchObject({ state: 'closing' })
    value.feed(send({ id: 3, method: 'Target.disposeBrowserContext', params: { browserContextId: CTX } }))
    value.feed(recv({ id: 3, result: {} }))
    value.context.emit('close')
    expect(value.read()).toMatchObject({ state: 'closed', incomplete: false, reasons: [], trimmed: false })
    expect(value.released()).toBe(1)
    expect(value.context.listenerCount('close')).toBe(0)
    expect(value.context.browserEvents.listenerCount('disconnected')).toBe(0)
    expect(value.annotations).toEqual([])
  })

  it('关闭卡住之后浏览器被关掉：先到的 close 事件不算完整，按没有回复的 dispose 记原因', () => {
    vi.useFakeTimers()
    const value = attempt()
    const recorder = value.start()
    recorder?.closeStarted()
    value.feed(send({ id: 4, method: 'Target.disposeBrowserContext', params: { browserContextId: CTX } }))
    vi.advanceTimersByTime(200_000)
    expect(value.read()).toMatchObject({ state: 'closing', pending: [expect.objectContaining({ id: 4, method: 'Target.disposeBrowserContext' })] })
    // Playwright 关浏览器时先派发各 context 的 close，再派发断连（Browser.didClose）
    value.context.emit('close')
    value.context.browserEvents.emit('disconnected')
    const final = value.read()
    expect(final).toMatchObject({ state: 'closed', incomplete: true, reasons: ['dispose-unanswered'] })
    expect(final.contexts).toEqual([expect.objectContaining({ id: 'AAAAAAAA', disposeSentT: expect.any(Number) as unknown, disposeWaitingMs: expect.any(Number) as unknown })])
    expect((final.contexts as Record<string, unknown>[])[0]).not.toHaveProperty('disposeDoneT')
    expect(value.annotations).toEqual([{ type: PROTOCOL_INCOMPLETE, description: 'dispose-unanswered' }])
    expect(value.released()).toBe(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('没有开始关闭就收到 close 事件、或关闭之后没有看到 dispose，都记原因', () => {
    const early = attempt()
    early.start()
    early.context.emit('close')
    expect(early.read()).toMatchObject({ state: 'closed', incomplete: true, reasons: ['close-not-started'] })
    expect(early.annotations).toEqual([{ type: PROTOCOL_INCOMPLETE, description: 'close-not-started' }])

    const silent = attempt()
    silent.start()?.closeStarted()
    silent.context.emit('close')
    expect(silent.read()).toMatchObject({ state: 'closed', incomplete: true, reasons: ['dispose-not-sent'] })
  })

  it('关闭卡住时按时刻整份重写；浏览器先断连时写下断连状态并登记不完整', () => {
    vi.useFakeTimers()
    const value = attempt()
    const recorder = value.start()
    recorder?.closeStarted()
    value.feed(send({ id: 4, method: 'Target.disposeBrowserContext', params: { browserContextId: CTX } }))
    expect(value.read().postClose).toEqual([])
    vi.advanceTimersByTime(2_000)
    expect((value.read().postClose as unknown[]).length).toBe(1)
    expect(value.read().pending).toEqual([expect.objectContaining({ id: 4, method: 'Target.disposeBrowserContext' })])
    value.context.browserEvents.emit('disconnected')
    expect(value.read()).toMatchObject({ state: 'disconnected', incomplete: true })
    expect(value.annotations).toEqual([{ type: PROTOCOL_INCOMPLETE, description: 'disconnected' }])
    expect(value.released()).toBe(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('到兜底时限即释放', () => {
    vi.useFakeTimers()
    const value = attempt()
    value.start()
    vi.advanceTimersByTime(330_000)
    expect(value.read()).toMatchObject({ state: 'stopped', reasons: ['time-limit'] })
    expect(value.released()).toBe(1)
    expect(value.annotations).toEqual([{ type: PROTOCOL_INCOMPLETE, description: 'stopped' }])
  })

  it('接不上时写明原因、不返回记录器；报告文件已存在时不覆盖也不接', () => {
    const value = attempt()
    expect(value.start(() => 'core-unavailable')).toBeUndefined()
    expect(value.read()).toMatchObject({ state: 'stopped', incomplete: true, reasons: ['core-unavailable'], messages: 0 })
    expect(value.annotations).toEqual([{ type: PROTOCOL_INCOMPLETE, description: 'core-unavailable' }])

    const other = attempt()
    writeFileSync(other.path, 'existing evidence')
    let tapped = false
    expect(other.start(() => {
      tapped = true
      return { release: () => {} }
    })).toBeUndefined()
    expect(tapped).toBe(false)
    expect(readFileSync(other.path, 'utf8')).toBe('existing evidence')
    expect(other.annotations).toEqual([{ type: PROTOCOL_INCOMPLETE, description: 'report-unavailable' }])
    expect(existsSync(other.path)).toBe(true)

    // 接法自己抛错：只记原因，不传给用例
    const thrown = attempt()
    expect(thrown.start(() => {
      throw new Error('boom')
    })).toBeUndefined()
    expect(thrown.read()).toMatchObject({ state: 'stopped', incomplete: true, reasons: ['tap-failed'] })
    expect(thrown.annotations).toEqual([{ type: PROTOCOL_INCOMPLETE, description: 'tap-failed' }])
  })

  it('落下的文件不含任何参数值', () => {
    const value = attempt()
    const recorder = value.start()
    const filter = { feed: value.feed }
    stalledClose({ feed: (message: string) => filter.feed(message), closeStarted: () => recorder?.closeStarted() } as unknown as CloseProtocolFilter)
    value.context.browserEvents.emit('disconnected')
    const text = readFileSync(value.path, 'utf8')
    expect(text).not.toContain('SECRET')
    expect(JSON.parse(text)).toMatchObject({ state: 'disconnected', contexts: [expect.objectContaining({ id: 'AAAAAAAA' })] })
  })
})

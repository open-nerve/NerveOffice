import type { LocalKeyHandle } from '../../../shared/outbox/draft-codec.ts'
import type { DraftKey } from '../../../shared/outbox/draft-record.ts'
import type { FakeDraftStore } from '../../../shared/outbox/draft-store.test-support.ts'
import type { CaptureToWrite } from '../../../shared/outbox/draft-writer.ts'
import type { OutboxCallType, OutboxMessage } from './outbox-protocol.ts'
import type { OutboxWorkerClient, WorkerEventType, WorkerLike } from './outbox-worker-client.ts'
import { describe, expect, it } from 'vitest'
import { gunzipBytes, openDraft } from '../../../shared/outbox/draft-codec.ts'
import { CLIENT_INSTANCE_ID, DOCUMENT_ID, NOW, sampleMeta, USER_ID, WRITER_ID } from '../../../shared/outbox/draft-record.test-support.ts'
import { readStoredDraft } from '../../../shared/outbox/draft-record.ts'
import { fakeDraftStore } from '../../../shared/outbox/draft-store.test-support.ts'
import { fakeLeaseClock, settle } from '../fake-lease-clock.test-support.ts'
import { OUTBOX_PROTOCOL_VERSION } from './outbox-protocol.ts'
import { createOutboxWorkerClient, keyTransferOf } from './outbox-worker-client.ts'
import { createOutboxWorkerHandler } from './outbox-worker-handler.ts'

const DRAFT: DraftKey = { userId: USER_ID, documentId: DOCUMENT_ID }
const ME = { writeEpoch: 3, writerId: WRITER_ID }
const TIMEOUT_MS = 10_000

function utf8(text: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(text)
}

function textOf(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes)
}

function capture(draftSeq: number, content: string, overrides: Partial<CaptureToWrite> = {}): CaptureToWrite {
  return {
    key: DRAFT,
    writer: ME,
    draftSeq,
    baseRevision: 12,
    writtenBy: CLIENT_INSTANCE_ID,
    format: sampleMeta().format,
    formulasPending: false,
    inFlight: null,
    bytes: utf8(content),
    dedupe: true,
    ...overrides,
  }
}

async function localKey(version: number): Promise<LocalKeyHandle> {
  return { version, key: await crypto.subtle.importKey('raw', crypto.getRandomValues(new Uint8Array(32)), 'AES-GCM', false, ['encrypt', 'decrypt']) }
}

/** 按脚本回应的假 Worker：测试决定回什么、什么时候出错；postMessage 照真的结构化克隆（transfer 里的缓冲随之转移） */
class ScriptedWorker implements WorkerLike {
  readonly events = new EventTarget()
  readonly posted: { readonly message: Record<string, unknown>, readonly transfer: readonly Transferable[] }[] = []
  terminated = 0
  /** 下一次 postMessage 抛出它（克隆不了） */
  failNextPost: Error | undefined

  readonly postMessage = (message: unknown, transfer: Transferable[]): void => {
    const failure = this.failNextPost
    this.failNextPost = undefined
    if (failure !== undefined)
      throw failure
    this.posted.push({ message: structuredClone(message, { transfer }) as Record<string, unknown>, transfer })
  }

  /** 客户端挂着的监听个数（坏了之后应当都摘掉） */
  listeners = 0

  readonly addEventListener = (type: WorkerEventType, listener: (event: Event) => void): void => {
    this.listeners += 1
    this.events.addEventListener(type, listener)
  }

  readonly removeEventListener = (type: WorkerEventType, listener: (event: Event) => void): void => {
    this.listeners -= 1
    this.events.removeEventListener(type, listener)
  }

  readonly terminate = (): void => {
    this.terminated += 1
  }

  /** 最近一个这种请求的 id */
  idOf(type: OutboxCallType): number {
    const found = this.posted.findLast(entry => entry.message.type === type)
    if (found === undefined || typeof found.message.id !== 'number')
      throw new Error(`没有发出过 ${type}`)
    return found.message.id
  }

  emit(data: unknown): void {
    this.events.dispatchEvent(new MessageEvent('message', { data }))
  }

  reply(id: number, result: unknown): void {
    this.emit({ v: OUTBOX_PROTOCOL_VERSION, id, ok: true, result })
  }

  fail(type: 'error' | 'messageerror'): void {
    this.events.dispatchEvent(new Event(type))
  }
}

/** 客户端配脚本 Worker 与假时钟；握手已回 ready（ready: false 时不回） */
async function scripted(options: { readonly ready?: boolean, readonly keepAlive?: boolean } = {}) {
  const worker = new ScriptedWorker()
  const time = fakeLeaseClock()
  const client = createOutboxWorkerClient({ create: () => worker, clock: time.clock, requestTimeoutMs: TIMEOUT_MS, ...(options.keepAlive === undefined ? {} : { keepAlive: options.keepAlive }) })
  if (options.ready !== false) {
    worker.reply(worker.idOf('hello'), { kind: 'ready' })
    await expect(client.ready()).resolves.toEqual({ kind: 'ready' })
  }
  return { worker, time, client }
}

/** 客户端经结构化克隆连到 Worker 里真的处理（配假存储）：两边的消息异步送达，与真的 Worker 一样 */
function loopback(): { readonly client: OutboxWorkerClient, readonly fake: FakeDraftStore } {
  const events = new EventTarget()
  const fake = fakeDraftStore()
  const handler = createOutboxWorkerHandler({
    store: fake.store,
    now: () => NOW,
    post: (message: OutboxMessage, transfer: Transferable[]) => {
      const data = structuredClone(message, { transfer })
      setTimeout(() => events.dispatchEvent(new MessageEvent('message', { data })), 0)
    },
    stopKeepAlive: undefined,
  })
  const worker: WorkerLike = {
    postMessage: (message, transfer) => {
      const data = structuredClone(message, { transfer })
      setTimeout(() => void handler.receive(data), 0)
    },
    addEventListener: (type, listener) => events.addEventListener(type, listener),
    removeEventListener: (type, listener) => events.removeEventListener(type, listener),
    terminate: () => {},
  }
  return { client: createOutboxWorkerClient({ create: () => worker, clock: fakeLeaseClock().clock, requestTimeoutMs: TIMEOUT_MS }), fake }
}

describe('握手（M4-P1 设计 §3.4.8）', () => {
  it('一创建就发 hello（带协议版本；空定时器默认开着）；回 ready 之后 ready() 交回 ready', async () => {
    const { worker, client } = await scripted()
    expect(worker.posted[0]?.message).toEqual({ type: 'hello', keepAlive: true, v: OUTBOX_PROTOCOL_VERSION, id: worker.idOf('hello') })
    expect(client.broken()).toBeUndefined()
  })

  it('keepAlive: false 只给测试构建的对照（DEF-011）：照样放进握手', async () => {
    const { worker } = await scripted({ keepAlive: false })
    expect(worker.posted[0]?.message).toMatchObject({ type: 'hello', keepAlive: false })
  })

  it('握手回了失败、或者回的不是 ready：load-failed，Worker 被终止', async () => {
    for (const reply of [{ ok: false, error: { name: 'Error', message: 'x' } }, { ok: true, result: { kind: 'failed', error: { name: 'Error', message: 'x' } } }]) {
      const { worker, client } = await scripted({ ready: false })
      worker.emit({ v: OUTBOX_PROTOCOL_VERSION, id: worker.idOf('hello'), ...reply })
      await expect(client.ready()).resolves.toEqual({ kind: 'broken', failure: 'load-failed' })
      expect(client.broken()).toBe('load-failed')
      expect(worker.terminated).toBe(1)
    }
  })

  it('创建 Worker 时抛出（例如被策略拦下）：load-failed，之后的请求立即失败', async () => {
    const client = createOutboxWorkerClient({ create: () => {
      throw new DOMException('不让建', 'SecurityError')
    }, clock: fakeLeaseClock().clock, requestTimeoutMs: TIMEOUT_MS })
    await expect(client.ready()).resolves.toEqual({ kind: 'broken', failure: 'load-failed' })
    expect(await client.read(DRAFT)).toMatchObject({ kind: 'failed', error: { name: 'OutboxWorkerError' } })
  })
})

describe('按 id 对应', () => {
  it('回复可以乱序：各自交给自己的请求；结果经过核对（多出的字段不带出去）', async () => {
    const { worker, client } = await scripted()
    const first = client.remove(DRAFT, 7)
    const firstId = worker.idOf('remove')
    const second = client.read(DRAFT)
    worker.reply(worker.idOf('read'), { kind: 'absent', extra: 1 })
    worker.reply(firstId, { kind: 'changed' })
    expect(await second).toEqual({ kind: 'absent' })
    expect(await first).toEqual({ kind: 'changed' })
    expect(worker.posted.find(entry => entry.message.id === firstId)?.message).toEqual({ type: 'remove', draft: DRAFT, expectedSeq: 7, v: OUTBOX_PROTOCOL_VERSION, id: firstId })
  })

  it('不认识的 id（迟到的回复）：不管，客户端照常', async () => {
    const { worker, client } = await scripted()
    worker.reply(999, { kind: 'absent' })
    const read = client.read(DRAFT)
    worker.reply(worker.idOf('read'), { kind: 'absent' })
    expect(await read).toEqual({ kind: 'absent' })
    expect(client.broken()).toBeUndefined()
  })

  it('回复是 ok: false（Worker 没能处理这个请求）：这个请求以 failed 结束、错误原样；客户端照常', async () => {
    const { worker, client } = await scripted()
    const write = client.write(capture(1, 'x'))
    worker.emit({ v: OUTBOX_PROTOCOL_VERSION, id: worker.idOf('write'), ok: false, error: { name: 'OutboxProtocolError', message: '认不出' } })
    expect(await write).toEqual({ kind: 'failed', error: { name: 'OutboxProtocolError', message: '认不出' }, gzip: null })
    expect(client.broken()).toBeUndefined()
  })
})

describe('Worker 出事时不挂住：在途的全部以失败结束，之后立即失败，Worker 被终止', () => {
  async function inFlightRequests(client: OutboxWorkerClient) {
    return [client.write(capture(1, 'x')), client.read(DRAFT), client.setKey(undefined), client.seedDigest(DRAFT, undefined)] as const
  }

  async function expectAllFailed(requests: Awaited<ReturnType<typeof inFlightRequests>>, failure: string): Promise<void> {
    const [write, read, setKey, seed] = requests
    const written = await write
    expect(written).toMatchObject({ kind: 'failed', gzip: null, error: { name: 'OutboxWorkerError' } })
    expect(written.kind === 'failed' && written.error.message).toContain(failure)
    expect(await read).toMatchObject({ kind: 'failed', error: { name: 'OutboxWorkerError' } })
    expect(await setKey).toMatchObject({ kind: 'failed' })
    await expect(seed).resolves.toBeUndefined()
  }

  it('看门狗：一个请求到点没回应 → timeout', async () => {
    const { worker, time, client } = await scripted()
    const requests = await inFlightRequests(client)
    await time.advance(TIMEOUT_MS - 1)
    expect(client.broken()).toBeUndefined()
    await time.advance(1)
    expect(client.broken()).toBe('timeout')
    await expectAllFailed(requests, 'timeout')
    expect(worker.terminated).toBe(1)
    expect(await client.remove(DRAFT)).toMatchObject({ kind: 'failed', error: { name: 'OutboxWorkerError' } })
    expect(worker.posted.filter(entry => entry.message.type === 'remove'), '坏了之后不再发').toHaveLength(0)
  })

  it('回复了的请求不再计时：之后到点不算坏', async () => {
    const { worker, time, client } = await scripted()
    const read = client.read(DRAFT)
    worker.reply(worker.idOf('read'), { kind: 'absent' })
    expect(await read).toEqual({ kind: 'absent' })
    await time.advance(TIMEOUT_MS * 2)
    expect(client.broken()).toBeUndefined()
    expect(time.pending(), '计时器都已取消').toBe(0)
  })

  it('error：就绪之前 → load-failed（脚本加载失败、CSP），就绪之后 → crashed', async () => {
    const early = await scripted({ ready: false })
    const requests = await inFlightRequests(early.client)
    early.worker.fail('error')
    await expect(early.client.ready()).resolves.toEqual({ kind: 'broken', failure: 'load-failed' })
    await expectAllFailed(requests, 'load-failed')
    const late = await scripted()
    const lateRequests = await inFlightRequests(late.client)
    late.worker.fail('error')
    expect(late.client.broken()).toBe('crashed')
    await expectAllFailed(lateRequests, 'crashed')
    expect(late.worker.terminated).toBe(1)
  })

  it('messageerror、读不懂的消息、Worker 的通知、结果认不出：message-error', async () => {
    const cases: readonly ((worker: ScriptedWorker) => void)[] = [
      worker => worker.fail('messageerror'),
      worker => worker.emit('not a reply'),
      worker => worker.emit({ v: OUTBOX_PROTOCOL_VERSION, notice: 'unreadable-message' }),
      worker => worker.reply(worker.idOf('read'), { kind: 'draft', meta: 'broken' }),
    ]
    for (const trigger of cases) {
      const { worker, client } = await scripted()
      const requests = await inFlightRequests(client)
      trigger(worker)
      expect(client.broken()).toBe('message-error')
      await expectAllFailed(requests, 'message-error')
      expect(worker.terminated).toBe(1)
      expect(worker.listeners, '监听都摘掉了').toBe(0)
    }
  })

  it('dispose：terminated；之后立即失败；再 dispose 不重复终止', async () => {
    const { worker, client } = await scripted()
    const requests = await inFlightRequests(client)
    client.dispose()
    client.dispose()
    expect(client.broken()).toBe('terminated')
    await expectAllFailed(requests, 'terminated')
    expect(worker.terminated).toBe(1)
  })

  it('坏了之后每种方法都交回各自失败的样子，不抛出', async () => {
    const { client } = await scripted()
    client.dispose()
    const failed = { kind: 'failed', error: { name: 'OutboxWorkerError' } }
    expect(await client.register(DRAFT, ME, false)).toMatchObject(failed)
    expect(await client.write(capture(1, 'x'))).toMatchObject({ ...failed, gzip: null })
    expect(await client.markInFlight(DRAFT, ME, { requestId: 'r', clientInstanceId: CLIENT_INSTANCE_ID, localSeq: 1, sentAt: NOW })).toMatchObject(failed)
    expect(await client.confirm(DRAFT, ME, 1, 13)).toMatchObject(failed)
    expect(await client.read(DRAFT)).toMatchObject(failed)
    expect(await client.remove(DRAFT)).toMatchObject(failed)
    expect(await client.setKey(await localKey(2))).toMatchObject(failed)
    await expect(client.seedDigest(DRAFT, { digest: 'ab', formulasPending: false })).resolves.toBeUndefined()
    await expect(client.release(DRAFT)).resolves.toBeUndefined()
    expect(await client.reconcile(USER_ID)).toMatchObject(failed)
    expect(await client.notices(USER_ID)).toMatchObject(failed)
    expect(await client.clearNotice(DRAFT, 1)).toMatchObject(failed)
  })

  it('postMessage 抛出（这一条克隆不了）：只有这一个请求失败，客户端照常', async () => {
    const { worker, client } = await scripted()
    worker.failNextPost = new DOMException('克隆不了', 'DataCloneError')
    expect(await client.read(DRAFT)).toEqual({ kind: 'failed', error: { name: 'DataCloneError', message: '克隆不了' } })
    expect(client.broken()).toBeUndefined()
    const read = client.read(DRAFT)
    worker.reply(worker.idOf('read'), { kind: 'absent' })
    expect(await read).toEqual({ kind: 'absent' })
  })
})

describe('镜像的放开、比对与提示（M4-P1 设计 §3.8）', () => {
  it('放开句柄、比对、读出与清除提示：各发一条给 Worker，等它回复；结果照它的回复', async () => {
    const { worker, client } = await scripted()
    const released = client.release(DRAFT)
    expect(worker.posted.findLast(entry => entry.message.type === 'release')?.message).toMatchObject({ draft: DRAFT })
    worker.reply(worker.idOf('release'), { kind: 'released' })
    await expect(released).resolves.toBeUndefined()
    const reconciled = client.reconcile(USER_ID)
    expect(worker.posted.findLast(entry => entry.message.type === 'reconcile')?.message).toMatchObject({ userId: USER_ID })
    worker.reply(worker.idOf('reconcile'), { kind: 'reconciled', documents: 2 })
    expect(await reconciled).toEqual({ kind: 'reconciled', documents: 2 })
    const notices = client.notices(USER_ID)
    expect(worker.posted.findLast(entry => entry.message.type === 'notices')?.message).toMatchObject({ userId: USER_ID })
    worker.reply(worker.idOf('notices'), { kind: 'notices', notices: [{ ...DRAFT, kind: 'restored', at: NOW }, { ...DRAFT, kind: 'lost', at: NOW + 1 }] })
    expect(await notices).toEqual({ kind: 'notices', notices: [{ ...DRAFT, kind: 'restored', at: NOW }, { ...DRAFT, kind: 'lost', at: NOW + 1 }] })
    const cleared = client.clearNotice(DRAFT, NOW)
    expect(worker.posted.findLast(entry => entry.message.type === 'clear-notice')?.message).toMatchObject({ draft: DRAFT, expectedAt: NOW })
    worker.reply(worker.idOf('clear-notice'), { kind: 'cleared' })
    expect(await cleared).toEqual({ kind: 'cleared' })
    void client.clearNotice(DRAFT)
    expect(worker.posted.findLast(entry => entry.message.type === 'clear-notice')?.message).toMatchObject({ draft: DRAFT, expectedAt: null })
  })
})

describe('转移与交密钥', () => {
  it('写入的字节转移给 Worker：调用方那一份随之清空', async () => {
    const { worker, client } = await scripted()
    const bytes = utf8('payload')
    void client.write(capture(1, '', { bytes }))
    expect(bytes.byteLength).toBe(0)
    const sent = worker.posted.findLast(entry => entry.message.type === 'write')
    expect(sent?.transfer).toHaveLength(1)
  })

  it('交密钥：不可导出的 CryptoKey 经结构化克隆交过去（不转移）；丢掉密钥是 null', async () => {
    const { worker, client } = await scripted()
    const key = await localKey(4)
    void client.setKey(key)
    expect(worker.posted.findLast(entry => entry.message.type === 'set-key')).toMatchObject({ message: { key: { form: 'crypto-key', version: 4 } }, transfer: [] })
    void client.setKey(undefined)
    expect(worker.posted.findLast(entry => entry.message.type === 'set-key')?.message).toMatchObject({ key: null })
    expect(keyTransferOf(key)).toEqual({ key: { form: 'crypto-key', version: 4, key: key.key }, transfer: [] })
  })
})

describe('连到 Worker 里真的处理：每种方法走完整条路', () => {
  it('登记、写入（交回的 gzip 与库里的一致）、标记在途、读回、确认、去重的起点、放弃、换密钥', async () => {
    const { client, fake } = loopback()
    await expect(client.ready()).resolves.toEqual({ kind: 'ready' })
    const key = await localKey(2)
    expect(await client.setKey(key)).toEqual({ kind: 'key-set', notResealed: [] })
    expect(await client.register(DRAFT, ME, false)).toEqual({ kind: 'registered', lastDraftSeq: 0, existing: undefined, mirror: { kind: 'off' } })
    const written = await client.write(capture(1, '{"甲":1}'))
    expect(written.kind).toBe('written')
    const gzip = written.kind === 'written' ? written.gzip : new Uint8Array()
    expect(textOf(await gunzipBytes(new Uint8Array(gzip)))).toBe('{"甲":1}')
    const stored = readStoredDraft(fake.rawDraft(DRAFT))
    const opened = stored.kind === 'draft' ? await openDraft(key, stored.draft) : undefined
    expect(opened?.kind === 'opened' && Array.from(opened.gzip), '交回的 gzip 与库里解开的一致').toEqual(Array.from(gzip))
    expect(await client.markInFlight(DRAFT, ME, { requestId: 'r-1', clientInstanceId: CLIENT_INSTANCE_ID, localSeq: 1, sentAt: NOW })).toEqual({ kind: 'resealed' })
    const read = await client.read(DRAFT)
    expect(read).toMatchObject({ kind: 'draft', meta: { draftSeq: 1, inFlight: { requestId: 'r-1' } } })
    expect(read.kind === 'draft' && textOf(await gunzipBytes(new Uint8Array(read.gzip)))).toBe('{"甲":1}')
    expect(await client.write(capture(2, '{"甲":2}', { inFlight: { requestId: 'r-1', clientInstanceId: CLIENT_INSTANCE_ID, localSeq: 1, sentAt: NOW } }))).toMatchObject({ kind: 'written' })
    expect(await client.confirm(DRAFT, ME, 1, 13)).toEqual({ kind: 'rebased' })
    await client.seedDigest(DRAFT, undefined)
    const next = await localKey(3)
    expect(await client.setKey(next)).toEqual({ kind: 'key-set', notResealed: [] })
    const rekeyed = readStoredDraft(fake.rawDraft(DRAFT))
    expect(rekeyed.kind === 'draft' && [rekeyed.draft.keyVersion, rekeyed.draft.baseRevision]).toEqual([3, 13])
    expect(await client.remove(DRAFT, 1)).toEqual({ kind: 'changed' })
    expect(await client.remove(DRAFT, 2)).toEqual({ kind: 'removed' })
    await expect(client.release(DRAFT)).resolves.toBeUndefined()
    expect(await client.reconcile(USER_ID), '这个 Worker 没有镜像').toEqual({ kind: 'reconciled', documents: 0 })
    expect(await client.notices(USER_ID)).toEqual({ kind: 'notices', notices: [] })
    expect(await client.clearNotice(DRAFT)).toEqual({ kind: 'absent' })
    expect(client.broken()).toBeUndefined()
    await settle()
  })
})

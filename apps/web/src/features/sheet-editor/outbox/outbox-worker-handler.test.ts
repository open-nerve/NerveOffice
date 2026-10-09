import type { LocalKeyHandle } from '../../../shared/outbox/draft-codec.ts'
import type { DraftKey } from '../../../shared/outbox/draft-record.ts'
import type { FakeDraftStore } from '../../../shared/outbox/draft-store.test-support.ts'
import type { CaptureToWrite } from '../../../shared/outbox/draft-writer.ts'
import type { OutboxCall, OutboxMessage } from './outbox-protocol.ts'
import type { OutboxWorkerHandler } from './outbox-worker-handler.ts'
import { describe, expect, it, vi } from 'vitest'
import { gunzipBytes, openDraft } from '../../../shared/outbox/draft-codec.ts'
import { CLIENT_INSTANCE_ID, DOCUMENT_ID, NOW, sampleMeta, USER_ID, WRITER_ID } from '../../../shared/outbox/draft-record.test-support.ts'
import { readStoredDraft } from '../../../shared/outbox/draft-record.ts'
import { fakeDraftStore } from '../../../shared/outbox/draft-store.test-support.ts'
import { OUTBOX_PROTOCOL_VERSION, RAW_KEY_BYTES } from './outbox-protocol.ts'
import { createOutboxWorkerHandler } from './outbox-worker-handler.ts'

const DRAFT: DraftKey = { userId: USER_ID, documentId: DOCUMENT_ID }
const OTHER_DRAFT: DraftKey = { userId: USER_ID, documentId: '0199b0c4-7d3e-7a3b-9c4e-00000000d0c2' }
const ME = { writeEpoch: 3, writerId: WRITER_ID }

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

/** 让排着的异步走几轮（借真实的宏任务） */
async function turns(count: number): Promise<void> {
  for (let index = 0; index < count; index += 1)
    await new Promise(resolve => setTimeout(resolve, 0))
}

async function importRaw(raw: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt'])
}

interface Posted {
  /** Worker 这一侧交给 post 的 */
  readonly sent: OutboxMessage
  readonly transfer: readonly Transferable[]
  /** 主线程收到的（结构化克隆、按 transfer 转移之后） */
  readonly received: OutboxMessage
}

interface Harness {
  readonly fake: FakeDraftStore
  readonly handler: OutboxWorkerHandler
  readonly posted: readonly Posted[]
  /** 按 postMessage 的样子交给处理（结构化克隆，transfer 里的缓冲随之转移），等回复发出 */
  readonly send: (call: OutboxCall, id: number, transfer?: Transferable[]) => Promise<void>
  /** id 的回复（主线程收到的样子） */
  readonly replyTo: (id: number) => OutboxMessage | undefined
  readonly stopKeepAlive: ReturnType<typeof vi.fn>
}

function harness(options: { readonly canStopKeepAlive?: boolean, readonly post?: (message: OutboxMessage, transfer: Transferable[]) => void } = {}): Harness {
  const fake = fakeDraftStore()
  const posted: Posted[] = []
  const stopKeepAlive = vi.fn()
  const handler = createOutboxWorkerHandler({
    store: fake.store,
    now: () => NOW,
    post: options.post ?? ((message, transfer) => {
      // 与 postMessage 一样：克隆不了（transfer 里有重复的、转移不了的缓冲）就在这里抛出
      posted.push({ sent: message, transfer, received: structuredClone(message, { transfer }) })
    }),
    stopKeepAlive: options.canStopKeepAlive === false ? undefined : stopKeepAlive,
  })
  return {
    fake,
    handler,
    posted,
    send: async (call, id, transfer = []) => handler.receive(structuredClone({ ...call, v: OUTBOX_PROTOCOL_VERSION, id }, { transfer })),
    replyTo: id => posted.find(entry => 'id' in entry.received && entry.received.id === id)?.received,
    stopKeepAlive,
  }
}

/** 第 2 版的密钥（原始字节留着，测试用它核对库里的记录） */
async function keyOf(version: number): Promise<{ readonly handle: LocalKeyHandle, readonly raw: Uint8Array<ArrayBuffer> }> {
  const raw = crypto.getRandomValues(new Uint8Array(RAW_KEY_BYTES))
  return { handle: { version, key: await importRaw(new Uint8Array(raw)) }, raw }
}

/** 已经交了密钥、以本页登记为写入者 */
async function ready(): Promise<Harness & { readonly key: LocalKeyHandle }> {
  const setup = harness()
  const { handle } = await keyOf(2)
  await setup.send({ type: 'set-key', key: { form: 'crypto-key', version: handle.version, key: handle.key } }, 1)
  await setup.send({ type: 'register', draft: DRAFT, writer: ME, force: false }, 2)
  await setup.send({ type: 'register', draft: OTHER_DRAFT, writer: ME, force: false }, 3)
  expect(setup.replyTo(3)).toMatchObject({ ok: true, result: { kind: 'registered' } })
  return { ...setup, key: handle }
}

async function storedText(fake: FakeDraftStore, key: LocalKeyHandle, draft: DraftKey = DRAFT): Promise<{ readonly text: string, readonly keyVersion: number }> {
  const read = readStoredDraft(fake.rawDraft(draft))
  if (read.kind !== 'draft')
    throw new Error(`库里没有认得出的草稿：${read.kind}`)
  const opened = await openDraft(key, read.draft)
  if (opened.kind !== 'opened')
    throw new Error('解不开')
  return { text: textOf(await gunzipBytes(opened.gzip)), keyVersion: read.draft.keyVersion }
}

describe('握手（M4-P1 设计 §3.4.8）', () => {
  it('回 ready；keepAlive 为 false 时停掉空定时器（DEF-011 的对照）', async () => {
    const { send, replyTo, stopKeepAlive } = harness()
    await send({ type: 'hello', keepAlive: true }, 1)
    expect(replyTo(1)).toEqual({ v: OUTBOX_PROTOCOL_VERSION, id: 1, ok: true, result: { kind: 'ready' } })
    expect(stopKeepAlive).not.toHaveBeenCalled()
    await send({ type: 'hello', keepAlive: false }, 2)
    expect(replyTo(2)).toMatchObject({ ok: true, result: { kind: 'ready' } })
    expect(stopKeepAlive).toHaveBeenCalledOnce()
  })

  it('生产的入口不给 stopKeepAlive：keepAlive 为 false 照样回 ready，空定时器停不掉', async () => {
    const { send, replyTo, stopKeepAlive } = harness({ canStopKeepAlive: false })
    await send({ type: 'hello', keepAlive: false }, 1)
    expect(replyTo(1)).toMatchObject({ ok: true, result: { kind: 'ready' } })
    expect(stopKeepAlive).not.toHaveBeenCalled()
  })
})

describe('分派：每种请求交给写入管道，结果原样回复；交回的 gzip 转移给主线程', () => {
  it('写入：结果回到主线程，gzip 在 transfer 里（Worker 这一侧随之清空），解压之后等于写入的内容', async () => {
    const { fake, send, posted, replyTo, key } = await ready()
    const bytes = utf8('{"甲":1}')
    await send({ type: 'write', capture: capture(1, '', { bytes }) }, 10, [bytes.buffer])
    expect(bytes.byteLength, '写入的字节转移进了 Worker').toBe(0)
    const reply = replyTo(10)
    expect(reply).toMatchObject({ ok: true, result: { kind: 'written' } })
    const entry = posted.at(-1)
    const result = reply !== undefined && 'ok' in reply && reply.ok ? reply.result as { gzip: Uint8Array } : undefined
    expect(textOf(await gunzipBytes(new Uint8Array(result?.gzip ?? [])))).toBe('{"甲":1}')
    expect(entry?.transfer).toHaveLength(1)
    expect((entry?.sent as { result: { gzip: Uint8Array } }).result.gzip.byteLength, 'Worker 这一侧的已经转移走').toBe(0)
    expect((await storedText(fake, key)).text).toBe('{"甲":1}')
  })

  it('转移走的是交出去的那一份：管道自己留着的照样能重封（标记在途）', async () => {
    const { fake, send, replyTo, key } = await ready()
    await send({ type: 'write', capture: capture(1, 'kept') }, 10)
    await send({ type: 'mark-in-flight', draft: DRAFT, writer: ME, inFlight: { requestId: 'r-1', clientInstanceId: CLIENT_INSTANCE_ID, localSeq: 1, sentAt: NOW } }, 11)
    expect(replyTo(11)).toMatchObject({ ok: true, result: { kind: 'resealed' } })
    expect((await storedText(fake, key)).text).toBe('kept')
  })

  it('读回、确认、放弃、去重的起点、登记：结果原样；读回的 gzip 同样转移', async () => {
    const { send, posted, replyTo } = await ready()
    await send({ type: 'write', capture: capture(1, 'one') }, 10)
    await send({ type: 'read', draft: DRAFT }, 11)
    const read = replyTo(11)
    expect(read).toMatchObject({ ok: true, result: { kind: 'draft', meta: { draftSeq: 1 } } })
    expect(posted.find(entry => 'id' in entry.sent && entry.sent.id === 11)?.transfer).toHaveLength(1)
    await send({ type: 'seed-digest', draft: DRAFT, seed: null }, 12)
    expect(replyTo(12)).toMatchObject({ ok: true, result: { kind: 'seeded' } })
    await send({ type: 'confirm', draft: DRAFT, writer: ME, confirmedSeq: 1, revision: 13 }, 13)
    expect(replyTo(13)).toMatchObject({ ok: true, result: { kind: 'deleted' } })
    await send({ type: 'remove', draft: DRAFT, expectedSeq: null }, 14)
    expect(replyTo(14)).toMatchObject({ ok: true, result: { kind: 'absent' } })
    await send({ type: 'register', draft: DRAFT, writer: { writeEpoch: 2, writerId: WRITER_ID }, force: false }, 15)
    expect(replyTo(15)).toMatchObject({ ok: true, result: { kind: 'superseded', currentEpoch: 3 } })
    await send({ type: 'set-key', key: null }, 16)
    expect(replyTo(16)).toMatchObject({ ok: true, result: { kind: 'key-set', notResealed: [] } })
  })

  it('放弃带 expectedSeq：交给管道', async () => {
    const { send, replyTo } = await ready()
    await send({ type: 'write', capture: capture(2, 'two') }, 10)
    await send({ type: 'remove', draft: DRAFT, expectedSeq: 1 }, 11)
    expect(replyTo(11)).toMatchObject({ ok: true, result: { kind: 'changed' } })
    await send({ type: 'remove', draft: DRAFT, expectedSeq: 2 }, 12)
    expect(replyTo(12)).toMatchObject({ ok: true, result: { kind: 'removed' } })
  })
})

describe('按文档排队（管道）：同一份文档按收到的先后；另一份文档不等', () => {
  it('第一份文档的写入停在存储里时，第二份文档的写入先回复；第一份的两次按先后回复', async () => {
    const { fake, send, posted, key } = await ready()
    const held = fake.holdNext('writeDraft')
    const first = send({ type: 'write', capture: capture(1, 'first') }, 10)
    const second = send({ type: 'write', capture: capture(2, 'second') }, 11)
    await held.reached
    await send({ type: 'write', capture: capture(1, 'other', { key: OTHER_DRAFT }) }, 12)
    held.release()
    await Promise.all([first, second])
    const order = posted.map(entry => ('id' in entry.received ? entry.received.id : -1)).filter(id => id >= 10)
    expect(order).toEqual([12, 10, 11])
    expect((await storedText(fake, key)).text).toBe('second')
    expect((await storedText(fake, key, OTHER_DRAFT)).text).toBe('other')
  })
})

describe('交密钥（§3.4.8）：CryptoKey 原样用；原始字节在 Worker 里导入、用完清零', () => {
  it('原始字节：转移进来、导入之后清零；之后的写入用它', async () => {
    const { fake, handler, send, replyTo } = harness()
    const { raw } = await keyOf(3)
    const transferred = new Uint8Array(raw)
    await send({ type: 'set-key', key: { form: 'raw', version: 3, bytes: transferred } }, 1, [transferred.buffer])
    expect(replyTo(1)).toMatchObject({ ok: true, result: { kind: 'key-set' } })
    expect(transferred.byteLength, '主线程的那一份转移走了').toBe(0)
    // Worker 这一侧收到的那一份：直接交给处理，核对用完清零
    const inWorker = new Uint8Array(raw)
    await handler.receive({ type: 'set-key', key: { form: 'raw', version: 3, bytes: inWorker }, v: OUTBOX_PROTOCOL_VERSION, id: 9 })
    expect(replyTo(9)).toMatchObject({ ok: true, result: { kind: 'key-set' } })
    expect(Array.from(inWorker).every(byte => byte === 0), 'Worker 里的那一份用完清零').toBe(true)
    await send({ type: 'register', draft: DRAFT, writer: ME, force: false }, 2)
    await send({ type: 'write', capture: capture(1, 'raw key') }, 3)
    expect(replyTo(3)).toMatchObject({ ok: true, result: { kind: 'written' } })
    expect(await storedText(fake, { version: 3, key: await importRaw(raw) })).toEqual({ text: 'raw key', keyVersion: 3 })
  })

  it('交密钥之后到的请求等它装好：原始字节的导入是异步的，"先换密钥、再写"的先后不变（导入停住时写入不交给存储）', async () => {
    const { fake, send, replyTo } = await ready()
    const next = await keyOf(3)
    let finishImport: () => void = () => {}
    const importing = new Promise<void>((resolve) => {
      finishImport = resolve
    })
    const importKey = vi.spyOn(crypto.subtle, 'importKey').mockImplementationOnce(async () => {
      await importing
      return next.handle.key
    })
    const reachedStore = fake.holdNext('writeDraft')
    let reached = false
    void reachedStore.reached.then(() => {
      reached = true
    })
    const installing = send({ type: 'set-key', key: { form: 'raw', version: 3, bytes: new Uint8Array(next.raw) } }, 10)
    const writing = send({ type: 'write', capture: capture(1, 'after the key') }, 11)
    // 没有关口时，写入在这几轮里就做完摘要与压缩、用手里旧的第 2 版封好交给存储
    await turns(50)
    expect(reached, '密钥还没装好，写入不该交给存储').toBe(false)
    finishImport()
    await reachedStore.reached
    reachedStore.release()
    await Promise.all([installing, writing])
    importKey.mockRestore()
    expect(replyTo(11)).toMatchObject({ ok: true, result: { kind: 'written' } })
    expect((await storedText(fake, next.handle)).keyVersion).toBe(3)
  })

  it('写入途中换密钥：那一次按开始时的密钥写下，随后用新密钥重封', async () => {
    const { fake, send, replyTo } = await ready()
    const held = fake.holdNext('writeDraft')
    const writing = send({ type: 'write', capture: capture(1, 'in the middle') }, 10)
    await held.reached
    const next = await keyOf(3)
    const changing = send({ type: 'set-key', key: { form: 'crypto-key', version: 3, key: next.handle.key } }, 11)
    held.release()
    await Promise.all([writing, changing])
    expect(replyTo(10)).toMatchObject({ ok: true, result: { kind: 'written' } })
    expect(replyTo(11)).toMatchObject({ ok: true, result: { kind: 'key-set', notResealed: [] } })
    expect(await storedText(fake, next.handle)).toEqual({ text: 'in the middle', keyVersion: 3 })
  })

  it('导入失败：set-key 回 ok: false；手里的密钥随之丢掉（之后的写入 no-key，不用旧版本接着写）', async () => {
    const { send, replyTo } = await ready()
    const spy = vi.spyOn(crypto.subtle, 'importKey').mockRejectedValueOnce(new DOMException('导入失败', 'DataError'))
    await send({ type: 'set-key', key: { form: 'raw', version: 3, bytes: new Uint8Array(RAW_KEY_BYTES) } }, 10)
    spy.mockRestore()
    expect(replyTo(10)).toEqual({ v: OUTBOX_PROTOCOL_VERSION, id: 10, ok: false, error: { name: 'DataError', message: '导入失败' } })
    await send({ type: 'write', capture: capture(1, 'no key now') }, 11)
    expect(replyTo(11)).toMatchObject({ ok: true, result: { kind: 'no-key' } })
  })
})

describe('任何错误都以回复结束，不抛出', () => {
  it('认不出的请求：带得出 id 时回 ok: false；没有 id 时发通知（客户端把 Worker 当作坏了）', async () => {
    const { handler, posted, replyTo } = harness()
    await handler.receive({ v: OUTBOX_PROTOCOL_VERSION, id: 4, type: 'write', capture: {} })
    expect(replyTo(4)).toMatchObject({ v: OUTBOX_PROTOCOL_VERSION, id: 4, ok: false, error: { name: 'OutboxProtocolError' } })
    await handler.receive('garbage')
    expect(posted.at(-1)?.received).toEqual({ v: OUTBOX_PROTOCOL_VERSION, notice: 'unreadable-message' })
  })

  it('消息解不开（messageerror）：发通知', () => {
    const { handler, posted } = harness()
    handler.unreadable()
    expect(posted.map(entry => entry.received)).toEqual([{ v: OUTBOX_PROTOCOL_VERSION, notice: 'unreadable-message' }])
  })

  it('回复发不出去（结构化克隆失败）：退一步回 ok: false；那也发不出去时不抛出', async () => {
    const sent: OutboxMessage[] = []
    let failures = 1
    const { send } = harness({
      post: (message) => {
        if (failures > 0) {
          failures -= 1
          throw new DOMException('克隆不了', 'DataCloneError')
        }
        sent.push(message)
      },
    })
    await send({ type: 'hello', keepAlive: true }, 1)
    expect(sent).toEqual([{ v: OUTBOX_PROTOCOL_VERSION, id: 1, ok: false, error: { name: 'DataCloneError', message: '克隆不了' } }])
    failures = 2
    await expect(send({ type: 'hello', keepAlive: true }, 2)).resolves.toBeUndefined()
    expect(sent).toHaveLength(1)
  })
})

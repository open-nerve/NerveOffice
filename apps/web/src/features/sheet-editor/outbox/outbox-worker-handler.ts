// 发件箱 Worker 里的处理（M4-P1 设计 §3.1、§3.4.8）：认请求、交给写入管道（shared/outbox/draft-writer.ts，配上注入的存储与墙上时钟）、回复。
// - 每条请求都以回复结束，不抛出：认不出的（带得出 id 时）、管道之外出的错（例如导入原始字节的密钥失败）回 ok: false，那个请求随之结束，
//   不等客户端的看门狗；认不出 id 的消息与解不开的消息（messageerror）发通知，客户端把 Worker 当作坏了。
// - 同一份文档的先后由管道排队。交密钥要先把它装进管道（原始字节的交法要导入，是异步的）：之后到的请求等它装好再交给管道，
//   "先换密钥、再写"的先后不变；重封不用等。
// - 交回的 gzip 转移给主线程（管道交出的字节不是它自己留着的那一份）。
// - 握手里 keepAlive 为 false 时停掉空定时器：只有测试构建的入口给 stopKeepAlive（DEF-011 的对照），生产里停不掉。
// 存储、时钟与发消息的通道都注入，能在 jsdom 里测。不引用 zod，不依赖 DOM
import type { LocalKeyHandle } from '../../../shared/outbox/draft-codec.ts'
import type { DraftStore } from '../../../shared/outbox/draft-store.ts'
import type { KeyChange } from '../../../shared/outbox/draft-writer.ts'
import type { KeyTransfer, OutboxMessage, OutboxReply, OutboxRequest } from './outbox-protocol.ts'
import { createDraftWriter, describeFailure } from '../../../shared/outbox/draft-writer.ts'
import { OUTBOX_PROTOCOL_VERSION, readOutboxRequest } from './outbox-protocol.ts'

export interface OutboxWorkerHandlerOptions {
  /** 发件箱的存储（Worker 的入口给 IndexedDB 的实现） */
  readonly store: DraftStore
  /** 墙上时间（毫秒）：记录的更新时间、写入者的登记时刻 */
  readonly now: () => number
  /** 发给主线程（Worker 的 postMessage）；transfer 里是交回的 gzip 的缓冲 */
  readonly post: (message: OutboxMessage, transfer: Transferable[]) => void
  /** 停掉空定时器：只有测试构建的入口给（DEF-011 的对照）；为 undefined 时握手的 keepAlive: false 不起作用 */
  readonly stopKeepAlive: (() => void) | undefined
}

export interface OutboxWorkerHandler {
  /** 收到主线程的一条消息（Worker 的 message 事件）：回复发出之后完成，从不失败 */
  readonly receive: (data: unknown) => Promise<void>
  /** 收到的消息解不开（Worker 的 messageerror 事件） */
  readonly unreadable: () => void
}

const UNREADABLE_NOTICE: OutboxMessage = { v: OUTBOX_PROTOCOL_VERSION, notice: 'unreadable-message' }

/** 交来的密钥换成管道用的：CryptoKey 原样用；原始字节导入为不可导出、只能加密与解密的密钥，用完清零（成不成都清） */
async function receiveKey(transfer: KeyTransfer): Promise<LocalKeyHandle> {
  if (transfer.form === 'crypto-key')
    return { version: transfer.version, key: transfer.key }
  try {
    return { version: transfer.version, key: await crypto.subtle.importKey('raw', transfer.bytes, 'AES-GCM', false, ['encrypt', 'decrypt']) }
  }
  finally {
    transfer.bytes.fill(0)
  }
}

/** 一次处理的结果与要转移的字节 */
interface Performed {
  readonly result: unknown
  readonly transfer: ArrayBuffer[]
}

function plain(result: unknown): Performed {
  return { result, transfer: [] }
}

export function createOutboxWorkerHandler(options: OutboxWorkerHandlerOptions): OutboxWorkerHandler {
  const writer = createDraftWriter({ store: options.store, now: options.now })
  /** 交密钥的关口：上一次交来的密钥装进管道之后完成（不等重封） */
  let keyGate: Promise<void> = Promise.resolve()

  /** 发出去；结构化克隆失败时退一步回 ok: false（那个请求照样结束），那也发不出去就算了——客户端的看门狗会到点 */
  function send(message: OutboxMessage, transfer: ArrayBuffer[]): void {
    try {
      options.post(message, transfer)
    }
    catch (error) {
      if (!('id' in message))
        return
      try {
        options.post({ v: OUTBOX_PROTOCOL_VERSION, id: message.id, ok: false, error: describeFailure(error) }, [])
      }
      catch {
        // 连失败也发不出去：不抛出（Worker 里没有人接）
      }
    }
  }

  /** 把交来的密钥装进管道：排在上一次之后；导入失败时丢掉手里的密钥（之后的写入 no-key，不用旧版本接着写），并以失败回复 */
  async function installKey(transfer: KeyTransfer | null): Promise<KeyChange> {
    const installing = keyGate.then(async () => {
      try {
        // 包一层：关口只等密钥装进管道（setKey 同步换上密钥），不等它排在各文档写入之后的重封
        return { change: writer.setKey(transfer === null ? undefined : await receiveKey(transfer)) }
      }
      catch (error) {
        await writer.setKey(undefined)
        throw error
      }
    })
    keyGate = installing.then(() => {}, () => {})
    const { change } = await installing
    return change
  }

  async function perform(request: OutboxRequest): Promise<Performed> {
    switch (request.type) {
      case 'hello':
        if (!request.keepAlive)
          options.stopKeepAlive?.()
        return plain({ kind: 'ready' })
      case 'register': {
        const result = await writer.register(request.draft, request.writer, request.force)
        return { result, transfer: result.kind === 'registered' && result.existing?.kind === 'draft' ? [result.existing.gzip.buffer] : [] }
      }
      case 'write': {
        const result = await writer.write(request.capture)
        return { result, transfer: 'gzip' in result && result.gzip !== null ? [result.gzip.buffer] : [] }
      }
      case 'mark-in-flight':
        return plain(await writer.markInFlight(request.draft, request.writer, request.inFlight))
      case 'confirm':
        return plain(await writer.confirm(request.draft, request.writer, request.confirmedSeq, request.revision))
      case 'read': {
        const result = await writer.read(request.draft)
        return { result, transfer: result.kind === 'draft' ? [result.gzip.buffer] : [] }
      }
      case 'remove':
        return plain(await writer.remove(request.draft, request.expectedSeq ?? undefined))
      case 'set-key':
        return plain(await installKey(request.key))
      case 'seed-digest':
        await writer.seedDigest(request.draft, request.seed ?? undefined)
        return plain({ kind: 'seeded' })
    }
  }

  async function handle(request: OutboxRequest): Promise<void> {
    let reply: OutboxReply
    let transfer: ArrayBuffer[] = []
    try {
      // 交密钥自己排在关口里；别的请求等之前交来的密钥装好
      if (request.type !== 'set-key')
        await keyGate
      const performed = await perform(request)
      reply = { v: OUTBOX_PROTOCOL_VERSION, id: request.id, ok: true, result: performed.result }
      transfer = performed.transfer
    }
    catch (error) {
      reply = { v: OUTBOX_PROTOCOL_VERSION, id: request.id, ok: false, error: describeFailure(error) }
    }
    send(reply, transfer)
  }

  return {
    receive: async (data) => {
      const read = readOutboxRequest(data)
      if (read.kind === 'request')
        return handle(read.request)
      if (read.id === undefined)
        send(UNREADABLE_NOTICE, [])
      else
        send({ v: OUTBOX_PROTOCOL_VERSION, id: read.id, ok: false, error: { name: 'OutboxProtocolError', message: '认不出的请求（协议版本、种类或参数不对）' } }, [])
    },
    unreadable: () => send(UNREADABLE_NOTICE, []),
  }
}

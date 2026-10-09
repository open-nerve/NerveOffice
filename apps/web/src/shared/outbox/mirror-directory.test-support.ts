// 测试用：照 MirrorDirectory 的接口写的内存里的 OPFS（M4-P1 设计 §3.8）。文件按"用户/文档/槽位"存字节；同步访问句柄同一个文件同一时刻
// 只有一个（与浏览器一样：再拿交回 busy）；另有别的标签页占着句柄、下一次写入写到一半抛出（写满、出错）、没有 OPFS 这几样
import type { DraftKey } from './draft-record.ts'
import type { MirrorDirectory, MirrorProblem, SlotHandle } from './mirror-directory.ts'
import { SLOT_FILE_NAMES } from './mirror-directory.ts'

export interface FakeMirrorDirectory {
  readonly directory: MirrorDirectory
  /** 槽位文件的内容（一份拷贝）；文件不在为 undefined */
  readonly file: (key: DraftKey, slot: 0 | 1) => Uint8Array<ArrayBuffer> | undefined
  /** 直接放一个槽位文件（undefined 是删掉）：模拟上一次会话留下的、被改坏的 */
  readonly putFile: (key: DraftKey, slot: 0 | 1, bytes: Uint8Array | undefined) => void
  /** 别的标签页拿着这份文档的句柄：openSlots 交回 busy，直到交回的函数被调用 */
  readonly holdElsewhere: (key: DraftKey) => () => void
  /** 再成功 after 次 write 之后，下一次只写前 bytes 个字节就抛出名为 name 的错误（写满是 QuotaExceededError）：每次镜像先写内容、再写头 */
  readonly failWrite: (after: number, bytes: number, name: string) => void
  /** 下一次 openSlots 交回这个问题 */
  readonly failNextOpen: (problem: MirrorProblem) => void
  /** 开着的句柄个数 */
  readonly openHandles: () => number
  /** openSlots 被调用的次数 */
  readonly opens: () => number
  /** flush 被调用的次数 */
  readonly flushes: () => number
}

function pathOf(key: DraftKey, slot: 0 | 1): string {
  return `${key.userId}/${key.documentId}/${SLOT_FILE_NAMES[slot]}`
}

export function fakeMirrorDirectory(): FakeMirrorDirectory {
  const files = new Map<string, Uint8Array<ArrayBuffer>>()
  const locked = new Set<string>()
  const elsewhere = new Set<string>()
  let writeFailure: { after: number, readonly bytes: number, readonly name: string } | undefined
  let nextOpenFailure: MirrorProblem | undefined
  let opens = 0
  let flushes = 0

  function handleFor(path: string): SlotHandle {
    let closed = false
    const live = (): Uint8Array<ArrayBuffer> => {
      if (closed)
        throw new DOMException('句柄已经关了', 'InvalidStateError')
      return files.get(path) ?? new Uint8Array(0)
    }
    return {
      read: (buffer, { at }) => {
        const bytes = live().subarray(at, at + buffer.byteLength)
        buffer.set(bytes)
        return bytes.byteLength
      },
      write: (buffer, { at }) => {
        const current = live()
        let failure: { readonly bytes: number, readonly name: string } | undefined
        if (writeFailure !== undefined) {
          if (writeFailure.after === 0) {
            failure = writeFailure
            writeFailure = undefined
          }
          else {
            writeFailure.after -= 1
          }
        }
        const written = failure === undefined ? buffer : buffer.subarray(0, failure.bytes)
        const next = new Uint8Array(Math.max(current.byteLength, at + written.byteLength))
        next.set(current)
        next.set(written, at)
        files.set(path, next)
        if (failure !== undefined)
          throw new DOMException('写到一半出了错', failure.name)
        return written.byteLength
      },
      truncate: (size) => {
        files.set(path, live().slice(0, size))
      },
      getSize: () => live().byteLength,
      flush: () => {
        live()
        flushes += 1
      },
      close: () => {
        if (!closed)
          locked.delete(path)
        closed = true
      },
    }
  }

  const directory: MirrorDirectory = {
    openSlots: async (key, create) => {
      opens += 1
      const problem = nextOpenFailure
      nextOpenFailure = undefined
      if (problem !== undefined)
        return problem
      const paths = [pathOf(key, 0), pathOf(key, 1)] as const
      if (paths.some(path => !files.has(path))) {
        if (!create)
          return { kind: 'absent' }
        for (const path of paths) {
          if (!files.has(path))
            files.set(path, new Uint8Array(0))
        }
      }
      if (paths.some(path => locked.has(path) || elsewhere.has(path)))
        return { kind: 'busy' }
      paths.forEach(path => locked.add(path))
      return { kind: 'opened', slots: [handleFor(paths[0]), handleFor(paths[1])] }
    },
    listDocuments: async (userId) => {
      const documents = new Set<string>()
      for (const path of files.keys()) {
        const [owner, documentId] = path.split('/')
        if (owner === userId && documentId !== undefined)
          documents.add(documentId)
      }
      return { kind: 'listed', documentIds: [...documents].sort() }
    },
    removeUser: async (userId) => {
      const paths = [...files.keys()].filter(path => path.startsWith(`${userId}/`))
      if (paths.some(path => locked.has(path) || elsewhere.has(path)))
        return { kind: 'busy' }
      paths.forEach(path => files.delete(path))
      return { kind: 'removed' }
    },
    removeDocument: async (key) => {
      const paths = [pathOf(key, 0), pathOf(key, 1)]
      if (paths.some(path => locked.has(path) || elsewhere.has(path)))
        return { kind: 'busy' }
      paths.forEach(path => files.delete(path))
      return { kind: 'removed' }
    },
  }

  return {
    directory,
    file: (key, slot) => {
      const bytes = files.get(pathOf(key, slot))
      return bytes === undefined ? undefined : new Uint8Array(bytes)
    },
    putFile: (key, slot, bytes) => {
      if (bytes === undefined)
        files.delete(pathOf(key, slot))
      else
        files.set(pathOf(key, slot), new Uint8Array(bytes))
    },
    holdElsewhere: (key) => {
      const paths = [pathOf(key, 0), pathOf(key, 1)]
      paths.forEach(path => elsewhere.add(path))
      return () => paths.forEach(path => elsewhere.delete(path))
    },
    failWrite: (after, bytes, name) => {
      writeFailure = { after, bytes, name }
    },
    failNextOpen: (problem) => {
      nextOpenFailure = problem
    },
    openHandles: () => locked.size,
    opens: () => opens,
    flushes: () => flushes,
  }
}

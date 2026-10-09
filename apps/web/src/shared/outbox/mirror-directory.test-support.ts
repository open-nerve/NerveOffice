// 测试用：照 MirrorDirectory 的接口写的内存里的 OPFS（M4-P1 设计 §3.8）。文件按"用户/文档/槽位"存字节；同步访问句柄同一个文件同一时刻
// 只有一个（与浏览器一样：再拿交回 busy）；另有别的标签页占着句柄、下一次写入写到一半抛出（写满、出错）或者只写了一部分、没有 OPFS 这几样，
// 并记下每个槽位文件上改动的操作（截断、写、flush 的先后）
import type { DraftKey } from './draft-record.ts'
import type { MirrorDirectory, MirrorProblem, SlotFileInfo, SlotHandle } from './mirror-directory.ts'
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
  /** 再成功 after 次 write 之后，下一次只写前 bytes 个字节、不抛出（write 交回的字节数比要写的少） */
  readonly shortWrite: (after: number, bytes: number) => void
  /** 下一次 openSlots 交回这个问题 */
  readonly failNextOpen: (problem: MirrorProblem) => void
  /** 开着的句柄个数 */
  readonly openHandles: () => number
  /** openSlots 被调用的次数 */
  readonly opens: () => number
  /** flush 被调用的次数 */
  readonly flushes: () => number
  /** 这个槽位文件上改动的操作，按先后：truncate@大小、write@偏移、flush */
  readonly operations: (key: DraftKey, slot: 0 | 1) => readonly string[]
  /** 改一个槽位文件最后改动的时刻（模拟很久以前写的） */
  readonly touch: (key: DraftKey, slot: 0 | 1, lastModified: number) => void
}

function pathOf(key: DraftKey, slot: 0 | 1): string {
  return `${key.userId}/${key.documentId}/${SLOT_FILE_NAMES[slot]}`
}

/** clock：文件最后改动的时刻取它（墙上时间；默认一直是 0） */
export function fakeMirrorDirectory(options: { readonly clock?: () => number } = {}): FakeMirrorDirectory {
  const clock = options.clock ?? (() => 0)
  const files = new Map<string, Uint8Array<ArrayBuffer>>()
  const modified = new Map<string, number>()
  const locked = new Set<string>()
  const elsewhere = new Set<string>()
  /** name 为 undefined 时只写一部分、不抛出 */
  let writeFailure: { after: number, readonly bytes: number, readonly name: string | undefined } | undefined
  const operations = new Map<string, string[]>()
  let nextOpenFailure: MirrorProblem | undefined
  let opens = 0
  let flushes = 0

  function record(path: string, operation: string): void {
    operations.set(path, [...(operations.get(path) ?? []), operation])
    modified.set(path, clock())
  }

  function put(path: string, bytes: Uint8Array<ArrayBuffer>): void {
    files.set(path, bytes)
    modified.set(path, clock())
  }

  function documentPaths(): Map<string, readonly [string, string]> {
    const documents = new Map<string, readonly [string, string]>()
    for (const path of files.keys()) {
      const [owner, documentId] = path.split('/')
      if (owner !== undefined && documentId !== undefined)
        documents.set(`${owner}/${documentId}`, [owner, documentId])
    }
    return documents
  }

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
        let failure: { readonly bytes: number, readonly name: string | undefined } | undefined
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
        record(path, `write@${at}`)
        if (failure?.name !== undefined)
          throw new DOMException('写到一半出了错', failure.name)
        return written.byteLength
      },
      truncate: (size) => {
        files.set(path, live().slice(0, size))
        record(path, `truncate@${size}`)
      },
      getSize: () => live().byteLength,
      flush: () => {
        live()
        flushes += 1
        record(path, 'flush')
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
            put(path, new Uint8Array(0))
        }
      }
      if (paths.some(path => locked.has(path) || elsewhere.has(path)))
        return { kind: 'busy' }
      paths.forEach(path => locked.add(path))
      return { kind: 'opened', slots: [handleFor(paths[0]), handleFor(paths[1])] }
    },
    listDocuments: async (userId) => {
      const documents = [...documentPaths().values()].filter(([owner]) => owner === userId).map(([, documentId]) => documentId)
      return { kind: 'listed', documentIds: documents.sort() }
    },
    listUsers: async () => {
      const users = new Set([...documentPaths().values()].map(([owner]) => owner))
      return { kind: 'listed', userIds: [...users].sort() }
    },
    slotFiles: async (key) => {
      const paths = [pathOf(key, 0), pathOf(key, 1)] as const
      if (!paths.some(path => files.has(path)))
        return { kind: 'absent' }
      // 与浏览器一样（Chromium 系与 WebKit 实测）：别的句柄拿着时 getFile 照样读得出大小与改动时刻，删目录才是 busy
      const info = (path: string): SlotFileInfo | undefined => {
        const bytes = files.get(path)
        return bytes === undefined ? undefined : { size: bytes.byteLength, lastModified: modified.get(path) ?? 0 }
      }
      return { kind: 'files', files: [info(paths[0]), info(paths[1])] }
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
        put(pathOf(key, slot), new Uint8Array(bytes))
    },
    holdElsewhere: (key) => {
      const paths = [pathOf(key, 0), pathOf(key, 1)]
      paths.forEach(path => elsewhere.add(path))
      return () => paths.forEach(path => elsewhere.delete(path))
    },
    failWrite: (after, bytes, name) => {
      writeFailure = { after, bytes, name }
    },
    shortWrite: (after, bytes) => {
      writeFailure = { after, bytes, name: undefined }
    },
    failNextOpen: (problem) => {
      nextOpenFailure = problem
    },
    openHandles: () => locked.size,
    opens: () => opens,
    flushes: () => flushes,
    operations: (key, slot) => [...(operations.get(pathOf(key, slot)) ?? [])],
    touch: (key, slot, lastModified) => {
      modified.set(pathOf(key, slot), lastModified)
    },
  }
}

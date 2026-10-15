import type { DraftKey } from './draft-record.ts'
import { describe, expect, it, vi } from 'vitest'
import { DOCUMENT_ID, NOW, sampleStoredDraft, sampleWriter, USER_ID } from './draft-record.test-support.ts'
import { fakeDraftStore } from './draft-store.test-support.ts'
import { createLocalCleanup } from './local-cleanup.ts'
import { MIRROR_ROOT_NAME, opfsMirrorDirectory } from './mirror-directory.ts'
import { testCleanupPermit, testCleanupSessions } from './session-fence.test-support.ts'
import { RETIRED_WRITER_ID } from './writer-fence.ts'

// OPFS 的一层（审查 B4）：根目录注入一棵内存里的假句柄树——找目录与文件、建、同步访问句柄、getFile、列出、删，以及浏览器会抛出的几种错误。
// 浏览器里的行为（Chromium 系与 WebKit）另由镜像的浏览器层用例核对

const KEY: DraftKey = { userId: 'user-1', documentId: 'doc-1' }

function domError(name: string): DOMException {
  return new DOMException(name, name)
}

/** 假的同步访问句柄：记下开着没有 */
interface FakeSync {
  readonly read: (buffer: Uint8Array, options: { readonly at: number }) => number
  readonly write: (buffer: Uint8Array, options: { readonly at: number }) => number
  readonly truncate: (size: number) => void
  readonly getSize: () => number
  readonly flush: () => void
  readonly close: () => void
}

interface FakeFile {
  readonly kind: 'file'
  bytes: Uint8Array
  lastModified: number
  /** 同步访问句柄开着（别的标签页拿着也算） */
  locked: boolean
  /** 下一次 createSyncAccessHandle 抛出这个名字的错误 */
  failOpen?: string
  /** getFile 抛出这个名字的错误 */
  failRead?: string
  /** 这个文件句柄没有 createSyncAccessHandle（不是专用 Worker） */
  noSyncAccess?: boolean
}

interface FakeDirectory {
  readonly kind: 'directory'
  readonly children: Map<string, FakeDirectory | FakeFile>
  /** 找或建子目录、文件时抛出这个名字的错误 */
  failLookup?: string
}

function directory(): FakeDirectory {
  return { kind: 'directory', children: new Map() }
}

function file(bytes: Uint8Array = new Uint8Array(0), lastModified = 1_000): FakeFile {
  return { kind: 'file', bytes, lastModified, locked: false }
}

/** 这棵树里一个目录的句柄（FileSystemDirectoryHandle 用到的几样）；creates 记下带 create 的每一次查找（建没建都算：Chromium 里那样也碰目录库） */
function directoryHandle(node: FakeDirectory, creates: string[], opened: FakeSync[]): FileSystemDirectoryHandle {
  const lookup = <T extends 'directory' | 'file'>(name: string, kind: T, create: boolean): T extends 'directory' ? FakeDirectory : FakeFile => {
    if (node.failLookup !== undefined)
      throw domError(node.failLookup)
    if (create)
      creates.push(name)
    let child = node.children.get(name)
    if (child === undefined) {
      if (!create)
        throw domError('NotFoundError')
      child = kind === 'directory' ? directory() : file()
      node.children.set(name, child)
    }
    if (child.kind !== kind)
      throw domError('TypeMismatchError')
    return child as T extends 'directory' ? FakeDirectory : FakeFile
  }
  const handle = {
    kind: 'directory',
    getDirectoryHandle: async (name: string, options?: { readonly create?: boolean }) => directoryHandle(lookup(name, 'directory', options?.create === true), creates, opened),
    getFileHandle: async (name: string, options?: { readonly create?: boolean }) => fileHandle(lookup(name, 'file', options?.create === true), opened),
    removeEntry: async (name: string, options?: { readonly recursive?: boolean }) => {
      const child = node.children.get(name)
      if (child === undefined)
        throw domError('NotFoundError')
      if (child.kind === 'directory' && child.children.size > 0 && options?.recursive !== true)
        throw domError('InvalidModificationError')
      if (isLocked(child))
        throw domError('NoModificationAllowedError')
      node.children.delete(name)
    },
    async* entries() {
      for (const [name, child] of node.children)
        yield [name, { kind: child.kind }]
    },
  }
  return handle as unknown as FileSystemDirectoryHandle
}

function isLocked(node: FakeDirectory | FakeFile): boolean {
  return node.kind === 'file' ? node.locked : [...node.children.values()].some(isLocked)
}

function fileHandle(node: FakeFile, opened: FakeSync[]): FileSystemFileHandle {
  const handle: Record<string, unknown> = {
    kind: 'file',
    getFile: async () => {
      if (node.failRead !== undefined)
        throw domError(node.failRead)
      const bytes = new Uint8Array(node.bytes)
      return { size: bytes.byteLength, lastModified: node.lastModified, arrayBuffer: async () => bytes.buffer }
    },
  }
  if (node.noSyncAccess !== true) {
    handle.createSyncAccessHandle = async (): Promise<FakeSync> => {
      if (node.failOpen !== undefined) {
        const name = node.failOpen
        node.failOpen = undefined
        throw domError(name)
      }
      if (node.locked)
        throw domError('NoModificationAllowedError')
      node.locked = true
      let closed = false
      const sync: FakeSync = {
        read: (buffer, { at }) => {
          const part = node.bytes.subarray(at, at + buffer.byteLength)
          buffer.set(part)
          return part.byteLength
        },
        write: (buffer, { at }) => {
          const next = new Uint8Array(Math.max(node.bytes.byteLength, at + buffer.byteLength))
          next.set(node.bytes)
          next.set(buffer, at)
          node.bytes = next
          return buffer.byteLength
        },
        truncate: (size) => {
          node.bytes = node.bytes.slice(0, size)
        },
        getSize: () => node.bytes.byteLength,
        flush: () => {},
        close: () => {
          if (!closed)
            node.locked = false
          closed = true
        },
      }
      opened.push(sync)
      return sync
    }
  }
  return handle as unknown as FileSystemFileHandle
}

interface Tree {
  readonly root: FakeDirectory
  readonly creates: string[]
  readonly opened: FakeSync[]
  readonly mirror: ReturnType<typeof opfsMirrorDirectory>
}

/** 一棵树：根目录下按需放好镜像的目录（userId/documentId/a、b） */
function tree(): Tree {
  const root = directory()
  const creates: string[] = []
  const opened: FakeSync[] = []
  return { root, creates, opened, mirror: opfsMirrorDirectory(async () => directoryHandle(root, creates, opened)) }
}

/** 放好一份文档的目录与两个槽位文件 */
function putDocument(root: FakeDirectory, key: DraftKey, files: Readonly<Record<string, FakeFile>> = { a: file(), b: file() }): FakeDirectory {
  let top = root.children.get(MIRROR_ROOT_NAME)
  if (top === undefined) {
    top = directory()
    root.children.set(MIRROR_ROOT_NAME, top)
  }
  let user = (top as FakeDirectory).children.get(key.userId)
  if (user === undefined) {
    user = directory()
    ;(top as FakeDirectory).children.set(key.userId, user)
  }
  const document = directory()
  ;(user as FakeDirectory).children.set(key.documentId, document)
  for (const [name, node] of Object.entries(files))
    document.children.set(name, node)
  return document
}

describe('打开两个槽位：先不带 create 找，找不到才建；拿到一个、另一个拿不到时放开已拿到的', () => {
  it('第一次（create）：建出根目录、用户、文档的目录与 a、b；再打开不再建', async () => {
    const { creates, opened, mirror } = tree()
    const first = await mirror.openSlots(KEY, true)
    expect(first.kind).toBe('opened')
    expect(creates).toEqual([MIRROR_ROOT_NAME, 'user-1', 'doc-1', 'a', 'b'])
    opened.forEach(handle => handle.close())
    expect((await mirror.openSlots(KEY, true)).kind).toBe('opened')
    expect(creates, '已有的不碰目录库').toHaveLength(5)
  })

  it('不建（create 为假）：目录或者任何一个文件不在都是 absent，已拿到的放开', async () => {
    const { root, mirror } = tree()
    expect(await mirror.openSlots(KEY, false)).toEqual({ kind: 'absent' })
    const a = file()
    putDocument(root, KEY, { a })
    expect(await mirror.openSlots(KEY, false)).toEqual({ kind: 'absent' })
    expect(a.locked, '拿到的 a 放开了').toBe(false)
  })

  it('另一个被占着（别的标签页拿着 b）：busy，已拿到的 a 放开——两个标签页各拿一个时不互相锁死（审查 B4）', async () => {
    const { root, mirror } = tree()
    const a = file()
    const b = file()
    putDocument(root, KEY, { a, b })
    b.locked = true
    expect(await mirror.openSlots(KEY, true)).toEqual({ kind: 'busy' })
    expect(a.locked).toBe(false)
    b.failOpen = 'InvalidStateError'
    b.locked = false
    expect(await mirror.openSlots(KEY, true), 'WebKit 被占着时是 InvalidStateError').toEqual({ kind: 'busy' })
    expect(a.locked).toBe(false)
  })

  it('拿句柄时出错：写满、被策略禁止、别的错误各自归类，已拿到的放开；文件句柄没有同步访问（不是专用 Worker）：unsupported', async () => {
    for (const [name, expected] of [['QuotaExceededError', { kind: 'quota' }], ['SecurityError', { kind: 'failed' }], ['UnknownError', { kind: 'failed' }]] as const) {
      const { root, mirror } = tree()
      const a = file()
      const b = file()
      putDocument(root, KEY, { a, b })
      b.failOpen = name
      expect(await mirror.openSlots(KEY, true), name).toMatchObject(expected)
      expect(a.locked, name).toBe(false)
    }
    const { root, mirror } = tree()
    const a = file()
    putDocument(root, KEY, { a, b: { ...file(), noSyncAccess: true } })
    expect(await mirror.openSlots(KEY, true)).toEqual({ kind: 'unsupported' })
    expect(a.locked).toBe(false)
  })

  it('找目录时被策略禁止是 failed；只有 API 缺失才是 unsupported，不能据访问失败证明不存在', async () => {
    const { root, mirror } = tree()
    root.failLookup = 'SecurityError'
    expect(await mirror.openSlots(KEY, true)).toMatchObject({ kind: 'failed', error: { name: 'SecurityError' } })
    root.failLookup = 'NoModificationAllowedError'
    expect(await mirror.openSlots(KEY, true)).toEqual({ kind: 'busy' })
    root.failLookup = 'TypeError'
    expect(await mirror.openSlots(KEY, true)).toMatchObject({ kind: 'failed' })
    for (const unavailable of [opfsMirrorDirectory(() => undefined)]) {
      expect(await unavailable.openSlots(KEY, true)).toEqual({ kind: 'unsupported' })
      expect(await unavailable.listUsers()).toEqual({ kind: 'unsupported' })
      expect(await unavailable.listDocuments('user-1')).toEqual({ kind: 'unsupported' })
      expect(await unavailable.slotFiles(KEY)).toEqual({ kind: 'unsupported' })
      expect(await unavailable.readSlots(KEY)).toEqual({ kind: 'unsupported' })
      expect(await unavailable.removeUser('user-1')).toEqual({ kind: 'unsupported' })
      expect(await unavailable.removeDocument(KEY)).toEqual({ kind: 'unsupported' })
    }
  })

  it.each(['UnknownError', 'SecurityError', 'NotFoundError'])('根目录 %s 只证明读取失败，任何接口都不能推断没有镜像', async (name) => {
    const error = domError(name)
    for (const root of [async () => Promise.reject(error), () => {
      throw error
    }]) {
      const mirror = opfsMirrorDirectory(root)
      const failed = { kind: 'failed', error }
      expect(await mirror.openSlots(KEY, true)).toEqual(failed)
      expect(await mirror.openSlots(KEY, false)).toEqual(failed)
      expect(await mirror.listUsers()).toEqual(failed)
      expect(await mirror.listDocuments(KEY.userId)).toEqual(failed)
      expect(await mirror.slotFiles(KEY)).toEqual(failed)
      expect(await mirror.readSlots(KEY)).toEqual(failed)
      expect(await mirror.removeUser(KEY.userId)).toEqual(failed)
      expect(await mirror.removeDocument(KEY)).toEqual(failed)
    }
  })

  it('子目录 SecurityError 同样不能折成 unsupported，读取/枚举/删除均保留不确定事实', async () => {
    const { root, mirror } = tree()
    putDocument(root, KEY, { a: file(new Uint8Array([1, 2, 3])) })
    root.failLookup = 'SecurityError'
    const failed = { kind: 'failed', error: { name: 'SecurityError' } }
    expect(await mirror.listUsers()).toMatchObject(failed)
    expect(await mirror.listDocuments(KEY.userId)).toMatchObject(failed)
    expect(await mirror.slotFiles(KEY)).toMatchObject(failed)
    expect(await mirror.readSlots(KEY)).toMatchObject(failed)
    expect(await mirror.removeUser(KEY.userId)).toMatchObject(failed)
    expect(await mirror.removeDocument(KEY)).toMatchObject(failed)
    delete root.failLookup
    expect(await mirror.readSlots(KEY)).toMatchObject({ kind: 'bytes', files: [new Uint8Array([1, 2, 3]), undefined] })
  })
})

describe('真实目录分类进入完整清理与保留期', () => {
  const key = { userId: USER_ID, documentId: DOCUMENT_ID }

  function cleanupTree() {
    const t = tree()
    const store = fakeDraftStore()
    let fault: string | undefined
    const mirror = opfsMirrorDirectory(async () => {
      if (fault !== undefined)
        throw domError(fault)
      return directoryHandle(t.root, t.creates, t.opened)
    })
    const sessions = { ...testCleanupSessions(), finishUserCleanup: vi.fn(testCleanupSessions().finishUserCleanup) }
    const cleanup = createLocalCleanup({ store: store.store, sessions, directory: mirror, now: () => NOW })
    const bytes = new Uint8Array([10, 20, 30])
    putDocument(t.root, key, { a: file(bytes, NOW), b: file() })
    return {
      ...t,
      store,
      mirror,
      sessions,
      cleanup,
      bytes,
      fail: (name: string | undefined) => { fault = name },
    }
  }

  it.each(['UnknownError', 'SecurityError'])('非空镜像的根 %s：不清主库/墓碑、不提交 cleared；原许可在故障解除后可补清', async (name) => {
    const t = cleanupTree()
    t.store.putRaw('drafts', key, sampleStoredDraft())
    t.store.putRaw('writers', key, sampleWriter())
    expect(await t.mirror.readSlots(key)).toMatchObject({ kind: 'bytes', files: [t.bytes, new Uint8Array()] })
    const original = t.store.rawDraft(key)
    t.fail(name)
    expect(await t.cleanup.removeUser(testCleanupPermit())).toMatchObject({ kind: 'failed', error: { name } })
    expect(t.store.rawDraft(key)).toEqual(original)
    expect(t.store.rawWriter(key)).toMatchObject({ writerId: RETIRED_WRITER_ID })
    expect(t.sessions.finishUserCleanup).not.toHaveBeenCalled()
    t.fail(undefined)
    expect(await t.mirror.readSlots(key)).toMatchObject({ kind: 'bytes', files: [t.bytes, new Uint8Array()] })
    expect(await t.cleanup.removeUser(testCleanupPermit())).toEqual({ kind: 'cleared', pending: [] })
    expect(t.sessions.finishUserCleanup).toHaveBeenCalledExactlyOnceWith(testCleanupPermit())
    expect(t.store.rawDraft(key)).toBeUndefined()
    expect(t.store.rawWriter(key)).toBeUndefined()
    expect(await t.mirror.readSlots(key)).toEqual({ kind: 'absent' })
  })

  it.each(['UnknownError', 'SecurityError'])('保留期遇到根 %s：不得把镜像当作空集合丢弃墓碑', async (name) => {
    const t = cleanupTree()
    t.store.putRaw('writers', key, sampleWriter({ writerId: RETIRED_WRITER_ID }))
    const original = t.store.rawWriter(key)
    expect(await t.mirror.readSlots(key)).toMatchObject({ kind: 'bytes', files: [t.bytes, new Uint8Array()] })
    t.fail(name)
    expect(await t.cleanup.purgeExpired(NOW)).toMatchObject({ kind: 'purged', mirror: { kind: 'failed', error: { name } } })
    expect(t.store.rawWriter(key)).toEqual(original)
    t.fail(undefined)
    expect(await t.cleanup.purgeExpired(NOW)).toMatchObject({ kind: 'purged', mirror: { kind: 'done' } })
    expect(t.store.rawWriter(key)).toEqual(original)
    expect(await t.mirror.readSlots(key)).toMatchObject({ kind: 'bytes', files: [t.bytes, new Uint8Array()] })
  })
})

describe('列出、看文件、读、删（页面里也能用：不拿同步访问句柄）', () => {
  it('列出用户与文档：只列目录（文件不算），排好序；还没有镜像、这个人没有目录时是空的；列的时候出错如实交回', async () => {
    const { root, mirror } = tree()
    expect(await mirror.listUsers()).toEqual({ kind: 'listed', userIds: [] })
    expect(await mirror.listDocuments('user-1')).toEqual({ kind: 'listed', documentIds: [] })
    putDocument(root, { userId: 'user-2', documentId: 'doc-9' })
    putDocument(root, KEY)
    putDocument(root, { userId: 'user-1', documentId: 'doc-0' })
    ;(root.children.get(MIRROR_ROOT_NAME) as FakeDirectory).children.set('stray-file', file())
    expect(await mirror.listUsers()).toEqual({ kind: 'listed', userIds: ['user-1', 'user-2'] })
    expect(await mirror.listDocuments('user-1')).toEqual({ kind: 'listed', documentIds: ['doc-0', 'doc-1'] })
    expect(await mirror.listDocuments('nobody')).toEqual({ kind: 'listed', documentIds: [] })
    root.failLookup = 'InvalidStateError'
    expect(await mirror.listUsers()).toMatchObject({ kind: 'failed' })
    expect(await mirror.listDocuments('user-1')).toMatchObject({ kind: 'failed' })
  })

  it('槽位文件的大小与改动时刻、内容：别的句柄拿着时照样读得出；文件不在的是 undefined，目录不在是 absent；读的时候出错如实归类', async () => {
    const { root, mirror } = tree()
    expect(await mirror.slotFiles(KEY)).toEqual({ kind: 'absent' })
    expect(await mirror.readSlots(KEY)).toEqual({ kind: 'absent' })
    const a = file(new Uint8Array([1, 2, 3]), 5_000)
    a.locked = true
    putDocument(root, KEY, { a })
    expect(await mirror.slotFiles(KEY)).toEqual({ kind: 'files', files: [{ size: 3, lastModified: 5_000 }, undefined] })
    expect(await mirror.readSlots(KEY)).toEqual({ kind: 'bytes', files: [new Uint8Array([1, 2, 3]), undefined] })
    a.failRead = 'NotFoundError'
    expect(await mirror.slotFiles(KEY), '刚被删掉').toEqual({ kind: 'absent' })
    expect(await mirror.readSlots(KEY)).toEqual({ kind: 'absent' })
    a.failRead = 'NoModificationAllowedError'
    expect(await mirror.slotFiles(KEY)).toEqual({ kind: 'busy' })
    expect(await mirror.readSlots(KEY)).toEqual({ kind: 'busy' })
  })

  it.each(['UnknownError', 'NotFoundError', 'SecurityError'])('主线程读完非空第一槽后第二槽 %s，不谎报空目录或遗忘存在事实', async (name) => {
    const { root, mirror } = tree()
    const a = file(new Uint8Array([1, 2, 3]))
    putDocument(root, KEY, { a, b: { ...file(), failRead: name } })
    expect(await mirror.readSlots(KEY)).toMatchObject({ kind: 'failed', recordKnown: true, error: { name } })
    expect(a.bytes).toEqual(new Uint8Array([1, 2, 3]))
  })

  it('删文档、删用户：整个目录删掉；本来就不在算删了；有句柄开着时是 busy（不删）', async () => {
    const { root, mirror } = tree()
    expect(await mirror.removeDocument(KEY)).toEqual({ kind: 'removed' })
    expect(await mirror.removeUser('user-1')).toEqual({ kind: 'removed' })
    putDocument(root, { userId: 'user-1', documentId: 'doc-0' })
    expect(await mirror.removeDocument(KEY), '用户的目录在、这份文档的不在').toEqual({ kind: 'removed' })
    expect(await mirror.removeUser('user-9'), '根目录在、这个人的不在').toEqual({ kind: 'removed' })
    const a = file()
    putDocument(root, KEY, { a, b: file() })
    putDocument(root, { userId: 'user-1', documentId: 'doc-2' })
    a.locked = true
    expect(await mirror.removeDocument(KEY)).toEqual({ kind: 'busy' })
    expect(await mirror.removeUser('user-1')).toEqual({ kind: 'busy' })
    expect(await mirror.removeDocument({ userId: 'user-1', documentId: 'doc-2' })).toEqual({ kind: 'removed' })
    a.locked = false
    expect(await mirror.removeUser('user-1')).toEqual({ kind: 'removed' })
    expect(await mirror.listUsers()).toEqual({ kind: 'listed', userIds: [] })
  })
})

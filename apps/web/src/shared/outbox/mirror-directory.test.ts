import type { DraftKey } from './draft-record.ts'
import { describe, expect, it } from 'vitest'
import { MIRROR_ROOT_NAME, opfsMirrorDirectory } from './mirror-directory.ts'

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

/** 这棵树里一个目录的句柄（FileSystemDirectoryHandle 用到的几样）；creates 记下带 create 建出的条目 */
function directoryHandle(node: FakeDirectory, creates: string[], opened: FakeSync[]): FileSystemDirectoryHandle {
  const lookup = <T extends 'directory' | 'file'>(name: string, kind: T, create: boolean): T extends 'directory' ? FakeDirectory : FakeFile => {
    if (node.failLookup !== undefined)
      throw domError(node.failLookup)
    let child = node.children.get(name)
    if (child === undefined) {
      if (!create)
        throw domError('NotFoundError')
      child = kind === 'directory' ? directory() : file()
      node.children.set(name, child)
      creates.push(name)
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
    for (const [name, expected] of [['QuotaExceededError', { kind: 'quota' }], ['SecurityError', { kind: 'unsupported' }], ['UnknownError', { kind: 'failed' }]] as const) {
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

  it('找目录时出错：被策略禁止是 unsupported，别的照原样；没有 OPFS（拿不到根目录、根目录拿不到）一律 unsupported', async () => {
    const { root, mirror } = tree()
    root.failLookup = 'SecurityError'
    expect(await mirror.openSlots(KEY, true)).toEqual({ kind: 'unsupported' })
    root.failLookup = 'NoModificationAllowedError'
    expect(await mirror.openSlots(KEY, true)).toEqual({ kind: 'busy' })
    root.failLookup = 'TypeError'
    expect(await mirror.openSlots(KEY, true)).toMatchObject({ kind: 'failed' })
    for (const unavailable of [opfsMirrorDirectory(() => undefined), opfsMirrorDirectory(async () => Promise.reject(domError('UnknownError')))]) {
      expect(await unavailable.openSlots(KEY, true)).toEqual({ kind: 'unsupported' })
      expect(await unavailable.listUsers()).toEqual({ kind: 'unsupported' })
      expect(await unavailable.listDocuments('user-1')).toEqual({ kind: 'unsupported' })
      expect(await unavailable.slotFiles(KEY)).toEqual({ kind: 'unsupported' })
      expect(await unavailable.readSlots(KEY)).toEqual({ kind: 'unsupported' })
      expect(await unavailable.removeUser('user-1')).toEqual({ kind: 'unsupported' })
      expect(await unavailable.removeDocument(KEY)).toEqual({ kind: 'unsupported' })
    }
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

  it('删文档、删用户：整个目录删掉；本来就不在算删了；有句柄开着时是 busy（不删）', async () => {
    const { root, mirror } = tree()
    expect(await mirror.removeDocument(KEY)).toEqual({ kind: 'removed' })
    expect(await mirror.removeUser('user-1')).toEqual({ kind: 'removed' })
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

// OPFS 镜像的目录与槽位文件（M4-P1 设计 §3.8）：nerve-office-outbox/<userId>/<documentId>/ 下的 a 与 b。
// - Chromium 里 OPFS 的目录是一个 LevelDB（与 IndexedDB 同一类，崩溃重开时可能出事，S7 的调查）：建目录、建文件、删、改名、
//   createWritable 都改它；只有在 Worker 里用同步访问句柄改写已有的文件不碰它。所以这里只在第一次用到时建（先不带 create 找，
//   找不到才建），之后只拿同步访问句柄；删目录只在按用户清理与保留期（removeUser、removeDocument）。
// - 同步访问句柄只在专用 Worker 里有；同一个文件同一时刻只有一个（别的标签页占着时是 busy）。
// - 句柄与目录的接口不在 DOM 的类型库里（同步访问句柄只在 Worker 的类型库里；目录的异步迭代要 dom.asynciterable），按规范写出用到的几样。
// 这是与浏览器接线的一层：逻辑（两个槽位轮流写、退避、读与校验）在 draft-mirror.ts，那里注入这个接口、单元测试换成内存里的；
// 这一层由三个浏览器的浏览器层用例覆盖。发件箱 Worker 也引用这个文件：不引用 zod
import type { DraftKey } from './draft-record.ts'

/** 镜像在 OPFS 里的根目录名 */
export const MIRROR_ROOT_NAME = 'nerve-office-outbox'

/** 两个槽位文件的名字 */
export const SLOT_FILE_NAMES = ['a', 'b'] as const

/** 同步访问句柄里用到的几样（FileSystemSyncAccessHandle） */
export interface SlotHandle {
  readonly read: (buffer: Uint8Array, options: { readonly at: number }) => number
  readonly write: (buffer: Uint8Array, options: { readonly at: number }) => number
  readonly truncate: (size: number) => void
  readonly getSize: () => number
  readonly flush: () => void
  readonly close: () => void
}

/** OPFS 用不了（没有接口、不是专用 Worker、被策略禁止）、写满、别的错误 */
export type MirrorProblem
  = | { readonly kind: 'unsupported' }
    | { readonly kind: 'quota' }
    | { readonly kind: 'failed', readonly error: unknown }

/** 打开这份文档的两个槽位：拿到了两个句柄；文件不在（不建的时候）；被别的标签页占着；问题 */
export type OpenedSlots
  = | { readonly kind: 'opened', readonly slots: readonly [SlotHandle, SlotHandle] }
    | { readonly kind: 'absent' }
    | { readonly kind: 'busy' }
    | MirrorProblem

export type MirrorListOutcome = { readonly kind: 'listed', readonly documentIds: readonly string[] } | MirrorProblem

export type MirrorRemoveOutcome = { readonly kind: 'removed' } | { readonly kind: 'busy' } | MirrorProblem

export interface MirrorDirectory {
  /** 这份文档的两个槽位文件的同步访问句柄：create 为真时没有就建（目录与文件）；拿到一个、另一个拿不到时放开已拿到的 */
  readonly openSlots: (key: DraftKey, create: boolean) => Promise<OpenedSlots>
  /** 这个用户在镜像里有哪些文档（目录名）；没有这个用户的目录时为空 */
  readonly listDocuments: (userId: string) => Promise<MirrorListOutcome>
  /** 删掉这个用户的整个目录（退出登录、账户停用）；有句柄开着时是 busy */
  readonly removeUser: (userId: string) => Promise<MirrorRemoveOutcome>
  /** 删掉这份文档的目录（保留期）；有句柄开着时是 busy */
  readonly removeDocument: (key: DraftKey) => Promise<MirrorRemoveOutcome>
}

/** 文件句柄上的 createSyncAccessHandle（只在专用 Worker 里有） */
interface SyncCapableFile {
  readonly createSyncAccessHandle: () => Promise<SlotHandle>
}

function hasSyncAccess(file: FileSystemFileHandle): file is FileSystemFileHandle & SyncCapableFile {
  return typeof (file as Partial<SyncCapableFile>).createSyncAccessHandle === 'function'
}

function errorName(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'name' in error && typeof error.name === 'string' ? error.name : undefined
}

/**
 * 错误归类：NotFoundError 由调用处认（不在）；被别的句柄或可写流占着（Chromium 是 NoModificationAllowedError，WebKit 是 InvalidStateError）
 * 是 busy；写满；被策略禁止（SecurityError）当作用不了；别的照原样
 */
function problemOf(error: unknown): { readonly kind: 'busy' } | MirrorProblem {
  const name = errorName(error)
  if (name === 'NoModificationAllowedError' || name === 'InvalidStateError')
    return { kind: 'busy' }
  if (name === 'QuotaExceededError')
    return { kind: 'quota' }
  if (name === 'SecurityError')
    return { kind: 'unsupported' }
  return { kind: 'failed', error }
}

function isNotFound(error: unknown): boolean {
  return errorName(error) === 'NotFoundError'
}

/** OPFS 的根：页面与 Worker 里都是 navigator.storage.getDirectory()；没有这个接口时为 undefined */
function defaultRoot(): Promise<FileSystemDirectoryHandle> | undefined {
  const storage = (globalThis.navigator as { readonly storage?: { readonly getDirectory?: () => Promise<FileSystemDirectoryHandle> } } | undefined)?.storage
  return typeof storage?.getDirectory === 'function' ? storage.getDirectory() : undefined
}

/** 先不带 create 找（已有的不碰目录库），找不到并且 create 为真时才建；不建时找不到交回 undefined */
async function directoryIn(parent: FileSystemDirectoryHandle, name: string, create: boolean): Promise<FileSystemDirectoryHandle | undefined> {
  try {
    return await parent.getDirectoryHandle(name)
  }
  catch (error) {
    if (!isNotFound(error))
      throw error
  }
  return create ? parent.getDirectoryHandle(name, { create: true }) : undefined
}

async function fileIn(parent: FileSystemDirectoryHandle, name: string, create: boolean): Promise<FileSystemFileHandle | undefined> {
  try {
    return await parent.getFileHandle(name)
  }
  catch (error) {
    if (!isNotFound(error))
      throw error
  }
  return create ? parent.getFileHandle(name, { create: true }) : undefined
}

/** 目录里的子目录名（目录的异步迭代：DOM 的类型库里没有，按规范写出） */
async function childDirectories(directory: FileSystemDirectoryHandle): Promise<string[]> {
  const names: string[] = []
  for await (const [name, handle] of (directory as unknown as { entries: () => AsyncIterable<[string, FileSystemHandle]> }).entries()) {
    if (handle.kind === 'directory')
      names.push(name)
  }
  return names.sort()
}

/**
 * OPFS 里的镜像目录。root 默认是 navigator.storage.getDirectory()；没有这个接口、或者它拿不到根目录时一律 unsupported：
 * 拿不到根目录是这个来源在这里没有 OPFS——WebKit 的临时数据存储（Playwright 默认的上下文）报 UnknownError，Firefox 的隐私窗口报
 * SecurityError；不当作一时的出错去退避再试。
 * 删目录（removeUser、removeDocument）不用同步访问句柄，页面里也能做（P4 的退出登录、保留期在平台页面里）
 */
export function opfsMirrorDirectory(root: () => Promise<FileSystemDirectoryHandle> | undefined = defaultRoot): MirrorDirectory {
  async function rootDirectory(): Promise<FileSystemDirectoryHandle | 'unsupported'> {
    const opened = root()
    if (opened === undefined)
      return 'unsupported'
    try {
      return await opened
    }
    catch {
      return 'unsupported'
    }
  }

  async function base(create: boolean): Promise<FileSystemDirectoryHandle | undefined | 'unsupported'> {
    const top = await rootDirectory()
    return top === 'unsupported' ? top : directoryIn(top, MIRROR_ROOT_NAME, create)
  }

  async function documentDirectory(key: DraftKey, create: boolean): Promise<FileSystemDirectoryHandle | undefined | 'unsupported'> {
    const top = await base(create)
    if (top === undefined || top === 'unsupported')
      return top
    const user = await directoryIn(top, key.userId, create)
    return user === undefined ? undefined : directoryIn(user, key.documentId, create)
  }

  async function removeEntry(parent: () => Promise<FileSystemDirectoryHandle | undefined | 'unsupported'>, name: string): Promise<MirrorRemoveOutcome> {
    try {
      const directory = await parent()
      if (directory === 'unsupported')
        return { kind: 'unsupported' }
      if (directory !== undefined)
        await directory.removeEntry(name, { recursive: true })
      return { kind: 'removed' }
    }
    catch (error) {
      return isNotFound(error) ? { kind: 'removed' } : problemOf(error)
    }
  }

  return {
    openSlots: async (key, create) => {
      const opened: SlotHandle[] = []
      try {
        const directory = await documentDirectory(key, create)
        if (directory === 'unsupported')
          return { kind: 'unsupported' }
        if (directory === undefined)
          return { kind: 'absent' }
        for (const name of SLOT_FILE_NAMES) {
          const file = await fileIn(directory, name, create)
          if (file === undefined) {
            opened.forEach(handle => handle.close())
            return { kind: 'absent' }
          }
          if (!hasSyncAccess(file)) {
            opened.forEach(handle => handle.close())
            return { kind: 'unsupported' }
          }
          opened.push(await file.createSyncAccessHandle())
        }
        const [a, b] = opened
        if (a === undefined || b === undefined)
          throw new Error('两个槽位的句柄没有拿齐')
        return { kind: 'opened', slots: [a, b] }
      }
      catch (error) {
        opened.forEach(handle => handle.close())
        return isNotFound(error) ? { kind: 'absent' } : problemOf(error)
      }
    },
    listDocuments: async (userId) => {
      try {
        const top = await base(false)
        if (top === 'unsupported')
          return { kind: 'unsupported' }
        const user = top === undefined ? undefined : await directoryIn(top, userId, false)
        return { kind: 'listed', documentIds: user === undefined ? [] : await childDirectories(user) }
      }
      catch (error) {
        const problem = problemOf(error)
        return problem.kind === 'busy' ? { kind: 'failed', error } : problem
      }
    },
    removeUser: async userId => removeEntry(async () => base(false), userId),
    removeDocument: async key => removeEntry(async () => {
      const top = await base(false)
      return top === undefined || top === 'unsupported' ? top : directoryIn(top, key.userId, false)
    }, key.documentId),
  }
}

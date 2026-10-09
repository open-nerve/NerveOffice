// 测试构建里看、改 OPFS 镜像文件的 Worker（M4-P1 S9 的浏览器层用例）：同步访问句柄只在专用 Worker 里有，页面里的探针（pipeline-probe.ts）
// 经它读出槽位文件的字节（页面里按生产的格式校验）、把槽位改坏（截断、写进垃圾），模拟写一半与损坏。三个浏览器同一个写法。
// 只改已经存在的文件，不建；用之前要先让发件箱 Worker 放开句柄（句柄同一时刻一个文件只有一个）。只在测试构建里（探针创建它）
import type { SlotHandle } from '../../../../shared/outbox/mirror-directory.ts'
import { MIRROR_ROOT_NAME } from '../../../../shared/outbox/mirror-directory.ts'

/** 要做的：读一个槽位文件；截成 size 字节；整个换成 size 个 value */
export type OpfsProbeCall
  = | { readonly op: 'read', readonly path: readonly string[] }
    | { readonly op: 'truncate', readonly path: readonly string[], readonly size: number }
    | { readonly op: 'fill', readonly path: readonly string[], readonly size: number, readonly value: number }

export type OpfsProbeRequest = OpfsProbeCall & { readonly id: number }

export type OpfsProbeReply
  = | { readonly id: number, readonly ok: true, readonly bytes: Uint8Array<ArrayBuffer> | null }
    | { readonly id: number, readonly ok: false, readonly error: { readonly name: string, readonly message: string } }

const scope = globalThis as unknown as {
  addEventListener: (type: 'message', listener: (event: MessageEvent<OpfsProbeRequest>) => void) => void
  postMessage: (message: OpfsProbeReply, transfer: Transferable[]) => void
}

/** 文件句柄上的 createSyncAccessHandle（DOM 的类型库里没有） */
async function openFile(path: readonly string[]): Promise<SlotHandle | null> {
  let directory = await navigator.storage.getDirectory()
  const names = [MIRROR_ROOT_NAME, ...path]
  const fileName = names.pop()
  if (fileName === undefined)
    throw new TypeError('路径是空的')
  try {
    for (const name of names)
      directory = await directory.getDirectoryHandle(name)
    const file = await directory.getFileHandle(fileName)
    return await (file as unknown as { createSyncAccessHandle: () => Promise<SlotHandle> }).createSyncAccessHandle()
  }
  catch (error) {
    if (typeof error === 'object' && error !== null && 'name' in error && error.name === 'NotFoundError')
      return null
    throw error
  }
}

async function handle(request: OpfsProbeRequest): Promise<Uint8Array<ArrayBuffer> | null> {
  const file = await openFile(request.path)
  if (file === null)
    return null
  try {
    switch (request.op) {
      case 'read': {
        const bytes = new Uint8Array(file.getSize())
        file.read(bytes, { at: 0 })
        return bytes
      }
      case 'truncate':
        file.truncate(request.size)
        file.flush()
        return null
      case 'fill':
        file.truncate(0)
        file.write(new Uint8Array(request.size).fill(request.value), { at: 0 })
        file.flush()
        return null
    }
  }
  finally {
    file.close()
  }
}

scope.addEventListener('message', (event) => {
  const request = event.data
  void handle(request).then(
    bytes => scope.postMessage({ id: request.id, ok: true, bytes }, bytes === null ? [] : [bytes.buffer]),
    (error: unknown) => {
      const described = typeof error === 'object' && error !== null && 'name' in error && 'message' in error ? { name: String(error.name), message: String(error.message) } : { name: 'Error', message: String(error) }
      scope.postMessage({ id: request.id, ok: false, error: described }, [])
    },
  )
})

// 只读观察真实页面的 IndexedDB；不创建 probe 来源，不调用页面内部捕获/写入工厂。
// 解密在测试进程独立按落盘协议执行，校验磁盘正文与真实 HTTP 的 gzip 一致。
import type { LocalKey } from '@nerve-office/contracts'
import type { Page } from '@playwright/test'
import type { DraftKey, DraftMeta } from './outbox-probe.ts'
import { Buffer } from 'node:buffer'
import { createDecipheriv } from 'node:crypto'
import { gunzipSync } from 'node:zlib'
import { localKeySchema } from '@nerve-office/contracts'
import { e2eOrigin } from './environment.ts'
import { expect } from './fixtures.ts'

export interface DiskDraft extends DraftMeta {
  readonly ivHex: string
  readonly ciphertextHex: string
}

export interface DiskWriter {
  readonly lastDraftSeq: number
  readonly writeEpoch: number
  readonly writerId: string
}

export interface LocalDisk {
  readonly draft: DiskDraft | null
  readonly writer: DiskWriter | null
}

/** 只读记录真实 Worker 完成回包和 fetch 入口的顺序；不暂停、不改请求或结果。 */
export async function observeLocalSaveOrder(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const events: string[] = []
    Object.assign(window, { __localSaveOrder: events })
    const NativeWorker = Worker
    globalThis.Worker = class extends NativeWorker {
      readonly calls = new Map<number, string>()
      readonly observed: boolean

      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options)
        this.observed = options?.name === 'nerve-outbox'
        this.addEventListener('message', (message) => {
          const reply = message.data as { readonly id?: number, readonly ok?: boolean, readonly result?: { readonly kind?: string } }
          if (reply.id === undefined)
            return
          const type = this.calls.get(reply.id)
          this.calls.delete(reply.id)
          if (type === 'register' || type === 'write' || type === 'mark-in-flight')
            events.push(`${type}:${reply.ok === true ? reply.result?.kind : 'failed'}`)
        })
      }

      override postMessage(message: unknown, options?: Transferable[] | StructuredSerializeOptions): void {
        const call = message as { readonly id: number, readonly type: string }
        if (this.observed)
          this.calls.set(call.id, call.type)
        if (Array.isArray(options))
          super.postMessage(message, options)
        else
          super.postMessage(message, options)
      }
    }
    const nativeFetch = globalThis.fetch
    globalThis.fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input, location.href)
      if ((init?.method ?? (input instanceof Request ? input.method : 'GET')) === 'PUT' && /^\/api\/documents\/[^/]+\/content$/.test(url.pathname))
        events.push('http:save')
      return nativeFetch(input, init)
    }
  })
}

export async function localSaveOrder(page: Page): Promise<readonly string[]> {
  return page.evaluate(() => [...(window as unknown as { readonly __localSaveOrder: string[] }).__localSaveOrder])
}

export async function readLocalDisk(page: Page, key: DraftKey): Promise<LocalDisk> {
  return page.evaluate(async (key) => {
    return new Promise<LocalDisk>((resolve, reject) => {
      const open = indexedDB.open('nerve-office-outbox')
      // 能力关闭时库可以根本不存在；取消创建，不让观察本身创建一份库。
      let absent = false
      open.onupgradeneeded = () => {
        absent = true
        open.transaction?.abort()
      }
      open.onerror = () => absent ? resolve({ draft: null, writer: null }) : reject(open.error)
      open.onsuccess = () => {
        const db = open.result
        const tx = db.transaction(['drafts', 'writers'], 'readonly')
        const draft: IDBRequest<unknown> = tx.objectStore('drafts').get([key.userId, key.documentId])
        const writer: IDBRequest<unknown> = tx.objectStore('writers').get([key.userId, key.documentId])
        tx.onabort = () => {
          db.close()
          reject(tx.error)
        }
        tx.oncomplete = () => {
          db.close()
          const stored = draft.result as (DraftMeta & { readonly iv: Uint8Array, readonly ciphertext: Uint8Array }) | undefined
          const hex = (bytes: Uint8Array): string => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
          const { iv, ciphertext, ...meta } = stored ?? { iv: new Uint8Array(), ciphertext: new Uint8Array() }
          resolve({ draft: stored === undefined ? null : { ...meta as DraftMeta, ivHex: hex(iv), ciphertextHex: hex(ciphertext) }, writer: writer.result as DiskWriter | undefined ?? null })
        }
      }
    })
  }, key)
}

/** 服务端实际密钥，不从产品内存导出 CryptoKey。密钥不进入日志或断言消息。 */
export async function currentLocalKey(page: Page): Promise<LocalKey> {
  const { csrfToken } = await (await page.request.get('/api/auth/session')).json() as { readonly csrfToken: string }
  const response = await page.request.post('/api/local-key', { headers: { 'origin': e2eOrigin(), 'x-csrf-token': csrfToken } })
  expect(response.status()).toBe(200)
  return localKeySchema.parse(await response.json())
}

export function diskSnapshot(draft: DiskDraft, key: LocalKey): string {
  const format = draft.format
  const request = draft.inFlight
  // 协议金标准顺序；独立于生产 draftAad 实现，包含所有明文元数据。
  const aad = ['nerve-office/outbox-draft/v1', draft.userId, draft.documentId, draft.recordVersion, draft.draftSeq, draft.baseRevision, draft.writeEpoch, draft.writerId, draft.writtenBy, [format.clientBuild, format.univerVersion, format.profile, format.formatVersion], draft.formulasPending, draft.keyVersion, request === null ? null : [request.requestId, request.clientInstanceId, request.localSeq, request.sentAt], draft.rawBytes, draft.updatedAt]
  const sealed = Buffer.from(draft.ciphertextHex, 'hex')
  const decipher = createDecipheriv('aes-256-gcm', Buffer.from(key.key, 'base64'), Buffer.from(draft.ivHex, 'hex'), { authTagLength: 16 })
  decipher.setAAD(Buffer.from(JSON.stringify(aad)))
  decipher.setAuthTag(sealed.subarray(-16))
  const gzip = Buffer.concat([decipher.update(sealed.subarray(0, -16)), decipher.final()])
  return gunzipSync(gzip).toString('utf8')
}

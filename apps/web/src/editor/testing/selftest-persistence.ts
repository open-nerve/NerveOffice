// 测试构建共用的只读持久证据。AAD 与解密独立于产品恢复器；不把密钥、正文交给宿主。
import type { StoredDraft } from '../../shared/outbox/draft-record.ts'
import { createCrashWriteEvidence } from './selftest-crash-writes.ts'

export async function selftestSha256(text: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

/** 只在页面内取得本轮测试用户的真实密钥，按固定格式独立解密 IDB 原件。 */
export async function decryptSelftestDraft(draft: StoredDraft, csrfToken: string): Promise<string> {
  const response = await fetch('/api/local-key', { method: 'POST', headers: { 'x-csrf-token': csrfToken }, signal: AbortSignal.timeout(10_000) })
  if (!response.ok)
    throw new Error('无法独立取得本机密钥')
  const local = await response.json() as { version: number, key: string }
  if (local.version !== draft.keyVersion)
    throw new Error('磁盘密钥版本与服务端不同')
  const key = await crypto.subtle.importKey('raw', Uint8Array.from(atob(local.key), char => char.charCodeAt(0)), 'AES-GCM', false, ['decrypt'])
  const f = draft.format
  const flight = draft.inFlight
  // AAD 金标准字段顺序，独立于产品 draftAad/openDraft，与测试进程 local-draft.ts 的核对口径一致。
  const aad = ['nerve-office/outbox-draft/v1', draft.userId, draft.documentId, draft.recordVersion, draft.draftSeq, draft.baseRevision, draft.writeEpoch, draft.writerId, draft.writtenBy, [f.clientBuild, f.univerVersion, f.profile, f.formatVersion], draft.formulasPending, draft.keyVersion, flight === null ? null : [flight.requestId, flight.clientInstanceId, flight.localSeq, flight.sentAt], draft.rawBytes, draft.updatedAt]
  const gzip = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: draft.iv, additionalData: new TextEncoder().encode(JSON.stringify(aad)), tagLength: 128 }, key, draft.ciphertext)
  return new Response(new Blob([gzip]).stream().pipeThrough(new DecompressionStream('gzip'))).text()
}

/** 必须在本页生产 Worker 创建之前安装；释放后旧 Worker 的事件也不再记录。 */
export function observeSelftestWrites(target: { Worker: typeof Worker } = window) {
  const evidence = createCrashWriteEvidence()
  const NativeWorker = target.Worker
  let active = true
  class ObservedWorker extends NativeWorker {
    readonly outbox: boolean

    constructor(url: string | URL, options?: WorkerOptions) {
      super(url, options)
      this.outbox = options?.name === 'nerve-outbox'
      this.addEventListener('message', (event: MessageEvent<unknown>) => {
        if (active && this.outbox)
          evidence.received(this, event.data)
      })
    }

    override postMessage(message: unknown, options?: Transferable[] | StructuredSerializeOptions): void {
      if (active && this.outbox)
        evidence.sent(this, message)
      if (Array.isArray(options))
        super.postMessage(message, options)
      else
        super.postMessage(message, options)
    }
  }
  target.Worker = ObservedWorker
  return {
    ...evidence,
    dispose(): void {
      active = false
      if (target.Worker === ObservedWorker)
        target.Worker = NativeWorker
    },
  }
}

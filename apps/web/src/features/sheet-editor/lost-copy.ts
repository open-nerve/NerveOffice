// 失去编辑权之后的那一份（M3-P2 设计 §3.2、§3.4）：失去编辑权时捕获的本页内容与失去的时刻，"另存为副本"上传它。
// 每失去一次编辑权新建一个（阅读与编辑的状态机 edit-mode.ts 持有），按最新的内容回到阅读之后丢掉：快照、时刻与副本的请求
// 都只属于这一次，不跨流程留着。
// 副本的请求（requestId 与标题）：结果未知之后再试沿用（幂等，服务端只建一份）；成功或确定被拒绝之后换新的。
import type { ConflictCopyQuery, CreatedDocument } from '@nerve-office/contracts'
import type { CompressSnapshot } from './save-coordinator.ts'
import { conflictCopyTitle } from '@nerve-office/contracts'
import { isDefiniteRejection } from '../../shared/api/index.ts'

/** 另存为副本的标题里的时间：页面所在的时区，写到分钟，例如"2026-10-04 15:30" */
export function conflictCopyLabel(at: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`
}

export interface LostCopyOptions {
  readonly documentId: string
  /** 失去编辑权时捕获的本页内容 */
  readonly snapshot: string
  /** 失去编辑权的时刻（墙上时间）：副本的标题里的时间用它，不用点"另存为副本"的时刻 */
  readonly lostAt: Date
  /** 捕获时公式还没收齐（M3-P3 设计 §3.8）：副本带上"公式待更新"，服务端记在副本上 */
  readonly formulasPending: boolean
  /** 原文档现在的标题：副本的标题以它开头 */
  readonly title: () => string
  readonly newId: () => string
  readonly compress: CompressSnapshot
  /** 另存为副本的请求（M3-P2 设计 §3.2） */
  readonly conflictCopy: (documentId: string, query: ConflictCopyQuery, body: Uint8Array<ArrayBuffer>) => Promise<CreatedDocument>
}

export interface LostCopy {
  /** 上传快照、新建一份文档，交回它；失败时抛出那次的错误（内容留着，可以再试） */
  readonly save: () => Promise<CreatedDocument>
}

export function createLostCopy(options: LostCopyOptions): LostCopy {
  /** 这一次的请求：结果未知之后再试沿用 */
  let query: ConflictCopyQuery | undefined
  return {
    save: async () => {
      const sending = query ?? { requestId: options.newId(), title: conflictCopyTitle(options.title(), conflictCopyLabel(options.lostAt)), formulasPending: options.formulasPending }
      query = sending
      try {
        const created = await options.conflictCopy(options.documentId, sending, await options.compress(options.snapshot))
        query = undefined
        return created
      }
      catch (error) {
        // 确定被拒绝：这一次没有建，下次换新的 requestId；结果未知时沿用（服务端只建一份）
        if (isDefiniteRejection(error))
          query = undefined
        throw error
      }
    },
  }
}

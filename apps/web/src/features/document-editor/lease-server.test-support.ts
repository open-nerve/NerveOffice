// 测试用：一份文档在服务端的编辑租约（edit-lease.ts 的 EditLeaseApi 的假实现）。同一个 fakeLeaseServer 的接口给几个"标签页"共用，就像它们
// 连着同一个服务端——本机锁的争用由服务端裁决（M3-P6 设计 §3.13，Codex 评审 CX2）的用例要几页对同一个事实：哪一代是当前的。几页都是同一个人
// （holder），只管这一份文档的当前一代，规则照服务端（apps/api 的 edit-lease-rules.ts）里与这里有关的几条：
// - 申请：没有、已经释放就发新的一代；占着的是同一个页面——重试，发新的一代；是这个人的别的页面——带 self 就接管（新的一代记下被接管的那一代
//   的令牌），不带就被占用（EDIT_LEASE_HELD，sameUser）；
// - 续租：令牌是当前这一代的、没有结束——成功；当前这一代已经释放——released；对不上——被接管的那一代 taken_over（forced 为假），别的 replaced；
// - 释放：令牌是当前这一代的、没有结束才记 released，别的什么也不改。
// 申请、续租都在调用的那一刻"提交"，回包是不是迟到由用例决定（先拿到回答、等用例放行再交回）：E2E 里 route.fetch() 先执行真实的服务端事务、
// 延后送达回包的样子。
import type { AcquiredEditLease, RenewedEditLease, UserSummary } from '@nerve-office/contracts'
import type { EditLeaseApi } from './edit-lease.ts'
import { ApiError } from '../../shared/api/index.ts'

/** 服务端现在的一代 */
export interface ServedGeneration {
  /** 代次（第几代，从 1 起） */
  readonly epoch: number
  /** 持有它的页面（clientInstanceId） */
  readonly page: string
  readonly token: string
  /** 被它接管的那一代的令牌（本人接管时）；不是接管来的为 undefined */
  readonly takenOver: string | undefined
  readonly released: boolean
}

export interface FakeLeaseServer {
  /** 共用的接口（申请带上页面的 clientInstanceId；续租、释放按令牌） */
  readonly api: Pick<EditLeaseApi, 'acquire' | 'renew' | 'release'>
  /** 现在的一代（还没人申请过时为 undefined） */
  readonly current: () => ServedGeneration | undefined
}

const SERVER_TIME = '2026-10-04T03:03:10.000Z'
const EXPIRES_AT = '2026-10-04T03:04:40.000Z'
const RENEWED: RenewedEditLease = { expiresAt: EXPIRES_AT, request: null, localKeyVersion: null }

/** 第 epoch 代的令牌（43 个字符，同契约的长度） */
export function servedToken(epoch: number): string {
  return `G${String(epoch).padStart(3, '0')}`.padEnd(43, 'x')
}

/** 编辑权已失效（EDIT_LEASE_LOST）：被接管的带 forced */
function leaseLost(reason: string, forced?: boolean): ApiError {
  return new ApiError(409, 'EDIT_LEASE_LOST', '编辑权已失效', { details: forced === undefined ? { reason } : { reason, forced } })
}

/**
 * 一份文档的服务端租约（见文件头）。holder 是几页共同的用户（被占用时的详情里是他）；revision 是申请回答的修订号（默认 3：与编辑模式的用例
 * 载入的内容同一版，进入编辑时不取内容）
 */
export function fakeLeaseServer(holder: UserSummary, revision = 3): FakeLeaseServer {
  let current: ServedGeneration | undefined

  function grant(page: string, takenOver: string | undefined): AcquiredEditLease {
    const epoch = (current?.epoch ?? 0) + 1
    current = { epoch, page, token: servedToken(epoch), takenOver, released: false }
    return { token: current.token, writeEpoch: epoch, revision, source: null, expiresAt: EXPIRES_AT, interruption: null, formulasPending: false }
  }

  return {
    api: {
      acquire: async (_documentId, page, options) => {
        if (current === undefined || current.released || current.page === page)
          return grant(page, undefined)
        if (options?.takeover === 'self')
          return grant(page, current.token)
        throw new ApiError(409, 'EDIT_LEASE_HELD', '你在别处正在编辑', {
          details: { holder, lastActiveAt: SERVER_TIME, sameUser: true, sameSession: true, canTakeOver: false, request: null },
          serverTime: Date.parse(SERVER_TIME),
        })
      },
      renew: async (_documentId, token) => {
        if (current === undefined)
          throw leaseLost('none')
        if (current.token !== token)
          throw current.takenOver === token ? leaseLost('taken_over', false) : leaseLost('replaced')
        if (current.released)
          throw leaseLost('released')
        return RENEWED
      },
      release: async (_documentId, token) => {
        if (current?.token === token && !current.released)
          current = { ...current, released: true }
      },
    },
    current: () => current,
  }
}

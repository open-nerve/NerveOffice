// 带 requestId 的新建（新建表格、新建文件夹、复制，M2-P6 复核 M1）：同一件事在有结论之前沿用同一个 requestId，服务端按它只做一次。
// 规则只写在这里，各处共用；保存的状态机（features/sheet-editor/save-coordinator.ts）是同一类问题的另一处实现。
import { ApiError, isAuthenticationError, isCsrfTokenError, isDefiniteRejection, isUnknownOutcome } from './client.ts'

/**
 * 会话类的拒绝（未登录、登录已过期、CSRF 令牌不对）：请求在进入业务之前就被拦下，服务端没有看它的 requestId，
 * 说明不了更早那一次结果未知的请求有没有生效
 */
function isSessionRejection(error: unknown): boolean {
  return isAuthenticationError(error) || isCsrfTokenError(error)
}

/**
 * 这件事有了结论、下一次要换新的 requestId：与载荷有关的确定拒绝（会话类以外的 4xx：内容不合法、没有权限、不存在、
 * 同名、REQUEST_ID_CONFLICT……）。结果未知（网络、5xx、回包读不出来）、服务端忙（503，这一次确定没有生效，更早那一次却可能生效了）
 * 与会话类的拒绝都不算：沿用同一个，再试时服务端照样只做一次
 */
function concludes(error: unknown): boolean {
  return isDefiniteRejection(error) && !isSessionRejection(error)
}

/** 同一个 requestId 已经被另一个请求用掉了（载荷不同） */
function isRequestIdConflict(error: unknown): error is ApiError {
  return error instanceof ApiError && error.code === 'REQUEST_ID_CONFLICT'
}

export interface RequestIdLedger {
  /**
   * 带着这件事（key，例如"在哪里新建"、"复制到哪里"）的 requestId 发出请求，按结果记账：
   * - 成功，或者与载荷有关的确定拒绝：这件事有了结论，下一次换新的；
   * - 结果未知、服务端忙、会话类的拒绝：留着，再试沿用同一个（之前有过结果未知的，之后的会话类拒绝同样留着）。
   * 失败时原样抛出。key 只包含"同一件事"的部分：新建文件夹不含名称，结果未知之后改了名再提交，服务端以 REQUEST_ID_CONFLICT
   * 拒绝，界面据此说明上一次可能已经建好（earlierAttemptDone），而不是悄悄多建一个
   */
  readonly send: <T>(key: string, request: (requestId: string) => Promise<T>) => Promise<T>
  /**
   * 这次失败说明之前结果未知的那一次已经生效：服务端认出了那一次用过的 requestId，而这一次的载荷不同（REQUEST_ID_CONFLICT）。
   * 界面刷新相关的列表，说明"上一次可能已经建好"；requestId 已经换新，再提交就是另一件事
   */
  readonly earlierAttemptDone: (error: unknown) => boolean
}

/** 一件事还没有结论的那个 requestId；unknown：用它发出的请求里有过结果未知的 */
interface Pending {
  readonly id: string
  unknown: boolean
}

/**
 * 页面一份（app/runtime.ts 建，经 RequestIdLedgerContext 给组件）：组件随导航卸载、再回来时，结果未知的那件事仍沿用原来的 requestId。
 * 只有还没有结论的事留在表里（结果未知、服务端忙、会话类的拒绝），最多与这一页上点过的新建、复制的去处一样多。
 */
export function createRequestIdLedger(newId: () => string = () => crypto.randomUUID()): RequestIdLedger {
  const pending = new Map<string, Pending>()
  /** 说明"之前那一次已经生效"的失败（REQUEST_ID_CONFLICT 的错误对象） */
  const doneEarlier = new WeakSet<object>()

  function conclude(key: string, entry: Pending): void {
    if (pending.get(key) === entry)
      pending.delete(key)
  }

  return {
    send: async (key, request) => {
      const entry = pending.get(key) ?? { id: newId(), unknown: false }
      pending.set(key, entry)
      try {
        const result = await request(entry.id)
        conclude(key, entry)
        return result
      }
      catch (error) {
        if (isUnknownOutcome(error)) {
          entry.unknown = true
        }
        else if (concludes(error)) {
          if (entry.unknown && isRequestIdConflict(error))
            doneEarlier.add(error)
          conclude(key, entry)
        }
        throw error
      }
    },
    earlierAttemptDone: error => typeof error === 'object' && error !== null && doneEarlier.has(error),
  }
}

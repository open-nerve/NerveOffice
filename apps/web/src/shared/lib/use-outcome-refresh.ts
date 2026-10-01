import type { RefreshIfUnknownOptions } from '../api/write-outcome.ts'
import { useCallback, useRef, useState } from 'react'
import { refreshIfUnknown } from '../api/write-outcome.ts'

/** 失败之后按共用的做法刷新：参数与 shared/api/write-outcome.ts 的 refreshIfUnknown 相同（晚到的刷新由这里接住），兑现为刷新好了没有 */
export type RefreshAfterFailure = (error: unknown, refresh: () => Promise<unknown>, options?: Omit<RefreshIfUnknownOptions, 'onLateRefresh'>) => Promise<boolean>

export interface OutcomeRefresh {
  /** 上一次失败之后页面刷新好了没有：说明据此说"已刷新"还是"没能刷新"（M2-P6 复核第三批 G-a）。每次失败都重新记下 */
  readonly refreshed: boolean
  readonly refreshAfterFailure: RefreshAfterFailure
}

/**
 * 写操作失败之后的刷新与"刷新好了没有"（确认的弹窗、管理界面的弹窗与表单、成员页、新建与整理的表单共用）。
 * 刷新到了时限还没回来时先按没能刷新说明；刷新在后台继续，之后成功了就改记为刷新好了（M2-P6 复核第五批 G4）——表格已经更新，
 * 说明不再说"页面没能刷新"；说明在 role="alert" 里，改过的文字读屏读得到。只改最近这一次失败的：再提交之后，
 * 前一次失败的刷新晚到，不改这一次的说法
 */
export function useOutcomeRefresh(): OutcomeRefresh {
  const [refreshed, setRefreshed] = useState(false)
  /** 第几次失败：晚到的刷新据此认出自己是不是最近这一次的 */
  const attemptRef = useRef(0)
  const refreshAfterFailure = useCallback<RefreshAfterFailure>(async (error, refresh, options) => {
    attemptRef.current += 1
    const attempt = attemptRef.current
    const result = await refreshIfUnknown(error, refresh, {
      ...options,
      onLateRefresh: () => {
        if (attemptRef.current === attempt)
          setRefreshed(true)
      },
    })
    setRefreshed(result)
    return result
  }, [])
  return { refreshed, refreshAfterFailure }
}

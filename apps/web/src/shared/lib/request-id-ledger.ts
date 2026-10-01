import type { RequestIdLedger } from '../api/request-ids.ts'
import { createContext, use } from 'react'

/** 带 requestId 的新建共用的记账（shared/api/request-ids.ts）：平台页面由应用的根组件提供（app/app.tsx），页面一份 */
export const RequestIdLedgerContext = createContext<RequestIdLedger | undefined>(undefined)

export function useRequestIdLedger(): RequestIdLedger {
  const ledger = use(RequestIdLedgerContext)
  if (ledger === undefined)
    throw new Error('requestId 的记账由应用的根组件提供（app/app.tsx）')
  return ledger
}

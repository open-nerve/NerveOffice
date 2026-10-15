// 会话行只允许已知的封装和状态；损坏/新格式与从未写入是不同的事实。
import type { LocalSessionState } from './session-fence.ts'
import { SESSION_SLOT } from './database.ts'
import { isFields } from './draft-record.ts'
import { readActiveSessionState, readLocalSessionState } from './session-fence.ts'

function isSessionRecord(value: unknown): value is Record<string, unknown> {
  return isFields(value) && value.slot === SESSION_SLOT && Object.keys(value).every(key => key === 'slot' || key === 'state')
}

/** 用户事务只认严格 active；未绑定、清理中、损坏或新格式均没有许可。 */
export function readStoredActiveSession(value: unknown) {
  return isSessionRecord(value) ? readActiveSessionState(value.state) : undefined
}

export function sessionRecord(state: LocalSessionState) {
  return { slot: SESSION_SLOT, state }
}

export function readStoredSession(value: unknown): LocalSessionState | undefined {
  if (value === undefined)
    return undefined
  const state = isSessionRecord(value) ? readLocalSessionState(value.state) : undefined
  if (state === undefined)
    throw new Error('本机会话状态损坏或使用未知格式')
  return state
}

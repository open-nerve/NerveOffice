// 本机会话资格的纯规则。网络、摘要、随机数与 IDB 由调用方负责；本模块不从“当前会话”替旧回包借资格。
import { isFields, isWhole } from './draft-record.ts'

export interface SessionSource { readonly userId: string, readonly sourceHash: string }
export type UserCleanupCause = 'logout' | 'account_disabled'
/** 大于请求层 30 秒的完整请求时限；页面崩溃后下一次查询可以结束遗留窗口，之后仍须真实复核。 */
export const SESSION_CHANGE_WINDOW_MS = 60_000
export interface SessionChangeWindow { readonly startedAt: number, readonly until: number }
export type LocalSessionState
  = | { readonly phase: 'unconfirmed', readonly generation: string, readonly changing: false | SessionChangeWindow, readonly source?: SessionSource, readonly retired?: true }
    | { readonly phase: 'active', readonly generation: string, readonly source: SessionSource, readonly activatedFrom: string }
    | { readonly phase: 'suspended', readonly generation: string, readonly source: SessionSource }
    | { readonly phase: 'clearing' | 'cleared', readonly generation: string, readonly source: SessionSource, readonly cause: UserCleanupCause }
export interface SessionCheckTicket { readonly kind: 'query' | 'mutation', readonly generation: string }
export interface DraftSessionPermit { readonly userId: string, readonly generation: string }
export interface UserCleanupPermit extends DraftSessionPermit { readonly cause: UserCleanupCause }
export interface SessionActivation { readonly state: LocalSessionState, readonly permit: DraftSessionPermit }
export interface SessionChange { readonly state: LocalSessionState, readonly ticket: SessionCheckTicket }
export interface UserCleanupStart { readonly state: LocalSessionState, readonly permit: UserCleanupPermit }
export type SessionCheckFailure = { readonly kind: 'disabled', readonly userId: string } | { readonly kind: 'preserve' }
export type SessionRejectionResult
  = | { readonly kind: 'stopped', readonly previous: DraftSessionPermit }
    | { readonly kind: 'clearing', readonly previous: DraftSessionPermit, readonly permit: UserCleanupPermit }

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}

function onlyFields(value: Readonly<Record<string, unknown>>, fields: readonly string[]): boolean {
  return Object.keys(value).every(key => fields.includes(key))
}

function isCleanupCause(value: unknown): value is UserCleanupCause {
  return value === 'logout' || value === 'account_disabled'
}

function nextGeneration(generation: string, current?: string): string {
  if (!isUuid(generation) || generation === current)
    throw new Error('本机会话代次必须是不同的新 UUID')
  return generation
}

export function createUnconfirmedSession(generation: string): LocalSessionState {
  return { phase: 'unconfirmed', generation: nextGeneration(generation), changing: false }
}

export function readSessionSource(value: unknown): SessionSource | undefined {
  if (!isFields(value) || !onlyFields(value, ['userId', 'sourceHash']) || !isUuid(value.userId)
    || typeof value.sourceHash !== 'string' || !/^[0-9a-f]{64}$/.test(value.sourceHash)) {
    return undefined
  }
  return { userId: value.userId, sourceHash: value.sourceHash }
}

function readChangeWindow(value: unknown): false | SessionChangeWindow | undefined {
  if (value === false)
    return false
  if (!isFields(value) || !onlyFields(value, ['startedAt', 'until']) || !isWhole(value.startedAt, 0)
    || !isWhole(value.until, 0) || value.until - value.startedAt !== SESSION_CHANGE_WINDOW_MS) {
    return undefined
  }
  return { startedAt: value.startedAt, until: value.until }
}

function changeExpired(window: SessionChangeWindow, now: number): boolean {
  return now < window.startedAt || now >= window.until
}

/** 未知的形状不能被旧构建当作 active，也不等于“库里尚无记录”。 */
export function readActiveSessionState(value: unknown): Extract<LocalSessionState, { readonly phase: 'active' }> | undefined {
  if (!isFields(value) || value.phase !== 'active' || !isUuid(value.generation)
    || !onlyFields(value, ['phase', 'generation', 'source', 'activatedFrom'])
    || !isUuid(value.activatedFrom) || value.activatedFrom === value.generation) {
    return undefined
  }
  const source = readSessionSource(value.source)
  return source === undefined ? undefined : { phase: 'active', generation: value.generation, source, activatedFrom: value.activatedFrom }
}

/** 完整状态解析只供主线程的状态转移使用；Worker 只需 active 的严格解析。 */
export function readLocalSessionState(value: unknown): LocalSessionState | undefined {
  if (isFields(value) && value.phase === 'active')
    return readActiveSessionState(value)
  if (!isFields(value) || !isUuid(value.generation))
    return undefined
  const generation = value.generation
  const source = readSessionSource(value.source)
  if (value.phase === 'unconfirmed') {
    const changing = readChangeWindow(value.changing)
    if (!onlyFields(value, ['phase', 'generation', 'changing', 'source', 'retired']) || changing === undefined
      || (value.source !== undefined && source === undefined) || (value.retired !== undefined && value.retired !== true)
      || (value.retired === true && source === undefined)) {
      return undefined
    }
    return { phase: 'unconfirmed', generation, changing, ...(source === undefined ? {} : { source }), ...(value.retired === true ? { retired: true } : {}) }
  }
  if (source === undefined)
    return undefined
  if (value.phase === 'suspended' && onlyFields(value, ['phase', 'generation', 'source']))
    return { phase: 'suspended', generation, source }
  if ((value.phase === 'clearing' || value.phase === 'cleared') && onlyFields(value, ['phase', 'generation', 'source', 'cause']) && isCleanupCause(value.cause))
    return { phase: value.phase, generation, source, cause: value.cause }
  return undefined
}

export function readSessionCheckTicket(value: unknown): SessionCheckTicket | undefined {
  if (!isFields(value) || !onlyFields(value, ['kind', 'generation']) || !isUuid(value.generation) || (value.kind !== 'query' && value.kind !== 'mutation'))
    return undefined
  return { kind: value.kind, generation: value.generation }
}

export function readDraftSessionPermit(value: unknown): DraftSessionPermit | undefined {
  if (!isFields(value) || !onlyFields(value, ['userId', 'generation']) || !isUuid(value.userId) || !isUuid(value.generation))
    return undefined
  return { userId: value.userId, generation: value.generation }
}

export function readUserCleanupPermit(value: unknown): UserCleanupPermit | undefined {
  if (!isFields(value) || !onlyFields(value, ['userId', 'generation', 'cause']) || !isUuid(value.userId) || !isUuid(value.generation) || !isCleanupCause(value.cause))
    return undefined
  return { userId: value.userId, generation: value.generation, cause: value.cause }
}

export function sessionCheckTicket(state: LocalSessionState): SessionCheckTicket {
  return { kind: 'query', generation: state.generation }
}

function sameSource(a: SessionSource | undefined, b: SessionSource): boolean {
  return a?.userId === b.userId && a.sourceHash === b.sourceHash
}

function retiredSource(state: LocalSessionState): boolean {
  return state.phase === 'clearing' || state.phase === 'cleared' || (state.phase === 'unconfirmed' && state.retired === true)
}

/** 比较原票据；同一轮激活可以共享，但不能只凭来源相同穿越更早的暂停/变更。 */
export function acceptSessionCheck(state: LocalSessionState, ticket: SessionCheckTicket, supplied: SessionSource, generation: string, now: number): SessionActivation | undefined {
  const source = readSessionSource(supplied)
  if (source === undefined || readSessionCheckTicket(ticket) === undefined || !isWhole(now, 0))
    return undefined
  if (state.phase === 'active' && sameSource(state.source, source)
    && (state.generation === ticket.generation || state.activatedFrom === ticket.generation)) {
    return { state, permit: { userId: source.userId, generation: state.generation } }
  }
  if (state.generation !== ticket.generation
    || (ticket.kind === 'query' && state.phase === 'unconfirmed' && state.changing !== false)
    || (ticket.kind === 'mutation' && (state.phase !== 'unconfirmed' || state.changing === false || changeExpired(state.changing, now)))
    || (retiredSource(state) && sameSource(state.source, source))) {
    return undefined
  }
  const next: LocalSessionState = { phase: 'active', generation: nextGeneration(generation, state.generation), source, activatedFrom: state.generation }
  return { state: next, permit: { userId: source.userId, generation: next.generation } }
}

/** 在会话变更的网络请求之前执行；清理过的来源不能借失败登录取消退役。 */
export function beginSessionChange(state: LocalSessionState, generation: string, now: number): SessionChange {
  if (!isWhole(now, 0) || !isWhole(now + SESSION_CHANGE_WINDOW_MS, 0))
    throw new Error('会话变更窗口需要有效的本机时间')
  const next: LocalSessionState = {
    phase: 'unconfirmed',
    generation: nextGeneration(generation, state.generation),
    changing: { startedAt: now, until: now + SESSION_CHANGE_WINDOW_MS },
    ...(state.source === undefined ? {} : { source: state.source }),
    ...(retiredSource(state) ? { retired: true } : {}),
  }
  return { state: next, ticket: { kind: 'mutation', generation: next.generation } }
}

/** 网络失败只结束属于该请求的未决状态；之后必须重新发查询，不能拿新票据重用旧响应。 */
export function failSessionChange(state: LocalSessionState, ticket: SessionCheckTicket, generation: string): LocalSessionState | undefined {
  if (state.phase !== 'unconfirmed' || state.changing === false || ticket.kind !== 'mutation' || state.generation !== ticket.generation)
    return undefined
  return { ...state, generation: nextGeneration(generation, state.generation), changing: false }
}

/** 由下一次真实查询开始前调用。时间只决定废弃旧资格，不授予恢复或清理权限。 */
export function expireSessionChange(state: LocalSessionState, now: number, generation: string): LocalSessionState | undefined {
  if (state.phase !== 'unconfirmed' || state.changing === false || !isWhole(now, 0) || !changeExpired(state.changing, now))
    return undefined
  return { ...state, generation: nextGeneration(generation, state.generation), changing: false }
}

export function canUseDraftSession(state: LocalSessionState | undefined, permit: DraftSessionPermit | undefined, userId: string): boolean {
  return state?.phase === 'active' && permit !== undefined && state.source.userId === userId
    && permit.userId === userId && state.generation === permit.generation
}

export function suspendSession(state: LocalSessionState, permit: DraftSessionPermit, generation: string): LocalSessionState | undefined {
  if (state.phase !== 'active' || !canUseDraftSession(state, permit, permit.userId))
    return undefined
  return { phase: 'suspended', generation: nextGeneration(generation, state.generation), source: state.source }
}

/** 失败只认请求前的原代次；activatedFrom 的成功共享规则不适用于失效和删除。 */
export function rejectSessionCheck(state: LocalSessionState, ticket: SessionCheckTicket, failure: SessionCheckFailure, generation: string): { readonly state: LocalSessionState, readonly result: SessionRejectionResult } | undefined {
  if (readSessionCheckTicket(ticket) === undefined || ticket.kind !== 'query' || state.generation !== ticket.generation
    || state.source === undefined || retiredSource(state)
    || (state.phase === 'unconfirmed' && state.changing !== false)
    || (failure.kind === 'disabled' && failure.userId !== state.source.userId)) {
    return undefined
  }
  const previous = { userId: state.source.userId, generation: state.generation }
  if (failure.kind === 'disabled') {
    const next: LocalSessionState = { phase: 'clearing', generation: nextGeneration(generation, state.generation), source: state.source, cause: 'account_disabled' }
    return { state: next, result: { kind: 'clearing', previous, permit: { userId: next.source.userId, generation: next.generation, cause: 'account_disabled' } } }
  }
  // 已暂停的来源没有新的停写事实；重复通知会让本页/其它页继续查询并再次通知。
  // 后续确证停用仍走上面的 clearing 分支，不把暂停误当作已清理。
  if (failure.kind !== 'preserve' || state.phase === 'suspended')
    return undefined
  return { state: { phase: 'suspended', generation: nextGeneration(generation, state.generation), source: state.source }, result: { kind: 'stopped', previous } }
}

export function beginUserCleanup(state: LocalSessionState, permit: DraftSessionPermit, cause: UserCleanupCause, generation: string): UserCleanupStart | undefined {
  if (state.phase !== 'active' || !canUseDraftSession(state, permit, permit.userId) || !isCleanupCause(cause))
    return undefined
  const next: LocalSessionState = { phase: 'clearing', generation: nextGeneration(generation, state.generation), source: state.source, cause }
  return { state: next, permit: { userId: next.source.userId, generation: next.generation, cause } }
}

export function cleanupPermitOf(state: LocalSessionState): UserCleanupPermit | undefined {
  return state.phase === 'clearing' ? { userId: state.source.userId, generation: state.generation, cause: state.cause } : undefined
}

export function canCleanUserSession(state: LocalSessionState | undefined, permit: UserCleanupPermit | undefined): boolean {
  return state?.phase === 'clearing' && permit !== undefined && state.source.userId === permit.userId
    && state.generation === permit.generation && state.cause === permit.cause
}

export function finishUserCleanup(state: LocalSessionState, permit: UserCleanupPermit, generation: string): LocalSessionState | undefined {
  if (state.phase !== 'clearing' || !canCleanUserSession(state, permit))
    return undefined
  return { phase: 'cleared', generation: nextGeneration(generation, state.generation), source: state.source, cause: state.cause }
}

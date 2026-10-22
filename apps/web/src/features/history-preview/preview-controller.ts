import type { DocumentHistoryDetail, SessionResponse } from '@nerve-office/contracts'
import type { SessionImageAccessController } from '../../shared/lib/session-image-access.ts'
import { compareVersions, DOCUMENT_PROFILE_OF, PLATFORM_FORMAT_VERSION, UNIVER_SDK_VERSION } from '@nerve-office/contracts'
import { isAccessDenied, isAuthenticationError } from '../../shared/api/index.ts'
import { createSessionImageAccess } from '../../shared/lib/session-image-access.ts'

export type PreviewState = { readonly kind: 'loading' | 'unavailable' | 'unsupported' | 'unusable' | 'signed-out' | 'changed-user' | 'disposed' } | { readonly kind: 'ready', readonly history: DocumentHistoryDetail } | { readonly kind: 'failed', readonly error: unknown }
export interface PreviewEditor {
  readonly usable: boolean
  readonly dispose: () => Promise<void>
}
export interface PreviewDependencies {
  readonly session: (signal: AbortSignal) => Promise<SessionResponse>
  readonly detail: (signal: AbortSignal) => Promise<DocumentHistoryDetail>
  readonly content: (signal: AbortSignal) => Promise<string>
  readonly mount: (snapshot: string, images: SessionImageAccessController, metadata: DocumentHistoryDetail) => Promise<PreviewEditor>
  readonly adopt: (session: SessionResponse | undefined) => void
}
export interface HistoryPreviewController {
  readonly refresh: () => Promise<void>
  readonly view: () => PreviewState
  readonly subscribe: (listener: () => void) => () => void
  readonly dispose: () => Promise<void>
}
function supported(history: DocumentHistoryDetail): boolean {
  return history.compatibility === 'supported' && history.type === 'sheet'
    && history.profile === DOCUMENT_PROFILE_OF.sheet && history.formatVersion === PLATFORM_FORMAT_VERSION
    && (compareVersions(history.sdkVersion, UNIVER_SDK_VERSION) ?? 1) <= 0
}

/** 只有读取、资格复核与 read 实例；不依赖完整编辑会话、草稿维护或自动保存。 */
export function createHistoryPreview(deps: PreviewDependencies): HistoryPreviewController {
  let state: PreviewState = { kind: 'loading' }
  let generation = 0
  let disposed = false
  let ended = false
  let abort: AbortController | undefined
  let images: SessionImageAccessController | undefined
  let editor: PreviewEditor | undefined
  let mounting = Promise.resolve()
  let retiring = Promise.resolve()
  const listeners = new Set<() => void>()
  const current = (token: number) => !disposed && !ended && token === generation
  function publish(next: PreviewState): void {
    state = next
    for (const listener of [...listeners])
      listener()
  }
  async function retire(): Promise<void> {
    const previous = editor
    editor = undefined
    if (previous !== undefined)
      retiring = retiring.then(async () => previous.dispose())
    return retiring
  }
  async function block(next: PreviewState, terminal = false): Promise<void> {
    images?.suspend()
    if (terminal) {
      ended = true
      deps.adopt(undefined)
    }
    publish(next)
    await retire()
  }
  async function authorize(token: number, signal: AbortSignal) {
    const session = await deps.session(signal)
    if (!current(token))
      return undefined
    if (images !== undefined && images.owner !== session.user.id) {
      await block({ kind: 'changed-user' }, true)
      return undefined
    }
    images ??= createSessionImageAccess(session.user.id)
    deps.adopt(session)
    const history = await deps.detail(signal)
    if (!current(token))
      return undefined
    if (!supported(history)) {
      await block({ kind: 'unsupported' })
      return undefined
    }
    return { session, history }
  }
  async function refresh(): Promise<void> {
    if (disposed || ended)
      return
    const token = ++generation
    abort?.abort()
    abort = new AbortController()
    const { signal } = abort
    // 复核期间宿主立即隐藏画布，图片停止；失败不能继续显示旧身份的数据。
    images?.suspend()
    publish({ kind: 'loading' })
    try {
      let access = await authorize(token, signal)
      if (access === undefined || !current(token))
        return
      if (editor === undefined) {
        const snapshot = await deps.content(signal)
        if (!current(token))
          return
        access = await authorize(token, signal)
        if (access === undefined || !current(token))
          return
        const { history } = access
        const imageAccess = images
        if (imageAccess === undefined)
          return
        // 连续复核遇到仍在创建的 SDK 时串行；晚到实例先销毁，才允许下一实例使用同一容器。
        const pending = mounting.then(async () => {
          await retiring
          if (!current(token))
            return
          const mounted = await deps.mount(snapshot, imageAccess, history)
          if (!current(token)) {
            await mounted.dispose()
            return
          }
          if (!mounted.usable) {
            await mounted.dispose()
            await block({ kind: 'unusable' })
            return
          }
          editor = mounted
        })
        mounting = pending.catch(() => {})
        await pending
        if (!current(token) || editor === undefined)
          return
        // SDK 初始化可能很慢，显示之前再次确认，图片也只在这之后启用。
        access = await authorize(token, signal)
        if (access === undefined || !current(token))
          return
      }
      images?.confirm(access.session)
      publish({ kind: 'ready', history: access.history })
    }
    catch (error) {
      if (!current(token))
        return
      if (isAuthenticationError(error))
        await block({ kind: 'signed-out' }, true)
      else if (isAccessDenied(error))
        await block({ kind: 'unavailable' })
      else
        await block({ kind: 'failed', error })
    }
  }
  return {
    refresh,
    view: () => state,
    subscribe: (listener) => {
      if (!disposed)
        listeners.add(listener)
      return () => listeners.delete(listener)
    },
    dispose: async () => {
      if (!disposed) {
        disposed = true
        generation += 1
        abort?.abort()
        images?.dispose()
        publish({ kind: 'disposed' })
        listeners.clear()
      }
      await retire()
      await mounting
    },
  }
}

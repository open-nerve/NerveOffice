import type { CreatedDocument, CreateDocumentRequest, CsvCreateLocation, SessionResponse } from '@nerve-office/contracts'
import type { CsvTable } from '../../shared/csv/index.ts'
import type { CsvProblem } from './csv-controller.ts'
import type { CsvFile, CsvPreview } from './csv-file.ts'
import { assertNewCsvDocument, CsvOperationError } from '../../editor/index.ts'
import { isAccessDenied, isAuthenticationError, isCsrfTokenError, isDefiniteRejection } from '../../shared/api/index.ts'
import { concludesRequest, createRequestIdLedger } from '../../shared/api/request-ids.ts'
import { CSV_LIMITS, CsvError, parseCsv } from '../../shared/csv/index.ts'
import { csvPreview } from './csv-file.ts'

export interface CsvCreationOwner {
  readonly userId: string
  readonly csrfToken: string
}

export interface CsvCreatedHost {
  /** current 必须参与最终同步写入前的核对；成功仅表示模型已修改，保存仍由正式页头说明。 */
  readonly apply: (table: CsvTable, current: () => boolean) => Promise<boolean>
  readonly dispose: () => void
}

export interface CsvCreationDestination {
  readonly spaceName: string
  readonly folderName?: string
}

export interface CsvCreationOptions {
  readonly location: CsvCreateLocation
  readonly session: (signal: AbortSignal) => Promise<SessionResponse>
  readonly adopt: (session: SessionResponse) => void
  /** 使用服务端空间权限；有 folder 时同时核对 folder 所属 space。无资格须拒绝。 */
  readonly access: (location: CsvCreateLocation, signal: AbortSignal) => Promise<CsvCreationDestination>
  readonly create: (request: CreateDocumentRequest) => Promise<CreatedDocument>
  readonly openCreated: (document: CreatedDocument, owner: CsvCreationOwner) => Promise<CsvCreatedHost>
  readonly online: () => boolean
  readonly newId?: () => string
}

export type CsvCreationProblem = CsvProblem | 'offline' | 'identity' | 'access-denied' | 'create-failed' | 'result-unknown' | 'already-created' | 'open-failed' | 'import-failed'
export type CsvCreationStage = 'loading' | 'selecting' | 'reading' | 'preview' | 'confirming' | 'creating' | 'opening' | 'importing' | 'failed' | 'replayed' | 'done' | 'invalid'
export interface CsvCreationView {
  readonly stage: CsvCreationStage
  readonly creation: 'none' | 'unknown' | 'created'
  readonly destination: CsvCreationDestination | undefined
  readonly fileName: string | undefined
  readonly preview: CsvPreview | undefined
  readonly document: Pick<CreatedDocument, 'id' | 'title'> | undefined
  readonly problem: CsvCreationProblem | undefined
}

export interface CsvCreation {
  readonly view: () => CsvCreationView
  readonly subscribe: (listener: () => void) => () => void
  readonly load: () => Promise<void>
  readonly chooseFile: (file: CsvFile) => Promise<void>
  readonly confirm: () => Promise<void>
  readonly retry: () => Promise<void>
  readonly invalidate: () => void
  readonly cancel: () => void
  readonly dispose: () => void
  readonly hasPendingWork: () => boolean
}

/** 创建意图只属于原位置/原会话；POST 的未知结果不等于未创建，不用新请求补建。 */
export function createCsvCreation(options: CsvCreationOptions): CsvCreation {
  const ledger = createRequestIdLedger(options.newId)
  const location = { ...options.location }
  const key = `csv:${location.spaceId}/${location.folderId ?? ''}`
  const listeners = new Set<() => void>()
  let generation = 0
  let ended = false
  let disposed = false
  let abort = new AbortController()
  let owner: CsvCreationOwner | undefined
  let destination: CsvCreationDestination | undefined
  let table: CsvTable | undefined
  let fileName: string | undefined
  let preview: CsvPreview | undefined
  let created: CreatedDocument | undefined
  let host: CsvCreatedHost | undefined
  let creation: CsvCreationView['creation'] = 'none'
  let view: CsvCreationView = { stage: 'loading', creation, destination, fileName, preview, document: undefined, problem: undefined }
  const current = (token: number): boolean => !ended && !disposed && token === generation

  function publish(stage: CsvCreationStage, problem?: CsvCreationProblem): void {
    view = { stage, creation, destination, fileName, preview, document: created === undefined ? undefined : { id: created.id, title: created.title }, problem }
    for (const listener of [...listeners]) {
      try {
        listener()
      }
      catch (error) { reportError(error) }
    }
  }

  function clearFile(): void {
    table = undefined
    preview = undefined
    fileName = undefined
  }

  function next(): number {
    abort.abort()
    abort = new AbortController()
    generation += 1
    return generation
  }

  function retire(): void {
    const previous = host
    host = undefined
    previous?.dispose()
  }

  function invalidate(): void {
    if (ended || disposed || view.stage === 'done')
      return
    ended = true
    next()
    clearFile()
    destination = undefined
    created = undefined
    publish('invalid', 'identity')
  }

  function failed(error: unknown, fallback: CsvCreationProblem): CsvCreationProblem {
    if (isAuthenticationError(error) || isCsrfTokenError(error)) {
      invalidate()
      return 'identity'
    }
    if (isAccessDenied(error))
      return 'access-denied'
    if (error instanceof CsvOperationError)
      return error.reason
    if (error instanceof CsvError && error.reason !== 'cancelled')
      return error.reason
    return fallback
  }

  async function authorize(token: number, inspectDestination: boolean): Promise<boolean> {
    const signedIn = await options.session(abort.signal)
    if (!current(token))
      return false
    if (owner !== undefined && (signedIn.user.id !== owner.userId || signedIn.csrfToken !== owner.csrfToken)) {
      invalidate()
      return false
    }
    owner ??= { userId: signedIn.user.id, csrfToken: signedIn.csrfToken }
    options.adopt(signedIn)
    if (!current(token))
      return false
    // 未知结果必须进入原 requestId 的服务端重放；原位置不能再新建，不代表已建文档不可读。
    // 已知文档的打开/编辑资格由正式宿主核对，不能借这里重建原位置的一份新文档。
    if (inspectDestination) {
      const allowed = await options.access(location, abort.signal)
      if (!current(token))
        return false
      destination = allowed
    }
    return true
  }

  async function load(): Promise<void> {
    if (ended || disposed || table !== undefined || creation !== 'none' || (generation !== 0 && view.stage === 'loading'))
      return
    const token = next()
    publish('loading')
    try {
      if (await authorize(token, true) && current(token))
        publish('selecting')
    }
    catch (error) {
      if (current(token)) {
        const problem = failed(error, 'create-failed')
        if (current(token))
          publish('failed', problem)
      }
    }
  }

  async function openAndApply(token: number): Promise<void> {
    if (!created || !owner || !table || !current(token))
      return
    let fallback: CsvCreationProblem = 'open-failed'
    try {
      let opened = host
      if (opened === undefined) {
        publish('opening')
        if (!current(token))
          return
        opened = await options.openCreated(created, owner)
        if (!current(token)) {
          opened.dispose()
          return
        }
        host = opened
      }
      fallback = 'import-failed'
      publish('importing')
      // 不在网络/挂载等待之前另捕获完整矩阵，失效可以即时释放控制器唯一的引用。
      const applied = await opened.apply(table, () => current(token))
      if (!current(token))
        return
      if (!applied) {
        publish('failed', 'import-failed')
        return
      }
      clearFile()
      publish('done')
    }
    catch (error) {
      if (current(token)) {
        const problem = failed(error, fallback)
        if (current(token))
          publish('failed', problem)
      }
    }
  }

  async function confirm(): Promise<void> {
    if (ended || disposed || !table || (view.stage !== 'preview' && view.stage !== 'failed'))
      return
    if (!options.online()) {
      publish(view.stage, 'offline')
      return
    }
    const token = next()
    publish('confirming')
    let sent = false
    const previouslyUnknown = creation === 'unknown'
    try {
      if (!await authorize(token, creation === 'none') || !current(token))
        return
      if (!options.online()) {
        publish('failed', 'offline')
        return
      }
      if (created !== undefined) {
        await openAndApply(token)
        return
      }
      assertNewCsvDocument(table)
      if (!current(token))
        return
      creation = 'unknown'
      publish('creating')
      if (!current(token)) {
        creation = previouslyUnknown ? 'unknown' : 'none'
        publish('invalid', 'identity')
        return
      }
      sent = true
      const result = await ledger.send(key, async requestId => options.create({ type: 'sheet', ...location, requestId }))
      if (!current(token))
        return
      created = result
      creation = 'created'
      if (result.replayed) {
        clearFile()
        publish('replayed')
        return
      }
      await openAndApply(token)
    }
    catch (error) {
      if (!current(token))
        return
      // 已有未知结果后再得到业务拒绝，不能认定早先没生效或换 id 补建。
      if (sent && previouslyUnknown && concludesRequest(error)) {
        invalidate()
        publish('invalid', 'already-created')
        return
      }
      if (sent && !previouslyUnknown && isDefiniteRejection(error))
        creation = 'none'
      const problem = failed(error, creation === 'unknown' ? 'result-unknown' : 'create-failed')
      if (current(token))
        publish('failed', problem)
    }
  }

  return {
    view: () => view,
    subscribe(listener) {
      if (!disposed)
        listeners.add(listener)
      return () => listeners.delete(listener)
    },
    load,
    async chooseFile(file) {
      if (ended || disposed || owner === undefined || creation !== 'none' || !['selecting', 'reading', 'preview', 'failed'].includes(view.stage))
        return
      const token = next()
      clearFile()
      fileName = file.name.slice(0, 256)
      publish('reading')
      let fallback: CsvCreationProblem = 'file-read'
      try {
        if (!Number.isFinite(file.size) || file.size < 0 || file.size > CSV_LIMITS.bytes)
          throw new CsvError('bytes')
        const bytes = await file.arrayBuffer()
        if (!current(token))
          return
        fallback = 'syntax'
        const parsed = await parseCsv(new Uint8Array(bytes), { signal: abort.signal })
        if (!current(token))
          return
        assertNewCsvDocument(parsed)
        table = parsed
        preview = csvPreview(parsed)
        publish('preview')
      }
      catch (error) {
        if (current(token))
          publish('selecting', failed(error, fallback))
      }
    },
    confirm,
    retry: async () => table === undefined ? load() : confirm(),
    invalidate,
    cancel() {
      if (ended || disposed || creation !== 'none')
        return
      next()
      clearFile()
      publish('selecting')
    },
    dispose() {
      if (disposed)
        return
      ended = true
      next()
      clearFile()
      created = undefined
      destination = undefined
      retire()
      disposed = true
      listeners.clear()
      publish('invalid', 'identity')
    },
    hasPendingWork: () => table !== undefined || creation === 'unknown',
  }
}

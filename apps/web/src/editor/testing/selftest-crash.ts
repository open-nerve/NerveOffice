// M4-P3 S5：真实 Safari 崩溃的页面侧。控制通道只选测试阶段，不授予产品恢复资格。
// 初次经编辑器 Facade 写正文，等生产 Worker 实际写成并独立解密核对；重载后先只读取证，驱动许可后点击一次真实恢复入口。
import type { SelftestPageView } from './selftest-session.ts'
import { AUTOSAVE_HOLD_STORAGE_KEY } from './autosave-control.ts'
import { autosaveControl } from './selftest-autosave.ts'
import { byRole, isVisible, waitFor } from './selftest-dom.ts'
import { readSelftestDraft } from './selftest-local-draft.ts'
import { observeSelftestWrites as observeWrites, decryptSelftestDraft as persistedText, selftestSha256 as sha256 } from './selftest-persistence.ts'
import { withTimeout } from './selftest-session.ts'

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const TIMEOUT = 90_000
export const CRASH_SELFTEST_TEXT = 'Safari 页面崩溃前已持久保存的正文'

export interface CrashSelftestHost {
  readonly documentId: string
  readonly chrome: HTMLElement
  readonly view: () => SelftestPageView
  readonly pageErrors: () => readonly string[]
  readonly recovered: () => boolean
  readonly subscribe: (listener: () => void) => () => void
  readonly diagnostics?: () => unknown
}

export function crashControlFrom(href: string): { readonly endpoint: string, readonly runId: string } | undefined {
  try {
    const page = new URL(href)
    const endpoint = new URL(page.searchParams.get('next') ?? '')
    const match = new RegExp(`^/__nerve-crash/(${UUID})$`, 'i').exec(endpoint.pathname)
    const runId = match?.[1]
    if (endpoint.origin !== page.origin || endpoint.username !== '' || endpoint.password !== '' || endpoint.search !== '' || endpoint.hash !== '' || runId === undefined)
      return undefined
    return { endpoint: endpoint.href, runId }
  }
  catch {
    return undefined
  }
}

/** 单独按已存格式取值，不用产品恢复器或 SDK 的恢复结果替代磁盘正文。 */
export function crashCellValue(text: string): unknown {
  const parsed: unknown = JSON.parse(text)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
    return undefined
  const envelope = parsed as { snapshot?: unknown }
  const book = (envelope.snapshot ?? parsed) as { sheetOrder?: string[], sheets?: Record<string, { cellData?: Record<string, Record<string, { v?: unknown }>> }> }
  const first = book.sheetOrder?.[0]
  return first === undefined ? undefined : book.sheets?.[first]?.cellData?.[0]?.[0]?.v
}

function recoveryEntry(chrome: HTMLElement): { readonly kind: 'restore' | 'takeover-self', readonly button: HTMLElement } | undefined {
  const enabled = (button: HTMLElement): boolean => isVisible(button) && !button.hasAttribute('disabled') && button.getAttribute('aria-disabled') !== 'true'
  const notice = chrome.querySelector<HTMLElement>('[data-slot="recovery-notice"]')
  if (notice === null)
    return undefined
  const restore = byRole('button', { name: '恢复并编辑', root: notice }).filter(enabled)
  const takeover = byRole('button', { name: '在此编辑', root: chrome }).filter(enabled)
  const copy = byRole('button', { name: '另存为副本', root: notice }).filter(enabled)
  if (restore.length === 1 && restore[0] !== undefined && takeover.length === 0)
    return { kind: 'restore', button: restore[0] }
  if (takeover.length === 1 && takeover[0] !== undefined && restore.length === 0 && copy.length === 1)
    return { kind: 'takeover-self', button: takeover[0] }
  return undefined
}

/** 必须在 page.load 前等待它完成：只安装观测与设置测试上传暂停，不提前操作编辑器。 */
export async function watchCrashSelftest(host: CrashSelftestHost): Promise<void> {
  const control = crashControlFrom(location.href)
  if (control === undefined)
    throw new Error('崩溃自检没有合法的同源控制入口')
  const bootId = crypto.randomUUID()
  const common = { runId: control.runId, documentId: host.documentId, bootId }
  const post = async (kind: string, facts: Record<string, unknown> = {}): Promise<{ kind: string, mirrorRequired?: boolean }> => {
    const response = await fetch(control.endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind, ...common, ...facts }), signal: AbortSignal.timeout(10_000) })
    if (!response.ok)
      throw new Error(`崩溃控制通道失败：${response.status}`)
    return response.json() as Promise<{ kind: string, mirrorRequired?: boolean }>
  }
  const command = await post('boot')
  if (command.kind !== 'prepare' && command.kind !== 'observe')
    throw new Error('驱动没有允许本页继续自检')
  const diagnostic = async (stage: 'boot' | 'ready' | 'awaiting-confirmation' | 'restored' | 'failed'): Promise<void> => {
    if (host.diagnostics === undefined)
      throw new Error('测试构建没有安装清理前只读诊断')
    const result = await post('diagnostic', { stage, facts: host.diagnostics() })
    if (result.kind !== 'wait')
      throw new Error('只读诊断没有被驱动接受')
  }
  await diagnostic('boot')
  const writes = observeWrites()
  const autosave = autosaveControl()
  // 只暂停初页的定时云端上传。重载页放开测试暂停，不读写产品身份。
  sessionStorage.removeItem(AUTOSAVE_HOLD_STORAGE_KEY)
  if (command.kind === 'prepare')
    autosave.hold()
  else
    autosave.release()
  let recovered = false
  const checkRecovery = (): void => {
    recovered ||= host.recovered() && /已恢复.*本机修改，等待保存到云端/.test(document.querySelector('[data-slot="recovery-notice"]')?.textContent ?? '')
  }
  const unsubscribe = host.subscribe(checkRecovery)
  const notices = new MutationObserver(checkRecovery)
  notices.observe(document.body, { childList: true, subtree: true, characterData: true })
  const run = async (): Promise<void> => {
    const until = async (condition: () => boolean): Promise<void> => {
      if (!await waitFor(condition, TIMEOUT, 50))
        throw new Error('崩溃页面自检未等到实际状态')
    }
    await until(() => host.view().surface === 'steady' && ['reading', 'editing'].includes(host.view().mode ?? ''))
    const response = await fetch('/api/auth/session', { signal: AbortSignal.timeout(10_000) })
    if (!response.ok)
      throw new Error('崩溃自检会话无效')
    const session = await response.json() as { user: { id: string }, csrfToken: string }
    if (command.kind === 'prepare') {
      if (host.view().mode !== 'reading')
        throw new Error('准备页没有从阅读开始')
      const button = byRole('button', { name: '编辑', root: host.chrome }).find(isVisible)
      if (button === undefined)
        throw new Error('准备页没有编辑入口')
      button.click()
      await until(() => host.view().mode === 'editing' && host.view().surface === 'steady')
      const api = window.__nerveEditorProbe?.univerAPI as unknown as { getActiveWorkbook: () => { getActiveSheet: () => { getRange: (cell: string) => { setValue: (value: string) => unknown } } } }
      api.getActiveWorkbook().getActiveSheet().getRange('A1').setValue(CRASH_SELFTEST_TEXT)
      await until(() => writes.count() > 0)
      const draft = await readSelftestDraft(session.user.id, host.documentId)
      if (draft === undefined)
        throw new Error('成功回包之后没有磁盘正文')
      const text = await persistedText(draft, session.csrfToken)
      const value = crashCellValue(text)
      if (value !== CRASH_SELFTEST_TEXT)
        throw new Error('独立解密读到的正文不符')
      const snapshotHash = await sha256(text)
      const mirror = writes.mirrorFor(draft, snapshotHash)
      if (command.mirrorRequired === true && mirror === undefined)
        throw new Error('生产 Worker 没有证明这份磁盘草稿的 OPFS 镜像已写成')
      await diagnostic('ready')
      await post('ready', { userId: session.user.id, clientInstanceId: draft.writtenBy, writerId: draft.writerId, draftSeq: draft.draftSeq, baseRevision: draft.baseRevision, contentHash: await sha256(value), snapshotHash, workerWrites: writes.count(), inFlight: draft.inFlight !== null, visible: document.visibilityState === 'visible', pageErrors: host.pageErrors().length, ...(command.mirrorRequired === true ? { mirror } : {}) })
    }
    else {
      if (host.view().mode !== 'reading')
        throw new Error('恢复页未经确认已经进入编辑')
      await until(() => recoveryEntry(host.chrome) !== undefined)
      const entry = recoveryEntry(host.chrome)
      if (entry === undefined)
        throw new Error('确认前恢复入口已变化')
      const original = await readSelftestDraft(session.user.id, host.documentId)
      if (original === undefined)
        throw new Error('确认前本机原件已丢失')
      const originalText = await persistedText(original, session.csrfToken)
      const originalValue = crashCellValue(originalText)
      if (originalValue !== CRASH_SELFTEST_TEXT)
        throw new Error('确认前独立解密的正文不符')
      await diagnostic('awaiting-confirmation')
      const waiting = await post('awaiting-confirmation', { userId: session.user.id, clientInstanceId: original.writtenBy, writerId: original.writerId, draftSeq: original.draftSeq, baseRevision: original.baseRevision, contentHash: await sha256(originalValue), snapshotHash: await sha256(originalText), inFlight: original.inFlight !== null, mode: host.view().mode, entry: entry.kind, visible: document.visibilityState === 'visible', pageErrors: host.pageErrors().length })
      if (waiting.kind !== 'wait')
        throw new Error('驱动未接受确认前证据')
      for (;;) {
        const permission = await post('confirm')
        if (permission.kind === 'confirm')
          break
        if (permission.kind !== 'wait')
          throw new Error('驱动拒绝明确恢复许可')
        await new Promise(resolve => setTimeout(resolve, 50))
      }
      const currentEntry = recoveryEntry(host.chrome)
      if (currentEntry?.kind !== entry.kind || host.view().mode !== 'reading' || host.view().surface !== 'steady' || document.visibilityState !== 'visible' || host.pageErrors().length !== 0)
        throw new Error('确认许可交付后页面或恢复入口已经变化')
      // 明确的合成 UI 点击；不调用产品恢复方法、不写正文、不补写 clientInstanceId 或导航事实。
      currentEntry.button.click()
      await until(() => host.view().mode === 'editing' && host.view().save === 'clean')
      let draft = await readSelftestDraft(session.user.id, host.documentId)
      const untilClean = Date.now() + 10_000
      while (draft !== undefined && Date.now() < untilClean) {
        await new Promise(resolve => setTimeout(resolve, 50))
        draft = await readSelftestDraft(session.user.id, host.documentId)
      }
      const snapshot = window.__nerveEditorProbe?.snapshot()
      const value = snapshot === undefined ? undefined : crashCellValue(snapshot)
      await diagnostic('restored')
      await post('restored', { contentHash: await sha256(typeof value === 'string' ? value : ''), mode: host.view().mode, recoveredNotice: recovered, draftRemaining: draft !== undefined, visible: document.visibilityState === 'visible', pageErrors: host.pageErrors().length })
    }
  }
  // page.load 在挂接返回后才开始。自检在后台等状态，失败仍向驱动交回，不能静默等到整轮超时。
  void withTimeout(run(), TIMEOUT).catch(async () => {
    await diagnostic('failed').catch(() => {})
    await post('failed').catch(() => {})
  }).finally(() => {
    unsubscribe()
    notices.disconnect()
    writes.dispose()
  })
}

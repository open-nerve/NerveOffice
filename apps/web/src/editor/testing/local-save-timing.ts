// P2 与真实 Safari 共用计时；函数须可直接序列化到浏览器，不引用模块或外部闭包。
export interface MeasuredEdit {
  readonly cell: string
  readonly value: string | number
  readonly sheet?: string
  readonly formula: boolean
}

export interface LocalSaveTiming {
  readonly startedAt: number
  readonly savedAt: number
  readonly localSavedMs: number
  readonly commandMs: number
  readonly formulaSettledMs: number
  readonly editorSeq: number
}

/** 起点包含同步修改成本；只接受新修改经历未保存后的 saved，不主动捕获或上传。 */
export async function observeLocalSaveEdit(edit: MeasuredEdit): Promise<LocalSaveTiming> {
  const probe = window.__nerveEditorProbe
  const status = document.querySelector('[data-slot="local-save-status"]')
  if (probe === undefined || status === null)
    throw new Error('编辑器或本机保存状态没有准备好')
  const workbook = probe.univerAPI.getActiveWorkbook()
  if (workbook === null || workbook === undefined)
    throw new Error('工作簿没有准备好')
  const sheet = edit.sheet === undefined ? workbook.getActiveSheet() : workbook.getSheetByName(edit.sheet)
  if (sheet === null || sheet === undefined)
    throw new Error('工作表没有准备好')
  const range = sheet.getRange(edit.cell)
  const beforeSeq = probe.changeSeq()
  const beforeRound = probe.formulaProgress().round
  return new Promise<LocalSaveTiming>((resolve, reject) => {
    let changed = false
    let sawUnsaved = false
    let startedAt = 0
    let commandMs = 0
    let formulaSettledMs: number | undefined = edit.formula ? undefined : 0
    let frame = 0
    const observeFormula = () => {
      const progress = probe.formulaProgress()
      if (edit.formula && progress.round > beforeRound && progress.completed && !progress.stopped && probe.formulasSettled())
        formulaSettledMs ??= performance.now() - startedAt
    }
    const observer = new MutationObserver(() => {
      if (!changed)
        return
      const state = status.getAttribute('data-local-save-state')
      if (state !== 'saved')
        sawUnsaved = true
      if (!sawUnsaved || state !== 'saved')
        return
      const savedAt = performance.now()
      observeFormula()
      cleanup()
      if (formulaSettledMs === undefined) {
        reject(new Error('本机已保存时，本轮公式尚未完成'))
        return
      }
      resolve({ startedAt, savedAt, localSavedMs: savedAt - startedAt, commandMs, formulaSettledMs, editorSeq: probe.changeSeq() })
    })
    const timeout = setTimeout(() => {
      cleanup()
      reject(new Error(`15 秒内未观察到本轮本机保存完成：state=${status.getAttribute('data-local-save-state')}，sawUnsaved=${sawUnsaved}`))
    }, 15_000)
    function cleanup() {
      observer.disconnect()
      cancelAnimationFrame(frame)
      clearTimeout(timeout)
    }
    const tick = () => {
      observeFormula()
      frame = requestAnimationFrame(tick)
    }
    observer.observe(status, { attributes: true, attributeFilter: ['data-local-save-state'] })
    try {
      startedAt = performance.now()
      range.setValue(edit.value)
      commandMs = performance.now() - startedAt
      changed = probe.changeSeq() > beforeSeq
      if (!changed)
        throw new Error('修改命令没有产生新的编辑序号')
      frame = requestAnimationFrame(tick)
    }
    catch (error) {
      cleanup()
      reject(error)
    }
  })
}

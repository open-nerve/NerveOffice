// 在浏览器内计时：只观察实际页面与公式状态，不调用捕获、flush、写入或调度控制。
import type { Page } from '@playwright/test'
import type {} from './editor-probe.ts'

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

/** 起点包含同步修改命令的成本；终点必须在新一轮未保存状态之后，不能误用旧 saved。 */
export async function measureLocalEdit(page: Page, edit: MeasuredEdit): Promise<LocalSaveTiming> {
  return page.evaluate(async (edit) => {
    const probe = window.__nerveEditorProbe
    const status = document.querySelector('[data-slot="local-save-status"]')
    if (probe === undefined || status === null)
      throw new Error('编辑器或本机保存状态没有准备好')
    const workbook = probe.univerAPI.getActiveWorkbook()
    const sheet = edit.sheet === undefined ? workbook.getActiveSheet() : workbook.getSheetByName(edit.sheet)
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
  }, edit)
}

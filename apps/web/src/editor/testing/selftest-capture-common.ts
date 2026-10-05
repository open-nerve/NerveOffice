// 捕获时机的页面自检的共用部分（M3-P4 S1，./selftest-capture.ts 与 ./selftest-formulas.ts 用）：Facade 里另外用到的方法的声明、
// 编辑时才跑的前提（S7 起连同自动保存的准备：这一场景里自动保存照常还是暂停定时的上传，./selftest-autosave.ts）与命令日志的一个查询。
// S1 在这里另有捕获规则的参考实现与按它捕获的循环（自动保存实现之前用）；S7 起各场景观察真实的自动保存（./selftest-autosave.ts），参考实现删掉
import type { ProbeCommand } from './e2e-probe.ts'
import type { AutosaveSetup } from './selftest-autosave.ts'
import type { SelftestRange, SelftestSheet, SelftestWorkbook, Session } from './selftest-session.ts'
import { documentChangesIn } from './content-compare.ts'
import { prepareAutosave } from './selftest-autosave.ts'
import { check, chromeButton, fail } from './selftest-session.ts'

// ---- Facade：捕获时机的场景另外用到的（sheets、sheets-ui 与探针补上的插件 Facade 都有） ----

export interface CaptureRange extends SelftestRange {
  /** 设为选区（只改视图） */
  readonly activate: () => unknown
  readonly setFontSize: (size: number) => unknown
  readonly setWrap: (enabled: boolean) => unknown
  readonly breakApart: () => unknown
}

export interface CaptureImage {
  readonly setPositionAsync: (row: number, column: number) => Promise<boolean>
  readonly setSizeAsync: (width: number, height: number) => Promise<boolean>
  readonly remove: () => boolean
}

export interface CaptureSheet extends SelftestSheet {
  readonly getRange: (a1: string) => CaptureRange
  readonly insertColumnAfter: (column: number) => unknown
  readonly deleteColumns: (column: number, count: number) => unknown
  readonly setColumnWidth: (column: number, width: number) => unknown
  readonly setFrozenRows: (rows: number) => unknown
  /** sheets-ui 的 Facade */
  readonly zoom: (ratio: number) => unknown
  readonly scrollToCell: (row: number, column: number) => unknown
  readonly getImages: () => readonly CaptureImage[]
}

export interface CaptureWorkbook extends SelftestWorkbook {
  readonly getActiveSheet: () => CaptureSheet
  readonly getSheetByName: (name: string) => CaptureSheet
  readonly setActiveSheet: (sheet: CaptureSheet) => unknown
  readonly insertDefinedName: (name: string, reference: string) => unknown
}

export interface CaptureTextFinder {
  readonly findAll: () => readonly unknown[]
  readonly replaceAllWithAsync: (text: string) => Promise<number>
}

export interface CaptureApi {
  readonly getActiveWorkbook: () => CaptureWorkbook
  readonly executeCommand: (id: string, params?: object, options?: object) => Promise<boolean>
  readonly newDataValidation: () => { readonly requireNumberBetween: (from: number, to: number) => { readonly build: () => unknown } }
  readonly createTextFinderAsync: (text: string) => Promise<CaptureTextFinder>
  readonly undo: () => Promise<boolean>
  readonly redo: () => Promise<boolean>
}

export function facade(session: Session): CaptureApi {
  return session.probe.univerAPI as unknown as CaptureApi
}

export function sheetNamed(session: Session, name: string): CaptureSheet {
  const sheet = facade(session).getActiveWorkbook().getSheetByName(name) as CaptureSheet | null
  if (sheet === null)
    fail(`没有工作表"${name}"`)
  return sheet
}

export async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export function round(ms: number): number {
  return Math.round(ms)
}

// ---- 编辑时才跑 ----

/**
 * 这些场景都要在编辑时跑：挂接没能进入编辑（被占用、不能编辑）时，余下的检查没有意义。
 * 同一项里准备自动保存（./selftest-autosave.ts 的 prepareAutosave）：调度接上了、进入编辑到现在没有捕获与上传（打开不算修改），
 * 再按这个场景的需要定下照常还是暂停定时的上传、节奏（真实 Safari 里打开时不暂停，Playwright 的夹具默认暂停：这里一律按场景重设，两边一样）
 */
export async function checkEditing(session: Session, autosave: AutosaveSetup): Promise<boolean> {
  return check(session, 'page.editing', async () => {
    if (session.host.page.readOnly !== false)
      fail('页面没有进入编辑（挂接进入编辑没有成功：被别人占用、没有编辑的权限？）')
    if (chromeButton(session, '保存') === undefined)
      fail('进入了编辑，页头没有保存按钮')
    return `编辑中，公式在${session.probe.formulaMode === 'worker' ? ' Worker 里' : '主线程'}计算；${prepareAutosave(autosave)}`
  })
}

// ---- 命令日志 ----

/**
 * 命令日志按变更检测的口径另做的判定（content-compare.ts，与编辑器的判定是同一份规则，单元测试核对）：mark 之后本文档的修改，
 * 按发生的顺序。change-detection 拿它与编辑器的本地修改序号对照（两边不一致就是判定出了岔子）
 */
export function changesAfter(session: Session, mark: number): ProbeCommand[] {
  return documentChangesIn(session.probe.commands(mark), session.unitId)
}

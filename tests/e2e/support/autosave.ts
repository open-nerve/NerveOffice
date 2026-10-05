// 测试构建的自动保存控制（M3-P4 设计 §3.14；apps/web/src/editor/testing/autosave-control.ts）：E2E 经它把握自动保存的时机。
// - 夹具默认让定时的自动保存暂停（fixtures.ts 的 autosave 选项，打开之前经 addInitScript 写 sessionStorage）：现有的用例按
//   "按保存才上传"的语义成立；立即上传（保存按钮、Cmd/Ctrl+S、退出编辑、切到后台）照常，捕获照常；
// - 要自动保存的用例在开头 test.use({ autosave: 'running' })，或者打开之后 releaseAutosave；
// - 控制只在测试构建里：用到下面几个函数的用例打上 @test-build（外部模式测生产镜像，里面没有控制，自动保存照常运行）。
// 页面里执行的函数经 page.evaluate 序列化过去，不能引用外面的变量：挂在 window 上的名字经参数传入
import type { Page } from '@playwright/test'
import type { AutosaveControl, AutosaveControlFlushResult, AutosaveControlLimits, AutosaveLogEntry } from '../../../apps/web/src/editor/testing/autosave-control.ts'
import { AUTOSAVE_CONTROL_GLOBAL, AUTOSAVE_HELD, AUTOSAVE_HOLD_STORAGE_KEY } from '../../../apps/web/src/editor/testing/autosave-control.ts'

export type { AutosaveLogEntry } from '../../../apps/web/src/editor/testing/autosave-control.ts'

/** 打开时定时的自动保存暂停（held）还是照常（running） */
export type AutosaveMode = 'held' | 'running'

/** addInitScript 的参数：sessionStorage 的键与值（null 是去掉，照常） */
export interface AutosaveModeScript {
  readonly key: string
  readonly value: string | null
}

export function autosaveModeScript(mode: AutosaveMode): AutosaveModeScript {
  return { key: AUTOSAVE_HOLD_STORAGE_KEY, value: mode === 'held' ? AUTOSAVE_HELD : null }
}

/** 在页面里执行（addInitScript）：每次载入之前写好"打开时是否暂停"。sessionStorage 不能用时（例如 about:blank）什么也不做 */
export function applyAutosaveMode({ key, value }: AutosaveModeScript): void {
  try {
    if (value === null)
      sessionStorage.removeItem(key)
    else
      sessionStorage.setItem(key, value)
  }
  catch {
    // 不能用 sessionStorage 的页面没有编辑器
  }
}

/** 页面上的控制（window 上的那一个）；页面里执行 */
type ControlWindow = Record<string, AutosaveControl | undefined>

/** 等编辑器页组装好控制（测试构建在组装之前动态引入它） */
async function controlReady(page: Page): Promise<void> {
  await page.waitForFunction(name => (window as unknown as ControlWindow)[name] !== undefined, AUTOSAVE_CONTROL_GLOBAL)
}

/** 放开定时的自动保存（静默、上限、重试、恢复联网照常上传） */
export async function releaseAutosave(page: Page): Promise<void> {
  await controlReady(page)
  await page.evaluate(name => (window as unknown as ControlWindow)[name]?.release(), AUTOSAVE_CONTROL_GLOBAL)
}

/** 暂停定时的自动保存（立即上传照常） */
export async function holdAutosave(page: Page): Promise<void> {
  await controlReady(page)
  await page.evaluate(name => (window as unknown as ControlWindow)[name]?.hold(), AUTOSAVE_CONTROL_GLOBAL)
}

/** 换节奏（例如把捕获的上限调到 50 ms 测"超过上限"） */
export async function setAutosaveLimits(page: Page, limits: Partial<AutosaveControlLimits>): Promise<void> {
  await controlReady(page)
  await page.evaluate(({ name, next }) => (window as unknown as ControlWindow)[name]?.setLimits(next), { name: AUTOSAVE_CONTROL_GLOBAL, next: limits })
}

/** 当前的调度立即上传一次（flush('control')：不提交单元格、不等公式、去重）；不在编辑时为 undefined */
export async function flushAutosave(page: Page): Promise<AutosaveControlFlushResult | undefined> {
  await controlReady(page)
  return page.evaluate(async name => (window as unknown as ControlWindow)[name]?.flush(), AUTOSAVE_CONTROL_GLOBAL)
}

/** 每次捕获与上传的日志（时刻是页面的 performance.now） */
export async function autosaveLog(page: Page): Promise<AutosaveLogEntry[]> {
  await controlReady(page)
  return page.evaluate(name => (window as unknown as ControlWindow)[name]?.log() ?? [], AUTOSAVE_CONTROL_GLOBAL)
}

/** 清掉日志 */
export async function clearAutosaveLog(page: Page): Promise<void> {
  await controlReady(page)
  await page.evaluate(name => (window as unknown as ControlWindow)[name]?.clearLog(), AUTOSAVE_CONTROL_GLOBAL)
}

/** 日志里的上传 */
export function uploadsOf(log: readonly AutosaveLogEntry[]): Extract<AutosaveLogEntry, { kind: 'upload' }>[] {
  return log.filter((entry): entry is Extract<AutosaveLogEntry, { kind: 'upload' }> => entry.kind === 'upload')
}

/** 日志里的捕获 */
export function capturesOf(log: readonly AutosaveLogEntry[]): Extract<AutosaveLogEntry, { kind: 'capture' }>[] {
  return log.filter((entry): entry is Extract<AutosaveLogEntry, { kind: 'capture' }> => entry.kind === 'capture')
}

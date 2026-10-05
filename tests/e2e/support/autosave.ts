// 测试构建的自动保存控制（M3-P4 设计 §3.14；apps/web/src/editor/testing/autosave-control.ts）：E2E 经它把握自动保存的时机。
// - 夹具默认让定时的自动保存暂停（fixtures.ts 的 autosave 选项，打开之前经 addInitScript 写 sessionStorage）：现有的用例按
//   "按保存才上传"的语义成立；立即上传（保存按钮、Cmd/Ctrl+S、退出编辑、切到后台）照常，捕获照常；
// - 要自动保存的用例在开头 test.use({ autosave: 'running' })，或者打开之后 releaseAutosave；
// - 控制只在测试构建里：用到下面几个函数的用例打上 @test-build（外部模式测生产镜像，里面没有控制，自动保存照常运行）。
// 页面里执行的函数经 page.evaluate 序列化过去，不能引用外面的变量：挂在 window 上的名字经参数传入。
// 另有自动保存的用例共用的观察与时钟（M3-P4 S6）：记下页面发出的保存与释放、上传的正文与查询参数、页面隐藏、停住时间与"停住时让到点的计时器执行"
import type { Page, Request } from '@playwright/test'
import type { AutosaveControl, AutosaveControlFlushResult, AutosaveControlLimits, AutosaveLogEntry } from '../../../apps/web/src/editor/testing/autosave-control.ts'
import { gunzipSync } from 'node:zlib'
// fixtures.ts 引用这个文件（夹具按它选打开时暂停与否）：expect 直接从 Playwright 取，不经 fixtures.ts，免得循环引用
import { expect } from '@playwright/test'
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

// ---- 自动保存的用例共用的观察与时钟（M3-P4 S6） ----

/** 这个页面发出的保存（PUT …/content）与释放编辑权（DELETE …/edit-lease），按发出的先后 */
export interface RecordedWrites {
  readonly saves: Request[]
  readonly releases: Request[]
}

export function recordWrites(page: Page, documentId: string): RecordedWrites {
  const writes: RecordedWrites = { saves: [], releases: [] }
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname
    if (request.method() === 'PUT' && path === `/api/documents/${documentId}/content`)
      writes.saves.push(request)
    if (request.method() === 'DELETE' && path === `/api/documents/${documentId}/edit-lease`)
      writes.releases.push(request)
  })
  return writes
}

/** 一次保存上传的快照原文（gzip 解压之后：就是本页捕获的那一份） */
export function uploadedText(request: Request | undefined): string {
  const body = request?.postDataBuffer()
  if (body === undefined || body === null)
    throw new Error('没有这次保存的请求或者它没有正文')
  return gunzipSync(body).toString('utf8')
}

/** 一次保存的查询参数里的一项（requestId、formulasPending 等） */
export function saveParam(request: Request | undefined, name: string): string | null {
  if (request === undefined)
    throw new Error('没有这次保存的请求')
  return new URL(request.url()).searchParams.get(name)
}

/** 页面隐藏或回到前台：改写可见性并派发 visibilitychange（Playwright 的页面一直可见；页面按 document.visibilityState 判断） */
export async function setPageHidden(page: Page, hidden: boolean): Promise<void> {
  await page.evaluate((value) => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => value ? 'hidden' : 'visible' })
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => value })
    document.dispatchEvent(new Event('visibilitychange'))
  }, hidden)
}

/**
 * 停住页面的时间：打开之前已经 page.clock.install()（之后时间照常流动，页面照常载入、渲染）。停在 1 秒之后的那一刻（忙的机器上也不会是
 * "过去"的时刻），交回停住时页面的 performance.now()——调度的时钟就是它：之后的修改都发生在这一刻，计时器只在 runFor 往前拨时到点，
 * 机器多忙，修改、捕获、上传与断言之间都不会有计时器自己到点。重建编辑器（渲染靠动画帧）之前 page.clock.resume()
 */
export async function pauseTime(page: Page): Promise<number> {
  await page.clock.pauseAt(await page.evaluate(() => Date.now()) + 1_000)
  return page.evaluate(() => performance.now())
}

/**
 * 停住的时间里看日志：先让到点的计时器执行（runFor(0)，不拨时间）。公式在 Worker 里算、请求在途是真实的时间：结果出来之后调度排下的
 * "立即再看"就在停住的这一刻，要它们执行了日志才跟上。配合 expect.poll 用
 */
export async function logNow(page: Page): Promise<AutosaveLogEntry[]> {
  await page.clock.runFor(0)
  return autosaveLog(page)
}

/** 停住的时间里页面现在的时刻（调度的时钟） */
export async function pausedNow(page: Page): Promise<number> {
  return page.evaluate(() => performance.now())
}

/**
 * 停住的时间里等到 check 为真：每次先看一眼，不行就往前拨 stepMs 再看。公式在 Worker 或主线程里算是真实的时间，算完之后 SDK 可能还要
 * 一个正的计时器才往下走（排着的下一轮、被 stop 的一轮重新开始都要等 10 ms 的计算防抖；主线程模式下还有别的），只让到点的计时器执行
 * 会停在那里——公式的用例用它等捕获与上传，时刻只断言"不早于规则允许的那一刻"
 */
export async function advanceUntil(page: Page, check: () => Promise<boolean>, message: string, stepMs = 5): Promise<void> {
  await expect.poll(async () => {
    if (await check())
      return true
    await page.clock.runFor(stepMs)
    return check()
  }, { message, intervals: [50], timeout: 60_000 }).toBe(true)
}

/** SDK 的计算防抖（engine-formula 的 CALCULATION_DEBOUNCE_TIME）：修改之后过这么久才开始一轮 */
export const SDK_CALCULATION_DEBOUNCE_MS = 10

/**
 * 停住的时间里改了一处之后：往前拨过 SDK 的计算防抖（这一轮开始），等它算完（公式在 Worker 或主线程里算，真实的时间）。
 * 之后再往前拨到捕获的上限时，捕获不会因为公式没收齐而带上标记——要看"上限"的节奏而不是"公式待更新"的用例用它
 */
export async function settleAfterEdit(page: Page): Promise<void> {
  await page.clock.runFor(SDK_CALCULATION_DEBOUNCE_MS)
  // 编辑器的探针（support/editor-probe.ts 声明它）：与自动保存读的是同一个"公式收齐"
  await expect.poll(async () => page.evaluate(() => window.__nerveEditorProbe?.formulasSettled() ?? false), { message: '这一处修改引起的一轮公式算完了' }).toBe(true)
}

/** 拦住这个页面的保存（PUT …/content），直到 release；拦住的请求照常发出（route.continue），之后的不拦 */
export async function holdSaves(page: Page): Promise<{ readonly release: () => void, readonly held: () => number }> {
  let release: () => void = () => {}
  const released = new Promise<void>((resolve) => {
    release = resolve
  })
  let held = 0
  await page.route('**/api/documents/*/content?*', async (route) => {
    if (route.request().method() === 'PUT') {
      held += 1
      await released
    }
    await route.continue()
  })
  return { release, held: () => held }
}

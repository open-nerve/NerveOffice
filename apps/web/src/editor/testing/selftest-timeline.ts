// 交接与请求编辑的页面自检共用的观察（M3-P5 设计 §3.14 的交接场景，./selftest-handover.ts；M3-P6 设计 §3.10 的请求编辑场景，./selftest-request.ts；
// M3-P6 S5 从 ./selftest-handover.ts 拆出，内容不变）：测试构建的交接日志（./handover-log.ts，window.__nerveHandoverLog）、场景自己的观察与交回的
// 时间线（墙上时间：跨标签页、跨两次载入比先后）、页面的可见性、页头的文字（读屏状态、一直在的读屏状态区、失去编辑权的说明）、内容里的格，
// 与日志判读的两个小工具。只在测试构建里（editor/testing/，随自检的分块动态引入）
import type { HandoverLog, HandoverLogEntry } from './handover-log.ts'
import type { SelftestTimelineEntry } from './selftest-report.ts'
import type { Session } from './selftest-session.ts'
import { HANDOVER_LOG_GLOBAL } from './handover-log.ts'
import { round } from './selftest-capture-common.ts'
import { fail } from './selftest-session.ts'

// ---- 日志与时间线 ----

/** 交接日志里的一条（./handover-log.ts 的 HandoverLogEntry：种类、本页的单调时钟、墙上时间与各自的字段） */
export type LogEntry = Pick<HandoverLogEntry, 'kind' | 'at' | 'wall'> & Readonly<Record<string, unknown>>

/** 页面上的交接日志（测试构建在组装编辑器页之前装上） */
export function handoverLog(): HandoverLog {
  const log = (window as unknown as Record<string, HandoverLog | undefined>)[HANDOVER_LOG_GLOBAL]
  if (log === undefined)
    fail(`页面上没有交接日志（window.${HANDOVER_LOG_GLOBAL}）：不是测试构建？`)
  return log
}

/** 场景自己的一条观察：种类带 page: 前缀（与交接日志的分开），墙上时间与本页的单调时钟 */
export function observation(kind: string, fields: Readonly<Record<string, unknown>> = {}): SelftestTimelineEntry {
  return { kind: `page:${kind}`, wall: Date.now(), at: round(performance.now()), ...fields }
}

/** 交回的时间线：交接日志（拷贝）与场景的观察，按墙上时间排好 */
export function timelineWith(observations: readonly SelftestTimelineEntry[]): SelftestTimelineEntry[] {
  const log = (window as unknown as Record<string, HandoverLog | undefined>)[HANDOVER_LOG_GLOBAL]?.log() ?? []
  return [...log.map(entry => ({ ...entry, at: round(entry.at) })), ...observations].sort((a, b) => a.wall - b.wall)
}

/** 页面变成隐藏、又显示出来（记进时间线）；在 window 上的捕获阶段听：先于编辑器页挂在 document 上的处理（自动保存在那里同步捕获、发起上传） */
export interface VisibilityWatch {
  /** 第一次变成隐藏的时刻（performance.now） */
  readonly hiddenAt: () => number | undefined
  /** 第一次隐藏之后第一次又显示出来的时刻（performance.now；M3-P6：请求编辑的场景等它） */
  readonly shownAt: () => number | undefined
  readonly dispose: () => void
}

export function watchVisibility(observations: SelftestTimelineEntry[]): VisibilityWatch {
  let hiddenAt: number | undefined
  let shownAt: number | undefined
  const listener = (): void => {
    observations.push(observation(`visibility-${document.visibilityState}`))
    if (document.visibilityState === 'hidden')
      hiddenAt ??= performance.now()
    else if (hiddenAt !== undefined)
      shownAt ??= performance.now()
  }
  window.addEventListener('visibilitychange', listener, true)
  return { hiddenAt: () => hiddenAt, shownAt: () => shownAt, dispose: () => window.removeEventListener('visibilitychange', listener, true) }
}

/** 进入了编辑：编辑的 steady，容器上是可编辑的编辑器 */
export function editingSteady(session: Session): boolean {
  const view = session.host.view()
  return view.mode === 'editing' && view.surface === 'steady' && session.host.surface.getAttribute('data-editor-access') === 'edit'
}

// ---- 页面上的文字 ----

/** 空白合并之后的文字 */
export function textOf(element: Element | null | undefined): string {
  return (element?.textContent ?? '').replace(/\s+/g, ' ').trim()
}

/** 页头里的读屏状态（role=status）的文字 */
export function statusTexts(session: Session): string[] {
  return [...session.host.chrome.querySelectorAll('[role="status"]')].map(textOf).filter(text => text !== '')
}

/** 一直在的读屏状态区（data-slot="status-region"）的文字 */
export function statusRegionText(session: Session): string {
  return textOf(session.host.chrome.querySelector('[data-slot="status-region"]'))
}

/** 失去编辑权的说明（role=alert，以"编辑权已失效"开头）的文字；没有时空串 */
export function lostNoticeText(session: Session): string {
  return [...session.host.chrome.querySelectorAll('[role="alert"]')].map(textOf).find(text => text.startsWith('编辑权已失效')) ?? ''
}

/** 快照里一格的值 */
export function cellOf(snapshot: string, cell: { readonly sheetId: string, readonly row: number, readonly column: number }): unknown {
  const workbook = JSON.parse(snapshot) as { readonly sheets: Readonly<Record<string, { readonly cellData?: Readonly<Record<string, Readonly<Record<string, { readonly v?: unknown }>>>> }>> }
  return workbook.sheets[cell.sheetId]?.cellData?.[cell.row]?.[cell.column]?.v
}

/** 内容里这几格在不在（值相同）：交回"A1 在、A3 不在"一类的说明与不符合 expected 的那些 */
export function cellsIn(snapshot: string, cells: readonly { readonly sheetId: string, readonly cell: string, readonly row: number, readonly column: number, readonly value: string }[], expected: readonly boolean[]): { readonly text: string, readonly wrong: string[] } {
  const present = cells.map(cell => cellOf(snapshot, cell) === cell.value)
  return {
    text: cells.map((cell, index) => `${cell.cell}${present[index] === true ? '在' : '不在'}`).join('、'),
    wrong: cells.flatMap((cell, index) => present[index] === expected[index] ? [] : [`${cell.cell}${expected[index] === true ? '应当在' : '不应在'}`]),
  }
}

// ---- 日志判读的小工具 ----

/** 日志里第一条这一种（另满足 where）的；没有时 undefined */
export function firstOf(log: readonly LogEntry[], kind: string, where: (entry: LogEntry) => boolean = () => true): LogEntry | undefined {
  return log.find(entry => entry.kind === kind && where(entry))
}

/** entry 相对 origin 的毫秒数（按本页的单调时钟 at）；缺一个时 null */
export function since(entry: LogEntry | undefined, origin: LogEntry | undefined): number | null {
  return entry === undefined || origin === undefined ? null : round(entry.at - origin.at)
}

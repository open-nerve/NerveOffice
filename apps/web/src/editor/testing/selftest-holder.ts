// 正在编辑的一方（持有者）的前半段（M3-P5 设计 §3.14 的 takeover-holder，M3-P6 设计 §3.10 的 paused-holder 共用；M3-P6 S5 从 ./selftest-handover.ts
// 拆出，步骤与说法不变）：在编辑时、定时的上传暂停、捕获的静默与上限调到一小时——
// 1. 第一格经测试构建的控制立即存上（驱动脚本看到这一版才让这一页隐藏），上传的同时写第二格（留着）；
// 2. 等这一页变成隐藏：自动保存在隐藏的那一刻捕获、上传第二格（P4 的"切到后台立即上传"）；
// 3. 隐藏之后再写第三格（模拟切走之前最后一刻没被捕获的修改：它只在这一页先保存再交出时存上，否则留在这一页——失去编辑权之后另存为副本）。
// 只在测试构建里（editor/testing/）
import type { SelftestTimelineEntry } from './selftest-report.ts'
import type { Session } from './selftest-session.ts'
import type { VisibilityWatch } from './selftest-timeline.ts'
import { autosaveControl, capturesIn, describeAutosave, requestOf, triggerText, untilUploaded } from './selftest-autosave.ts'
import { checkEditing, facade, round } from './selftest-capture-common.ts'
import { waitFor } from './selftest-dom.ts'
import { check, CHECK_TIMEOUT_MS, fail } from './selftest-session.ts'
import { observation } from './selftest-timeline.ts'

/** 捕获的静默与上限调到一小时：场景里只有控制的 flush 与切到后台会捕获、上传 */
export const NO_TIMED_CAPTURE_MS = 3_600_000

/** 等页面变成隐藏最多多久：驱动脚本在库里看到第一格之后才让这一页隐藏 */
const HIDDEN_WAIT_MS = 120_000

/** 隐藏之后等自动保存把第二格上传最多多久（Safari 隐藏几秒之后就压低计时器：上传要在那之前发出） */
const SAVE_WAIT_MS = 20_000

/** 写进模板第一张表的一格 */
export interface HolderEdit {
  readonly sheetId: string
  readonly cell: string
  readonly row: number
  readonly column: number
  readonly value: string
}

/** 前半段怎样跑：三格、检查与计时的标识前缀、说明里"之后等什么"（场景不同，说法不同） */
export interface HolderPrelude {
  /** 第一格（存上）、第二格（隐藏的那一刻上传）、第三格（隐藏之后写） */
  readonly edits: readonly [HolderEdit, HolderEdit, HolderEdit]
  /** 检查的标识是 <prefix>.holder.first-save 等，计时是 <prefix>.hidden-upload */
  readonly prefix: string
  /** 第一格存上之后等什么（例如"之后等驱动脚本另开 B（A 随之隐藏）"） */
  readonly afterSave: string
  /** 等不到隐藏时多半是什么原因（例如"驱动脚本没有另开 B？"） */
  readonly notHidden: string
  /** 第三格写下之后等什么（例如"之后等 B 的'在此编辑'"） */
  readonly afterWrite: string
}

/** 跑前半段：编辑时的准备与三项检查，都通过时交回 true（之后由场景接着等结果） */
export async function holderPrelude(session: Session, visibility: VisibilityWatch, observations: SelftestTimelineEntry[], prelude: HolderPrelude): Promise<boolean> {
  if (!await checkEditing(session, { mode: 'held', limits: { captureQuietMs: NO_TIMED_CAPTURE_MS, captureMaxMs: NO_TIMED_CAPTURE_MS } }))
    return false
  const control = autosaveControl()
  const [first, second, third] = prelude.edits
  const sheet = facade(session).getActiveWorkbook().getActiveSheet()
  const saved = await check(session, `${prelude.prefix}.holder.first-save`, async () => {
    if (sheet.getSheetId() !== first.sheetId)
      fail(`当前工作表是 ${sheet.getSheetId()}（应当是模板的 ${first.sheetId}）`)
    sheet.getRange(first.cell).setValue(first.value)
    const firstSeq = session.probe.changeSeq()
    // 控制的 flush：同步捕获第一格、发起上传；随即写第二格——它不在这一次里，留到隐藏的那一刻（与 hidden-save 相同）
    const started = performance.now()
    const flushing = control.flush()
    sheet.getRange(second.cell).setValue(second.value)
    const result = await flushing
    if (result?.outcome?.kind !== 'saved')
      fail(`控制的 flush 没有存上：${JSON.stringify(result) ?? '没有当前的调度'}；${describeAutosave(session)}`)
    const request = requestOf(result.outcome.requestId)
    if (request?.status !== 200 || request.localSeq !== String(firstSeq))
      fail(`第一格的保存请求：状态 ${String(request?.status)}、修改序号 ${String(request?.localSeq)}（应当是 200、${firstSeq}）`)
    if (session.host.view().save !== 'dirty')
      fail(`第一格存上之后保存状态是 ${session.host.view().save ?? '没有'}（应当是 dirty：第二格还没上传）`)
    observations.push(observation('first-saved'))
    return `第一格（${first.cell}）经控制的 flush 存上（${round(performance.now() - started)} ms），第二格（${second.cell}）留着；${prelude.afterSave}`
  })
  if (!saved)
    return false
  const uploaded = await check(session, `${prelude.prefix}.holder.hidden-upload`, async () => {
    if (!await waitFor(() => visibility.hiddenAt() !== undefined, HIDDEN_WAIT_MS, 100))
      fail(`${HIDDEN_WAIT_MS / 1000} 秒内页面没有变成隐藏（${prelude.notHidden}）`)
    const hiddenAt = visibility.hiddenAt() ?? 0
    const seq = session.probe.changeSeq()
    const { upload, request } = await untilUploaded(session, seq, { timeoutMs: SAVE_WAIT_MS })
    const capture = capturesIn(control.log()).find(item => item.trigger === 'hidden')
    if (capture?.seq !== seq || upload.trigger !== 'hidden')
      fail(`隐藏的那一刻自动保存没有捕获、上传第二格（捕获 ${capture === undefined ? '没有' : triggerText(capture.trigger)}，上传 ${triggerText(upload.trigger)}）：${describeAutosave(session)}`)
    if (request?.status !== 200 || request.answeredAt === undefined)
      fail(`隐藏之后的保存请求：状态 ${String(request?.status)}`)
    const ms = { capture: round(capture.at - hiddenAt), request: round(request.at - hiddenAt), response: round(request.answeredAt - hiddenAt) }
    session.timings.push({ id: `${prelude.prefix}.hidden-upload`, ms })
    return `隐藏之后 +${ms.capture} ms 自动保存捕获第二格（切到后台）、+${ms.request} ms 发出保存请求、+${ms.response} ms 收到 200`
  }, HIDDEN_WAIT_MS + SAVE_WAIT_MS + CHECK_TIMEOUT_MS)
  if (!uploaded)
    return false
  return check(session, `${prelude.prefix}.holder.after-hidden-edit`, async () => {
    // 隐藏之后再写一格：模拟切走之前最后一刻没被捕获的修改（真实的用户在隐藏的页面里不会键入）。捕获的静默与上限是一小时、定时的上传暂停
    sheet.getRange(third.cell).setValue(third.value)
    if (session.host.view().save !== 'dirty')
      fail(`写了第三格，保存状态是 ${session.host.view().save ?? '没有'}（应当是 dirty）`)
    observations.push(observation('after-hidden-edit'))
    return `隐藏之后写下第三格（${third.cell}），留着没捕获、没上传；${prelude.afterWrite}`
  })
}

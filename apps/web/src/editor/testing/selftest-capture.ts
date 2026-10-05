// 捕获时机的页面自检（M3-P4 设计 §3.15，DEF-003 的其余部分：变更检测、空闲任务的时序与捕获时机）：在真实 Safari 上复核 P4 的自动保存
// 与它依赖的浏览器行为。S1 在自动保存实现之前用捕获规则的参考实现另做捕获；S7 起看编辑器页里真实的自动保存（./selftest-autosave.ts：
// 测试构建的控制露出的日志、同步的订阅、页面发出的保存请求与服务器上存下的内容）。
// 都在编辑时跑（挂接先进入编辑，features/sheet-editor/selftest-hook.ts），每个场景开始时定下自动保存照常还是暂停定时的上传；
// 样本见 ./capture-samples.ts（E2E 的生成器写库）：
// - environment：requestIdleCallback 是不是原生的（WebKit 26.6 没有，SDK 用 1 ms 的 setTimeout 垫片）、CompressionStream、crypto.subtle、
//   计时的精度与几种计时器实际的延迟；
// - change-detection（只读样本：图片是 data: 地址，M3-P3 起服务端不收，所以暂停定时的上传、只看捕获）：打开静默（到编辑的 steady 之后
//   再 5 秒，本地修改序号仍是 0，自动保存没有捕获）；只改视图的动作不算修改、不捕获；M0 动作矩阵里能经 Facade 执行的改内容的动作逐个
//   被检测到（内容确实变了，命令日志与变更检测一致）；自动保存跟上之后再看 5 秒，没有迟到而没被检测的变化（最后一次捕获的内容经同步的订阅取）；
// - formula-timing（公式样本，× Worker/主线程：地址参数选，./formula-mode.ts）：见 ./selftest-formulas.ts（自动保存照常，核对服务器上的公式值）；
// - auto-height（大表，自动保存照常）：5 万行改字号，行高在空闲任务里迟到；自动保存跟上、再看 5 秒，服务器上的就是最终的行高；
// - large-copy（大表，自动保存照常）：复制 5 万格的工作表，立即另取的快照里复制品完整（大表操作的拆分已关），没有懒执行；
//   自动保存存下之后服务器上的复制品同样完整；
// - composition（自动保存照常）：批注输入框组字（合成的事件）时 SDK 写不写模型（300 ms 防抖）；自动保存组字中不捕获、组合结束 1 秒之后
//   捕获，服务器上是最终的文字；
// - hidden-save：经测试构建的控制立即上传第一格，上传的同时写第二格（定时的上传暂停、捕获的静默与上限调到一小时，第二格留着），等页面真的
//   变成隐藏（驱动脚本另开一个标签页；校准用例模拟）——自动保存在隐藏的那一刻自己捕获、上传第二格；驱动脚本按库里的证据判定。
// 每项等确定的信号（命令执行完、公式收齐、捕获、上传、保存状态变化）、有时限；时间线随结果交回（timings，相对第一次修改的毫秒数）。
// 共用的部分（Facade 的声明、编辑时才跑的前提）在 ./selftest-capture-common.ts，观察自动保存的在 ./selftest-autosave.ts，公式时序在 ./selftest-formulas.ts。
import type { ProbeCommand } from './e2e-probe.ts'
import type { CaptureImage } from './selftest-capture-common.ts'
import type { CaptureScenario } from './selftest-report.ts'
import type { Session } from './selftest-session.ts'
import { FORMULA_PROTOCOL, NOTE_TEXTAREA_SELECTOR } from '../internal-api/index.ts'
import { BIG_SHEET, cellCount } from './capture-samples.ts'
import { sameContent } from './content-compare.ts'
import { autosaveControl, autosaveTimeline, capturesIn, captureTimingProblems, confirmed, describeAutosave, detectedChanges, requestOf, triggerText, untilCaughtUp, untilUploaded, uploadsIn, watchCaptures } from './selftest-autosave.ts'
import { changesAfter, checkEditing, facade, round, sheetNamed, sleep } from './selftest-capture-common.ts'
import { isVisible, nextFrames, waitFor } from './selftest-dom.ts'
import { formulaTimingScenario } from './selftest-formulas.ts'
import { COMPOSITION_NOTE, HIDDEN_SAVE_EDITS } from './selftest-report.ts'
import { check, CHECK_TIMEOUT_MS, describe, differences, fail, fetchServerContent, lastSeq, seenSince, SIGNAL_TIMEOUT_MS } from './selftest-session.ts'

// ---- environment ----

function isNative(fn: unknown): boolean {
  return typeof fn === 'function' && /\{\s*\[native code\]\s*\}/.test(Function.prototype.toString.call(fn))
}

/** 页面上的 requestIdleCallback（SDK 在没有原生的时候装上 setTimeout(1) 的垫片，core 的 common/shims.ts）：有没有、是不是原生的 */
function idleCallbackKind(): 'native' | 'shim' | 'missing' {
  const fn: unknown = Reflect.get(window, 'requestIdleCallback')
  if (typeof fn !== 'function')
    return 'missing'
  return isNative(fn) ? 'native' : 'shim'
}

const IDLE_CALLBACK_TEXT = { native: '是原生的', shim: '不是原生的（SDK 的 setTimeout(1) 垫片）', missing: '没有' } as const

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)] ?? Number.NaN
}

async function measureTimer(schedule: (done: () => void) => void, count: number): Promise<number> {
  const delays: number[] = []
  for (let index = 0; index < count; index += 1) {
    const start = performance.now()
    await new Promise<void>(resolve => schedule(resolve))
    delays.push(performance.now() - start)
  }
  return median(delays)
}

async function environmentScenario(session: Session): Promise<void> {
  await checkEditing(session, { mode: 'running' })
  await check(session, 'env.idle-callback', async () => {
    const kind = idleCallbackKind()
    const delay = kind === 'missing' ? Number.NaN : await measureTimer(done => requestIdleCallback(() => done()), 10)
    session.timings.push({ id: 'env.idle-callback', ms: { median: Number.isFinite(delay) ? Math.round(delay * 10) / 10 : null } })
    return `requestIdleCallback ${IDLE_CALLBACK_TEXT[kind]}，回调的延迟中位数 ${delay.toFixed(1)} ms`
  })
  await check(session, 'env.compression-stream', async () => {
    if (typeof CompressionStream !== 'function')
      fail('没有 CompressionStream（保存要先 gzip）')
    const text = '捕获的快照'.repeat(1000)
    const compressed = await new Response(new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer()
    const restored = await new Response(new Blob([compressed]).stream().pipeThrough(new DecompressionStream('gzip'))).text()
    if (restored !== text)
      fail('gzip 压缩再解压之后与原文不同')
    return `CompressionStream('gzip') 可用：${new TextEncoder().encode(text).length} 字节压成 ${compressed.byteLength} 字节，解压一致`
  })
  await check(session, 'env.crypto-subtle', async () => {
    if (!window.isSecureContext || crypto.subtle === undefined)
      fail(`没有 crypto.subtle（isSecureContext=${String(window.isSecureContext)}）：会话内去重要 SHA-256`)
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('abc')))
    const hex = [...digest].map(byte => byte.toString(16).padStart(2, '0')).join('')
    if (hex !== 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
      fail(`SHA-256("abc") 算出 ${hex}`)
    return 'crypto.subtle.digest(\'SHA-256\') 可用，isSecureContext 为真'
  })
  await check(session, 'env.timers', async () => {
    const samples: number[] = []
    let previous = performance.now()
    while (samples.length < 200) {
      const now = performance.now()
      if (now !== previous) {
        samples.push(now - previous)
        previous = now
      }
    }
    const resolution = Math.min(...samples)
    const zero = await measureTimer(done => setTimeout(done, 0), 20)
    const one = await measureTimer(done => setTimeout(done, 1), 20)
    const ten = await measureTimer(done => setTimeout(done, 10), 10)
    const frame = await measureTimer(done => requestAnimationFrame(() => done()), 10)
    const message = await measureTimer((done) => {
      const channel = new MessageChannel()
      channel.port1.onmessage = () => {
        channel.port1.close()
        done()
      }
      channel.port2.postMessage(null)
    }, 20)
    const rounded = (value: number): number => Math.round(value * 100) / 100
    session.timings.push({ id: 'env.timers', ms: { resolution: rounded(resolution), timeout0: rounded(zero), timeout1: rounded(one), timeout10: rounded(ten), animationFrame: rounded(frame), messageChannel: rounded(message) } })
    return `performance.now() 的最小步长 ${rounded(resolution)} ms；中位数：setTimeout(0) ${rounded(zero)} ms、setTimeout(1) ${rounded(one)} ms、setTimeout(10) ${rounded(ten)} ms、动画帧 ${rounded(frame)} ms、MessageChannel ${rounded(message)} ms`
  })
  await check(session, 'env.other', async () => {
    const facts = [
      `navigator.locks ${'locks' in navigator ? '有' : '没有'}`,
      `BroadcastChannel ${typeof BroadcastChannel === 'function' ? '有' : '没有'}`,
      `可见性 ${document.visibilityState}`,
      `设备像素比 ${window.devicePixelRatio}`,
    ]
    return facts.join('，')
  })
}

// ---- change-detection ----

/** 一个动作：只改视图的不算修改，改内容的要被检测到 */
interface ChangeAction {
  readonly name: string
  readonly run: (session: Session) => unknown
}

const DATA = '数据'
const FEATURES = '功能'
const SUMMARY = '汇总'
const LONG_TEXT = '很长的一段文字，用来触发自动换行后的行高自适应；很长的一段文字，很长的一段文字。'

/** 只改视图（M0 动作矩阵的 5 种，F 类：滚动在 M0 是真实的滚轮，这里用 sheets-ui 的 scrollToCell） */
const VIEW_ACTIONS: readonly ChangeAction[] = [
  { name: '选区', run: session => sheetNamed(session, DATA).getRange('C3:D4').activate() },
  { name: '滚动', run: session => sheetNamed(session, DATA).scrollToCell(40, 3) },
  { name: '缩放', run: session => sheetNamed(session, DATA).zoom(1.5) },
  {
    name: '切换工作表',
    run: (session) => {
      const workbook = facade(session).getActiveWorkbook()
      workbook.setActiveSheet(sheetNamed(session, SUMMARY))
      workbook.setActiveSheet(sheetNamed(session, DATA))
    },
  },
  { name: '查找', run: async session => (await facade(session).createTextFinderAsync('苹果')).findAll() },
]

/**
 * 改内容（M0 动作矩阵里能经 Facade 执行的；U 类的键入、粘贴改用 Facade 写值与公式，撤销与重做用 Facade）。一份文档上按顺序做，
 * 后面的动作不依赖前面的结果（工作表按名称取）。插入图片与新增超链接在 M5 之前被入口守卫挡着，不做
 */
const CONTENT_ACTIONS: readonly ChangeAction[] = [
  { name: '写入数值', run: session => sheetNamed(session, DATA).getRange('K3').setValue(123) },
  { name: '写入公式', run: session => sheetNamed(session, DATA).getRange('K4').setValue('=SUM(B2:B6)') },
  { name: '加粗', run: session => sheetNamed(session, DATA).getRange('A2:B3').setFontWeight('bold') },
  {
    name: '数字格式',
    run: async (session) => {
      const sheet = sheetNamed(session, DATA)
      return facade(session).executeCommand('sheet.command.numfmt.set.numfmt', { unitId: session.unitId, subUnitId: sheet.getSheetId(), values: [1, 2, 3, 4, 5].map(row => ({ row, col: 1, pattern: '0.0' })) })
    },
  },
  { name: '合并', run: session => sheetNamed(session, DATA).getRange('K10:L11').merge() },
  { name: '取消合并', run: session => sheetNamed(session, DATA).getRange('A13:C14').breakApart() },
  { name: '插入行', run: session => sheetNamed(session, DATA).insertRowAfter(3) },
  { name: '删除行', run: session => sheetNamed(session, DATA).deleteRows(16, 1) },
  { name: '插入列', run: session => sheetNamed(session, DATA).insertColumnAfter(3) },
  { name: '删除列', run: session => sheetNamed(session, DATA).deleteColumns(12, 1) },
  { name: '行高', run: session => sheetNamed(session, DATA).setRowHeight(5, 40) },
  { name: '列宽', run: session => sheetNamed(session, DATA).setColumnWidth(5, 150) },
  {
    name: '长文本换行（自动行高）',
    run: (session) => {
      const range = sheetNamed(session, DATA).getRange('K12')
      range.setValue(LONG_TEXT)
      range.setWrap(true)
    },
  },
  { name: '冻结', run: session => sheetNamed(session, DATA).setFrozenRows(3) },
  {
    name: '条件格式',
    run: (session) => {
      const sheet = sheetNamed(session, DATA)
      return sheet.addConditionalFormattingRule(sheet.newConditionalFormattingRule().whenCellNotEmpty().setRanges([sheet.getRange('K1:K20').getRange()]).setBackground('#fecaca').build())
    },
  },
  { name: '数据验证', run: session => sheetNamed(session, DATA).getRange('K20:K25').setDataValidation(facade(session).newDataValidation().requireNumberBetween(1, 10).build()) },
  { name: '筛选', run: session => sheetNamed(session, DATA).getRange('A1:F6').createFilter() },
  { name: '排序', run: session => sheetNamed(session, DATA).getRange('A2:F6').sort({ column: 1, ascending: false }) },
  { name: '批注', run: session => sheetNamed(session, DATA).getRange('K30').createOrUpdateNote({ note: '新备注', width: 160, height: 60 }) },
  { name: '定义名称', run: session => facade(session).getActiveWorkbook().insertDefinedName('新名称', `'${DATA}'!$A$2:$A$6`) },
  {
    // 选中区域时查找替换只在区域里找（只改视图的"选区"选了 C3:D4）：先选回一格
    name: '全部替换',
    run: async (session) => {
      sheetNamed(session, DATA).getRange('A1').activate()
      return (await facade(session).createTextFinderAsync('苹果')).replaceAllWithAsync('苹果X')
    },
  },
  { name: '取消已有的超链接', run: session => sheetNamed(session, FEATURES).getRange('H3').cancelHyperLink() },
  { name: '移动图片', run: async session => imageOf(session).setPositionAsync(12, 12) },
  { name: '缩放图片', run: async session => imageOf(session).setSizeAsync(200, 150) },
  { name: '删除图片', run: session => imageOf(session).remove() },
  { name: '新增工作表', run: session => facade(session).getActiveWorkbook().insertSheet('新表') },
  { name: '工作表改名', run: session => sheetNamed(session, SUMMARY).setName('汇总二') },
  { name: '移动工作表', run: session => facade(session).getActiveWorkbook().moveSheet(sheetNamed(session, '汇总二'), 0) },
  { name: '隐藏工作表', run: session => sheetNamed(session, '汇总二').hideSheet() },
  { name: '复制工作表', run: session => facade(session).getActiveWorkbook().duplicateSheet(sheetNamed(session, FEATURES)) },
  { name: '删除工作表', run: session => facade(session).getActiveWorkbook().deleteSheet(sheetNamed(session, '新表')) },
  { name: '撤销', run: async session => facade(session).undo() },
  { name: '重做', run: async session => facade(session).redo() },
]

function imageOf(session: Session): CaptureImage {
  const image = sheetNamed(session, FEATURES).getImages()[0]
  if (image === undefined)
    fail(`"${FEATURES}"表没有浮动图片`)
  return image
}

/** 打开之后静默多久再看（M0：到 steady 之后再 5 秒） */
const OPEN_QUIET_MS = 5_000

/** 捕获之后再看多久有没有迟到的变化（M0：5 秒） */
const LATE_WINDOW_MS = 5_000

/** 只改视图的动作之后等多久再看（两帧之后，再给异步的处理一点时间） */
const VIEW_SETTLE_MS = 300

function mutationIds(commands: readonly ProbeCommand[]): string {
  const counts = new Map<string, number>()
  for (const command of commands)
    counts.set(command.id, (counts.get(command.id) ?? 0) + 1)
  return [...counts].map(([id, count]) => (count > 1 ? `${id} ×${count}` : id)).join('、')
}

async function changeDetectionScenario(session: Session): Promise<void> {
  // 只读样本有两张 data: 地址的图片（浮动图片与单元格里的图片，M3-P3 起服务端按 image-source 一律拒收；改内容的动作只删掉浮动的那张）：
  // 暂停定时的上传，只看自动保存的捕获——捕获的内容经同步的订阅另取。整页跳走交回结果时页面变成隐藏、切到后台的上传照常发起，服务端拒收
  // （422），服务器上仍是修订号 1
  if (!await checkEditing(session, { mode: 'held' }))
    return
  const { probe } = session
  const control = autosaveControl()
  const watch = watchCaptures(session)
  try {
    await check(session, 'change.open-quiet', async () => {
      await sleep(OPEN_QUIET_MS)
      if (probe.changeSeq() !== 0)
        fail(`打开之后本地修改序号是 ${probe.changeSeq()}（应当是 0：打开不算修改）；命令日志里的修改：${mutationIds(changesAfter(session, 0))}`)
      const changes = changesAfter(session, 0)
      if (changes.length > 0)
        fail(`就绪之后命令日志里有改文档的 mutation：${mutationIds(changes)}`)
      if (!sameContent(session.opened, probe.snapshot()))
        fail(`内存里的内容与开始时不同：${differences(session.opened, probe.snapshot())}`)
      if (control.log().length > 0)
        fail(`打开之后 ${OPEN_QUIET_MS / 1000} 秒里自动保存有了记录：${describeAutosave(session)}`)
      return `到编辑的 steady 之后再 ${OPEN_QUIET_MS / 1000} 秒：本地修改序号 0，就绪之后 ${probe.commands().length} 条命令里没有改文档的 mutation，内容不变，自动保存没有捕获`
    }, OPEN_QUIET_MS + CHECK_TIMEOUT_MS)

    for (const action of VIEW_ACTIONS) {
      await check(session, `view.${action.name}`, async () => {
        const before = probe.snapshot()
        const seq = probe.changeSeq()
        const mark = lastSeq(probe)
        const logged = control.log().length
        await action.run(session)
        if (!await nextFrames())
          fail('等不到动画帧（页面隐藏？）')
        await sleep(VIEW_SETTLE_MS)
        const changes = changesAfter(session, mark)
        if (probe.changeSeq() !== seq || changes.length > 0)
          fail(`误报：本地修改序号 ${seq} → ${probe.changeSeq()}，改文档的 mutation：${mutationIds(changes)}`)
        if (!sameContent(before, probe.snapshot()))
          fail(`内容变了：${differences(before, probe.snapshot())}`)
        if (control.log().length !== logged)
          fail(`只改视图，自动保存却有了记录：${describeAutosave(session)}`)
        return `不算修改（本地修改序号仍是 ${seq}），内容不变，自动保存没有捕获；之后 ${probe.commands(mark).length} 条命令`
      })
    }

    const contentMark = lastSeq(probe)
    const contentSeq = probe.changeSeq()
    for (const action of CONTENT_ACTIONS) {
      await check(session, `change.${action.name}`, async () => {
        const before = probe.snapshot()
        const seq = probe.changeSeq()
        const mark = lastSeq(probe)
        let callError: string | undefined
        try {
          await action.run(session)
        }
        catch (error) {
          callError = describe(error)
        }
        if (!await waitFor(() => changesAfter(session, mark).length > 0, SIGNAL_TIMEOUT_MS))
          fail(`没有执行改文档的 mutation${callError === undefined ? '' : `（调用抛出 ${callError}）`}；${seenSince(probe, mark)}`)
        // 同一个同步段里读：命令日志里的修改与变更检测的序号
        const changes = changesAfter(session, mark)
        const delta = probe.changeSeq() - seq
        if (delta === 0)
          fail(`漏报：执行了 ${mutationIds(changes)}，本地修改序号没有变`)
        if (delta !== changes.length)
          fail(`变更检测加了 ${delta}，命令日志里改文档的 mutation 有 ${changes.length} 条（${mutationIds(changes)}）：两边的判定不一致`)
        const after = probe.snapshot()
        if (sameContent(before, after))
          fail(`认作修改（${mutationIds(changes)}），内容却没有变`)
        return `检测到 ${delta} 处（${mutationIds(changes)}），内容变了：${differences(before, after)}${callError === undefined ? '' : `；调用抛出 ${callError}`}`
      })
    }

    await check(session, 'change.late', async () => {
      // 自动保存跟上全部修改（最后一次捕获的序号等于本地修改序号），之后 5 秒序号与日志都不变；最后一次捕获的内容（同步的订阅另取的）
      // 与此刻内存里的相同：没有迟到而没被检测的变化
      await untilCaughtUp(session, { uploads: false, monitorMs: LATE_WINDOW_MS, timeoutMs: 30_000 })
      const final = watch.captures().at(-1)
      if (final === undefined)
        fail(`自动保存一次也没有捕获：${describeAutosave(session)}`)
      if (watch.mismatches().length > 0)
        fail(`另取的内容与调度捕获的对不上：${watch.mismatches().join('；')}`)
      const current = probe.snapshot()
      if (probe.changeSeq() !== final.entry.seq || !sameContent(final.snapshot, current))
        fail(`最后一次捕获之后内容变了、没有被检测到：${differences(final.snapshot, current)}`)
      const log = control.log()
      const changes = detectedChanges(session, contentMark, contentSeq)
      const timing = captureTimingProblems(capturesIn(log), changes, control.limits(), contentSeq)
      if (timing.length > 0)
        fail(`捕获早于规则：${timing.join('；')}`)
      if (uploadsIn(log).length > 0)
        fail(`暂停了定时的上传，自动保存却上传了：${describeAutosave(session)}`)
      const origin = changes[0]?.at ?? 0
      return `改内容的 ${CONTENT_ACTIONS.length} 个动作之后自动保存捕获 ${capturesIn(log).length} 次（相对第一处修改：${autosaveTimeline(log, origin)}），捕获的时刻都不早于规则的下限；再看 ${LATE_WINDOW_MS / 1000} 秒：没有迟到而没被检测的变化，最后一次捕获与内存里的内容相同；定时的上传暂停时没有上传`
    }, LATE_WINDOW_MS + 45_000)
  }
  finally {
    watch.dispose()
  }
}

// ---- auto-height ----

const AUTO_HEIGHT_MUTATION = 'sheet.mutation.set-worksheet-row-auto-height'

async function autoHeightScenario(session: Session): Promise<void> {
  if (!await checkEditing(session, { mode: 'running' }))
    return
  const { probe } = session
  const control = autosaveControl()
  await check(session, 'auto-height.font-size', async () => {
    const mark = lastSeq(probe)
    const baseSeq = probe.changeSeq()
    const origin = performance.now()
    sheetNamed(session, BIG_SHEET.name).getRange(`A1:A${BIG_SHEET.rows}`).setFontSize(28)
    const commandDone = performance.now()
    // 自动保存跟上全部修改（迟到的行高被检测到、再捕获与上传），之后 5 秒序号与日志都不变
    await untilCaughtUp(session, { uploads: true, monitorMs: LATE_WINDOW_MS, timeoutMs: 60_000 })
    const heights = probe.commands(mark).filter(command => command.phase === 'executed' && command.id === AUTO_HEIGHT_MUTATION)
    if (heights.length === 0)
      fail(`没有行高的 mutation（${AUTO_HEIGHT_MUTATION}）：样本或 SDK 变了`)
    const detected = heights.filter(command => !command.flags.includes('onlyLocal'))
    const log = control.log()
    const captures = capturesIn(log)
    const uploads = uploadsIn(log).filter(confirmed)
    const first = captures[0]
    const last = captures.at(-1)
    // 服务器上的就是最后一次上传的那一份（服务端原样存下）：与此刻内存里的相同——迟到的行高也存上了
    const stored = await fetchServerContent(session.host.documentId)
    const current = probe.snapshot()
    if (!sameContent(stored, current))
      fail(`服务器上的内容与内存里的不同（最后一次上传之后的修改没有存上）：${differences(stored, current)}`)
    const timing = captureTimingProblems(captures, detectedChanges(session, mark, baseSeq), control.limits(), baseSeq)
    if (timing.length > 0)
      fail(`捕获早于规则：${timing.join('；')}`)
    const idle = heights.filter(command => command.at > commandDone)
    const late = first === undefined ? [] : heights.filter(command => command.at > first.at)
    session.timings.push({
      id: 'auto-height.font-size',
      ms: {
        command: round(commandDone - origin),
        firstHeight: round((heights[0]?.at ?? origin) - origin),
        lastHeight: round((heights.at(-1)?.at ?? origin) - origin),
        firstCapture: first === undefined ? null : round(first.at - origin),
        lastCapture: last === undefined ? null : round(last.at - origin),
        firstUpload: uploads[0] === undefined ? null : round(uploads[0].startedAt - origin),
        lastUploaded: uploads.at(-1) === undefined ? null : round((uploads.at(-1)?.at ?? origin) - origin),
      },
    })
    return `改字号的命令 ${round(commandDone - origin)} ms；行高的 mutation ${heights.length} 条（${detected.length} 条算修改；命令返回之后在空闲任务里到的 ${idle.length} 条，最后一条 +${round((heights.at(-1)?.at ?? origin) - origin)} ms）；自动保存 ${autosaveTimeline(log, origin)}，第一次捕获之后迟到的 ${late.length} 条都被检测到、再捕获与上传；再看 ${LATE_WINDOW_MS / 1000} 秒没有新的变化，服务器上的内容与内存里的相同（最终的行高）；requestIdleCallback ${IDLE_CALLBACK_TEXT[idleCallbackKind()]}`
  }, 90_000)
}

// ---- large-copy ----

async function largeCopyScenario(session: Session): Promise<void> {
  if (!await checkEditing(session, { mode: 'running' }))
    return
  const { probe } = session
  const control = autosaveControl()
  let copied: { readonly id: string, readonly cells: number, readonly origin: number } | undefined
  await check(session, 'large-copy.duplicate', async () => {
    const before = (JSON.parse(probe.snapshot()) as { readonly sheetOrder: readonly string[] }).sheetOrder
    const mark = lastSeq(probe)
    const baseSeq = probe.changeSeq()
    const origin = performance.now()
    facade(session).getActiveWorkbook().duplicateSheet(sheetNamed(session, BIG_SHEET.name))
    const copiedAt = performance.now()
    // 立即另取（不等）：复制品要完整（关掉了大表操作的拆分，插件档案 v1 §1，M0-P3 报告 §2.2）——自动保存在这之后任何时刻捕获都是完整的
    const immediate = probe.snapshot()
    const captured = performance.now()
    const seq = probe.changeSeq()
    const order = (JSON.parse(immediate) as { readonly sheetOrder: readonly string[] }).sheetOrder
    const copyId = order.find(id => !before.includes(id))
    if (copyId === undefined)
      fail(`复制之后没有新的工作表（${order.join('、')}）；${seenSince(probe, mark)}`)
    const original = cellCount(immediate, BIG_SHEET.id)
    const copy = cellCount(immediate, copyId)
    if (original !== BIG_SHEET.rows)
      fail(`原表有 ${original} 格（样本是 ${BIG_SHEET.rows} 格）`)
    if (copy !== original)
      fail(`立即另取的快照里复制品只有 ${copy} 格（原表 ${original} 格）：大表操作被拆分了，余下的在空闲时以 onlyLocal 补上`)
    if (seq === baseSeq)
      fail('复制没有被检测为修改')
    await sleep(3_000)
    const lazy = probe.commands(mark).filter(command => command.phase === 'executed' && command.kind === 'mutation' && command.flags.includes('onlyLocal') && !command.flags.includes(FORMULA_PROTOCOL.applyResultOption) && command.id === FORMULA_PROTOCOL.setRangeValuesMutationId)
    if (lazy.length > 0)
      fail(`复制之后有 ${lazy.length} 条带 onlyLocal 的写值（懒执行）`)
    if (cellCount(probe.snapshot(), copyId) !== original)
      fail('3 秒之后复制品的格数变了')
    copied = { id: copyId, cells: original, origin }
    session.timings.push({ id: 'large-copy.duplicate', ms: { copy: round(copiedAt - origin), capture: round(captured - copiedAt) } })
    return `复制 ${original} 格的工作表 ${round(copiedAt - origin)} ms（同步），立即另取的快照（${round(captured - copiedAt)} ms）里复制品 ${copy} 格、与原表相同；检测到修改（序号 ${baseSeq} → ${seq}）；3 秒之内没有懒执行的写值`
  }, 30_000)
  await check(session, 'large-copy.uploaded', async () => {
    if (copied === undefined)
      fail('上一项没有做完')
    const { upload } = await untilUploaded(session, probe.changeSeq(), { timeoutMs: 30_000 })
    const stored = await fetchServerContent(session.host.documentId)
    const cells = cellCount(stored, copied.id)
    if (cells !== copied.cells || cellCount(stored, BIG_SHEET.id) !== copied.cells)
      fail(`服务器上的复制品 ${cells} 格、原表 ${cellCount(stored, BIG_SHEET.id)} 格（应当都是 ${copied.cells} 格）`)
    if (!sameContent(stored, probe.snapshot()))
      fail(`服务器上的内容与内存里的不同：${differences(stored, probe.snapshot())}`)
    session.timings.push({ id: 'large-copy.uploaded', ms: { uploadStart: round(upload.startedAt - copied.origin), uploaded: round(upload.at - copied.origin) } })
    return `自动保存 ${autosaveTimeline(control.log(), copied.origin)}；服务器上的复制品 ${cells} 格、与原表相同，与内存里的内容相同`
  }, 45_000)
}

// ---- composition ----

/** 批注里组字：拼音逐步变长（合成的 input），最后选定的文字 */
const COMPOSITION_STEPS = ['n', 'ni', 'nih', 'niha', 'nihao']
const COMPOSITION_STEP_MS = 80

/** SDK 的批注输入框按 300 ms 防抖写批注（sheets-note-ui 的 views/Note.tsx:110-143），组字中停住比它长一点 */
const NOTE_DEBOUNCE_WAIT_MS = 400

/**
 * 拼音写进批注之后再组字多久才选定：比捕获的静默（1 秒）长，不认组字的规则这时就会在组字中捕获（变异验证）；
 * 整段组字仍在捕获的上限（从第一处没捕获的修改算起 3 秒）之内
 */
const COMPOSITION_HOLD_EXTRA_MS = 300

/** 命令日志记下修改的时刻、这里记下组合结束的时刻，与调度记下的差一点（同一个同步段的前后）：比较时留出的余量 */
const COMPOSITION_TOLERANCE_MS = 20

/**
 * 改受控的 textarea 的值并派发 input：经原型上的 setter 改（Reflect.set 以 textarea 为接收者调用原型的 setter，绕过 React 装在元素上的
 * 值跟踪，React 才认得出值变了、调用 onChange），isComposing 按组字与否
 */
function typeInto(textarea: HTMLTextAreaElement, value: string, composing: boolean): void {
  Reflect.set(HTMLTextAreaElement.prototype, 'value', value, textarea)
  textarea.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, isComposing: composing, inputType: composing ? 'insertCompositionText' : 'insertText', data: value }))
}

function noteText(snapshotText: string, sheetId: string, row: number, column: number): string | undefined {
  const snapshot = JSON.parse(snapshotText) as { readonly resources?: readonly { readonly name: string, readonly data: string }[] }
  const data = snapshot.resources?.find(resource => resource.name === 'SHEET_NOTE_PLUGIN')?.data
  if (data === undefined || data === '')
    return undefined
  const notes = JSON.parse(data) as Readonly<Record<string, Readonly<Record<string, Readonly<Record<string, { readonly note?: string }>>>>>>
  return notes[sheetId]?.[row]?.[column]?.note
}

function noteTextarea(): HTMLTextAreaElement | undefined {
  return [...document.querySelectorAll<HTMLTextAreaElement>(NOTE_TEXTAREA_SELECTOR)].find(isVisible)
}

interface CompositionOutcome {
  readonly mark: number
  readonly startAt: number
  readonly endAt: number
  readonly quietMs: number
}

async function compositionScenario(session: Session): Promise<void> {
  if (!await checkEditing(session, { mode: 'running' }))
    return
  const { probe } = session
  const control = autosaveControl()
  const target = COMPOSITION_NOTE
  let textarea: HTMLTextAreaElement | undefined
  const opened = await check(session, 'composition.open-note', async () => {
    const sheet = facade(session).getActiveWorkbook().getActiveSheet()
    if (sheet.getSheetId() !== target.sheetId)
      fail(`当前工作表是 ${sheet.getSheetId()}（应当是模板的 ${target.sheetId}）`)
    sheet.getRange(target.cell).activate()
    const mark = lastSeq(probe)
    const openedAt = performance.now()
    await facade(session).executeCommand('sheet.operation.add-note-popup')
    if (!await waitFor(() => noteTextarea() !== undefined, SIGNAL_TIMEOUT_MS))
      fail(`批注的输入框没有出现；${seenSince(probe, mark)}`)
    textarea = noteTextarea()
    // 浮层在动画帧里聚焦它；没有聚焦时（合成的命令不带用户手势）自己聚焦
    const focused = await waitFor(() => document.activeElement === textarea, 1_000)
    if (!focused)
      textarea?.focus()
    // 打开时浮层按输入框的尺寸写回批注（Note.tsx 的 handleResize），等它过去；自动保存照常把它存上——组字从没有未存的修改开始
    await sleep(NOTE_DEBOUNCE_WAIT_MS + 200)
    const writes = probe.commands(mark).filter(command => command.phase === 'executed' && command.id === 'sheet.mutation.update-note')
    await untilCaughtUp(session, { uploads: true, monitorMs: 0, timeoutMs: 20_000 })
    return `批注的输入框出现${focused ? '并聚焦' : '（没有自己聚焦，自检聚焦它）'}；打开时写了 ${writes.length} 次批注${writes.length === 0 ? '' : `，自动保存存上（${autosaveTimeline(control.log(), openedAt)}）`}`
  }, 30_000)
  if (!opened || textarea === undefined)
    return
  const input = textarea
  let outcome: CompositionOutcome | undefined
  await check(session, 'composition.note-while-composing', async () => {
    control.clearLog()
    const mark = lastSeq(probe)
    const baseSeq = probe.changeSeq()
    const quietMs = control.limits().captureQuietMs
    const startAt = performance.now()
    input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, composed: true, data: '' }))
    for (const step of COMPOSITION_STEPS) {
      input.dispatchEvent(new CompositionEvent('compositionupdate', { bubbles: true, composed: true, data: step }))
      typeInto(input, step, true)
      await sleep(COMPOSITION_STEP_MS)
    }
    await sleep(NOTE_DEBOUNCE_WAIT_MS)
    const writesWhileComposing = probe.commands(mark).filter(command => command.phase === 'executed' && command.id === 'sheet.mutation.update-note')
    const seqWhileComposing = probe.changeSeq() - baseSeq
    await sleep(quietMs + COMPOSITION_HOLD_EXTRA_MS)
    input.dispatchEvent(new CompositionEvent('compositionupdate', { bubbles: true, composed: true, data: target.text }))
    typeInto(input, target.text, true)
    input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, composed: true, data: target.text }))
    const endAt = performance.now()
    outcome = { mark, startAt, endAt, quietMs }
    if (writesWhileComposing.length === 0)
      fail(`组字中停了 ${NOTE_DEBOUNCE_WAIT_MS} ms，SDK 没有把拼音写进批注（预期按 300 ms 防抖写进去）：组字中批注不写模型，设计 §3.6 的前提要重新看`)
    if (seqWhileComposing === 0)
      fail('组字中写了批注，变更检测没有认出')
    return `组字中 SDK 把拼音写进了批注：${writesWhileComposing.length} 次 update-note（第一次在组字开始之后 +${round((writesWhileComposing[0]?.at ?? startAt) - startAt)} ms），变更检测认出 ${seqWhileComposing} 处修改；组字 ${round(endAt - startAt)} ms`
  }, 30_000)
  await check(session, 'composition.capture-after-end', async () => {
    if (outcome === undefined)
      fail('上一项没有做完')
    const { mark, startAt, endAt, quietMs } = outcome
    // 组合结束之后 SDK 按 300 ms 防抖把选定的文字写进批注：等这一处修改，再等自动保存把它上传
    const written = (): boolean => probe.commands(mark).some(command => command.phase === 'executed' && command.id === 'sheet.mutation.update-note' && command.at > endAt)
    if (!await waitFor(written, SIGNAL_TIMEOUT_MS))
      fail(`组合结束之后 SDK 没有把选定的文字写进批注；${seenSince(probe, mark)}`)
    const { upload } = await untilUploaded(session, probe.changeSeq(), { timeoutMs: 20_000 })
    const log = control.log()
    const captures = capturesIn(log)
    const during = captures.filter(capture => capture.at >= startAt && capture.at < endAt)
    if (during.length > 0)
      fail(`组字中捕获了 ${during.length} 次（第一次 +${round((during[0]?.at ?? startAt) - startAt)} ms，${triggerText(during[0]?.trigger ?? '?')}）：组字中不应捕获`)
    const first = captures.find(capture => capture.at >= endAt)
    if (first === undefined)
      fail('组合结束之后没有捕获')
    if (first.at < endAt + quietMs - COMPOSITION_TOLERANCE_MS)
      fail(`组合结束之后 ${round(first.at - endAt)} ms 就捕获了（应当至少 ${quietMs} ms）`)
    const stored = await fetchServerContent(session.host.documentId)
    const note = noteText(stored, target.sheetId, target.row, target.column)
    if (note !== target.text)
      fail(`服务器上的批注是 ${JSON.stringify(note)}（应当是选定的"${target.text}"）`)
    session.timings.push({ id: 'composition', ms: { compositionEnd: round(endAt - startAt), firstCapture: round(first.at - startAt), uploaded: round(upload.at - startAt) } })
    return `组字中没有捕获；组合结束之后 +${round(first.at - endAt)} ms 捕获（${triggerText(first.trigger)}）、+${round(upload.at - endAt)} ms 上传存上（${triggerText(upload.trigger)}），服务器上的批注是选定的"${target.text}"（共 ${captures.length} 次捕获）`
  })
}

// ---- hidden-save ----

/** 等页面变成隐藏最多等多久：驱动脚本在库里看到第一次上传之后才另开标签页 */
const HIDDEN_WAIT_MS = 120_000

/** 上传最多等多久（隐藏之后 Safari 约 6 秒停计时器，等的循环也随之停住；回到前台之后才继续） */
const SAVE_WAIT_MS = 20_000

/**
 * 隐藏之前不让自动保存按时捕获：捕获的静默与上限调到一小时。第二格在隐藏的那一刻才由自动保存捕获（与上传一起）——切到后台时有没捕获的修改，
 * 是最吃紧的情形（同步捕获、压缩、发出请求都要赶在 Safari 停计时器之前）
 */
const NO_TIMED_CAPTURE_MS = 3_600_000

async function hiddenSaveScenario(session: Session): Promise<void> {
  if (!await checkEditing(session, { mode: 'held', limits: { captureQuietMs: NO_TIMED_CAPTURE_MS, captureMaxMs: NO_TIMED_CAPTURE_MS } }))
    return
  const control = autosaveControl()
  const [first, second] = HIDDEN_SAVE_EDITS
  const sheet = facade(session).getActiveWorkbook().getActiveSheet()
  const state: { hiddenAt?: number } = {}
  // 隐藏的那一刻：在 window 上的捕获阶段记下，先于编辑器页挂在 document 上的处理（自动保存在那里同步捕获、发起上传）
  const onVisibility = (): void => {
    if (document.visibilityState === 'hidden')
      state.hiddenAt ??= performance.now()
  }
  window.addEventListener('visibilitychange', onVisibility, true)
  try {
    const firstSaved = await check(session, 'hidden.first-save', async () => {
      if (sheet.getSheetId() !== first.sheetId)
        fail(`当前工作表是 ${sheet.getSheetId()}（应当是模板的 ${first.sheetId}）`)
      sheet.getRange(first.cell).setValue(first.value)
      const firstSeq = session.probe.changeSeq()
      if (session.host.view().save !== 'dirty')
        fail(`改了一格，保存状态是 ${session.host.view().save ?? '没有'}（应当是 dirty）`)
      // 控制的 flush：同步捕获（第一格）、发起上传；随即写第二格——它不在这一次上传里，留到隐藏的那一刻
      const started = performance.now()
      const flushing = control.flush()
      sheet.getRange(second.cell).setValue(second.value)
      const secondSeq = session.probe.changeSeq()
      const result = await flushing
      if (result?.outcome?.kind !== 'saved')
        fail(`控制的 flush 没有存上：${JSON.stringify(result) ?? '没有当前的调度'}；${describeAutosave(session)}`)
      const log = control.log()
      const captures = capturesIn(log)
      const uploads = uploadsIn(log)
      if (captures.length !== 1 || captures[0]?.trigger !== 'control' || captures[0].seq !== firstSeq)
        fail(`捕获应当只有控制的那一次（序号 ${firstSeq}）：${autosaveTimeline(log, started)}`)
      if (uploads.length !== 1 || uploads[0]?.seq !== firstSeq)
        fail(`上传应当只有控制的那一次（序号 ${firstSeq}）：${autosaveTimeline(log, started)}`)
      const request = requestOf(result.outcome.requestId)
      if (request?.status !== 200 || request.localSeq !== String(firstSeq))
        fail(`第一格的保存请求：状态 ${String(request?.status)}、修改序号 ${String(request?.localSeq)}（应当是 200、${firstSeq}）`)
      if (secondSeq <= firstSeq)
        fail('写第二格没有被检测为修改')
      if (session.host.view().save !== 'dirty')
        fail(`第一格存上之后保存状态是 ${session.host.view().save ?? '没有'}（应当是 dirty：第二格还没上传）`)
      return `第一格（${first.cell}）经控制的 flush 捕获、上传、存上（${round(performance.now() - started)} ms）；第二格（${second.cell}）在它上传时写下，留着没捕获（捕获的静默与上限是一小时）、没上传（定时的上传暂停）；之后等页面变成隐藏（驱动脚本另开标签页）`
    })
    if (!firstSaved)
      return
    await check(session, 'hidden.upload-while-hidden', async () => {
      if (!await waitFor(() => state.hiddenAt !== undefined, HIDDEN_WAIT_MS, 100))
        fail(`${HIDDEN_WAIT_MS / 1000} 秒内页面没有变成隐藏`)
      const hiddenAt = state.hiddenAt ?? 0
      const seq = session.probe.changeSeq()
      const { upload, request } = await untilUploaded(session, seq, { timeoutMs: SAVE_WAIT_MS })
      const capture = capturesIn(control.log()).find(item => item.trigger === 'hidden')
      if (capture?.seq !== seq)
        fail(`隐藏的那一刻自动保存没有捕获第二格：${describeAutosave(session)}`)
      if (upload.trigger !== 'hidden')
        fail(`上传第二格的不是切到后台（${triggerText(upload.trigger)}）：${describeAutosave(session)}`)
      if (request?.status !== 200 || request.answeredAt === undefined)
        fail(`隐藏之后的保存请求：状态 ${String(request?.status)}`)
      const ms = { capture: round(capture.at - hiddenAt), request: round(request.at - hiddenAt), response: round(request.answeredAt - hiddenAt), uploaded: round(upload.at - hiddenAt) }
      session.timings.push({ id: 'hidden.upload', ms })
      return `隐藏之后 +${ms.capture} ms 自动保存捕获第二格（切到后台）、+${ms.request} ms 发出保存请求、+${ms.response} ms 收到 200，+${ms.uploaded} ms 调度记下存上（页面看到的；驱动脚本以库里的为准）`
    }, HIDDEN_WAIT_MS + SAVE_WAIT_MS + CHECK_TIMEOUT_MS)
  }
  finally {
    window.removeEventListener('visibilitychange', onVisibility, true)
  }
}

/** 捕获时机的各场景（场景名在 ./selftest-report.ts 的 CAPTURE_SCENARIOS） */
export const CAPTURE_SCENARIO_RUNNERS: Readonly<Record<CaptureScenario, (session: Session) => Promise<void>>> = {
  'environment': environmentScenario,
  'change-detection': changeDetectionScenario,
  'formula-timing': formulaTimingScenario,
  'auto-height': autoHeightScenario,
  'large-copy': largeCopyScenario,
  'composition': compositionScenario,
  'hidden-save': hiddenSaveScenario,
}

/** 这些场景要求页面在中途变成隐藏（不按"页面被隐藏，余下的检查不做"处理） */
export const EXPECTS_HIDDEN: ReadonlySet<string> = new Set<CaptureScenario>(['hidden-save'])

// 请求编辑的两条路的页面自检（selftest-request.ts）里的判读：请求方的时间线判读成一条路（在后台停在交给了我、回到前台才进入），被暂停的持有者的
// 时间线判读成一条路（回到前台之后才得知失去编辑权、没有交出）与各段的用时。真实 Safari 的复核（M3-P6 设计 §3.10，DEF-062）按它们判断走的是不是设计的那一条。
// 有别的条件兜着的条件也各有一条只违反它的用例（审查 B13：每个条件单独有人看着）
import type { SelftestTimelineEntry } from './selftest-report.ts'
import { EDIT_HANDOVER_IDLE_SECONDS } from '@nerve-office/contracts'
import { describe, expect, it } from 'vitest'
import { HANDOVER_IDLE_MS, summarizePausedHolder, summarizeWaiter } from './selftest-request.ts'

/** 一条：wall 是墙上时间（毫秒），at 随便取 */
function entry(kind: string, wall: number, fields: Readonly<Record<string, unknown>> = {}): SelftestTimelineEntry {
  return { kind, wall, at: wall, ...fields }
}

/** 请求方：发出、在等，2 秒之后隐藏；隐藏之后 4 秒续期得到 reserved、停在交给了我（看不见）；14 秒之后回到前台，随即开始进入、申请、进入编辑 */
const WAITER: readonly SelftestTimelineEntry[] = [
  entry('page:click', 950),
  entry('request-sent', 1_000, { outcome: 'pending' }),
  entry('request-renewed', 2_500, { outcome: 'pending' }),
  entry('page:visibility-hidden', 3_000),
  entry('request-renewed', 7_000, { outcome: 'reserved' }),
  entry('request-granted', 7_000, { visible: false }),
  entry('page:visibility-visible', 21_000),
  entry('request-enter', 21_001),
  entry('acquire', 21_001, { trigger: 'granted', takeover: null }),
  entry('acquire-result', 21_040, { result: 'acquired', interruption: false, code: null }),
  entry('entered', 21_600),
]

function without(timeline: readonly SelftestTimelineEntry[], kind: string): SelftestTimelineEntry[] {
  return timeline.filter(item => item.kind !== kind)
}

function replaced(timeline: readonly SelftestTimelineEntry[], kind: string, fields: Readonly<Record<string, unknown>>): SelftestTimelineEntry[] {
  return timeline.map(item => item.kind === kind ? { ...item, ...fields } : item)
}

describe('请求方的时间线判读成一条路（summarizeWaiter）', () => {
  it('entered-on-return：在等时隐藏，续期得到 reserved、停在交给了我（看不见），之后不续期、不申请；回到前台之后才开始进入、普通申请、进入编辑', () => {
    const summary = summarizeWaiter(WAITER)
    expect(summary.path).toBe('entered-on-return')
    expect(summary.problems).toEqual([])
    expect(summary.ms).toEqual({ sentToHidden: 2_000, hiddenToGranted: 4_000, held: 14_000, shownToAcquire: 1, shownToEntered: 600 })
    expect(summary.text).toBe('发出请求（pending），2.0 秒之后页面隐藏，隐藏之后 4.0 秒续期得到 reserved、停在交给了我（页面看不见），14.0 秒之后回到前台（这期间续期 0 次、没有申请），回到前台之后 +1 ms 申请（granted，接管方式 null，结果 acquired）、+600 ms 进入编辑')
  })

  it('entered-while-hidden：看得见之前就申请了（在后台抢到的编辑权会因 Safari 暂停而到期）', () => {
    const early = [...WAITER.slice(0, 6), entry('request-enter', 7_001), entry('acquire', 7_001, { trigger: 'granted', takeover: null }), entry('acquire-result', 7_040, { result: 'acquired', interruption: false, code: null }), entry('entered', 7_600), entry('page:visibility-visible', 21_000)]
    const summary = summarizeWaiter(early)
    expect(summary.path).toBe('entered-while-hidden')
    expect(summary.problems).toEqual(['页面看不见的时候就申请了编辑权（应当停在交给了我、回到前台再进）'])
    expect(summary.text).toContain('这期间续期 0 次、申请了')
  })

  it('granted-while-visible：得知交给了这一页时页面看得见（驱动脚本没让它隐藏），或者 granted 记着看得见', () => {
    expect(summarizeWaiter(without(without(WAITER, 'page:visibility-hidden'), 'page:visibility-visible')).path).toBe('granted-while-visible')
    expect(summarizeWaiter(replaced(WAITER, 'request-granted', { visible: true })).path).toBe('granted-while-visible')
    const late = replaced(WAITER, 'page:visibility-hidden', { wall: 8_000 })
    expect(summarizeWaiter(late).problems).toEqual(['得知交给了这一页的时候页面看得见（驱动脚本没让它隐藏，或者隐藏得太晚）'])
  })

  it('not-granted、not-shown、not-entered：各自说明', () => {
    expect(summarizeWaiter(without(WAITER, 'request-granted')).problems).toEqual(['一直没有得知编辑权交给了这一页（没有 request-granted）'])
    const stuck = WAITER.filter(item => item.wall < 21_000)
    expect(summarizeWaiter(stuck).path).toBe('not-shown')
    expect(summarizeWaiter(stuck).text).toContain('一直没有回到前台')
    const refused = replaced(without(WAITER, 'entered'), 'acquire-result', { result: 'held' })
    expect(summarizeWaiter(refused).path).toBe('not-entered')
    expect(summarizeWaiter(refused).problems).toEqual(['回到前台之后没有进入编辑（申请 结果 held，没有进入编辑）'])
  })

  it('细节不合预期时另记问题：发出时不在等、交给了我的那次续期不是 reserved、交给了我之后还在续期、申请带了接管方式或来由不对、回到前台之后没有开始进入', () => {
    expect(summarizeWaiter(replaced(WAITER, 'request-sent', { outcome: 'free' })).problems).toEqual(['发出请求的结果是 free（应当在等 pending：另一方正在编辑）'])
    const free = WAITER.map(item => item.kind === 'request-renewed' && item.wall === 7_000 ? { ...item, outcome: 'free' } : item)
    expect(summarizeWaiter(free).problems).toEqual(['得知交给了这一页的那次续期的结果是 free（应当是 reserved：另一方交出之后编辑权留给这一页）'])
    const renewing = [...WAITER.slice(0, 6), entry('request-renewed', 12_000, { outcome: 'reserved' }), ...WAITER.slice(6)]
    expect(summarizeWaiter(renewing).problems).toEqual(['停在交给了我之后又续期了 1 次（granted 时不再续期）'])
    expect(summarizeWaiter(replaced(WAITER, 'acquire', { takeover: 'self' })).problems).toEqual(['申请的来由是 granted、接管方式是 self（应当是请求被批准之后的普通申请：granted、null）'])
    expect(summarizeWaiter(without(WAITER, 'request-enter')).problems).toEqual(['回到前台之后没有记下开始进入（request-enter）'])
    expect(summarizeWaiter(without(WAITER, 'request-sent')).problems).toContain('发出请求的结果是 没有发出（应当在等 pending：另一方正在编辑）')
  })

  it('只违反"回到前台之后才开始进入"：开始进入记在回到前台之前，申请却在回到前台之后（路照样是 entered-on-return，另记问题）', () => {
    const early = WAITER.map(item => item.kind === 'request-enter' ? { ...item, wall: 20_000 } : item)
    const summary = summarizeWaiter(early)
    expect(summary.path).toBe('entered-on-return')
    expect(summary.problems).toEqual(['开始进入（request-enter）记在回到前台之前 1000 ms（应当回到前台之后才开始进入）'])
  })
})

/** 持有者：进入编辑，隐藏，6 秒之后心跳带来请求；计时器压低、最后停了 95 秒；隐藏之后 150 秒回到前台，随即开始自动交出（积压的计时器）、失去编辑权（held:other） */
const HOLDER: readonly SelftestTimelineEntry[] = [
  entry('entered', 500),
  entry('page:state', 1_000, { mode: 'editing' }),
  entry('page:visibility-hidden', 10_000),
  entry('page:state', 16_000, { mode: 'editing', incoming: 'peer-id' }),
  entry('page:tick-gap', 30_000, { gapMs: 4_000 }),
  entry('page:tick-gap', 160_000, { gapMs: 95_000 }),
  entry('page:visibility-visible', 160_002),
  entry('leave', 160_005, { cause: 'handover-request' }),
  entry('page:state', 160_005, { mode: 'exiting', incoming: 'peer-id', leaving: 'handover-request' }),
  entry('page:state', 160_090, { mode: 'losing', loss: 'held:other' }),
  entry('page:state', 160_300, { mode: 'lost', loss: 'held:other' }),
]

/** 没被暂停的持有者（2026-10-08 第一次真实 Safari 运行的样子）：进入编辑 0.5 秒，隐藏之后照常心跳、带来请求；进入编辑之后 123.7 秒自动交出，回来之后回到阅读 */
const ALIVE: readonly SelftestTimelineEntry[] = [
  ...HOLDER.slice(0, 5),
  entry('leave', 124_200, { cause: 'handover-request' }),
  entry('page:state', 124_200, { mode: 'exiting', incoming: 'peer-id', leaving: 'handover-request' }),
  entry('page:visibility-visible', 142_400),
  entry('left', 142_700, { cause: 'handover-request', outcome: 'reading' }),
  entry('page:state', 142_700, { mode: 'reading' }),
]

describe('被盖屏的持有者的时间线判读成一条路（summarizePausedHolder）', () => {
  it('与 contracts 的空闲满 2 分钟自动交出相同（这里另写一份：引用 contracts 会改变测试构建的分块）', () => {
    expect(HANDOVER_IDLE_MS).toBe(EDIT_HANDOVER_IDLE_SECONDS * 1000)
  })

  it('lost-after-pause：隐藏（心跳带来请求、出现提示）、计时器停了很久，回到前台之后才失去编辑权（另一方在编辑），没有交出', () => {
    const summary = summarizePausedHolder(HOLDER)
    expect(summary.path).toBe('lost-after-pause')
    expect(summary.problems).toEqual([])
    expect(summary.ms).toEqual({ hiddenToRequest: 6_000, longestGap: 95_000, hiddenToShown: 150_002, shownToLost: 88, enteredToLeave: null })
    expect(summary.text).toBe('隐藏，隐藏之后 6.0 秒心跳带来请求（出现提示），计时器最长停了 95.0 秒（到隐藏之后 150.0 秒），隐藏之后 150.0 秒回到前台，回来之后 +3 ms 开始离开编辑（handover-request），回来之后 +88 ms 失去编辑权（held:other）')
  })

  it('Playwright 的样子：心跳被拦住、请求没有带到，计时器不停；回到前台之后的下一次心跳才得知——同样是 lost-after-pause', () => {
    const playwright = [entry('page:visibility-hidden', 10_000), entry('page:visibility-visible', 110_000), entry('page:state', 115_000, { mode: 'losing', loss: 'held:other' }), entry('page:state', 115_200, { mode: 'lost', loss: 'held:other' })]
    const summary = summarizePausedHolder(playwright)
    expect([summary.path, summary.problems, summary.ms.hiddenToRequest, summary.ms.longestGap]).toEqual(['lost-after-pause', [], null, null])
    expect(summary.text).toBe('隐藏，隐藏期间心跳没有带来请求，计时器没有超过 3 秒的停顿，隐藏之后 100.0 秒回到前台，回来之后没有开始离开编辑，回来之后 +5000 ms 失去编辑权（held:other）')
  })

  it('handed-over：没被暂停——心跳带来请求，进入编辑之后空闲满 2 分钟才自动交出、回到阅读；没有失去编辑权', () => {
    const summary = summarizePausedHolder(ALIVE)
    expect(summary.path).toBe('handed-over')
    expect(summary.problems).toEqual([])
    expect(summary.ms).toEqual({ hiddenToRequest: 6_000, longestGap: 4_000, hiddenToShown: 132_400, shownToLost: null, enteredToLeave: 123_700 })
    expect(summary.text).toBe('隐藏，隐藏之后 6.0 秒心跳带来请求（出现提示），计时器最长停了 4.0 秒（到隐藏之后 20.0 秒），隐藏之后 132.4 秒回到前台，进入编辑之后 123.7 秒（隐藏之后 114.2 秒）开始自动交出（handover-request），隐藏之后 132.7 秒回到阅读，没有失去编辑权')
  })

  it('handed-over 而细节不对：空闲不满 2 分钟就交出、不是自动交出、交出之前心跳没有带来请求，各自说明', () => {
    const early = ALIVE.map(item => item.kind === 'leave' ? { ...item, wall: 100_000 } : item)
    expect(summarizePausedHolder(early).problems).toEqual(['进入编辑之后 99.5 秒就开始自动交出（应当空闲满 120 秒）'])
    const exited = ALIVE.map(item => item.kind === 'leave' || item.kind === 'left' ? { ...item, cause: 'exit' } : item)
    expect(summarizePausedHolder(exited).problems).toEqual(['离开编辑的原因是 exit（应当是自动交出 handover-request）'])
    const unasked = ALIVE.filter(item => item.incoming === undefined)
    expect(summarizePausedHolder(unasked).problems).toEqual(['开始交出之前心跳没有带来请求'])
  })

  it('只违反"回到阅读的那一次也是自动交出"：空闲满 2 分钟的自动交出没成（留在编辑），人回来之后点"退出编辑"才交出、回到阅读', () => {
    const retried: SelftestTimelineEntry[] = [
      ...HOLDER.slice(0, 5),
      entry('leave', 124_200, { cause: 'handover-request' }),
      entry('page:state', 124_200, { mode: 'exiting', incoming: 'peer-id', leaving: 'handover-request' }),
      entry('left', 124_900, { cause: 'handover-request', outcome: 'stayed' }),
      entry('page:state', 124_900, { mode: 'editing', incoming: 'peer-id' }),
      entry('page:visibility-visible', 142_400),
      entry('leave', 143_000, { cause: 'exit' }),
      entry('page:state', 143_000, { mode: 'exiting', incoming: 'peer-id', leaving: 'exit' }),
      entry('left', 143_300, { cause: 'exit', outcome: 'reading' }),
      entry('page:state', 143_300, { mode: 'reading' }),
    ]
    const summary = summarizePausedHolder(retried)
    expect(summary.path).toBe('handed-over')
    expect(summary.problems).toEqual(['离开编辑的原因是 handover-request、回到阅读的那一次是 exit（应当是自动交出 handover-request）'])
  })

  it('lost-while-hidden、not-lost、not-shown、not-hidden：各自说明', () => {
    const early = [...HOLDER.slice(0, 4), entry('page:state', 120_000, { mode: 'lost', loss: 'held:other' }), entry('page:visibility-visible', 160_000)]
    expect(summarizePausedHolder(early).problems).toEqual(['还在后台就得知失去编辑权：这一页没有被暂停，却也没有在空闲满 2 分钟时交出'])
    expect(summarizePausedHolder(early).text).toContain('还在后台时失去编辑权（held:other）')
    expect(summarizePausedHolder(HOLDER.slice(0, 7)).path).toBe('not-lost')
    expect(summarizePausedHolder(HOLDER.slice(0, 6)).path).toBe('not-shown')
    expect(summarizePausedHolder(HOLDER.slice(0, 2)).problems).toEqual(['页面一直没有隐藏（驱动脚本没有盖屏？）'])
  })

  it('失去编辑权的原因不是另一方在编辑（例如自己在别处、被收回）时另记问题', () => {
    const self = replaced(HOLDER, 'page:state', { loss: 'held:self' })
    expect(summarizePausedHolder(self).problems).toEqual(['失去编辑权的原因是 held:self（应当是 held:other：续上时另一方已经接手、正在编辑）'])
  })
})

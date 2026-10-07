// 交接的页面自检（selftest-handover.ts）里的判读：B 的交接日志判读成一条路（answered、silent）与各段的用时，A 的日志判读成一句话，
// 刷新之前离开时的观察判读成先后与问题（真实 Safari 复核要回答的：WebKit 是不是先取消在途的保存、之后才派发 pagehide）。
import type { LogEntry } from './selftest-handover.ts'
import type { SelftestTimelineEntry } from './selftest-report.ts'
import { EDIT_PENDING_SAVE_WAIT_MS } from '@nerve-office/contracts'
import { describe, expect, it } from 'vitest'
import { leavingSummary, PENDING_SAVE_WAIT_MS, pendingSaveKeyOf, summarizeHolder, summarizeTaker } from './selftest-handover.ts'

/** 一条日志：at 是本页的单调时钟，墙上时间取 1000 + at */
function entry(kind: string, at: number, fields: Readonly<Record<string, unknown>> = {}): LogEntry {
  return { kind, at, wall: 1_000 + at, ...fields }
}

/** 进入编辑之前的那几条（B 打开时没有）与"在此编辑"开始、锁在本浏览器、发出请求 */
const ASKED: readonly LogEntry[] = [
  entry('takeover-start', 100, { anyway: false }),
  entry('takeover-locate', 102, { here: true }),
  entry('handover-request', 103, { requestId: 'r1' }),
]

describe('B 的交接日志判读成一条路（summarizeTaker）', () => {
  it('answered：收到 ack、锁空了，之后普通申请、取得、进入编辑；各段相对开始或请求', () => {
    const summary = summarizeTaker([
      ...ASKED,
      entry('handover-reply', 120, { requestId: 'r1', reply: 'ack', detail: 'editing' }),
      entry('handover-lock-free', 400),
      entry('acquire', 401, { trigger: 'take-over', takeover: null }),
      entry('acquire-result', 430, { result: 'acquired', interruption: false, code: null }),
      entry('entered', 900),
    ])
    expect(summary.path).toBe('answered')
    expect(summary.problems).toEqual([])
    expect(summary.ms).toEqual({ request: 3, reply: 17, finished: 297, silent: null, acquire: 301, entered: 800 })
    expect(summary.text).toBe('点"在此编辑"之后 +3 ms 发出交接请求，+17 ms 收到回应（ack）、+297 ms 锁空了、普通申请，+800 ms 进入编辑')
  })

  it('answered：收到 done 也算做完；A 的释放没送到（被自己占着）时另以本人接管再申请一次，也合预期', () => {
    const summary = summarizeTaker([
      ...ASKED,
      entry('handover-reply', 110, { requestId: 'r1', reply: 'ack', detail: 'editing' }),
      entry('handover-reply', 300, { requestId: 'r1', reply: 'done', detail: null }),
      entry('acquire', 301, { trigger: 'take-over', takeover: null }),
      entry('acquire-result', 320, { result: 'held', interruption: false, code: null }),
      entry('acquire', 321, { trigger: 'take-over', takeover: 'self' }),
      entry('acquire-result', 340, { result: 'acquired', interruption: false, code: null }),
      entry('entered', 700),
    ])
    expect([summary.path, summary.problems, summary.ms.finished]).toEqual(['answered', [], 197])
    expect(summary.text).toContain('收到 done')
  })

  it('silent：3 秒没有回应，以本人接管申请、取得、进入编辑', () => {
    const summary = summarizeTaker([
      ...ASKED,
      entry('handover-silent', 3_103),
      entry('acquire', 3_104, { trigger: 'take-over', takeover: 'self' }),
      entry('acquire-result', 3_130, { result: 'acquired', interruption: false, code: null }),
      entry('entered', 3_600),
    ])
    expect(summary.path).toBe('silent')
    expect(summary.problems).toEqual([])
    expect(summary.ms).toEqual({ request: 3, reply: null, finished: null, silent: 3_000, acquire: 3_004, entered: 3_500 })
    expect(summary.text).toBe('点"在此编辑"之后 +3 ms 发出交接请求，3000 ms 没有回应（一直没有回应）、以本人接管申请，+3500 ms 进入编辑')
  })

  it('不合预期的都说出来：没有回应却普通申请、回应了却以本人接管申请、锁不在本浏览器、没有取得、没有进入', () => {
    expect(summarizeTaker([...ASKED, entry('handover-silent', 3_103), entry('acquire', 3_104, { takeover: null }), entry('acquire-result', 3_130, { result: 'acquired' }), entry('entered', 3_600)]).problems)
      .toEqual(['没有回应之后应当以本人接管申请，申请的接管方式是 null'])
    expect(summarizeTaker([...ASKED, entry('handover-lock-free', 200), entry('acquire', 201, { takeover: 'self' }), entry('acquire-result', 230, { result: 'acquired' }), entry('entered', 600)]).problems)
      .toEqual(['A 做完之后应当普通申请（被自己占着时另以本人接管再申请一次），申请的接管方式是 self'])
    const stray = summarizeTaker([entry('takeover-start', 100), entry('takeover-locate', 102, { here: false }), entry('acquire', 103, { takeover: 'self' }), entry('acquire-result', 130, { result: 'held' })])
    expect(stray.path).toBe('unknown')
    expect(stray.problems).toEqual([
      '锁不在本浏览器（takeover-locate 是 false）：A 已经不在编辑了？',
      '没有发出交接请求（handover-request）',
      '既没有收到 A 做完的信号，也没有到时限',
      '申请的结果是 held（应当取得编辑权）',
      '没有进入编辑（entered）',
    ])
    expect(summarizeTaker([...ASKED, entry('handover-reply', 120, { reply: 'failed', detail: 'not-saved' })]).problems).toContain('A 回应没能交出（not-saved）')
    expect(summarizeTaker([]).problems[0]).toBe('日志里没有"在此编辑"开始（takeover-start）')
  })

  it('只看"在此编辑"开始之后的：之前进入、离开编辑的那几条不算', () => {
    const summary = summarizeTaker([entry('acquire', 1, { takeover: null }), entry('acquire-result', 2, { result: 'acquired' }), entry('entered', 3), ...ASKED, entry('handover-silent', 3_103), entry('acquire', 3_104, { takeover: 'self' }), entry('acquire-result', 3_130, { result: 'acquired' }), entry('entered', 3_600)])
    expect([summary.path, summary.problems, summary.ms.entered]).toEqual(['silent', [], 3_500])
  })
})

describe('A 的交接日志判读（summarizeHolder）', () => {
  it('回应了：回应、告诉 B 做完了、离开编辑，各步相对隐藏的时刻', () => {
    const summary = summarizeHolder([
      entry('handover-answer', 9_000, { requestId: 'r1', answer: 'ack', state: 'editing' }),
      entry('leave', 9_001, { cause: 'handover-tab' }),
      entry('handover-finish', 9_300, { requestId: 'r1', outcome: 'done', reason: null }),
      entry('left', 9_800, { cause: 'handover-tab', outcome: 'reading' }),
    ], 1_000)
    expect([summary.answered, summary.stolen, summary.left]).toEqual([true, false, 'reading'])
    expect(summary.text).toBe('隐藏之后 +9.0 秒 回应 ack（editing），+9.3 秒 告诉 B done，+9.8 秒 离开编辑（handover-tab，reading）')
  })

  it('没有回应、锁被抢', () => {
    const summary = summarizeHolder([entry('lock-stolen', 12_000)], 1_000)
    expect([summary.answered, summary.stolen, summary.left, summary.text]).toEqual([false, true, undefined, '没有回应交接请求，+12.0 秒 得知锁被抢'])
  })
})

/** 离开时的一条观察（墙上时间） */
function seen(kind: string, wall: number, fields: Readonly<Record<string, unknown>> = {}): SelftestTimelineEntry {
  return { kind: `page:${kind}`, wall, ...fields }
}

const MARKER = '{"v":1,"at":1791355102563,"revision":1}'

describe('刷新之前离开时的观察（leavingSummary）', () => {
  it('导航一开始就取消在途的请求（S6 在 Playwright 的 WebKit 上看到的先后；location.reload 时 Chromium 系也是）：保存的请求先失败、之后才 pagehide；编辑器页处理之后有记号，没有释放与交出', () => {
    const summary = leavingSummary([
      seen('reload', 1_000),
      seen('save-failed', 1_004, { error: 'TypeError: Load failed' }),
      seen('pagehide', 1_020, { save: 'failed', request: 'failed' }),
      seen('after-pagehide', 1_021, { marker: MARKER }),
    ])
    expect(summary.problems).toEqual([])
    expect(summary.text).toBe(`保存的请求先失败（刷新之后 +4 ms，TypeError: Load failed），之后才派发 pagehide（+20 ms，保存的状态 failed）——导航一开始就取消了在途的请求；编辑器页处理之后 localStorage 里有记号 ${MARKER}；没有发释放与交出`)
  })

  it('pagehide 时保存还在途（S6 在 Playwright 的 Chromium 系上刷新时看到的先后），之后请求失败', () => {
    const summary = leavingSummary([
      seen('reload', 1_000),
      seen('pagehide', 1_010, { save: 'saving', request: 'pending' }),
      seen('after-pagehide', 1_011, { marker: MARKER }),
      seen('save-failed', 1_030, { error: 'TypeError: Failed to fetch' }),
    ])
    expect(summary.problems).toEqual([])
    expect(summary.text).toContain('pagehide 时（刷新之后 +10 ms）保存还在途（保存的状态 saving，请求 pending），之后请求失败（+30 ms）')
  })

  it('发了释放或交出、没有记号、没有 pagehide：都算问题', () => {
    const summary = leavingSummary([
      seen('reload', 1_000),
      seen('release-sent', 1_012, { method: 'DELETE', path: '/api/documents/d/edit-lease' }),
      seen('after-pagehide', 1_013, { marker: null }),
    ])
    expect(summary.problems).toEqual([
      '没有记下页面关闭（pagehide）',
      '页面关闭时发了 DELETE /api/documents/d/edit-lease（保存在途或者结果未知时不应释放、交出）',
      '编辑器页处理 pagehide 之后 localStorage 里没有记号',
    ])
  })
})

describe('等刷新之前在途的保存的时限', () => {
  it('与 contracts 的 EDIT_PENDING_SAVE_WAIT_MS 相同（这里另写一份，不引用 contracts）', () => {
    expect(PENDING_SAVE_WAIT_MS).toBe(EDIT_PENDING_SAVE_WAIT_MS)
  })
})

describe('记号的键', () => {
  it('与编辑器页的 pending-save-marker.ts 相同（那边的单元测试钉着同一个写法）：nerve-office:pending-save:<文档 id>', () => {
    expect(pendingSaveKeyOf('d1')).toBe('nerve-office:pending-save:d1')
  })
})

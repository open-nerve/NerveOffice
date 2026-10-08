// 真实 Safari 的复核与本机的桌面（desktop.ts）里不碰进程的部分：读出用户多久没有操作、屏幕锁没锁、用户回来没有，盖屏怎样结束的，与盖屏脚本的要点
// （写明用途与怎样中止、Esc 与鼠标按下就退出、取事件的掩码、到了自己的时限也退出）。
import { describe, expect, it } from 'vitest'
import { COVER_SCRIPT, COVER_TEXT, coverOutcomeOf, hidIdleSecondsIn, returnedBetween, screenLockedIn } from './desktop.ts'

describe('用户多久没有操作（hidIdleSecondsIn）', () => {
  it('ioreg 的输出里 HIDIdleTime（纳秒）换成秒；找不到时 undefined', () => {
    const text = '    | |   "HIDIdleTime" = 125300000000\n    | |   "HIDParameters" = {}'
    expect(hidIdleSecondsIn(text)).toBe(125.3)
    expect(hidIdleSecondsIn('"HIDIdleTime" = 0')).toBe(0)
    expect(hidIdleSecondsIn('没有这一项')).toBeUndefined()
  })
})

describe('屏幕锁没锁（screenLockedIn）', () => {
  const session = (extra: string): string => `"IOConsoleUsers" = ({"kCGSSessionOnConsoleKey"=Yes,"kCGSSessionUserNameKey"="xiaoruan"${extra}})`
  it('CGSSessionScreenIsLocked 是 Yes 时锁着；没有这一项时没锁', () => {
    expect(screenLockedIn(session(''))).toBe(false)
    expect(screenLockedIn(session(',"CGSSessionScreenIsLocked"=Yes'))).toBe(true)
  })

  it('这次登录不在控制台上（切换了用户）当作锁着：Safari 的页面都是隐藏的', () => {
    expect(screenLockedIn('"IOConsoleUsers" = ({"kCGSSessionOnConsoleKey"=No})')).toBe(true)
    expect(screenLockedIn('')).toBe(true)
  })
})

describe('用户回来没有（returnedBetween）', () => {
  it('空闲只随时间增长：比上一次小（留 0.5 秒的抖动）就是中间有过操作', () => {
    expect(returnedBetween(130, 131)).toBe(false)
    expect(returnedBetween(130, 129.6)).toBe(false)
    expect(returnedBetween(130, 2)).toBe(true)
    expect(returnedBetween(0.4, 0.1)).toBe(false)
  })
})

describe('盖屏怎样结束的（coverOutcomeOf）', () => {
  it('驱动脚本结束了它（有信号）是 stopped；脚本自己退出时按输出：escape、click、timeout；别的是 failed', () => {
    expect(coverOutcomeOf(null, 'SIGTERM', '')).toBe('stopped')
    expect(coverOutcomeOf(0, null, 'escape\n')).toBe('escape')
    expect(coverOutcomeOf(0, null, 'click\n')).toBe('click')
    expect(coverOutcomeOf(0, null, 'timeout\n')).toBe('timeout')
    expect(coverOutcomeOf(1, null, '')).toBe('failed')
    expect(coverOutcomeOf(0, null, 'something else')).toBe('failed')
  })
})

describe('盖屏的脚本（COVER_SCRIPT）', () => {
  it('窗口上写明用途与怎样中止；铺满每一块屏幕、普通窗口的层级（像别的应用的窗口一样挡住 Safari）', () => {
    expect(COVER_TEXT).toBe('NerveOffice 的 Safari 复核正在进行（约 3 分钟），按 Esc 或点这里中止')
    expect(COVER_SCRIPT).toContain('$.NSScreen.screens')
    expect(COVER_SCRIPT).toContain('window.setLevel($.NSNormalWindowLevel)')
    expect(COVER_SCRIPT).toContain('app.activateIgnoringOtherApps(true)')
  })

  it('Esc（键码 53）与鼠标按下就退出并说出来；取事件的掩码是 2^53 - 1（NSEventMaskAny 经 JXA 只剩最高一位，一个事件也取不到）；到了时限也退出', () => {
    expect(COVER_SCRIPT).toContain('Number(event.keyCode) === 53')
    expect(COVER_SCRIPT).toContain('$.NSEventTypeLeftMouseDown')
    expect(COVER_SCRIPT).toContain('nextEventMatchingMaskUntilDateInModeDequeue(9007199254740991,')
    expect(2 ** 53 - 1).toBe(9_007_199_254_740_991)
    expect(COVER_SCRIPT).toContain('const until = Date.now() + seconds * 1000')
    expect(COVER_SCRIPT).toContain('let outcome = \'timeout\'')
  })
})

// 真实 Safari 的复核与本机的桌面（M3-P6 设计 §3.10）：用户在不在、屏幕锁没锁、盖屏的窗口。驱动脚本（./selftest.ts）用；不碰进程的部分是纯函数，
// 单元测试覆盖（./desktop.test.ts）。
// - 用户空闲：ioreg 里 IOHIDSystem 的 HIDIdleTime（纳秒：多久没有键盘、鼠标、触控板的操作）。开始之前等它满一阵子（--idle）；跑的时候每秒看一次，
//   比上一次小（归零了）就是用户回来了——这一次作废（Safari 的窗口可能被挡住、页面的暂停不是按编排来的）。合成的按键与点击（CGEventPostToPid）
//   同样让它归零，窗口的开关与 open 不会（2026-10-08 本机实测）；
// - 屏幕锁定：ioreg -n Root -d1 的 IOConsoleUsers 里 CGSSessionScreenIsLocked 是 Yes，或者这次登录不在控制台上（切换了用户）——Safari 的页面
//   都是隐藏的，不跑；
// - 盖屏（请求编辑的路 2）：osascript 自己开的窗口铺满每一块屏幕（不碰别的应用，不要辅助功能权限），把 Safari 挡住——页面随即隐藏，约 50–55 秒之后
//   计时器与请求全部停下（探索 B 实测）。窗口上写明用途与"按 Esc 或点这里中止"；脚本自己处理事件：Esc（键码 53）或鼠标按下就关掉窗口、退出并输出
//   escape、click；到了自己的时限也退出（timeout：驱动脚本死掉时窗口不会一直留着）；驱动脚本用完 SIGTERM 结束它（stopped），osascript 退出时窗口随之
//   消失。取事件的掩码写成 2^53 - 1：JXA 把 NSEventMaskAny（2^64 - 1）变成 JS 的数之后只剩最高一位，一个事件也取不到（实测）
import type { Buffer } from 'node:buffer'
import type { ChildProcess } from 'node:child_process'
import { execFileSync, spawn } from 'node:child_process'
import process from 'node:process'

/** HIDIdleTime（ioreg -c IOHIDSystem 的输出里，纳秒）换成秒；找不到时 undefined */
export function hidIdleSecondsIn(text: string): number | undefined {
  const match = /"HIDIdleTime" = (\d+)/.exec(text)
  return match === null ? undefined : Number(match[1]) / 1e9
}

/** 屏幕锁着（或者这次登录不在控制台上）：ioreg -n Root -d1 的输出里 CGSSessionScreenIsLocked 是 Yes，或者 kCGSSessionOnConsoleKey 不是 Yes */
export function screenLockedIn(text: string): boolean {
  return /"CGSSessionScreenIsLocked"=Yes/.test(text) || !/"kCGSSessionOnConsoleKey"=Yes/.test(text)
}

/**
 * 两次读到的空闲秒数之间用户有没有操作过：空闲只会随时间增长，比上一次小（留 0.5 秒的余量，两次读之间的抖动）就是中间归零过
 */
export function returnedBetween(previous: number, current: number): boolean {
  return current < previous - 0.5
}

/** 本机用户多久没有操作了（秒）；读不到时 undefined。只取带 HIDIdleTime 的那一个对象（-r -k，约 20 毫秒、4 KiB；整个 IOHIDSystem 约 400 KiB） */
export function hidIdleSeconds(): number | undefined {
  return hidIdleSecondsIn(execFileSync('ioreg', ['-r', '-k', 'HIDIdleTime', '-d', '1'], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }))
}

/** 屏幕锁着（或者这次登录不在控制台上） */
export function screenLocked(): boolean {
  return screenLockedIn(execFileSync('ioreg', ['-n', 'Root', '-d1'], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }))
}

/**
 * 等用户空闲满 seconds 秒（每 10 秒看一次），最多等 maxWaitSeconds 秒：等到了交回 true。屏幕锁着时照样等（锁着的屏幕上跑不了，驱动脚本另外核对）
 */
export async function waitForIdle(seconds: number, maxWaitSeconds: number, say: (message: string) => void): Promise<boolean> {
  const deadline = Date.now() + maxWaitSeconds * 1000
  let told = false
  for (;;) {
    const idle = hidIdleSeconds() ?? 0
    if (idle >= seconds)
      return true
    if (Date.now() >= deadline)
      return false
    if (!told) {
      say(`等用户空闲满 ${seconds} 秒再开始（现在空闲 ${idle.toFixed(0)} 秒，最多等 ${maxWaitSeconds} 秒）`)
      told = true
    }
    await new Promise(resolve => setTimeout(resolve, 10_000))
  }
}

/** 跑的时候看用户回来没有：每秒读一次空闲，归零了就记下那一刻（之后不再看） */
export interface ActivityWatch {
  /** 用户回来的时刻（Date.now）；没有时 undefined */
  readonly returnedAt: () => number | undefined
  readonly stop: () => void
}

export function watchActivity(intervalMs = 1_000): ActivityWatch {
  let previous = hidIdleSeconds() ?? 0
  let returnedAt: number | undefined
  const timer = setInterval(() => {
    const current = hidIdleSeconds()
    if (current === undefined)
      return
    if (returnedBetween(previous, current)) {
      returnedAt ??= Date.now()
      clearInterval(timer)
    }
    previous = current
  }, intervalMs)
  return { returnedAt: () => returnedAt, stop: () => clearInterval(timer) }
}

/** 盖屏的窗口上的字（M3-P6 设计 §3.10：写明用途与怎样中止） */
export const COVER_TEXT = 'NerveOffice 的 Safari 复核正在进行（约 3 分钟），按 Esc 或点这里中止'

/** 盖屏的窗口：osascript 的 JavaScript（经标准输入交给 osascript -l JavaScript -），参数是最多盖多少秒与窗口上的字 */
export const COVER_SCRIPT = `ObjC.import('AppKit')
ObjC.import('Foundation')

function run(argv) {
  const seconds = Number(argv[0])
  const text = String(argv[1])
  const app = $.NSApplication.sharedApplication
  app.setActivationPolicy($.NSApplicationActivationPolicyRegular)
  app.finishLaunching
  const windows = []
  const screens = $.NSScreen.screens
  for (let i = 0; i < screens.count; i += 1) {
    const frame = screens.objectAtIndex(i).frame
    const window = $.NSWindow.alloc.initWithContentRectStyleMaskBackingDefer(frame, $.NSWindowStyleMaskBorderless, $.NSBackingStoreBuffered, false)
    window.setBackgroundColor($.NSColor.colorWithCalibratedWhiteAlpha(0.15, 1))
    window.setOpaque(true)
    window.setLevel($.NSNormalWindowLevel)
    const label = $.NSTextField.labelWithString($(text))
    label.setTextColor($.NSColor.whiteColor)
    label.setFont($.NSFont.systemFontOfSize(30))
    label.sizeToFit
    const size = label.frame.size
    label.setFrameOrigin($.NSMakePoint((frame.size.width - size.width) / 2, (frame.size.height - size.height) / 2))
    window.contentView.addSubview(label)
    window.makeKeyAndOrderFront(null)
    windows.push(window)
  }
  app.activateIgnoringOtherApps(true)
  const until = Date.now() + seconds * 1000
  let outcome = 'timeout'
  while (Date.now() < until) {
    const event = app.nextEventMatchingMaskUntilDateInModeDequeue(9007199254740991, $.NSDate.dateWithTimeIntervalSinceNow(0.2), $.NSDefaultRunLoopMode, true)
    if (event.isNil())
      continue
    const type = Number(event.type)
    if (type === Number($.NSEventTypeKeyDown) && Number(event.keyCode) === 53) {
      outcome = 'escape'
      break
    }
    if (type === Number($.NSEventTypeLeftMouseDown) || type === Number($.NSEventTypeRightMouseDown)) {
      outcome = 'click'
      break
    }
    app.sendEvent(event)
  }
  for (const window of windows)
    window.orderOut(null)
  return outcome
}
`

/**
 * 盖屏怎样结束的：stopped 是驱动脚本结束了它（SIGTERM）；escape、click 是有人按了 Esc 或点了窗口（这一次作废）；timeout 是到了它自己的时限
 * （驱动脚本没有按时结束它）；failed 是别的（osascript 出错）
 */
export type CoverOutcome = 'stopped' | 'escape' | 'click' | 'timeout' | 'failed'

/** 按 osascript 的退出码、信号与输出认出盖屏怎样结束的 */
export function coverOutcomeOf(code: number | null, signal: string | null, stdout: string): CoverOutcome {
  if (signal !== null)
    return 'stopped'
  const said = stdout.trim()
  if (code === 0 && (said === 'escape' || said === 'click' || said === 'timeout'))
    return said
  return 'failed'
}

export interface Cover {
  /** osascript 的进程号（核对跑完之后没有留下进程） */
  readonly pid: number | undefined
  /** 已经结束了就交回怎样结束的；还盖着时 undefined */
  readonly outcome: () => CoverOutcome | undefined
  /** 结束它（还盖着时 SIGTERM，等它退出），交回怎样结束的 */
  readonly stop: () => Promise<CoverOutcome>
}

/** 盖屏：起 osascript（脚本经标准输入），最多盖 seconds 秒 */
export function startCover(seconds: number, text: string = COVER_TEXT): Cover {
  const child: ChildProcess = spawn('osascript', ['-l', 'JavaScript', '-', String(seconds), text], { stdio: ['pipe', 'pipe', 'pipe'] })
  let stdout = ''
  let outcome: CoverOutcome | undefined
  child.stdout?.on('data', (chunk: Buffer) => {
    stdout += chunk.toString('utf8')
  })
  const exited = new Promise<CoverOutcome>((resolve) => {
    child.once('exit', (code, signal) => {
      outcome = coverOutcomeOf(code, signal, stdout)
      resolve(outcome)
    })
    child.once('error', () => {
      outcome = 'failed'
      resolve(outcome)
    })
  })
  child.stdin?.end(COVER_SCRIPT)
  return {
    pid: child.pid,
    outcome: () => outcome,
    stop: async () => {
      if (outcome === undefined)
        child.kill('SIGTERM')
      return exited
    },
  }
}

/** 这个进程号还在不在（跑完之后核对盖屏的 osascript 没有留下） */
export function processAlive(pid: number | undefined): boolean {
  if (pid === undefined)
    return false
  try {
    process.kill(pid, 0)
    return true
  }
  catch {
    return false
  }
}

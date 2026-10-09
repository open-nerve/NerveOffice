// 崩溃工具认进程的部分（browser-processes.ts）里不碰进程的纯函数：进程表的解析（Linux 的 /proc、macOS 的 ps）、命令行里的资料目录、lsof 的输出、
// 这次启动的根与进程树、按角色分类、认出这次启动的全部进程（含 macOS 上 WebKit 的 XPC 服务与"有别的实例"）、要求的角色、结束之后还活着的、
// 冻住与结束的先后、重开时记下的 Cookie 不带值。样本取自本机实测（2026-10-09，Playwright 1.63：chrome-headless-shell、Google Chrome 154、WebKit 2359）
import type { InstanceProcess, InstanceSpec, ProcessRole, ProcessRow } from './browser-processes.ts'
import { describe, expect, it } from 'vitest'
import {
  bootTimeSecondsIn,
  cookieSummary,
  descendantsOf,
  elapsedMs,
  identifyInstance,
  launchRootIn,
  mentionsProfile,
  missingRoles,
  parseProcStat,
  parsePsOutput,
  pidsHoldingFilesIn,
  processStatus,
  procRow,
  roleOf,
  signalOrder,
  stillAlive,
  webkitNetworkingCandidates,
} from './browser-processes.ts'

/** 资料目录：带中文与全角标点（用例标题进了 testInfo 的输出目录） */
const PROFILE = '/repo/tests/e2e/test-results/crash-写入途中结束-原子性-crash-webkit/profile'
const WORKER = 4000
const LAUNCHED_AT = 1_790_000_000_000

function row(partial: Partial<ProcessRow> & Pick<ProcessRow, 'pid' | 'command'>): ProcessRow {
  return { ppid: 1, pgid: partial.pid, state: 'S', startedAt: LAUNCHED_AT + 500, ...partial }
}

/** 已经认出来的一个进程 */
function proc(pid: number, role: ProcessRole, partial: Partial<ProcessRow> = {}): InstanceProcess {
  return { ...row({ pid, command: role, ...partial }), role, via: 'tree' }
}

const HEADLESS_SHELL = '/Users/x/Library/Caches/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell'
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const CHROME_HELPERS = '/Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Versions/154.0.8037.98/Helpers'
const WEBKIT = '/Users/x/Library/Caches/ms-playwright/webkit-2359'

describe('/proc/<pid>/stat 的解析（parseProcStat）', () => {
  it('从最后一个右括号之后切：comm 里的空格与括号不影响；交回状态、父进程、进程组与启动的时钟滴答（第 22 项）', () => {
    const stat = '5678 (Web Content (x) ) S 5600 5600 5600 0 -1 4194560 120 0 0 0 7 3 0 0 20 0 12 0 987654 1234567 89 18446744073709551615'
    expect(parseProcStat(stat)).toEqual({ pid: 5678, comm: 'Web Content (x) ', state: 'S', ppid: 5600, pgid: 5600, startTicks: 987654 })
    expect(parseProcStat('1 (systemd) S 0 1 1 0 -1 4194560 1 2 3 4 5 6 7 8 20 0 1 0 12 3 4\n')).toMatchObject({ pid: 1, ppid: 0, startTicks: 12 })
  })

  it('形状不对时交回 undefined（进程恰好退出、读到半截）', () => {
    expect(parseProcStat('')).toBeUndefined()
    expect(parseProcStat('12 (x S 1 1')).toBeUndefined()
    expect(parseProcStat('12 (x) S 1 1 1')).toBeUndefined()
    expect(parseProcStat('abc (x) S 1 1 1 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 12')).toBeUndefined()
  })
})

describe('开机时刻（bootTimeSecondsIn）', () => {
  it('/proc/stat 里的 btime；没有时 undefined', () => {
    expect(bootTimeSecondsIn('cpu  1 2 3\nbtime 1790392537\nprocesses 99\n')).toBe(1_790_392_537)
    expect(bootTimeSecondsIn('cpu  1 2 3\n')).toBeUndefined()
  })
})

describe('Linux 的一个进程（procRow）', () => {
  const stat = '700 (MiniBrowser) S 650 650 650 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 250 0 0'
  it('启动时刻 = 开机时刻 + 滴答 / 每秒的滴答；命令行的 NUL 换成空格', () => {
    expect(procRow(stat, '/ms-playwright/webkit-2359/minibrowser-wpe/MiniBrowser\0--inspector-pipe\0--headless\0', 1_790_000_000_000, 100)).toEqual({
      pid: 700,
      ppid: 650,
      pgid: 650,
      state: 'S',
      startedAt: 1_790_000_002_500,
      command: '/ms-playwright/webkit-2359/minibrowser-wpe/MiniBrowser --inspector-pipe --headless',
    })
  })

  it('命令行是空的（僵尸、内核线程）时同 ps 写成 [comm]；stat 不对时 undefined', () => {
    expect(procRow('701 (WPEWebProcess) Z 700 650 650 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 260 0 0', '', 0, 100)).toMatchObject({ state: 'Z', command: '[WPEWebProcess]' })
    expect(procRow('坏的', 'x', 0, 100)).toBeUndefined()
  })
})

describe('ps 的 etime（elapsedMs）', () => {
  it('[[dd-]hh:]mm:ss 换成毫秒；写法不对时 undefined', () => {
    expect(elapsedMs('00:02')).toBe(2_000)
    expect(elapsedMs('01:02:03')).toBe(3_723_000)
    expect(elapsedMs('2-01:02:03')).toBe((2 * 86_400 + 3_723) * 1000)
    expect(elapsedMs('13-00:35:05')).toBe((13 * 86_400 + 35 * 60 + 5) * 1000)
    expect(elapsedMs('')).toBeUndefined()
    expect(elapsedMs('1:2')).toBeUndefined()
    expect(elapsedMs('aa:bb')).toBeUndefined()
  })
})

describe('macOS 的 ps 输出（parsePsOutput）', () => {
  it('pid、ppid、pgid、状态的第一个字母、按读的时刻与 etime 推出的启动时刻、完整的命令行（含中文与空格）', () => {
    const text = [
      `  6892  4000  6892 Ss       00:02 bash ${WEBKIT}/pw_run.sh --inspector-pipe --headless --user-data-dir=${PROFILE} about:blank`,
      `  6922     1  6922 Ss       00:01 ${WEBKIT}/com.apple.WebKit.Networking.xpc/Contents/MacOS/com.apple.WebKit.Networking.Development`,
      ` 40084 40057 40057 S    02-22:11:12 ${CHROME_HELPERS}/Google Chrome Helper (Renderer).app/Contents/MacOS/Google Chrome Helper (Renderer) --type=renderer`,
      '   901   900   900 Z        00:00 <defunct>',
      '坏的一行',
      '',
    ].join('\n')
    const rows = parsePsOutput(text, LAUNCHED_AT)
    expect(rows).toHaveLength(4)
    expect(rows[0]).toEqual({ pid: 6892, ppid: 4000, pgid: 6892, state: 'S', startedAt: LAUNCHED_AT - 2_000, command: `bash ${WEBKIT}/pw_run.sh --inspector-pipe --headless --user-data-dir=${PROFILE} about:blank` })
    expect(rows[2]).toMatchObject({ pid: 40084, ppid: 40057, startedAt: LAUNCHED_AT - (2 * 86_400 + 22 * 3_600 + 11 * 60 + 12) * 1000, command: `${CHROME_HELPERS}/Google Chrome Helper (Renderer).app/Contents/MacOS/Google Chrome Helper (Renderer) --type=renderer` })
    expect(rows[3]).toMatchObject({ pid: 901, state: 'Z', command: '<defunct>' })
  })
})

describe('命令行里提到资料目录（mentionsProfile）', () => {
  it('--user-data-dir=<目录>、目录本身、目录下的文件都算；只认整段路径', () => {
    expect(mentionsProfile(`${CHROME} --headless --user-data-dir=${PROFILE} --remote-debugging-pipe`, PROFILE)).toBe(true)
    expect(mentionsProfile(`bash ${WEBKIT}/pw_run.sh --user-data-dir=${PROFILE}`, PROFILE)).toBe(true)
    expect(mentionsProfile(`/x/chrome_crashpad_handler --database=${PROFILE}/Crashpad --annotation=x`, PROFILE)).toBe(true)
    expect(mentionsProfile(`/bin/cat ${PROFILE}`, PROFILE)).toBe(true)
  })

  it('前缀相同的别的目录、别的用例的资料目录、不带资料目录的都不算', () => {
    expect(mentionsProfile(`${CHROME} --user-data-dir=${PROFILE}-2`, PROFILE)).toBe(false)
    expect(mentionsProfile(`${CHROME} --user-data-dir=${PROFILE}x/Default`, PROFILE)).toBe(false)
    expect(mentionsProfile(`${CHROME} --user-data-dir=/other${PROFILE}`, PROFILE)).toBe(false)
    expect(mentionsProfile(`${CHROME} --restart`, PROFILE)).toBe(false)
  })

  it('路径里的正则元字符按字面认', () => {
    const odd = '/tmp/a+b(c)[d]/profile'
    expect(mentionsProfile(`x --user-data-dir=${odd}`, odd)).toBe(true)
    expect(mentionsProfile('x --user-data-dir=/tmp/aab(c)[d]/profile', odd)).toBe(false)
  })
})

describe('lsof -F pn 的输出（pidsHoldingFilesIn）', () => {
  it('打开着目录里文件（或目录本身）的进程；别的目录、前缀相同的别的目录不算', () => {
    const output = [
      'p6922',
      'fcwd',
      'n/',
      'f12',
      `n${PROFILE}/IndexedDB/v1/http_127.0.0.1_57199/x/IndexedDB.sqlite3-wal`,
      'p6919',
      'f3',
      `n${PROFILE}-2/Cookies`,
      'p6950',
      'f5',
      `n${PROFILE}`,
      'p7000',
      'f1',
      'n/dev/null',
      '',
    ].join('\n')
    expect([...pidsHoldingFilesIn(output, PROFILE)].sort()).toEqual([6922, 6950])
    expect(pidsHoldingFilesIn('', PROFILE).size).toBe(0)
  })
})

describe('这次启动的根（launchRootIn）', () => {
  const table = [
    row({ pid: 5100, ppid: WORKER, command: `${HEADLESS_SHELL} --user-data-dir=${PROFILE} --remote-debugging-pipe` }),
    row({ pid: 5101, ppid: 5100, pgid: 5100, command: `${HEADLESS_SHELL} --type=renderer` }),
    // 工作进程起的另一个浏览器（共用的浏览器、别的资料目录）
    row({ pid: 5200, ppid: WORKER, command: `${HEADLESS_SHELL} --user-data-dir=/tmp/playwright_chromiumdev_profile-x` }),
    // 别人（不是这个工作进程）以同一个资料目录起的：不是根
    row({ pid: 5300, ppid: 4100, command: `${HEADLESS_SHELL} --user-data-dir=${PROFILE}` }),
  ]
  it('工作进程的子进程、命令行带资料目录：恰好一个', () => {
    expect(launchRootIn(table, WORKER, PROFILE)).toEqual({ kind: 'found', pid: 5100 })
  })

  it('没有、或者不止一个时如实交回', () => {
    expect(launchRootIn(table, 4999, PROFILE)).toEqual({ kind: 'missing' })
    expect(launchRootIn([...table, row({ pid: 5400, ppid: WORKER, command: `bash x --user-data-dir=${PROFILE}` })], WORKER, PROFILE)).toEqual({ kind: 'ambiguous', pids: [5100, 5400] })
  })

  it('僵尸不算', () => {
    expect(launchRootIn([row({ pid: 5100, ppid: WORKER, state: 'Z', command: `${HEADLESS_SHELL} --user-data-dir=${PROFILE}` })], WORKER, PROFILE)).toEqual({ kind: 'missing' })
  })
})

describe('进程树（descendantsOf）', () => {
  it('按 ppid 一层层往下，含根；别的树不算', () => {
    const table = [
      row({ pid: 10, ppid: 1, command: 'root' }),
      row({ pid: 11, ppid: 10, command: 'a' }),
      row({ pid: 12, ppid: 11, command: 'b' }),
      row({ pid: 13, ppid: 12, command: 'c' }),
      row({ pid: 20, ppid: 1, command: 'other' }),
      row({ pid: 21, ppid: 20, command: 'other child' }),
    ]
    expect([...descendantsOf(table, 10)].sort((a, b) => a - b)).toEqual([10, 11, 12, 13])
    expect([...descendantsOf(table, 99)]).toEqual([99])
  })
})

/** 一次启动的规格 */
function spec(partial: Partial<InstanceSpec> = {}): InstanceSpec {
  return { platform: 'darwin', family: 'chromium', workerPid: WORKER, rootPid: 5100, profileDir: PROFILE, launchedAt: LAUNCHED_AT, webkitInstallDir: undefined, ...partial }
}

describe('按角色分类（roleOf）', () => {
  it('Chromium 系：根是 browser；--type 与 --utility-sub-type 分出渲染、GPU、网络服务、存储服务、别的工具进程、zygote、crashpad', () => {
    const s = spec()
    expect(roleOf(row({ pid: 5100, command: `${HEADLESS_SHELL} --user-data-dir=${PROFILE}` }), s)).toBe('browser')
    expect(roleOf(row({ pid: 5101, command: `${HEADLESS_SHELL} --type=renderer --headless=old` }), s)).toBe('renderer')
    expect(roleOf(row({ pid: 5102, command: `${HEADLESS_SHELL} --type=gpu-process --no-sandbox` }), s)).toBe('gpu')
    expect(roleOf(row({ pid: 5103, command: `${CHROME_HELPERS}/Google Chrome Helper.app/Contents/MacOS/Google Chrome Helper --type=utility --utility-sub-type=network.mojom.NetworkService --lang=en-US` }), s)).toBe('network')
    expect(roleOf(row({ pid: 5104, command: `${CHROME_HELPERS}/Google Chrome Helper.app/Contents/MacOS/Google Chrome Helper --type=utility --utility-sub-type=storage.mojom.StorageService` }), s)).toBe('storage')
    expect(roleOf(row({ pid: 5105, command: `${CHROME_HELPERS}/Google Chrome Helper.app/Contents/MacOS/Google Chrome Helper --type=utility --utility-sub-type=audio.mojom.AudioService` }), s)).toBe('utility')
    expect(roleOf(row({ pid: 5106, command: '/opt/google/chrome/chrome --type=zygote --no-zygote-sandbox' }), s)).toBe('zygote')
    expect(roleOf(row({ pid: 5107, command: '/opt/google/chrome/chrome_crashpad_handler --monitor-self-annotation=ptype=crashpad-handler --database=/x' }), s)).toBe('crashpad')
    expect(roleOf(row({ pid: 5108, command: '/opt/google/chrome/chrome --type=broker' }), s)).toBe('other')
  })

  it('macOS 的 WebKit：根是启动脚本，Playwright.app 是 UI，安装目录下的 XPC 按服务名分出页面、网络、GPU', () => {
    const s = spec({ family: 'webkit', rootPid: 6892, webkitInstallDir: WEBKIT })
    expect(roleOf(row({ pid: 6892, command: `bash ${WEBKIT}/pw_run.sh --user-data-dir=${PROFILE}` }), s)).toBe('launcher')
    expect(roleOf(row({ pid: 6898, command: `${WEBKIT}/Playwright.app/Contents/MacOS/Playwright --inspector-pipe --headless --user-data-dir=${PROFILE}` }), s)).toBe('ui')
    expect(roleOf(row({ pid: 6921, command: `${WEBKIT}/com.apple.WebKit.WebContent.xpc/Contents/MacOS/com.apple.WebKit.WebContent.Development` }), s)).toBe('web-content')
    expect(roleOf(row({ pid: 6922, command: `${WEBKIT}/com.apple.WebKit.Networking.xpc/Contents/MacOS/com.apple.WebKit.Networking.Development` }), s)).toBe('networking')
    expect(roleOf(row({ pid: 6919, command: `${WEBKIT}/com.apple.WebKit.GPU.xpc/Contents/MacOS/com.apple.WebKit.GPU.Development` }), s)).toBe('gpu')
    expect(roleOf(row({ pid: 6930, command: `${WEBKIT}/com.apple.WebKit.Model.xpc/Contents/MacOS/com.apple.WebKit.Model.Development` }), s)).toBe('other')
  })

  it('Linux 的 WebKit（WPE）：MiniBrowser 是 UI，WPEWebProcess、WPENetworkProcess、WPEGPUProcess；沙箱的 bwrap 与 xdg-dbus-proxy', () => {
    const s = spec({ platform: 'linux', family: 'webkit', rootPid: 650, webkitInstallDir: '/ms-playwright/webkit-2359' })
    expect(roleOf(row({ pid: 650, command: `/bin/bash /ms-playwright/webkit-2359/pw_run.sh --user-data-dir=${PROFILE}` }), s)).toBe('launcher')
    expect(roleOf(row({ pid: 700, command: '/ms-playwright/webkit-2359/minibrowser-wpe/MiniBrowser --inspector-pipe --headless' }), s)).toBe('ui')
    expect(roleOf(row({ pid: 701, command: '/ms-playwright/webkit-2359/minibrowser-wpe/libexec/wpe-webkit-2.0/WPEWebProcess 7 9' }), s)).toBe('web-content')
    expect(roleOf(row({ pid: 702, command: '/ms-playwright/webkit-2359/minibrowser-wpe/libexec/wpe-webkit-2.0/WPENetworkProcess 8 10' }), s)).toBe('networking')
    expect(roleOf(row({ pid: 703, command: '/ms-playwright/webkit-2359/minibrowser-wpe/libexec/wpe-webkit-2.0/WPEGPUProcess 11' }), s)).toBe('gpu')
    expect(roleOf(row({ pid: 704, command: 'bwrap --args 39 /ms-playwright/webkit-2359/minibrowser-wpe/libexec/wpe-webkit-2.0/WPEWebProcess 7 9' }), s)).toBe('sandbox')
    expect(roleOf(row({ pid: 705, command: 'xdg-dbus-proxy --args=40' }), s)).toBe('sandbox')
  })
})

describe('认出这次启动的全部进程（identifyInstance）', () => {
  it('Chromium 系：进程树 ∪ 进程组 ∪ 命令行提到资料目录；需求方自己在用的 Google Chrome（同名、同一个可执行文件）一个也不碰', () => {
    const table = [
      row({ pid: 5100, ppid: WORKER, pgid: 5100, command: `${CHROME} --headless --user-data-dir=${PROFILE}` }),
      row({ pid: 5101, ppid: 5100, pgid: 5100, command: `${CHROME_HELPERS}/Google Chrome Helper (Renderer).app/Contents/MacOS/Google Chrome Helper (Renderer) --type=renderer --user-data-dir=${PROFILE}` }),
      // 父进程已经结束、过继给 launchd，但还在这次的进程组里
      row({ pid: 5102, ppid: 1, pgid: 5100, command: `${CHROME_HELPERS}/Google Chrome Helper.app/Contents/MacOS/Google Chrome Helper --type=utility --utility-sub-type=network.mojom.NetworkService` }),
      // 守护进程化的（另一个进程组、父进程是 1），命令行里带着资料目录
      row({ pid: 5103, ppid: 1, pgid: 5103, command: `/x/chrome_crashpad_handler --monitor-self-annotation=ptype=crashpad-handler --database=${PROFILE}/Crashpad` }),
      // 需求方的 Chrome 与它的帮手进程
      row({ pid: 40057, ppid: 1, pgid: 40057, startedAt: LAUNCHED_AT - 86_400_000, command: `${CHROME} --origin-trial-disabled-features=X --restart` }),
      row({ pid: 40070, ppid: 40057, pgid: 40057, startedAt: LAUNCHED_AT - 86_400_000, command: `${CHROME_HELPERS}/Google Chrome Helper.app/Contents/MacOS/Google Chrome Helper --type=utility --utility-sub-type=network.mojom.NetworkService` }),
      row({ pid: 40077, ppid: 40057, pgid: 40057, startedAt: LAUNCHED_AT + 1_000, command: `${CHROME_HELPERS}/Google Chrome Helper (Renderer).app/Contents/MacOS/Google Chrome Helper (Renderer) --type=renderer` }),
    ]
    const { processes, problems } = identifyInstance(table, spec(), new Set())
    expect(problems).toEqual([])
    expect(processes.map(p => [p.pid, p.via, p.role])).toEqual([
      [5100, 'tree', 'browser'],
      [5101, 'tree', 'renderer'],
      [5102, 'group', 'network'],
      [5103, 'profile-arg', 'crashpad'],
    ])
  })

  const webkitTable = (extra: readonly ProcessRow[] = []): ProcessRow[] => [
    row({ pid: 6892, ppid: WORKER, pgid: 6892, command: `bash ${WEBKIT}/pw_run.sh --inspector-pipe --headless --user-data-dir=${PROFILE} about:blank` }),
    row({ pid: 6898, ppid: 6892, pgid: 6892, command: `${WEBKIT}/Playwright.app/Contents/MacOS/Playwright --inspector-pipe --headless --user-data-dir=${PROFILE} about:blank` }),
    row({ pid: 6919, command: `${WEBKIT}/com.apple.WebKit.GPU.xpc/Contents/MacOS/com.apple.WebKit.GPU.Development` }),
    row({ pid: 6921, command: `${WEBKIT}/com.apple.WebKit.WebContent.xpc/Contents/MacOS/com.apple.WebKit.WebContent.Development` }),
    row({ pid: 6922, command: `${WEBKIT}/com.apple.WebKit.Networking.xpc/Contents/MacOS/com.apple.WebKit.Networking.Development` }),
    // 启动之前 2 秒以前就有的（上一次运行留下的）：不是这次的
    row({ pid: 6800, startedAt: LAUNCHED_AT - 2_001, command: `${WEBKIT}/com.apple.WebKit.WebContent.xpc/Contents/MacOS/com.apple.WebKit.WebContent.Development` }),
    // 系统的 WebKit（Safari 用的）与 Spotlight：不碰
    row({ pid: 10507, command: '/System/Library/Frameworks/WebKit.framework/Versions/A/XPCServices/com.apple.WebKit.WebContent.xpc/Contents/MacOS/com.apple.WebKit.WebContent' }),
    row({ pid: 10854, command: '/System/Library/Frameworks/WebKit.framework/Versions/A/XPCServices/com.apple.WebKit.Networking.xpc/Contents/MacOS/com.apple.WebKit.Networking' }),
    row({ pid: 777, command: '/System/Library/Frameworks/CoreServices.framework/Frameworks/Metadata.framework/Versions/A/Support/mdworker_shared -s mdworker' }),
    ...extra,
  ]
  const webkitSpec = spec({ family: 'webkit', rootPid: 6892, webkitInstallDir: WEBKIT })

  it('macOS 的 WebKit、机器上只有这一个实例：Networking 按打开着资料目录里的文件认，WebContent 与 GPU 按安装目录与启动时刻认', () => {
    const { processes, problems } = identifyInstance(webkitTable(), webkitSpec, new Set([6922]))
    expect(problems).toEqual([])
    expect(processes.map(p => [p.pid, p.via, p.role])).toEqual([
      [6892, 'tree', 'launcher'],
      [6898, 'tree', 'ui'],
      [6919, 'webkit-xpc', 'gpu'],
      [6921, 'webkit-xpc', 'web-content'],
      [6922, 'profile-files', 'networking'],
    ])
  })

  it('打开着资料目录里文件的进程只认安装目录下的 XPC：Spotlight、系统的 WebKit 打开着也不碰', () => {
    const { processes } = identifyInstance(webkitTable(), webkitSpec, new Set([6922, 777, 10854]))
    expect(processes.map(p => p.pid)).not.toContain(777)
    expect(processes.map(p => p.pid)).not.toContain(10854)
  })

  it('另有 Playwright WebKit 实例（同一个安装目录的 UI 进程）：记成问题，不按安装目录与启动时刻认，打开着文件的 Networking 照样认', () => {
    const other = [
      row({ pid: 7000, ppid: 7100, pgid: 7000, command: `bash ${WEBKIT}/pw_run.sh --inspector-pipe --headless --no-startup-window` }),
      row({ pid: 7001, ppid: 7000, pgid: 7000, command: `${WEBKIT}/Playwright.app/Contents/MacOS/Playwright --inspector-pipe --headless --no-startup-window` }),
      row({ pid: 7002, command: `${WEBKIT}/com.apple.WebKit.WebContent.xpc/Contents/MacOS/com.apple.WebKit.WebContent.Development` }),
    ]
    const { processes, problems } = identifyInstance(webkitTable(other), webkitSpec, new Set([6922]))
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('7001')
    expect(processes.map(p => [p.pid, p.via])).toEqual([[6892, 'tree'], [6898, 'tree'], [6922, 'profile-files']])
  })

  it('别的版本的 Playwright WebKit（另一个安装目录）不算"别的实例"，它的 XPC 也不认', () => {
    const otherVersion = [
      row({ pid: 7001, ppid: 7000, command: '/Users/x/Library/Caches/ms-playwright/webkit-2203/Playwright.app/Contents/MacOS/Playwright --inspector-pipe' }),
      row({ pid: 7002, command: '/Users/x/Library/Caches/ms-playwright/webkit-2203/com.apple.WebKit.WebContent.xpc/Contents/MacOS/com.apple.WebKit.WebContent.Development' }),
    ]
    const { processes, problems } = identifyInstance(webkitTable(otherVersion), webkitSpec, new Set([6922]))
    expect(problems).toEqual([])
    expect(processes.map(p => p.pid)).not.toContain(7002)
  })

  it('Linux 的 WebKit：都在进程树里，不用安装目录的规则', () => {
    const linux = spec({ platform: 'linux', family: 'webkit', rootPid: 650, webkitInstallDir: '/ms-playwright/webkit-2359' })
    const table = [
      row({ pid: 650, ppid: WORKER, pgid: 650, command: `/bin/bash /ms-playwright/webkit-2359/pw_run.sh --user-data-dir=${PROFILE}` }),
      row({ pid: 700, ppid: 650, pgid: 650, command: '/ms-playwright/webkit-2359/minibrowser-wpe/MiniBrowser --inspector-pipe --headless' }),
      row({ pid: 701, ppid: 700, pgid: 701, command: '/ms-playwright/webkit-2359/minibrowser-wpe/libexec/wpe-webkit-2.0/WPEWebProcess 7 9' }),
      row({ pid: 702, ppid: 700, pgid: 650, command: '/ms-playwright/webkit-2359/minibrowser-wpe/libexec/wpe-webkit-2.0/WPENetworkProcess 8 10' }),
      // 另一个实例的 WPEWebProcess：不在树里、不在组里
      row({ pid: 801, ppid: 800, pgid: 800, command: '/ms-playwright/webkit-2359/minibrowser-wpe/libexec/wpe-webkit-2.0/WPEWebProcess 7 9' }),
    ]
    const { processes, problems } = identifyInstance(table, linux, new Set())
    expect(problems).toEqual([])
    expect(processes.map(p => [p.pid, p.role])).toEqual([[650, 'launcher'], [700, 'ui'], [701, 'web-content'], [702, 'networking']])
  })

  it('lsof 只查安装目录下的 Networking（可能有别的实例的）；Chromium 系、Linux 不查', () => {
    expect(webkitNetworkingCandidates(webkitTable(), webkitSpec).map(r => r.pid)).toEqual([6922])
    expect(webkitNetworkingCandidates(webkitTable(), spec())).toEqual([])
    expect(webkitNetworkingCandidates(webkitTable(), { ...webkitSpec, platform: 'linux' })).toEqual([])
  })

  it('不认测试的工作进程本身', () => {
    const table = [row({ pid: WORKER, ppid: 3999, pgid: 5100, command: `node worker --user-data-dir=${PROFILE}` }), row({ pid: 5100, ppid: WORKER, pgid: 5100, command: `${CHROME} --user-data-dir=${PROFILE}` })]
    expect(identifyInstance(table, spec(), new Set()).processes.map(p => p.pid)).toEqual([5100])
  })
})

describe('Linux 上的 Chrome 与 Edge（CI 的 chrome、msedge 项目；本机的 Docker 是 arm64，没有这两个浏览器）', () => {
  // 典型的进程表：zygote 生出 GPU、工具与渲染进程；crashpad 的处理进程两次 fork、另起会话（父进程 1、自己的进程组），它的监视进程是它的子进程。
  // 角色齐全、多出来的辅助进程（crashpad、zygote、别的工具进程）都算这次启动的、一并结束；断言按角色，不按个数
  const linux = spec({ platform: 'linux', rootPid: 3000 })
  const chromeTable = (browser: string, crashpad: string): ProcessRow[] => [
    row({ pid: 3000, ppid: WORKER, pgid: 3000, command: `${browser} --disable-field-trial-config --disable-background-networking --headless --user-data-dir=${PROFILE} --remote-debugging-pipe --no-startup-window` }),
    row({ pid: 3002, ppid: 1, pgid: 3002, command: `${crashpad} --monitor-self --monitor-self-annotation=ptype=crashpad-handler --database=${PROFILE}/Crash Reports --url=https://clients2.google.com/cr/report --initial-client-fd=5 --shared-client-connection` }),
    row({ pid: 3004, ppid: 3002, pgid: 3002, command: `${crashpad} --no-periodic-tasks --monitor-self-annotation=ptype=crashpad-handler --initial-client-fd=4` }),
    row({ pid: 3010, ppid: 3000, pgid: 3000, command: `${browser} --type=zygote --no-zygote-sandbox --no-sandbox --headless --crashpad-handler-pid=3002 --enable-crash-reporter=,` }),
    row({ pid: 3011, ppid: 3000, pgid: 3000, command: `${browser} --type=zygote --no-sandbox --headless --crashpad-handler-pid=3002` }),
    row({ pid: 3020, ppid: 3010, pgid: 3000, command: `${browser} --type=gpu-process --no-sandbox --headless --crashpad-handler-pid=3002` }),
    row({ pid: 3021, ppid: 3010, pgid: 3000, command: `${browser} --type=utility --utility-sub-type=network.mojom.NetworkService --lang=en-US --service-sandbox-type=none --no-sandbox` }),
    row({ pid: 3022, ppid: 3010, pgid: 3000, command: `${browser} --type=utility --utility-sub-type=storage.mojom.StorageService --lang=en-US --service-sandbox-type=utility --no-sandbox` }),
    row({ pid: 3023, ppid: 3010, pgid: 3000, command: `${browser} --type=utility --utility-sub-type=audio.mojom.AudioService --lang=en-US --no-sandbox` }),
    // 渲染进程的父进程是 zygote；Chromium 改写了它的命令行（参数之间是空格，不是 NUL），读出来同样是一行
    row({ pid: 3030, ppid: 3011, pgid: 3000, command: `${browser} --type=renderer --crashpad-handler-pid=3002 --no-sandbox --lang=en-US --num-raster-threads=4` }),
    // 同一台机器上别人的浏览器：同一个可执行文件，不在这次的树、组里，命令行里没有这次的资料目录
    row({ pid: 4100, ppid: 1, pgid: 4100, command: browser }),
    row({ pid: 4110, ppid: 4100, pgid: 4100, command: `${browser} --type=zygote` }),
    row({ pid: 4120, ppid: 4110, pgid: 4100, command: `${browser} --type=renderer` }),
    row({ pid: 4102, ppid: 1, pgid: 4102, command: `${crashpad} --monitor-self-annotation=ptype=crashpad-handler --database=/home/u/.config/google-chrome/Crash Reports` }),
  ]

  it('Google Chrome（/opt/google/chrome）：全部辅助进程按角色认出、一并结束；别人的 Chrome 不碰', () => {
    const { processes, problems } = identifyInstance(chromeTable('/opt/google/chrome/chrome', '/opt/google/chrome/chrome_crashpad_handler'), linux, new Set())
    expect(problems).toEqual([])
    expect(processes.map(p => [p.pid, p.via, p.role])).toEqual([
      [3000, 'tree', 'browser'],
      [3002, 'profile-arg', 'crashpad'],
      [3004, 'tree', 'crashpad'],
      [3010, 'tree', 'zygote'],
      [3011, 'tree', 'zygote'],
      [3020, 'tree', 'gpu'],
      [3021, 'tree', 'network'],
      [3022, 'tree', 'storage'],
      [3023, 'tree', 'utility'],
      [3030, 'tree', 'renderer'],
    ])
    expect(missingRoles(processes, linux)).toEqual([])
  })

  it('Microsoft Edge（/opt/microsoft/msedge）：同一套规则', () => {
    const { processes } = identifyInstance(chromeTable('/opt/microsoft/msedge/msedge', '/opt/microsoft/msedge/msedge_crashpad_handler'), linux, new Set())
    expect(processes.map(p => p.pid)).toEqual([3000, 3002, 3004, 3010, 3011, 3020, 3021, 3022, 3023, 3030])
    expect(missingRoles(processes, linux)).toEqual([])
  })

  it('crashpad 留在树里（不两次 fork）时同样认出；渲染进程的祖先链再长也在树里', () => {
    const table = chromeTable('/opt/google/chrome/chrome', '/opt/google/chrome/chrome_crashpad_handler').map(r => r.pid === 3002 ? { ...r, ppid: 3000, pgid: 3000, command: '/opt/google/chrome/chrome_crashpad_handler --monitor-self-annotation=ptype=crashpad-handler --database=/tmp/Crashpad' } : r)
    expect(identifyInstance(table, linux, new Set()).processes.filter(p => p.role === 'crashpad').map(p => [p.pid, p.via])).toEqual([[3002, 'tree'], [3004, 'tree']])
  })
})

describe('要求结束的角色（missingRoles）', () => {
  const p = (role: ProcessRole): InstanceProcess => proc(1, role)
  it('Chromium 系：浏览器、渲染、网络服务', () => {
    expect(missingRoles([p('browser'), p('renderer'), p('network'), p('gpu')], spec())).toEqual([])
    expect(missingRoles([p('browser'), p('gpu')], spec())).toEqual(['renderer', 'network'])
  })

  it('WebKit：启动脚本、UI、网络进程（承载 IndexedDB 与 Cookie）、页面进程', () => {
    expect(missingRoles([p('launcher'), p('ui'), p('networking'), p('web-content')], spec({ family: 'webkit' }))).toEqual([])
    expect(missingRoles([p('launcher'), p('ui')], spec({ family: 'webkit', platform: 'linux' }))).toEqual(['networking', 'web-content'])
  })
})

describe('结束之后还活着的（stillAlive）', () => {
  const killed = [proc(10, 'browser', { command: 'a' }), proc(11, 'renderer', { command: 'b' }), proc(12, 'network', { command: 'c' }), proc(13, 'gpu', { command: 'd' })]
  it('同一个进程号、启动时刻相差不超过 2 秒、而且没有退出（僵尸、已死）的才算还活着；进程号被别的进程重新用了不算', () => {
    const table = [
      row({ pid: 10, command: 'a', startedAt: LAUNCHED_AT + 1_500 }),
      row({ pid: 11, command: 'b', state: 'Z' }),
      row({ pid: 12, command: 'c', state: 'X' }),
      row({ pid: 13, command: 'someone else', startedAt: LAUNCHED_AT + 60_000 }),
    ]
    expect(stillAlive(table, killed).map(r => r.pid)).toEqual([10])
    expect(stillAlive([], killed)).toEqual([])
  })

  it('Linux 上正在退出的进程命令行读出来是空的（[comm]）：还是那个进程，没退出完就还活着（容器里实测：结束之后的 zygote）', () => {
    expect(stillAlive([row({ pid: 11, command: '[chrome-headless]', state: 'S' })], killed).map(r => r.pid)).toEqual([11])
  })
})

describe('准备时认出的进程现在怎样了（processStatus）', () => {
  const known = proc(10, 'networking', { command: 'net' })
  it('还是同一个进程、已经退出、进程号换成了别的进程（冻住它之后要立即恢复）', () => {
    expect(processStatus([row({ pid: 10, command: 'net', state: 'T' })], known)).toBe('same')
    expect(processStatus([], known)).toBe('gone')
    expect(processStatus([row({ pid: 10, command: 'someone else', startedAt: LAUNCHED_AT + 30_000 })], known)).toBe('replaced')
  })
})

describe('冻住与结束的先后（signalOrder）', () => {
  it('承载存储的（WebKit 的网络进程、Chromium 的浏览器与存储服务）在前，其余按原来的顺序', () => {
    const roles: readonly ProcessRole[] = ['renderer', 'networking', 'ui', 'browser', 'gpu', 'storage']
    expect(signalOrder(roles.map((role, index) => proc(index + 1, role))).map(p => p.role)).toEqual(['networking', 'browser', 'storage', 'renderer', 'ui', 'gpu'])
  })
})

describe('重开时记下的 Cookie（cookieSummary）', () => {
  it('只记名字、域、路径、过期时刻与是不是会话 Cookie，不带值（令牌不进报告与日志）', () => {
    const summary = cookieSummary([
      { name: 'nerve_session', value: 'SECRET-TOKEN', domain: '127.0.0.1', path: '/', expires: 1_800_000_000, httpOnly: true, secure: false, sameSite: 'Lax' },
      { name: 'temp', value: 'v', domain: '127.0.0.1', path: '/', expires: -1, httpOnly: false, secure: false, sameSite: 'Lax' },
    ])
    expect(summary).toEqual([
      { name: 'nerve_session', domain: '127.0.0.1', path: '/', expires: 1_800_000_000, session: false },
      { name: 'temp', domain: '127.0.0.1', path: '/', expires: -1, session: true },
    ])
    expect(JSON.stringify(summary)).not.toContain('SECRET-TOKEN')
  })
})

// 页面自检的结果（M3-P2 设计 §3.5）：编辑器页的自检（./selftest.ts）写出，驱动脚本（tests/e2e/safari/selftest.ts）
// 与 E2E（tests/e2e/specs/editor/selftest.spec.ts）读回。
// 结果怎么带出页面：页面的 CSP 只许同源连接（connect-src 'self'），E2E 的后端是生产的后端、没有收集结果的接口；顶层跳转不受 CSP 限制，
// 所以自检结束时整页跳到 next（驱动脚本起的收集端），结果压缩之后放在查询参数 result 里（gzip、base64url），收集端解开。
// 这个文件不引用任何模块：浏览器与 Node（驱动脚本、E2E）都用它（CompressionStream、atob、btoa 两边都有），
// E2E 经模块边界的例外引用它（eslint.config.ts）。

/** 结果的格式标识：门禁 artifacts 也按它核对生产构建里没有自检（tools/src/gates/policy.ts 的禁用关键字） */
export const SELFTEST_REPORT_FORMAT = 'nerve-office.editor-selftest.v1'

/** 编辑器页的地址带它时跑自检（值是场景） */
export const SELFTEST_PARAM = 'selftest'

/** 自检结束之后整页跳到的地址（驱动脚本起的收集端）：结果加在它的查询参数 RESULT_PARAM 上 */
export const NEXT_PARAM = 'next'

/** 收集端从这个查询参数读结果 */
export const RESULT_PARAM = 'result'

/**
 * 测试构建里选公式模式的地址参数（M3-P4 设计 §3.14，US-M3-03 的两种模式）：编辑器页的地址带 formula=main 时编辑器以主线程模式创建
 * （编辑器的开关 ./formula-mode.ts 读它），不带或者 formula=worker 时用公式 Worker。页面自检的入口页按步骤带上它（selftestEditorUrl）；
 * E2E 打开编辑器页时同样可以带。生产构建里没有这个开关
 */
export const FORMULA_MODE_PARAM = 'formula'

/** 两种公式模式在地址里的写法（键与编辑器的 FormulaMode 相同） */
export const FORMULA_MODE_VALUES = { 'worker': 'worker', 'main-thread': 'main' } as const

/**
 * 运行次数的地址参数（M4-P1 S1，设计 §3.6）：真实浏览器的前置复核（PROBE_SCENARIOS）按它定各项重复几次——驱动脚本默认 40
 * （真实 Safari 与本机持久上下文里的实测），Playwright 的校准不带（每项最少的次数：CI 只核对探针本身）。入口页从 # 片段读、
 * 原样带到编辑器页的地址上（selftestEditorUrl）；别的场景不看它
 */
export const RUNS_PARAM = 'runs'

/** runs 的上限：再多只是拉长一次运行（worker-stall 的 40 次在真实 Safari 上约 5 分钟） */
export const RUNS_MAX = 400

/**
 * 打开编辑器页时暂停定时的自动保存（M3-P4 S7，审查 B1）：入口页登录之后、跳到编辑器页之前在 sessionStorage 里写下它（同一个标签页里跳转，
 * sessionStorage 跟着走），测试构建的自动保存控制（./autosave-control.ts 的 AUTOSAVE_HOLD_STORAGE_KEY、AUTOSAVE_HELD）据此打开即暂停——
 * 真实 Safari 与 Playwright 的夹具（默认暂停）从打开起是同一个状态。自检开始时还会再暂停一次、各场景按需要放开（selftest-autosave.ts），
 * 结果不依赖打开时的状态。这个文件不引用任何模块，在这里另写一份，单元测试核对两边一致
 */
export const SELFTEST_AUTOSAVE_HOLD = { key: 'nerve-office.autosave-hold', value: 'held' } as const

/** 公式在哪里计算（与编辑器的 FormulaMode 相同；这个文件不引用任何模块，在这里另写一份，单元测试核对两边一致） */
export type SelftestFormulaMode = keyof typeof FORMULA_MODE_VALUES

/**
 * 自检的场景：
 * - read-only：查看者打开只读样本，逐项试只读入口（Facade、撤销与重做、合成的快捷键、界面）；
 * - read-only-formulas：查看者打开去掉公式缓存值的样本，公式在 Worker 里算出结果、没有被防火墙取消；
 * - edit-chrome：能编辑的人打开同一份样本，界面检查的对照（工具栏、右键菜单、底栏在能编辑时都在，合成的右键与按键确实有效）；
 * - enter-exit：作者打开自己的一份样本（M3-P2 S5）：阅读 → 点页头的"编辑"→ 经 Facade 改一格（ENTER_EXIT_EDIT）→ 点"退出编辑"
 *   （先保存）→ 回到阅读之后再试 Facade 的只读入口、撤销与重做（撤销栈已清空）与界面；两次切换的耗时记进 timings；
 * - 捕获时机的复核（CAPTURE_SCENARIOS，M3-P4 S1，DEF-003 的其余部分；都在编辑时跑，见 ./selftest-capture.ts）；
 * - 交接的复核（HANDOVER_SCENARIOS，M3-P5 设计 §3.14；驱动脚本编排，见 ./selftest-handover.ts）；
 * - 请求编辑的两条路（REQUEST_SCENARIOS，M3-P6 设计 §3.10，DEF-062；驱动脚本经接口扮演另一方，见 ./selftest-request.ts）
 */
export const CAPTURE_SCENARIOS = ['environment', 'change-detection', 'formula-timing', 'auto-height', 'large-copy', 'composition', 'hidden-save'] as const

export type CaptureScenario = (typeof CAPTURE_SCENARIOS)[number]

/**
 * 交接的复核（M3-P5 设计 §3.14 与 §3.7 的 R1）：takeover-holder 是正在编辑的标签页 A，takeover-taker 是同一个浏览器、同一次登录里另开的
 * 标签页 B（直接打开编辑器页，不经入口页再登录一次：再登录会换掉浏览器里的会话 Cookie，A 的编辑权绑定的那次登录随之对不上）；
 * takeover-holder-deaf 是收不到交接频道消息的 A（编辑器页的挂接在这一页装上，模拟被暂停、冻结、卡住的标签页：B 3 秒之后本人接管并抢锁）；
 * refresh-save 是刷新时有一次保存停在服务端（驱动脚本让它在服务端停一会儿）
 */
export const HANDOVER_SCENARIOS = ['takeover-holder', 'takeover-holder-deaf', 'takeover-taker', 'refresh-save'] as const

/** 收不到交接频道消息的 A（编辑器页的挂接据它装上吞掉消息的频道） */
export const DEAF_HOLDER_SCENARIO = 'takeover-holder-deaf'

export type HandoverScenario = (typeof HANDOVER_SCENARIOS)[number]

/**
 * 请求编辑的两条路（M3-P6 设计 §3.10，DEF-062）：被复核的一方在这个浏览器里，另一方（另一个账户）由驱动脚本经接口扮演（登录、申请、心跳、交出；
 * 请求、续期、申请）：
 * - request-waiter（路 1）：别人在编辑时这一页点"请求编辑"、在等；驱动脚本另开标签页让这一页隐藏、经接口交出——这一页的续期得知交给了它，
 *   在后台停在"交给了我"（granted）、不申请；遮住它的标签页关掉、回到前台之后才进入编辑（普通申请），之后写一格、存上；
 * - paused-holder（路 2）：这一页进入编辑、写一格并存上；驱动脚本盖住屏幕，这一页隐藏的那一刻上传第二格、之后再写第三格（只在本页）；另一方经接口
 *   请求编辑、续期——这一页被暂停时，空闲满 2 分钟的自动交出走不到，编辑权按时间到期，另一方接手，移走盖屏之后这一页得知失去编辑权（另一方在编辑）、
 *   第三格另存为副本（lost-after-pause）；没被暂停时空闲满 2 分钟先保存再自动交出（handed-over）。真实 Safari 走哪一条正是要复核的
 *   （探索 B 的空白页约 50 秒就被暂停；2026-10-08 本机 Safari 27.0 上编辑器页没有被暂停）
 */
export const REQUEST_SCENARIOS = ['request-waiter', 'paused-holder'] as const

export type RequestScenario = (typeof REQUEST_SCENARIOS)[number]

/**
 * 真实浏览器的前置复核（M4-P1 设计 §3.6，S1 第一轮）：不依赖发件箱生产代码的探针（场景在 ./selftest-storage.ts、./selftest-stall.ts、
 * ./selftest-cost.ts，探针 Worker 是 ./storage-probe-worker.ts）。页面只核对"跑完、数据齐"，事实（facts）与计时交回，
 * 判定在驱动脚本一侧的纯函数里（tests/e2e/support/probe-verdicts.ts）：
 * - storage（阅读）：持久保存、配额与用量、durability 与磁盘上的写入耗时、事务中止的回滚、IndexedDB 的基本行为（含 Worker 里）、
 *   Web Locks（§3.6 第 1–3、5、6、8 项）；
 * - key-transfer（阅读）：不可导出的 CryptoKey 经 postMessage 交给 Worker、Worker 里的 AES-GCM 带 AAD、CompressionStream 与 SHA-256，
 *   以及交不过去时的退路（原始字节在 Worker 里导入）（第 7 项）。单独一步：WebKit 序列化 CryptoKey 时可能要用钥匙串里的主密钥，
 *   万一弹出钥匙串的提示、页面停住，别的几项的结果已经交回
 * - storage-quota（阅读）：写满（第 4 项）——一条一条地加，最多写 QUOTA_PROBE_MAX_BYTES：配额被覆盖成 8–16 MiB（Playwright 的 Chromium 系
 *   经 CDP）时在这之前写满；没被覆盖时写到上限就停、删掉。不在真实 Safari 的步骤里：Safari 没有覆盖配额的接口，写满由第 5 项的回滚作有界的替代；
 * - worker-stall（阅读）：探针 Worker 有无空定时器 × 空闲多久之后，第一次异步操作的用时（第 9 项，DEF-011）；
 * - capture-cost（编辑）：捕获的主线程成本（save、序列化、编码分开）、Worker 放置时异步段与主线程 gzip 的主线程阻塞（第 10 项，DEF-012）；
 * - perf-baseline（编辑）：首屏、两种公式模式下增量与全量计算的收齐、事件循环与帧间隔（第 12 项，DEF-012）
 */
export const PROBE_SCENARIOS = ['storage', 'key-transfer', 'storage-quota', 'worker-stall', 'capture-cost', 'perf-baseline'] as const

export type ProbeScenario = (typeof PROBE_SCENARIOS)[number]

export function isProbeScenario(value: string): value is ProbeScenario {
  return (PROBE_SCENARIOS as readonly string[]).includes(value)
}

/**
 * storage-quota 最多往里写这么多（字节）：Playwright 经 CDP 把配额覆盖成 8–16 MiB（设计 §3.6 第 4 项）时在这之前写满；没被覆盖时
 * （真实浏览器的配额是磁盘的一部分，GiB 级）写到这里就停、删掉，不会把磁盘写满。页面看不出配额有没有被覆盖：estimate() 照旧报真实的配额
 * （M0-P6 的实测：覆盖成 8 MiB 时 estimate 仍是 8 GiB，2026-10-09 持久上下文里同样）
 */
export const QUOTA_PROBE_MAX_BYTES = 64 * 1024 * 1024

export const SELFTEST_SCENARIOS = ['read-only', 'read-only-formulas', 'edit-chrome', 'enter-exit', ...CAPTURE_SCENARIOS, ...HANDOVER_SCENARIOS, ...REQUEST_SCENARIOS, ...PROBE_SCENARIOS] as const

export type SelftestScenario = (typeof SELFTEST_SCENARIOS)[number]

export function isSelftestScenario(value: string): value is SelftestScenario {
  return (SELFTEST_SCENARIOS as readonly string[]).includes(value)
}

/**
 * enter-exit 在编辑时改的那一格（"数据"表 K45，从 0 开始是第 44 行、第 10 列；只读入口的清单不碰它）与写进去的值：
 * 驱动脚本与 E2E 核对服务器上的那份文档恰好多了一个修订、内容里有它
 */
export const ENTER_EXIT_EDIT = { sheetName: '数据', sheetId: 'sheet-1', cell: 'K45', row: 44, column: 10, value: '进入、退出编辑的自检' } as const

/**
 * hidden-save（M3-P4 S1；S7 起由自动保存上传）在编辑时写的两格（模板的第一张表 sheet-1）：写第一格，经测试构建的控制立即上传它，
 * 上传的同时写第二格——第二格留着没捕获、没上传（定时的上传暂停、捕获的静默与上限调到一小时），页面变成隐藏的那一刻由自动保存自己捕获、上传。
 * 驱动脚本与 E2E 核对服务器上的那份文档：第一次上传之后修订号 2；隐藏之后修订号 3、内容里有两格
 */
export const HIDDEN_SAVE_EDITS = [
  { sheetId: 'sheet-1', cell: 'A1', row: 0, column: 0, value: '隐藏之前保存的' },
  { sheetId: 'sheet-1', cell: 'A2', row: 1, column: 0, value: '隐藏的那一刻保存的' },
] as const

/**
 * composition（M3-P4 S1）组字写进的批注：模板的第一张表 sheet-1 的 B2，选定的文字。S7 起驱动脚本与 E2E 另核对服务器上的那份文档里
 * 有它（自动保存在组合结束之后存下）
 */
export const COMPOSITION_NOTE = { sheetId: 'sheet-1', cell: 'B2', row: 1, column: 1, text: '你好' } as const

/**
 * takeover-holder（A）写的三格（模板的第一张表 sheet-1）：第一格经测试构建的控制立即存上（驱动脚本看到这一版才另开 B），上传的同时写第二格
 * （留着，A 变成隐藏的那一刻由自动保存上传——P4 的"切到后台立即上传"）；隐藏之后再写第三格（模拟切走之前最后一刻没被捕获的修改：捕获的静默与
 * 上限调到一小时，它只在 A 回应交接、先保存再交出时存上，否则留在 A 里——失去编辑权之后的"另存为副本"）
 */
export const TAKEOVER_EDITS = [
  { sheetId: 'sheet-1', cell: 'A1', row: 0, column: 0, value: '隐藏之前存上的' },
  { sheetId: 'sheet-1', cell: 'A2', row: 1, column: 0, value: '隐藏的那一刻上传的' },
  { sheetId: 'sheet-1', cell: 'A3', row: 2, column: 0, value: '隐藏之后写的' },
] as const

/** takeover-taker（B）从页面开始载入算起等多久再点"在此编辑"（设计 §3.14：A 隐藏 8 秒之后；B 一打开 A 就隐藏了） */
export const TAKEOVER_TAKER_DELAY_MS = 8_000

/** refresh-save 进入编辑之后写的那一格：它的保存停在服务端（驱动脚本锁住了内容行）时页面刷新 */
export const REFRESH_SAVE_EDIT = { sheetId: 'sheet-1', cell: 'A1', row: 0, column: 0, value: '刷新时在途的保存' } as const

/** request-waiter（M3-P6，路 1）回到前台、进入编辑之后写下并存上的那一格：编辑权确实交给了它（保存照常提交） */
export const REQUEST_WAITER_EDIT = { sheetId: 'sheet-1', cell: 'B1', row: 0, column: 1, value: '回到前台进入编辑之后写的' } as const

/**
 * paused-holder（M3-P6，路 2）写的三格（模板的第一张表 sheet-1），与 takeover-holder 同一个写法：第一格经控制的 flush 立即存上（驱动脚本看到这一版
 * 才盖屏），同时写第二格（留着，隐藏的那一刻由自动保存上传）；隐藏之后再写第三格（捕获的静默与上限调到一小时、定时的上传暂停）——这一页被暂停、
 * 编辑权到期，第三格只在这一页，失去编辑权之后另存为副本
 */
export const PAUSED_HOLDER_EDITS = [
  { sheetId: 'sheet-1', cell: 'A1', row: 0, column: 0, value: '盖屏之前存上的' },
  { sheetId: 'sheet-1', cell: 'A2', row: 1, column: 0, value: '盖屏的那一刻上传的' },
  { sheetId: 'sheet-1', cell: 'A3', row: 2, column: 0, value: '盖屏之后写的' },
] as const

/**
 * 交接的场景交回的时间线（M3-P5）：交接日志（./handover-log.ts）与场景自己的观察（隐藏、显示、页面关闭时的状态、请求的结果等），
 * 每条有种类与墙上时间（毫秒，跨标签页、跨两次载入比先后用它），其余字段随种类
 */
export interface SelftestTimelineEntry {
  readonly kind: string
  readonly wall: number
  readonly [field: string]: unknown
}

/** 一项计时（例如 switch.enter：一次切换的各段耗时，毫秒；缺的是 null）。各段的含义见 ./switch-timing.ts 的 switchDurations */
export interface SelftestTiming {
  readonly id: string
  readonly ms: Readonly<Record<string, number | null>>
}

/**
 * 一项事实（M4-P1 S1：真实浏览器的复核交回的，例如 persisted、配额的字节数、durability 是否被反映、出错的名字）。
 * 键写成"项.名"（例如 persist.after）；判定在驱动脚本里（tests/e2e/support/probe-verdicts.ts），页面不判断它们对不对
 */
export type SelftestFact = string | number | boolean | null

/** 一项检查的结果 */
export interface SelftestCheck {
  /** 稳定的标识（例如 facade.筛选、shortcut.undo）：驱动脚本与报告按它对照不同浏览器的结果 */
  readonly id: string
  readonly pass: boolean
  /** 看到了什么（等到的信号、提示的说法、出错的原因），给人看 */
  readonly detail: string
  /** 用了多少毫秒 */
  readonly ms: number
}

/** 自检开始时页面的状态 */
export interface SelftestPage {
  /** ready：就绪到 steady；failed：载入失败（detail 说明）；timeout：等不到就绪；hidden：页面在后台，浏览器暂停了它（自检做不了） */
  readonly state: 'ready' | 'failed' | 'timeout' | 'hidden'
  /** 按只读打开（就绪时才有） */
  readonly readOnly?: boolean | undefined
  readonly detail?: string | undefined
}

export interface SelftestReport {
  readonly format: typeof SELFTEST_REPORT_FORMAT
  readonly scenario: string
  readonly documentId: string
  readonly userAgent: string
  /** 编辑器页开始载入、自检结束的时刻（ISO 8601） */
  readonly startedAt: string
  readonly finishedAt: string
  readonly page: SelftestPage
  /** 页面的可见性：开始时的，以及之间的每次变化（"时刻 状态"）。页面隐藏时浏览器暂停动画帧，Univer 画不出来 */
  readonly visibility: readonly string[]
  readonly checks: readonly SelftestCheck[]
  /** 没接住的异常与没处理的拒绝（"名称: 说明"） */
  readonly pageErrors: readonly string[]
  /** 页面里 console.error 的调用 */
  readonly consoleErrors: readonly string[]
  /** 浏览器的通知（ResizeObserver 没送达的通知，与 E2E 的 support/page-errors.ts 同一个判断），不算错误 */
  readonly ignoredNotices: readonly string[]
  /** read-only-formulas：打开之后公式算出的值（"工作表 id!A1" → 值），驱动脚本与 E2E 对照样本 */
  readonly formulaValues?: Readonly<Record<string, unknown>> | undefined
  /** enter-exit：每次切换的各段耗时 */
  readonly timings?: readonly SelftestTiming[] | undefined
  /**
   * 交接的场景（M3-P5）走了哪条路：takeover-taker 是 answered（A 回应了、先保存再交出）或 silent（3 秒没有回应、本人接管并抢锁）；
   * takeover-holder 是 handed-over（交出、回到阅读）或 lost（失去编辑权）；refresh-save 是 committed（那次保存提交了才接手）或 expired（等满 30 秒）。
   * 请求编辑的两条路（M3-P6）：request-waiter 是 entered-on-return（在后台停在交给了我、回到前台才进入）或别的（./selftest-request.ts 的 WaiterPath）；
   * paused-holder 是 lost-after-pause（被暂停，回到前台才得知失去编辑权）、handed-over（没被暂停，空闲满 2 分钟自动交出）或别的（PausedHolderPath）
   */
  readonly path?: string | undefined
  /** 交接的场景：时间线（交接日志与场景的观察） */
  readonly timeline?: readonly SelftestTimelineEntry[] | undefined
  /** 真实浏览器的前置复核（PROBE_SCENARIOS，M4-P1）：事实（SelftestFact）；计时在 timings 里 */
  readonly facts?: Readonly<Record<string, SelftestFact>> | undefined
  /** 自检本身没能跑完的原因（编辑器没就绪、自检抛错）；跑完时没有 */
  readonly failure?: string | undefined
}

/** 自检通过：页面就绪、每项检查都通过、没有页面错误与 console.error */
export function selftestPassed(report: SelftestReport): boolean {
  return report.failure === undefined && report.page.state === 'ready' && report.checks.length > 0
    && report.checks.every(check => check.pass) && report.pageErrors.length === 0 && report.consoleErrors.length === 0
}

// ---- 编码：gzip 之后 base64url（地址里不用再转义）----

function toBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes)
    binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
  if (!/^[\w-]*$/.test(text))
    throw new SelftestReportError('结果不是 base64url')
  const padded = text.replaceAll('-', '+').replaceAll('_', '/').padEnd(Math.ceil(text.length / 4) * 4, '=')
  const binary = atob(padded)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1)
    bytes[index] = binary.charCodeAt(index)
  return bytes
}

async function transform(bytes: Uint8Array<ArrayBuffer>, stream: CompressionStream | DecompressionStream): Promise<Uint8Array<ArrayBuffer>> {
  const source = new ReadableStream<Uint8Array<ArrayBuffer>>({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })
  return new Uint8Array(await new Response(source.pipeThrough(stream)).arrayBuffer())
}

export class SelftestReportError extends Error {
  override readonly name = 'SelftestReportError'
}

/** 结果写成查询参数的值 */
export async function encodeSelftestReport(report: SelftestReport): Promise<string> {
  return toBase64Url(await transform(new TextEncoder().encode(JSON.stringify(report)), new CompressionStream('gzip')))
}

/** 收集端解开查询参数里的结果；不是这个格式时抛出 SelftestReportError */
export async function decodeSelftestReport(encoded: string): Promise<SelftestReport> {
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(await transform(fromBase64Url(encoded), new DecompressionStream('gzip')))
  }
  catch (error) {
    throw error instanceof SelftestReportError ? error : new SelftestReportError('结果解不开（不是 gzip 压缩的 UTF-8 文本）', { cause: error })
  }
  let value: unknown
  try {
    value = JSON.parse(text)
  }
  catch (error) {
    throw new SelftestReportError('结果不是 JSON', { cause: error })
  }
  return parseSelftestReport(value)
}

/** next 可以用的主机：本机（M3-P2 复核 B7） */
const LOCAL_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', 'localhost'])

/**
 * next（自检的结果交给谁）只能是本机的源（M3-P2 复核 B7）：http、主机是 127.0.0.1 或 localhost，端口不限，地址里不带账户。
 * 驱动脚本起的收集端与 E2E 拦下的地址都在本机；结果里有文档 id、检查的结果、页面错误与公式算出的值，测试构建的页面不能被一个
 * 带着任意 next 的地址把它们整页带到别处。合格时返回 undefined，否则返回原因：入口页与编辑器页把它写在页面上，不登录、不跑、不跳转
 */
export function nextProblem(next: string): string | undefined {
  let url: URL
  try {
    url = new URL(next)
  }
  catch {
    return 'next 不是一个完整的地址'
  }
  if (url.protocol !== 'http:' || !LOCAL_HOSTS.has(url.hostname) || url.username !== '' || url.password !== '')
    return `next 只能是本机的地址（http://127.0.0.1:<端口> 或 http://localhost:<端口>），这里是 ${url.origin === 'null' ? url.protocol : url.origin}`
  return undefined
}

/** 自检结束之后跳去的地址：next 加上结果。next 不是本机的地址时抛出 SelftestReportError（调用方先用 nextProblem 核对，原因写在页面上） */
export function reportUrl(next: string, encoded: string): string {
  const problem = nextProblem(next)
  if (problem !== undefined)
    throw new SelftestReportError(problem)
  const url = new URL(next)
  url.searchParams.set(RESULT_PARAM, encoded)
  return url.href
}

/**
 * 入口页登录之后整页跳去的编辑器页：/documents/<文档 id>?selftest=<场景>&next=<…>，给了公式模式时另带 formula=<…>，给了运行次数时
 * 另带 runs=<…>（M4-P1）。路径与 contracts 的 documentPagePath 相同（单元测试对照）：入口页不引用 contracts 与平台页面、编辑器页共用的
 * 任何模块（M3-P2 复核 B4），所以在这里就地写
 */
export function selftestEditorUrl(origin: string, documentId: string, scenario: string, next: string, formula?: SelftestFormulaMode, runs?: number): string {
  const url = new URL(`/documents/${encodeURIComponent(documentId)}`, origin)
  url.searchParams.set(SELFTEST_PARAM, scenario)
  url.searchParams.set(NEXT_PARAM, next)
  if (formula !== undefined)
    url.searchParams.set(FORMULA_MODE_PARAM, FORMULA_MODE_VALUES[formula])
  if (runs !== undefined)
    url.searchParams.set(RUNS_PARAM, String(runs))
  return url.href
}

/** 地址里的运行次数（入口页从 # 片段读，编辑器页从查询串读）：没有时 undefined，不是 1–RUNS_MAX 的整数时 null */
export function runsOfValue(value: string | null): number | undefined | null {
  if (value === null)
    return undefined
  if (!/^[1-9]\d{0,5}$/.test(value))
    return null
  const runs = Number(value)
  return runs <= RUNS_MAX ? runs : null
}

/** 地址里的公式模式（入口页从 # 片段读）：认识的写法交回模式，没有时是 undefined，不认识时是 null（入口页按登录失败一样交回原因） */
export function formulaModeOfValue(value: string | null): SelftestFormulaMode | undefined | null {
  if (value === null)
    return undefined
  const found = (Object.keys(FORMULA_MODE_VALUES) as SelftestFormulaMode[]).find(mode => FORMULA_MODE_VALUES[mode] === value)
  return found ?? null
}

// ---- 读回时的校验：字段与类型都对才算这个格式（收集端收到的是地址里的任意文字）----

type Json = Readonly<Record<string, unknown>>

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string')
}

function isCheck(value: unknown): value is SelftestCheck {
  return isObject(value) && typeof value.id === 'string' && typeof value.pass === 'boolean' && typeof value.detail === 'string' && typeof value.ms === 'number'
}

function isTiming(value: unknown): value is SelftestTiming {
  return isObject(value) && typeof value.id === 'string' && isObject(value.ms)
    && Object.values(value.ms).every(item => item === null || (typeof item === 'number' && Number.isFinite(item)))
}

function isTimelineEntry(value: unknown): value is SelftestTimelineEntry {
  return isObject(value) && typeof value.kind === 'string' && typeof value.wall === 'number' && Number.isFinite(value.wall)
}

function isFact(value: unknown): value is SelftestFact {
  return value === null || typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))
}

function isPage(value: unknown): value is SelftestPage {
  return isObject(value) && (value.state === 'ready' || value.state === 'failed' || value.state === 'timeout' || value.state === 'hidden')
    && (value.readOnly === undefined || typeof value.readOnly === 'boolean')
    && (value.detail === undefined || typeof value.detail === 'string')
}

const REQUIRED_STRINGS = ['scenario', 'documentId', 'userAgent', 'startedAt', 'finishedAt'] as const
const REQUIRED_STRING_ARRAYS = ['visibility', 'pageErrors', 'consoleErrors', 'ignoredNotices'] as const

/** 按格式校验读回的值；不对时抛出 SelftestReportError，说明哪一项不对 */
export function parseSelftestReport(value: unknown): SelftestReport {
  if (!isObject(value) || value.format !== SELFTEST_REPORT_FORMAT)
    throw new SelftestReportError(`不是 ${SELFTEST_REPORT_FORMAT} 的结果`)
  for (const key of REQUIRED_STRINGS) {
    if (typeof value[key] !== 'string')
      throw new SelftestReportError(`结果的 ${key} 不是字符串`)
  }
  for (const key of REQUIRED_STRING_ARRAYS) {
    if (!isStringArray(value[key]))
      throw new SelftestReportError(`结果的 ${key} 不是字符串的数组`)
  }
  if (!isPage(value.page))
    throw new SelftestReportError('结果的 page 不对')
  if (!Array.isArray(value.checks) || !value.checks.every(isCheck))
    throw new SelftestReportError('结果的 checks 不对')
  if (value.formulaValues !== undefined && !isObject(value.formulaValues))
    throw new SelftestReportError('结果的 formulaValues 不对')
  if (value.timings !== undefined && (!Array.isArray(value.timings) || !value.timings.every(isTiming)))
    throw new SelftestReportError('结果的 timings 不对')
  if (value.path !== undefined && typeof value.path !== 'string')
    throw new SelftestReportError('结果的 path 不是字符串')
  if (value.timeline !== undefined && (!Array.isArray(value.timeline) || !value.timeline.every(isTimelineEntry)))
    throw new SelftestReportError('结果的 timeline 不对')
  if (value.facts !== undefined && (!isObject(value.facts) || !Object.values(value.facts).every(isFact)))
    throw new SelftestReportError('结果的 facts 不对（值只能是字符串、有限的数、真假或 null）')
  if (value.failure !== undefined && typeof value.failure !== 'string')
    throw new SelftestReportError('结果的 failure 不是字符串')
  return value as unknown as SelftestReport
}

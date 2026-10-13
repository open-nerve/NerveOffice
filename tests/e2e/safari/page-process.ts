// 真实 Safari 页面进程的保守判定；只处理事实，不读取系统、不发信号。
// 调用方须先证明本机来源列表覆盖整个目标进程，才能接线；LS 会略过临时会话与无 origin 页面，仅读到它不够。
// 本机读取器必须交付已核实的来源列表与启动时间；不能把进程名、最新 PID 或用户页面标题当作归属证据。

export interface SafariPageObservation {
  readonly pid: number
  readonly uid: number
  /** 内核进程出生时刻，Unix 微秒的十进制字符串，避免浮点舍入导致 PID 复用漏检。 */
  readonly startedAtUs: string
  readonly executable: string
  readonly bundleId: string
  readonly asn: string
  /** LSActivePageUserVisibleOriginsKey 的完整列表；读不到时 undefined，不用空数组代替。 */
  readonly origins: readonly string[] | undefined
}

export interface SafariPageContext {
  readonly origin: string
  readonly uid: number
  readonly mainPid: number
  /** 打开本次测试页之前的完整 PID 基线，capturedAt 是读取完成时刻。 */
  readonly baseline: { readonly capturedAt: number, readonly pids: readonly number[] }
}

export interface SafariPageSnapshot {
  readonly capturedAt: number
  readonly processes: readonly SafariPageObservation[]
  readonly desktop: { readonly idleSeconds: number | undefined, readonly locked: boolean, readonly returned: boolean }
}

export interface SafariPageTarget extends SafariPageObservation {
  readonly origins: readonly [string]
  readonly observedAt: number
}

export type SafariPageDecision
  = | { readonly kind: 'identified', readonly target: SafariPageTarget }
    | { readonly kind: 'refused', readonly reason: string }

const WEB_CONTENT = '/System/Library/Frameworks/WebKit.framework/Versions/A/XPCServices/com.apple.WebKit.WebContent.xpc/Contents/MacOS/com.apple.WebKit.WebContent'
const EXECUTABLES = new Set([WEB_CONTENT, `/System/Volumes/Preboot/Cryptexes/App${WEB_CONTENT}`])
const MAX_OBSERVATION_AGE_MS = 2_000

function refused(reason: string): SafariPageDecision {
  return { kind: 'refused', reason }
}

function validOrigin(origin: string): boolean {
  try {
    const url = new URL(origin)
    return url.origin === origin && url.protocol === 'http:' && url.hostname === '127.0.0.1' && Number(url.port) >= 1024
  }
  catch {
    return false
  }
}

const sameOrigin = (value: string, origin: string): boolean => value === origin || value === `${origin}/`

/** 只交回本次测试的来源，拒绝说明不包含其他用户的页面信息。 */
export function identifySafariPage(context: SafariPageContext, snapshot: SafariPageSnapshot, now: number): SafariPageDecision {
  if (!validOrigin(context.origin) || !Number.isSafeInteger(context.uid) || context.uid < 0 || !Number.isSafeInteger(context.mainPid) || context.mainPid <= 1)
    return refused('测试来源、用户或 Safari 主进程身份无效')
  if (!Number.isSafeInteger(now) || !Number.isSafeInteger(snapshot.capturedAt) || snapshot.capturedAt > now || now - snapshot.capturedAt > MAX_OBSERVATION_AGE_MS)
    return refused('进程观测过期或时刻无效，需要重新读取')
  if (!Number.isSafeInteger(context.baseline.capturedAt) || context.baseline.capturedAt <= 0 || context.baseline.capturedAt >= snapshot.capturedAt || context.baseline.pids.length === 0)
    return refused('缺少打开测试页之前的进程基线')
  const { idleSeconds, locked, returned } = snapshot.desktop
  if (locked || returned || idleSeconds === undefined || !Number.isFinite(idleSeconds) || idleSeconds < 120)
    return refused('屏幕锁定、用户有操作或空闲不足两分钟')
  if (new Set(snapshot.processes.map(process => process.pid)).size !== snapshot.processes.length)
    return refused('同一 PID 有多条观测，无法确认唯一身份与来源')
  const candidates = snapshot.processes.filter(process => process.origins?.some(origin => sameOrigin(origin, context.origin)) === true)
  if (candidates.length !== 1)
    return refused('测试来源没有唯一的页面进程')
  const process = candidates[0]!
  if (!Number.isSafeInteger(process.pid) || process.pid <= 1 || process.pid === context.mainPid || context.baseline.pids.includes(process.pid))
    return refused('候选不是本次打开后新出现的页面进程')
  if (process.uid !== context.uid || process.bundleId !== 'com.apple.WebKit.WebContent' || !EXECUTABLES.has(process.executable))
    return refused('候选的用户或可执行文件不是系统 WebContent')
  if (!/^ASN:0x[0-9a-f]+-0x[0-9a-f]+:$/i.test(process.asn) || !/^\d{10,20}$/.test(process.startedAtUs))
    return refused('候选缺少可核对的启动身份')
  const born = BigInt(process.startedAtUs)
  if (born < BigInt(context.baseline.capturedAt) * 1000n || born > BigInt(snapshot.capturedAt) * 1000n)
    return refused('候选出生时刻不在本次测试窗口内')
  if (process.origins?.length !== 1)
    return refused('候选同时承载其他页面，不能结束')
  const origins: readonly [string] = Object.freeze([context.origin])
  return { kind: 'identified', target: Object.freeze({ ...process, origins, observedAt: snapshot.capturedAt }) }
}

/** 执行器必须再次采集桌面与全部候选；旧快照、PID 复用或归属变化都使初次资格失效。 */
export function revalidateSafariPage(target: SafariPageTarget, context: SafariPageContext, snapshot: SafariPageSnapshot, now: number): SafariPageDecision {
  if (snapshot.capturedAt <= target.observedAt)
    return refused('执行前没有取得新的观测')
  const next = identifySafariPage(context, snapshot, now)
  if (next.kind === 'refused')
    return next
  const current = next.target
  if (current.pid !== target.pid || current.uid !== target.uid || current.startedAtUs !== target.startedAtUs || current.executable !== target.executable || current.bundleId !== target.bundleId || current.asn !== target.asn || current.origins[0] !== target.origins[0])
    return refused('原页面进程身份已变化，不能发送信号')
  return next
}

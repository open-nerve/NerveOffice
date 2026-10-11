// 独立 profile 的归属前提由本机操作者在创建时证明，HTTP 页面不能提供或替换。
// 新 profile 具有独立 WebsiteDataStore，隐藏历史页也仅来自本次专用测试；不能用当前 tab 列表替代此前提。
// 本模块只判定事实。桌面读取、Safari 只读 Apple Events、内核读取和单 PID 信号由独立适配器负责。

export interface SafariProfileProof {
  readonly name: string
  readonly windowId: number
  readonly axWindowUuid: string
  readonly exclusiveFromCreation: boolean
  readonly extensionsDisabled: boolean
  readonly createdAt: number
  readonly baseline: { readonly capturedAt: number, readonly pids: readonly number[] }
}

export interface ProfileProcessIdentity {
  readonly pid: number
  readonly uid: number
  readonly startedAtUs: string
  readonly executable: string
  readonly bundleId: string
  readonly asn: string
  /** SecCode 按 PID 检查 anchor apple and identifier com.apple.WebKit.WebContent。 */
  readonly appleSigned: boolean
}

export interface ProfilePageContext {
  readonly url: string
  readonly uid: number
  readonly mainPid: number
  /** 本轮绝对截止时刻；独立于映射的两秒新鲜度。 */
  readonly deadline: number
  readonly profile: SafariProfileProof
}

export interface ProfilePageSnapshot {
  /** 取所有映射前的时刻，保守计算最老事实的年龄，不用读完时刻掩盖慢查询。 */
  readonly capturedAt: number
  readonly finishedAt: number
  readonly desktop: { readonly idleSeconds: number | undefined, readonly locked: boolean, readonly returned: boolean }
  readonly processes: readonly ProfileProcessIdentity[]
  readonly windows: readonly {
    readonly windowId: number
    readonly profileMatches: boolean
    readonly tabs: readonly { readonly index: number, readonly pid: number, readonly urlMatches: boolean, readonly knownUrlMatches?: boolean }[]
  }[]
}

export interface ProfilePageTarget extends ProfileProcessIdentity {
  readonly windowId: number
  readonly profileName: string
  readonly url: string
  readonly observedAt: number
}

export type ProfilePageDecision
  = | { readonly kind: 'identified', readonly target: ProfilePageTarget }
    | { readonly kind: 'refused', readonly reason: string }

const WEB_CONTENT = '/System/Library/Frameworks/WebKit.framework/Versions/A/XPCServices/com.apple.WebKit.WebContent.xpc/Contents/MacOS/com.apple.WebKit.WebContent'
// Incoming/OS 是本机 macOS 27 内核实际返回的系统路径，同时要求动态 Apple 签名；不凭可执行文件名匹配。
const EXECUTABLES = new Set([WEB_CONTENT, `/System/Volumes/Preboot/Cryptexes/App${WEB_CONTENT}`, `/System/Volumes/Preboot/Cryptexes/Incoming/OS${WEB_CONTENT}`])
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const positive = (value: number): boolean => Number.isSafeInteger(value) && value > 0
const refused = (reason: string): ProfilePageDecision => ({ kind: 'refused', reason })

function localUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.href === value && url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname) && Number(url.port) >= 1024 && url.username === '' && url.password === '' && url.hash === '' && url.pathname !== '/'
  }
  catch {
    return false
  }
}

export function identifyProfilePage(context: ProfilePageContext, snapshot: ProfilePageSnapshot, now: number): ProfilePageDecision {
  const proof = context.profile
  if (!localUrl(context.url) || !positive(context.mainPid) || context.mainPid === 1 || !Number.isSafeInteger(context.uid) || context.uid < 0)
    return refused('目标 URL、用户或 Safari 主进程无效')
  if (!positive(context.deadline) || now >= context.deadline)
    return refused('本轮绝对截止时刻已到达或无效')
  if (!proof.exclusiveFromCreation || !proof.extensionsDisabled || proof.name.trim() === '' || !positive(proof.windowId) || !UUID.test(proof.axWindowUuid) || !positive(proof.createdAt))
    return refused('缺少经本机 UI 核实的新建专用场景证明')
  const baseline = proof.baseline
  if (!positive(baseline.capturedAt) || baseline.capturedAt >= proof.createdAt || proof.createdAt >= snapshot.capturedAt || baseline.pids.length === 0 || !baseline.pids.every(positive) || new Set(baseline.pids).size !== baseline.pids.length)
    return refused('场景创建前进程基线不完整或时序不符')
  if (!positive(now) || !positive(snapshot.capturedAt) || !positive(snapshot.finishedAt) || snapshot.finishedAt < snapshot.capturedAt || snapshot.finishedAt > now || now - snapshot.capturedAt > 2000)
    return refused('完整映射采集过慢、过期或时间无效')
  const desktop = snapshot.desktop
  if (desktop.locked || desktop.returned || desktop.idleSeconds === undefined || !Number.isFinite(desktop.idleSeconds) || desktop.idleSeconds < 120)
    return refused('用户活动、屏幕锁定或空闲不足两分钟')
  if (new Set(snapshot.windows.map(window => window.windowId)).size !== snapshot.windows.length || new Set(snapshot.processes.map(process => process.pid)).size !== snapshot.processes.length)
    return refused('重复窗口或 PID 使映射不唯一')
  const windows = snapshot.windows.filter(window => window.profileMatches)
  const window = windows[0]
  if (windows.length !== 1 || window?.windowId !== proof.windowId || window.tabs.length !== 1)
    return refused('专用场景与创建时的单窗口、单标签绑定不同')
  const tab = window.tabs[0]!
  if (!tab.urlMatches || tab.index !== 1 || !positive(tab.pid) || tab.pid === 1 || tab.pid === context.mainPid || baseline.pids.includes(tab.pid))
    return refused('目标不是精确测试页面或不是创建后新生进程')
  if (snapshot.windows.some(other => other.windowId !== proof.windowId && other.tabs.some(candidate => candidate.pid === tab.pid || candidate.urlMatches)))
    return refused('目标 PID 或测试 URL 同时出现在其他窗口')
  const process = snapshot.processes.find(process => process.pid === tab.pid)
  if (process === undefined || process.uid !== context.uid || !process.appleSigned || process.bundleId !== 'com.apple.WebKit.WebContent' || !EXECUTABLES.has(process.executable))
    return refused('没有相符的系统 WebContent 内核身份与 Apple 签名')
  if (!/^\d{10,20}$/.test(process.startedAtUs) || !/^ASN:0x[0-9a-f]+-0x[0-9a-f]+:$/i.test(process.asn))
    return refused('缺少可二次核对的微秒出生身份或 ASN')
  const born = BigInt(process.startedAtUs)
  if (born < BigInt(baseline.capturedAt) * 1000n || born > BigInt(snapshot.capturedAt) * 1000n)
    return refused('内核出生身份不在场景创建基线后的窗口内')
  return { kind: 'identified', target: Object.freeze({ ...process, windowId: proof.windowId, profileName: proof.name, url: context.url, observedAt: snapshot.capturedAt }) }
}

export function revalidateProfilePage(target: ProfilePageTarget, context: ProfilePageContext, snapshot: ProfilePageSnapshot, now: number): ProfilePageDecision {
  if (snapshot.capturedAt <= target.observedAt)
    return refused('信号前没有新的完整映射')
  const next = identifyProfilePage(context, snapshot, now)
  if (next.kind === 'refused')
    return next
  for (const key of ['pid', 'uid', 'startedAtUs', 'executable', 'bundleId', 'asn', 'windowId', 'profileName', 'url'] as const) {
    if (target[key] !== next.target[key])
      return refused('窗口、页面或进程身份已变化，不能发送信号')
  }
  return next
}

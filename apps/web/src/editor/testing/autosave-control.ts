// 测试构建的自动保存控制（M3-P4 设计 §3.14）：只拦网络不够——拦住时状态是"保存中…"、失去编辑权的流程要等它，断网又会触发重试与核对，
// 语义全变。所以在页面里给 E2E 一个控制：
// - hold / release：定时触发的自动保存（静默、上限、退避到点的重试、恢复联网）不发 / 照常；立即上传（保存按钮、Cmd/Ctrl+S、退出编辑、
//   切到后台）照常，捕获照常。打开时是否暂停由 sessionStorage 选（E2E 经 page.addInitScript 写 AUTOSAVE_HOLD_STORAGE_KEY；默认不暂停）；
// - setLimits / resetLimits：换节奏（例如把捕获的上限调到 50 ms 测"超过上限"，M0 的做法）；
// - flush：让当前的调度立即上传一次（autosave.ts 的 flush('control')：不提交单元格、不等公式、去重，会话与联网照样挡）；
// - log / clearLog：每次捕获与上传的原因、序号、时刻（调度的时钟，performance.now）与结果（requestId）。
// 整页共用一份：编辑模式每建一个调度就交给这里（attach），去掉时交回 undefined；节奏与暂停对之后建的调度同样有效。
// 只在测试构建里：编辑器页的组装处（features/sheet-editor/start.tsx）在 import.meta.env.MODE === 'e2e' 的分支里动态引入它；
// 生产构建里没有它（门禁 artifacts 按来源认出 editor/testing/，挂在 window 上的名字另由禁用关键字核对）。
// 这个文件不引用任何模块（nerve/editor-testing-shared）：E2E 也引用它（挂在 window 上的名字、sessionStorage 的键、日志的写法），
// 默认的节奏由组装处传进来（contracts 的 AUTOSAVE_*）。

/** 控制挂在 window 上的名字：E2E 经它调用（page.evaluate） */
export const AUTOSAVE_CONTROL_GLOBAL = '__nerveAutosaveControl'

/** sessionStorage 里"打开时暂停定时的自动保存"的键：值是 AUTOSAVE_HELD 时暂停 */
export const AUTOSAVE_HOLD_STORAGE_KEY = 'nerve-office.autosave-hold'
export const AUTOSAVE_HELD = 'held'

/** 节奏（autosave.ts 的 AutosaveLimits 同形） */
export interface AutosaveControlLimits {
  readonly captureQuietMs: number
  readonly captureMaxMs: number
  readonly captureSpacingFactor: number
  readonly uploadQuietMs: number
  readonly uploadMaxMs: number
  readonly retryInitialMs: number
  readonly retryMaxMs: number
}

/** 一次上传的结果（save-coordinator.ts 的 SaveOutcome 同形）：saved 带 requestId；failed 带归类；skipped 带原因 */
export interface AutosaveLogOutcome {
  readonly kind: string
  readonly requestId?: string | undefined
  readonly reason?: string | undefined
  readonly failure?: { readonly kind: string, readonly retryAfterMs?: number | undefined } | undefined
}

/** 日志里的一条（autosave.ts 的 AutosaveEvent 同形）：时刻都在调度的时钟上（performance.now） */
export type AutosaveLogEntry
  = | { readonly kind: 'capture', readonly trigger: string, readonly at: number, readonly seq: number, readonly formulasPending: boolean, readonly bytes: number, readonly durationMs: number }
    | { readonly kind: 'capture-failed', readonly trigger: string, readonly at: number }
    | { readonly kind: 'upload', readonly trigger: string, readonly startedAt: number, readonly at: number, readonly seq: number | undefined, readonly outcome: AutosaveLogOutcome }

/** 控制的 flush 交回的（autosave.ts 的 FlushResult 同形）；没有当前的调度（不在编辑）时为 undefined */
export interface AutosaveControlFlushResult {
  readonly edits: boolean
  readonly formulas: boolean
  readonly outcome: AutosaveLogOutcome | undefined
}

/** 挂在 window 上的控制（E2E 经 page.evaluate 调用） */
export interface AutosaveControl {
  readonly hold: () => void
  readonly release: () => void
  readonly held: () => boolean
  readonly setLimits: (limits: Partial<AutosaveControlLimits>) => void
  readonly resetLimits: () => void
  readonly limits: () => AutosaveControlLimits
  /** 当前的调度立即上传一次（flush('control')）：这一次结束之后兑现 */
  readonly flush: () => Promise<AutosaveControlFlushResult | undefined>
  /** 有没有当前的调度（编辑中） */
  readonly attached: () => boolean
  readonly log: () => AutosaveLogEntry[]
  readonly clearLog: () => void
}

/** 控制能调用的调度（autosave.ts 的 Autosave 的子集） */
export interface AutosaveControlTarget {
  readonly flush: (reason: 'control') => Promise<AutosaveControlFlushResult>
}

/** 交给编辑器页的那一面（edit-mode.ts 的 EditModeAutosave 的 tuning、observe、attach） */
export interface InstalledAutosaveControl {
  readonly tuning: {
    readonly limits: () => AutosaveControlLimits
    readonly held: () => boolean
    readonly onChange: (listener: () => void) => () => void
  }
  readonly observe: (event: AutosaveLogEntry) => void
  readonly attach: (target: AutosaveControlTarget | undefined) => void
  /** 挂在 window 上的那一个（单元测试用） */
  readonly control: AutosaveControl
}

/** 日志最多留这么多条（页面自检的长场景不至于一直涨） */
const LOG_LIMIT = 2000

/** 打开时暂停与否：sessionStorage 读不了（隐私模式等）时不暂停 */
function initiallyHeld(target: Pick<Window, 'sessionStorage'>): boolean {
  try {
    return target.sessionStorage.getItem(AUTOSAVE_HOLD_STORAGE_KEY) === AUTOSAVE_HELD
  }
  catch {
    return false
  }
}

/** 日志里存一份不再变的拷贝（事件对象里的结果可能被调度留着） */
function copyOf(event: AutosaveLogEntry): AutosaveLogEntry {
  return structuredClone(event)
}

/** 装上控制：挂到 window 上，交回给编辑器页的那一面。defaults 是生产的节奏（contracts 的 AUTOSAVE_*） */
export function installAutosaveControl(target: Window, defaults: AutosaveControlLimits): InstalledAutosaveControl {
  const listeners = new Set<() => void>()
  let held = initiallyHeld(target)
  let limits: AutosaveControlLimits = { ...defaults }
  let current: AutosaveControlTarget | undefined
  const entries: AutosaveLogEntry[] = []

  const changed = (): void => {
    for (const listener of [...listeners])
      listener()
  }

  const control: AutosaveControl = {
    hold: () => {
      held = true
      changed()
    },
    release: () => {
      held = false
      changed()
    },
    held: () => held,
    setLimits: (next) => {
      limits = { ...limits, ...next }
      changed()
    },
    resetLimits: () => {
      limits = { ...defaults }
      changed()
    },
    limits: () => limits,
    flush: async () => current?.flush('control'),
    attached: () => current !== undefined,
    log: () => entries.map(copyOf),
    clearLog: () => {
      entries.length = 0
    },
  }
  ;(target as unknown as Record<string, unknown>)[AUTOSAVE_CONTROL_GLOBAL] = control

  return {
    tuning: {
      limits: () => limits,
      held: () => held,
      onChange: (listener) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    },
    observe: (event) => {
      entries.push(copyOf(event))
      if (entries.length > LOG_LIMIT)
        entries.splice(0, entries.length - LOG_LIMIT)
    },
    attach: (next) => {
      current = next
    },
    control,
  }
}

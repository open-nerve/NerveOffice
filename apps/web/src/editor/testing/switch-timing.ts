// 模式切换的计时（M3-P2 设计 §3.1 第 4 条、§6 的 S5）：在页面上记下一次切换（进入编辑、退出编辑、"有更新，点击刷新"、打开）的各个时刻，
// 再整理成各段的耗时。E2E 的实测（tests/e2e/measure/）与测试构建的页面自检（./selftest.ts，真实 Safari）用同一套。
// 记什么（installSwitchTiming）：
// - click：页头里的按钮被点了（捕获阶段，早于页头自己的处理）：切换的起点；
// - chrome：页头里的按钮变了（各按钮的文字，| 连接）：页头说明"正在…"、进入目标状态的时刻；
// - state：编辑器容器的 data-editor-state 变了（loading、ready、steady）：ready 时交互屏障撤掉、可以操作，steady 在渲染完成之后 3 秒
//   （SDK 固定的延时，计划书 §12.2：不能当作指标，这里照记）；
// - access-removed：适配层销毁编辑器的最后一步去掉容器上的 data-editor-access（sheet-editor.ts）：旧的编辑器销毁完，
//   编辑器页随即把 surface 设为 creating、开始新建（edit-mode.ts 的 rebuild）；
// - access-set：新的编辑器开始挂载（写上 data-editor-access，detail 是 read 或 edit）；sync-end：挂载的同步部分（公式 Worker、Univer、
//   插件、createWorkbook）结束之后的第一个微任务；
// - canvas：表格的主画布挂进容器。Univer 的 ui（1.0.1）在 Ready 之后用 300 ms 的定时器做第一次渲染，挂上画布、随即进入 Rendered
//   （ui-shared.controller.ts 的 _bootstrapWorkbench），所以这是 Rendered 的时刻；
// - request、response：页面经 fetch 发出的请求与它的回应（方法、路径、状态码）；整理时再用资源计时（Resource Timing）里的结束时刻
//   补上正文读完的时刻。
// 销毁与开始挂载这两个时刻要同步记下（之后的微任务里看已经晚了：挂载的同步部分有几十毫秒），所以在容器这个元素上包一层
// setAttribute、removeAttribute；别的用 MutationObserver 与捕获阶段的监听。只观察，不改变页面的行为。
// 这个文件不引用任何模块（nerve/editor-testing-shared）：E2E 也引用它——installSwitchTiming 由 Playwright 序列化到页面里执行
// （addInitScript），整理（summarizeSwitch、switchDurations）在 Playwright 的进程里做；自检直接调用。
// 所以 installSwitchTiming 只能用它的参数与函数里的东西，不能引用这个文件里的别的东西（常量也不行）。

/** 计时装在页面的哪里 */
export interface SwitchTimingOptions {
  /** 记录器挂在 window 上的名字：E2E 经它读出，同一个页面只装一次 */
  readonly globalName: string
  /** 编辑器的容器与页头 */
  readonly surface: string
  readonly chrome: string
}

/** 编辑器页上的计时：容器是 #sheet-editor，页头是 #editor-chrome（apps/web/editor.html） */
export const SWITCH_TIMING_OPTIONS: SwitchTimingOptions = { globalName: '__nerveSwitchTiming', surface: '#sheet-editor', chrome: '#editor-chrome' }

export type SwitchMarkKind = 'click' | 'chrome' | 'state' | 'access-removed' | 'access-set' | 'sync-end' | 'canvas' | 'request' | 'response'

/** 一个时刻 */
export interface SwitchMark {
  /** performance.now()：页面的导航开始是 0 */
  readonly at: number
  readonly kind: SwitchMarkKind
  /** click：按钮的文字；chrome：页头各按钮的文字（| 连接）；state：新的值；access-*、sync-end：read 或 edit；request："方法 路径"；response：状态码或 failed */
  readonly detail: string
  /** request 与它的 response 相同 */
  readonly id?: number
}

/** 资源计时里一个接口请求的开始与结束（正文读完） */
export interface ResourceEnd {
  readonly path: string
  readonly startTime: number
  readonly responseEnd: number
}

export interface SwitchTimingRecorder {
  readonly marks: () => SwitchMark[]
  /** 资源计时里 /api/ 下的请求 */
  readonly resources: () => ResourceEnd[]
  /** 清掉已有的时刻与资源计时（每次切换之前） */
  readonly clear: () => void
}

/**
 * 装上计时，返回记录器（已经装过就返回原来的）。可以在页面开始之前装（E2E 的 addInitScript：容器与页头还没有，文档解析完时再挂上），
 * 也可以在编辑器就绪之后装（自检）。只能用参数与函数里的东西（见文件开头）
 */
export function installSwitchTiming(options: SwitchTimingOptions): SwitchTimingRecorder {
  const host = window as unknown as Record<string, SwitchTimingRecorder | undefined>
  const existing = host[options.globalName]
  if (existing !== undefined)
    return existing
  const accessAttribute = 'data-editor-access'
  const stateAttribute = 'data-editor-state'
  const canvasSelector = 'canvas[id^="univer-sheet-main-canvas_"]'
  let marks: SwitchMark[] = []
  let requestCount = 0
  const mark = (kind: SwitchMarkKind, detail: string, id?: number): void => {
    marks.push(id === undefined ? { at: performance.now(), kind, detail } : { at: performance.now(), kind, detail, id })
  }
  const textOf = (element: Element): string => (element.textContent ?? '').replace(/\s+/g, ' ').trim()

  // 请求：页面的请求层每次调用时取全局的 fetch（shared/api/client.ts），包一层就看得到每个请求
  const originalFetch = window.fetch.bind(window)
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = input instanceof Request ? input : undefined
    const method = (init?.method ?? request?.method ?? 'GET').toUpperCase()
    const path = new URL(request?.url ?? String(input), location.href).pathname
    requestCount += 1
    const id = requestCount
    mark('request', `${method} ${path}`, id)
    try {
      const response = await originalFetch(input, init)
      mark('response', String(response.status), id)
      return response
    }
    catch (error) {
      mark('response', 'failed', id)
      throw error
    }
  }
  // 资源计时默认只留 250 条：反复切换时不够
  performance.setResourceTimingBufferSize(10_000)

  // 点击：捕获阶段，早于页头（React）的处理
  document.addEventListener('click', (event) => {
    const chrome = document.querySelector(options.chrome)
    const button = event.target instanceof Element ? event.target.closest('button') : null
    if (button !== null && chrome !== null && chrome.contains(button))
      mark('click', textOf(button))
  }, true)

  let attached = false
  const attach = (): void => {
    const surface = document.querySelector(options.surface)
    const chrome = document.querySelector(options.chrome)
    if (attached || !(surface instanceof HTMLElement) || !(chrome instanceof HTMLElement))
      return
    attached = true
    let awaitingCanvas = false
    // 适配层在这个元素上写、去掉 data-editor-access（sheet-editor.ts 的 mount 与销毁的最后一步）：同步记下
    const setAttribute = surface.setAttribute.bind(surface)
    const removeAttribute = surface.removeAttribute.bind(surface)
    surface.setAttribute = (name: string, value: string): void => {
      if (name === accessAttribute) {
        mark('access-set', value)
        awaitingCanvas = true
        queueMicrotask(() => mark('sync-end', value))
      }
      setAttribute(name, value)
    }
    surface.removeAttribute = (name: string): void => {
      if (name === accessAttribute)
        mark('access-removed', surface.getAttribute(name) ?? '')
      removeAttribute(name)
    }
    let state = surface.getAttribute(stateAttribute) ?? ''
    new MutationObserver((records) => {
      // 同一批里可能有几次改动：每条记录给出改之前的值，改之后的值是下一条的改之前，最后一条的改之后就是现在的值
      const changes = records.filter(record => record.type === 'attributes' && record.target === surface)
      changes.forEach((record, index) => {
        const value = changes[index + 1]?.oldValue ?? surface.getAttribute(stateAttribute) ?? ''
        if (value !== state) {
          state = value
          mark('state', value)
        }
      })
      if (!awaitingCanvas)
        return
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (node instanceof Element && (node.matches(canvasSelector) || node.querySelector(canvasSelector) !== null)) {
            awaitingCanvas = false
            mark('canvas', '')
            return
          }
        }
      }
    }).observe(surface, { attributes: true, attributeFilter: [stateAttribute], attributeOldValue: true, childList: true, subtree: true })
    const signature = (): string => [...chrome.querySelectorAll('button')].map(textOf).join('|')
    let buttons = signature()
    mark('chrome', buttons)
    new MutationObserver(() => {
      const next = signature()
      if (next !== buttons) {
        buttons = next
        mark('chrome', next)
      }
    }).observe(chrome, { childList: true, subtree: true, characterData: true })
  }
  attach()
  // 页面开始之前装上的（E2E）：文档解析完（模块脚本执行之前）容器与页头才在
  if (!attached)
    document.addEventListener('readystatechange', attach)

  const recorder: SwitchTimingRecorder = {
    marks: () => [...marks],
    resources: () => performance.getEntriesByType('resource')
      .map(entry => entry as PerformanceResourceTiming)
      .map(entry => ({ path: new URL(entry.name).pathname, startTime: entry.startTime, responseEnd: entry.responseEnd }))
      .filter(entry => entry.path.startsWith('/api/')),
    clear: () => {
      marks = []
      performance.clearResourceTimings()
    },
  }
  host[options.globalName] = recorder
  return recorder
}

// ---- 整理 ----

/** 切换的方向：打开（导航开始到阅读）、进入编辑、退出编辑、"有更新，点击刷新" */
export type SwitchDirection = 'open' | 'enter' | 'exit' | 'refresh'

/** 一个请求在切换里的角色（按方法与路径） */
export type RequestRole = 'acquire' | 'release' | 'renew' | 'status' | 'content' | 'save' | 'session' | 'document' | 'other'

/** 一个请求：相对起点的开始与结束（正文读完；没有资源计时时是回应到达） */
export interface SwitchRequest {
  readonly role: RequestRole
  /** "方法 路径 状态码" */
  readonly label: string
  readonly start: number
  readonly end: number
}

/**
 * 一次切换的各个时刻（相对起点的毫秒数，没有的是 null）。起点：页面收到点击；打开时是导航开始。
 * creating 是开始新建编辑器（旧的销毁完；打开时没有旧的，是开始挂载）
 */
export interface SwitchTiming {
  readonly direction: SwitchDirection
  /** 页头第一次变化（说明"正在…"） */
  readonly feedback: number | null
  /** 页头进入目标状态（进入：有"退出编辑"；退出：有"编辑"、没有"退出编辑"；刷新："有更新"的按钮不在了；打开：有"编辑"） */
  readonly header: number | null
  readonly creating: number | null
  readonly mountStart: number | null
  readonly syncEnd: number | null
  /** Rendered（主画布挂进容器） */
  readonly rendered: number | null
  /** 交互屏障撤掉（data-editor-state 变成 ready） */
  readonly ready: number | null
  readonly steady: number | null
  /** 起点之后、steady 之前（没有 steady 时到最后）发出的请求 */
  readonly requests: readonly SwitchRequest[]
}

/** 页头各按钮的文字（chrome 的 detail）是不是这个方向的目标状态 */
export function headerReached(direction: SwitchDirection, buttons: string): boolean {
  const names = buttons === '' ? [] : buttons.split('|')
  switch (direction) {
    case 'enter':
      return names.includes('退出编辑')
    case 'exit':
      return names.includes('编辑') && !names.includes('退出编辑')
    case 'refresh':
      return !names.includes('有更新，点击刷新') && !names.includes('正在载入最新的版本…')
    case 'open':
      return names.includes('编辑')
  }
}

/** 编辑租约（/edit-lease）上各方法的角色：申请、释放、心跳续租、编辑状态 */
const LEASE_ROLES: Readonly<Record<string, RequestRole>> = { POST: 'acquire', DELETE: 'release', PUT: 'renew', GET: 'status' }

/** 按方法与路径（"方法 路径"）认出请求的角色 */
export function requestRole(label: string): RequestRole {
  const [method = '', path = ''] = label.split(' ')
  if (path.endsWith('/edit-lease'))
    return LEASE_ROLES[method] ?? 'other'
  if (path.endsWith('/content') && (method === 'GET' || method === 'PUT'))
    return method === 'GET' ? 'content' : 'save'
  if (path === '/api/auth/session')
    return 'session'
  if (method === 'GET' && /^\/api\/documents\/[^/]+$/.test(path))
    return 'document'
  return 'other'
}

function rounded(value: number): number {
  return Math.round(value * 10) / 10
}

/**
 * 把一次切换的时刻整理成 SwitchTiming。marks 是这次切换前后记下的（切换之前 clear 过；打开时从页面开始），
 * 起点是第一次点击（打开时是导航开始，0）；没有点击时抛错
 */
export function summarizeSwitch(direction: SwitchDirection, marks: readonly SwitchMark[], resources: readonly ResourceEnd[] = []): SwitchTiming {
  const origin = direction === 'open' ? 0 : marks.find(mark => mark.kind === 'click')?.at
  if (origin === undefined)
    throw new Error('没有点击的记录：切换的起点不知道')
  const first = (kind: SwitchMarkKind, from: number, test: (mark: SwitchMark) => boolean = () => true): SwitchMark | undefined =>
    marks.find(mark => mark.kind === kind && mark.at >= from && test(mark))
  const offset = (mark: SwitchMark | undefined): number | null => mark === undefined ? null : rounded(mark.at - origin)
  const mountStart = first('access-set', origin)
  const removed = direction === 'open' ? undefined : first('access-removed', origin)
  const creating = removed ?? mountStart
  const syncEnd = mountStart === undefined ? undefined : first('sync-end', mountStart.at)
  const rendered = mountStart === undefined ? undefined : first('canvas', mountStart.at)
  // 编辑器页在新的编辑器接上时按它当时的阶段写 ready 或 steady（editor-page.ts 的 modeChanged）：渲染完成 3 秒之后才接上时直接是 steady
  const ready = mountStart === undefined ? undefined : first('state', mountStart.at, mark => mark.detail === 'ready' || mark.detail === 'steady')
  const steady = ready === undefined ? undefined : first('state', ready.at, mark => mark.detail === 'steady')
  const until = steady?.at ?? Number.POSITIVE_INFINITY
  const requests = marks
    .filter(mark => mark.kind === 'request' && mark.at >= origin && mark.at <= until)
    .map((request): SwitchRequest => {
      const response = marks.find(mark => mark.kind === 'response' && mark.id === request.id)
      const path = request.detail.split(' ')[1] ?? ''
      // 资源计时里同一个路径、开始时刻最接近的那一条（20 ms 以内）：正文读完的时刻
      const resource = resources
        .filter(entry => entry.path === path && Math.abs(entry.startTime - request.at) <= 20)
        .sort((a, b) => Math.abs(a.startTime - request.at) - Math.abs(b.startTime - request.at))[0]
      const end = Math.max(response?.at ?? request.at, resource?.responseEnd ?? 0)
      return {
        role: requestRole(request.detail),
        label: `${request.detail} ${response?.detail ?? '没有回应'}`,
        start: rounded(request.at - origin),
        end: rounded(end - origin),
      }
    })
  return {
    direction,
    // 打开时页头从空白开始画，"第一次变化"没有意义
    feedback: direction === 'open' ? null : offset(first('chrome', origin)),
    header: offset(first('chrome', origin, mark => headerReached(direction, mark.detail))),
    creating: offset(creating),
    mountStart: offset(mountStart),
    syncEnd: offset(syncEnd),
    rendered: offset(rendered),
    ready: offset(ready),
    steady: offset(steady),
    requests,
  }
}

/** 这个方向上切换本身的请求（阅读时的检查、心跳不算） */
const SWITCH_ROLES: Readonly<Record<SwitchDirection, readonly RequestRole[]>> = {
  open: ['session', 'document', 'content'],
  enter: ['acquire', 'content'],
  exit: ['save', 'release'],
  refresh: ['content'],
}

/** 几段时间合起来占了多久（重叠的只算一次：打开时详情与内容并行读） */
function coveredMs(spans: readonly { readonly start: number, readonly end: number }[]): number {
  let total = 0
  let reach = Number.NEGATIVE_INFINITY
  for (const span of [...spans].sort((a, b) => a.start - b.start)) {
    const start = Math.max(span.start, reach)
    if (span.end > start)
      total += span.end - start
    reach = Math.max(reach, span.end)
  }
  return total
}

/** switchDurations 给出的各段（报告与统计按这个顺序列出） */
export const SWITCH_DURATION_KEYS = ['feedback', 'header', 'ready', 'steady', 'network', 'acquire', 'content', 'save', 'release', 'beforeRebuild', 'dispose', 'rebuild', 'rebuildSteady', 'syncCreate', 'firstRender', 'readyWait'] as const

export type SwitchDurationKey = (typeof SWITCH_DURATION_KEYS)[number]

/**
 * 一次切换的各段耗时（毫秒；缺的是 null）：
 * - feedback、header、ready、steady：起点到页头第一次变化（说明"正在…"）、到页头进入目标状态、到交互屏障撤掉（可以操作）、到 steady；
 * - network：切换本身的请求占了多久（重叠的只算一次；进入：申请编辑权、需要时读内容；退出：保存、释放；刷新：读内容；
 *   打开：会话、详情、内容）；acquire、content、save、release 是其中各项；
 * - beforeRebuild：起点到开始新建编辑器（网络、捕获、销毁旧的编辑器等）；dispose：开始新建之前最后一个切换请求结束、到开始新建
 *   （主要是销毁旧的编辑器）；
 * - rebuild、rebuildSteady：开始新建到交互屏障撤掉、到 steady（edit-mode.ts 的 surface 从 creating 到 rendered、steady）；
 *   其中 syncCreate 是挂载的同步部分，firstRender 是同步部分结束到 Rendered（含 SDK 固定的 300 ms），readyWait 是 Rendered 到交互屏障撤掉
 *   （公式 Worker 装好 IMAGE() 的限制、探针等）
 */
export function switchDurations(timing: SwitchTiming): Readonly<Record<SwitchDurationKey, number | null>> {
  const between = (from: number | null, to: number | null): number | null => from === null || to === null ? null : rounded(to - from)
  const relevant = timing.requests.filter(request => SWITCH_ROLES[timing.direction].includes(request.role))
  const covered = (role?: RequestRole): number | null => {
    const picked = relevant.filter(request => role === undefined || request.role === role)
    return picked.length === 0 ? null : rounded(coveredMs(picked))
  }
  const opening = timing.direction === 'open'
  const beforeCreating = timing.creating === null ? [] : relevant.filter(request => request.end <= (timing.creating ?? 0))
  const lastEnd = beforeCreating.length === 0 ? 0 : Math.max(...beforeCreating.map(request => request.end))
  return {
    feedback: timing.feedback,
    header: timing.header,
    ready: timing.ready,
    steady: timing.steady,
    network: covered(),
    acquire: covered('acquire'),
    content: covered('content'),
    save: covered('save'),
    release: covered('release'),
    beforeRebuild: opening ? null : timing.creating,
    dispose: opening ? null : between(lastEnd, timing.creating),
    rebuild: between(timing.creating, timing.ready),
    rebuildSteady: between(timing.creating, timing.steady),
    syncCreate: between(timing.mountStart, timing.syncEnd),
    firstRender: between(timing.syncEnd, timing.rendered),
    readyWait: between(timing.rendered, timing.ready),
  }
}

// 仅补充一次登录 popup 调查的证据；不改变导航、时钟、断言或重试。
import type { BrowserContext, Frame, Page, Request, Response, TestInfo } from '@playwright/test'
import { Buffer } from 'node:buffer'
import { performance } from 'node:perf_hooks'

const TARGET_TITLE = 'US-M3-02 登录过期：自动保存的上传得到 401 之后暂停（页头说暂停保存、登录回来之后自动保存），之后不再发请求——没有 401 接连不断；本人在新标签页登录回来之后自动上传'
const MAX_EVENTS = 256
const MAX_BYTES = 128 * 1024

export function isLoginPopupTarget(target: { file: string, title: string, project: string }, enabled: string | undefined): boolean {
  return enabled === '1' && target.project === 'webkit' && target.title === TARGET_TITLE
    && target.file.endsWith('/tests/e2e/specs/editor/autosave.spec.ts')
}

interface NavigationEvent {
  readonly kind: 'request' | 'response' | 'requestfinished' | 'requestfailed' | 'page-observed' | 'frame' | 'domcontentloaded' | 'load'
  readonly at: string
  readonly monotonicMs: number
  readonly pageId?: number
  readonly requestId?: number
  readonly status?: number
  readonly url?: string
}

function pathOf(url: string | undefined): string | null {
  try {
    const parsed = new URL(url ?? '')
    return /^https?:$/.test(parsed.protocol) && parsed.pathname.length <= 2048 ? parsed.pathname : null
  }
  catch {
    return null
  }
}

export function isLoginPopupUrl(url: string, baseURL: string): boolean {
  try {
    return new URL(url).origin === new URL(baseURL).origin && pathOf(url) === '/login'
  }
  catch {
    return false
  }
}

export function createLoginPopupLog({ maxBytes = MAX_BYTES }: { maxBytes?: number } = {}) {
  if (!Number.isInteger(maxBytes) || maxBytes < 256 || maxBytes > MAX_BYTES)
    throw new Error('诊断容量必须在 256 B 与 128 KiB 之间')
  const events: (Omit<NavigationEvent, 'url'> & { path: string | null })[] = []
  let truncated = false
  let dropped = 0
  let incomplete = false
  let sealed: string | undefined
  const snapshot = () => ({ version: 1, events: events.map(event => ({ ...event })), truncated, dropped, incomplete })
  return {
    snapshot,
    seal: () => (sealed ??= JSON.stringify(snapshot())),
    markIncomplete: () => {
      if (sealed === undefined)
        incomplete = true
    },
    record(input: NavigationEvent): void {
      if (sealed !== undefined)
        return
      if (truncated || events.length >= MAX_EVENTS) {
        truncated = true
        dropped = Math.min(Number.MAX_SAFE_INTEGER, dropped + 1)
        return
      }
      // 明确选字段，不能把 URL 查询串、原始错误或调用方多带的字段一起复制。
      const event = {
        kind: input.kind,
        at: input.at,
        monotonicMs: input.monotonicMs,
        path: pathOf(input.url),
        ...(input.pageId === undefined ? {} : { pageId: input.pageId }),
        ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
        ...(input.status === undefined ? {} : { status: input.status }),
      }
      // 预留截断/未知状态和最大计数的字节；终止记录后整个附件仍在原限额内。
      const bytes = Buffer.byteLength(JSON.stringify({ version: 1, events: [...events, event], truncated: false, dropped: Number.MAX_SAFE_INTEGER, incomplete: false }))
      if (bytes > maxBytes) {
        truncated = true
        dropped = Math.min(Number.MAX_SAFE_INTEGER, dropped + 1)
        return
      }
      events.push(event)
    },
  }
}

/** context request 监听先于 popup 创建，不依赖后到的 page 事件才能记录初始导航。 */
export function watchLoginPopupDiagnostic(context: BrowserContext, testInfo: TestInfo): { stop: () => void, attach: () => Promise<void> } {
  const log = createLoginPopupLog()
  const requests = new WeakMap<Request, number>()
  const pages = new Map<Page, number>()
  const selectedPages = new WeakSet<Page>()
  const remove: (() => void)[] = []
  let requestSequence = 0
  let sealed: string | undefined
  const note = (event: Omit<NavigationEvent, 'at' | 'monotonicMs'>) => log.record({ ...event, at: new Date().toISOString(), monotonicMs: performance.now() })
  const guard = <T>(callback: (value: T) => void) => (value: T): void => {
    try {
      callback(value)
    }
    catch {
      log.markIncomplete()
    }
  }
  const isLogin = (url: string) => isLoginPopupUrl(url, testInfo.project.use.baseURL ?? '')
  const watchPage = (page: Page): void => {
    if (pages.has(page))
      return
    if (pages.size >= 16) {
      log.markIncomplete()
      return
    }
    const pageId = pages.size + 1
    pages.set(page, pageId)
    if (isLogin(page.url())) {
      selectedPages.add(page)
      // page 事件可能晚于首个 commit；这里只记录现在看到的 URL，不补造历史 frame 事件。
      note({ kind: 'page-observed', pageId, url: page.url() })
    }
    const onFrame = guard((frame: Frame) => {
      if (frame !== page.mainFrame())
        return
      if (isLogin(frame.url()))
        selectedPages.add(page)
      if (selectedPages.has(page))
        note({ kind: 'frame', pageId, url: frame.url() })
    })
    const onDcl = guard(() => {
      if (selectedPages.has(page))
        note({ kind: 'domcontentloaded', pageId, url: page.url() })
    })
    const onLoad = guard(() => {
      if (selectedPages.has(page))
        note({ kind: 'load', pageId, url: page.url() })
    })
    page.on('framenavigated', onFrame)
    page.on('domcontentloaded', onDcl)
    page.on('load', onLoad)
    remove.push(() => {
      page.off('framenavigated', onFrame)
      page.off('domcontentloaded', onDcl)
      page.off('load', onLoad)
    })
  }
  const noteRequest = (kind: NavigationEvent['kind'], request: Request, status?: number): void => {
    const requestId = requests.get(request)
    if (requestId === undefined)
      return
    let pageId: number | undefined
    try {
      const page = request.frame().page()
      watchPage(page)
      selectedPages.add(page)
      pageId = pages.get(page)
    }
    catch {
      // popup 的初始请求可能先于 Frame 可用；保留请求事实，页归属明确记为未知。
      log.markIncomplete()
    }
    note({ kind, requestId, pageId, status, url: request.url() })
  }
  const onRequest = guard((request: Request) => {
    if (request.method() !== 'GET' || !request.isNavigationRequest() || !isLogin(request.url()))
      return
    requests.set(request, ++requestSequence)
    noteRequest('request', request)
  })
  const onResponse = guard((response: Response) => noteRequest('response', response.request(), response.status()))
  const onFinished = guard((request: Request) => noteRequest('requestfinished', request))
  const onFailed = guard((request: Request) => noteRequest('requestfailed', request))
  const onPage = guard(watchPage)
  context.on('request', onRequest)
  context.on('response', onResponse)
  context.on('requestfinished', onFinished)
  context.on('requestfailed', onFailed)
  context.on('page', onPage)
  for (const page of context.pages())
    onPage(page)
  return {
    stop() {
      if (sealed !== undefined)
        return
      try {
        context.off('request', onRequest)
        context.off('response', onResponse)
        context.off('requestfinished', onFinished)
        context.off('requestfailed', onFailed)
        context.off('page', onPage)
      }
      catch {
        log.markIncomplete()
      }
      for (const dispose of remove)
        guard(dispose)(undefined)
      sealed = log.seal()
    },
    async attach() {
      try {
        if (sealed === undefined)
          throw new Error('诊断尚未同步封存')
        await testInfo.attach('login-popup-navigation', { body: Buffer.from(sealed), contentType: 'application/json' })
      }
      catch {
        // 取证失败不覆盖原用例异常或 close 错误；缺附件/此标记均不得用于接受诊断结果。
        testInfo.annotations.push({ type: 'login-popup-diagnostic-incomplete', description: 'attachment-unavailable' })
      }
    },
  }
}

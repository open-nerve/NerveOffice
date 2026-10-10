// 页面自检（selftest.ts）的整体行为里不依赖编辑器的部分：开始时页面已经隐藏（Safari 暂停了它：没有动画帧，几秒之后计时器也停了），
// 余下的检查记为没有做、结果说明原因——不在这样的页面上逐项等到超时，给出"提示没有关掉"之类误导的说法（2026-10-04 真实 Safari 的
// 第一次 S5 运行：窗口在外接显示器上被别的应用铺满屏幕的窗口挡住，steady 之前就隐藏了）；地址里的 next 不是本机的地址时不跑、
// 不跳转（M3-P2 复核 B7）。各项检查本身由 E2E 的校准覆盖（selftest.spec.ts）。
import type { EditorProbe } from './e2e-probe.ts'
import type { SelftestHost } from './selftest.ts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AUTOSAVE_CONTROL_GLOBAL, installAutosaveControl } from './autosave-control.ts'
import { runEditorSelftest, runSelftestAndReport } from './selftest.ts'

function host(): SelftestHost {
  return {
    documentId: '01a0fb60-a504-7c95-8bdf-8aeaec893aaf',
    surface: document.createElement('div'),
    chrome: document.createElement('div'),
    startedAt: '2026-10-04T06:13:41.000Z',
    page: { state: 'ready', readOnly: true },
    view: () => ({ mode: 'reading', surface: 'steady' }),
    subscribe: () => () => {},
    visibility: () => ['2026-10-04T06:13:41.488Z visible', '2026-10-04T06:13:43.320Z hidden'],
    allowLeave: () => {},
    pageErrors: () => [],
    consoleErrors: () => [],
    ignoredNotices: () => [],
    firstLoad: () => ({ ready: 1200, steady: 4300 }),
  }
}

/** 只够自检开始时用的探针：取工作簿的 id 与打开时的快照 */
const PROBE = {
  univerAPI: { getActiveWorkbook: () => ({ getId: () => 'unit-1' }) },
  snapshot: () => '{"id":"unit-1","sheets":{}}',
  commands: () => [],
  shortcuts: () => [],
  formulaBarText: () => '',
} as unknown as EditorProbe

afterEach(() => {
  vi.restoreAllMocks()
  delete window.__nerveEditorProbe
})

describe('页面自检开始时页面已经隐藏', () => {
  it('每一项都记为没有做、说明被隐藏，结果交回"余下的检查没有做"', async () => {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    window.__nerveEditorProbe = PROBE
    const report = await runEditorSelftest(host(), 'read-only-formulas')
    expect(report.failure).toMatch(/^页面在 \S+ 被隐藏，余下的检查没有做$/)
    expect(report.checks.map(check => check.id)).toEqual(['page.read-only', 'formulas.computed', 'formulas.no-change-attempts', 'formulas.server-unchanged'])
    expect(report.checks.every(check => !check.pass && check.detail.startsWith('没有做：页面在') && check.ms === 0)).toBe(true)
  })

  it('开始时看得见：照常检查（这里页头是空的，第一项按页头的样子判断不通过，而不是没有做）', async () => {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    window.__nerveEditorProbe = PROBE
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"id":"unit-1","sheets":{}}'))
    const report = await runEditorSelftest(host(), 'read-only-formulas')
    expect(report.checks[0]).toMatchObject({ id: 'page.read-only', pass: false, detail: '页头：没有"只能查看"，没有保存按钮' })
    expect(report.failure).toBeUndefined()
  })
})

describe('自检开始时暂停定时的自动保存（M3-P4 S7 审查 B1：结果不依赖打开时的状态）', () => {
  afterEach(() => {
    delete (window as unknown as Record<string, unknown>)[AUTOSAVE_CONTROL_GLOBAL]
  })

  it('打开时照常、换过节奏的页面：自检开始时暂停定时的上传、换回默认的节奏（捕获时机的场景之后按需要放开）', async () => {
    const defaults = { captureQuietMs: 1000, captureMaxMs: 3000, captureSpacingFactor: 10, uploadQuietMs: 2000, uploadMaxMs: 15_000, retryInitialMs: 2000, retryMaxMs: 60_000 }
    const { control } = installAutosaveControl(window, defaults)
    control.setLimits({ captureMaxMs: 50 })
    expect(control.held()).toBe(false)
    // 页面隐藏：各项都记为没有做，这里只看开始时的那一步
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    window.__nerveEditorProbe = PROBE
    await runEditorSelftest(host(), 'read-only-formulas')
    expect(control.held()).toBe(true)
    expect(control.limits()).toEqual(defaults)
  })

  it('页面上没有控制（不是测试构建）：照常开始，不抛出', async () => {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    window.__nerveEditorProbe = PROBE
    const report = await runEditorSelftest(host(), 'read-only-formulas')
    expect(report.failure).toMatch(/被隐藏，余下的检查没有做$/)
  })
})

describe('页面自检的 next 不是本机的地址（M3-P2 复核 B7）', () => {
  afterEach(() => {
    document.body.replaceChildren()
    history.replaceState(null, '', '/')
  })

  it('不跑（不建结果）、不跳转，原因写在页面上，返回 undefined', async () => {
    const page = `/documents/01a0fb60-a504-7c95-8bdf-8aeaec893aaf?selftest=enter-exit&next=${encodeURIComponent('https://collector.example/report?step=1')}`
    history.replaceState(null, '', page)
    window.__nerveEditorProbe = PROBE
    const visibility = vi.fn(() => [])
    expect(await runSelftestAndReport({ ...host(), visibility })).toBeUndefined()
    expect(visibility).not.toHaveBeenCalled()
    expect(document.body.querySelector('[role="alert"]')?.textContent).toBe('页面自检没有运行：next 只能是本机的地址（http://127.0.0.1:<端口> 或 http://localhost:<端口>），这里是 https://collector.example')
    expect(`${window.location.pathname}${window.location.search}`).toBe(page)
  })
})

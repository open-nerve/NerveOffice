// 页面自检（selftest.ts）的整体行为里不依赖编辑器的部分：开始时页面已经隐藏（Safari 暂停了它：没有动画帧，几秒之后计时器也停了），
// 余下的检查记为没有做、结果说明原因——不在这样的页面上逐项等到超时，给出"提示没有关掉"之类误导的说法（2026-10-04 真实 Safari 的
// 第一次 S5 运行：窗口在外接显示器上被别的应用铺满屏幕的窗口挡住，steady 之前就隐藏了）。各项检查本身由 E2E 的校准覆盖（selftest.spec.ts）。
import type { EditorProbe } from './e2e-probe.ts'
import type { SelftestHost } from './selftest.ts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runEditorSelftest } from './selftest.ts'

function host(): SelftestHost {
  return {
    documentId: '01a0fb60-a504-7c95-8bdf-8aeaec893aaf',
    surface: document.createElement('div'),
    chrome: document.createElement('div'),
    startedAt: '2026-10-04T06:13:41.000Z',
    page: { state: 'ready', readOnly: true },
    view: () => ({ mode: 'reading', surface: 'steady' }),
    visibility: () => ['2026-10-04T06:13:41.488Z visible', '2026-10-04T06:13:43.320Z hidden'],
    pageErrors: () => [],
    consoleErrors: () => [],
    ignoredNotices: () => [],
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

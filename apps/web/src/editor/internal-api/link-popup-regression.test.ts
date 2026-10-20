import type { IDisposable } from '@univerjs/core'
import { DOCS_NORMAL_EDITOR_UNIT_ID_KEY } from '@univerjs/core'
import { UniverSheetsHyperLinkMobileUIPlugin, UniverSheetsHyperLinkUIPlugin } from '@univerjs/sheets-hyper-link-ui'
import { NEVER, Subject } from 'rxjs'
import { describe, expect, it, vi } from 'vitest'

interface Selection {
  unitId: string
  subUnitId: string
  segmentId: string
  segmentPage: number
  textRanges: { startOffset: number, endOffset: number }[]
  rectRanges: unknown[]
  isEditing: boolean
}

/** 从真实插件的依赖登记取得实际 controller，不复制待验 listener 或新增 SDK 导出。 */
function controller(mobile: boolean) {
  const dependencies: unknown[][] = []
  const injector = { add: (entry: unknown[]) => dependencies.push(entry), get: () => ({}) }
  const Plugin = mobile ? UniverSheetsHyperLinkMobileUIPlugin : UniverSheetsHyperLinkUIPlugin
  const plugin = new Plugin({}, injector as never, { setConfig: () => {} } as never)
  plugin.onStarting()
  const name = mobile ? 'SheetsHyperLinkMobilePopupController' : 'SheetsHyperLinkPopupController'
  const entry = dependencies.find(([token]) => typeof token === 'function' && token.name === name)
  expect(entry, '发布包必须仍登记同一弹窗 controller').toBeDefined()
  const Controller = entry![0] as new (...args: unknown[]) => IDisposable
  const selection$ = new Subject<Selection>()
  const endEditing = vi.fn()
  const instance = new Controller(
    { currentRichText$: NEVER, currentClickedCell$: NEVER },
    { endEditing },
    {},
    {},
    {},
    { onCommandExecuted: () => ({ dispose() {} }) },
    { currentEditCellState$: NEVER, visible$: NEVER },
    { textSelection$: selection$ },
    {},
  )
  return { selection$, endEditing, dispose: () => {
    instance.dispose()
    plugin.dispose()
  } }
}

function selected(): Selection {
  return {
    unitId: DOCS_NORMAL_EDITOR_UNIT_ID_KEY,
    subUnitId: DOCS_NORMAL_EDITOR_UNIT_ID_KEY,
    segmentId: '',
    segmentPage: -1,
    textRanges: [{ startOffset: 0, endOffset: 5 }],
    rectRanges: [],
    isEditing: true,
  }
}

describe.each([false, true])('固定 SDK 链接弹窗选区生命周期（mobile=%s）', (mobile) => {
  it('表单取得焦点仅改变编辑状态时保留弹窗，真正替换选区时仍关闭', () => {
    const fixture = controller(mobile)
    try {
      const selection = selected()
      fixture.selection$.next(selection)
      fixture.endEditing.mockClear()
      fixture.selection$.next({ ...selection, isEditing: false })
      fixture.selection$.next({ ...selection, isEditing: true })
      expect(fixture.endEditing).not.toHaveBeenCalled()
      fixture.selection$.next({ ...selection, textRanges: [{ startOffset: 1, endOffset: 3 }] })
      expect(fixture.endEditing).toHaveBeenCalledExactlyOnceWith('editing')
    }
    finally { fixture.dispose() }
  })

  it.each([
    { textRanges: [] },
    { rectRanges: [{}] },
    { segmentId: 'header' },
    { segmentPage: 1 },
    { subUnitId: 'another-sub-unit' },
  ])('清空选区或改变范围上下文仍关闭：%j', (change) => {
    const fixture = controller(mobile)
    try {
      const selection = selected()
      fixture.selection$.next(selection)
      fixture.endEditing.mockClear()
      fixture.selection$.next({ ...selection, ...change })
      expect(fixture.endEditing).toHaveBeenCalledExactlyOnceWith('editing')
    }
    finally { fixture.dispose() }
  })

  it('其他文档不关闭本弹窗，退役后也不再响应', () => {
    const fixture = controller(mobile)
    fixture.selection$.next({ ...selected(), unitId: 'other-document' })
    expect(fixture.endEditing).not.toHaveBeenCalled()
    fixture.dispose()
    fixture.selection$.next(selected())
    expect(fixture.endEditing).not.toHaveBeenCalled()
  })
})

import type { FUniver } from '@univerjs/core/facade'
import { describe, expect, it, vi } from 'vitest'
import { installLinkInputPolicy, linkUiConfig, normalizeLinkInput } from './link-input-policy.ts'

interface InputEvent { id: string, params?: unknown, cancel?: boolean }

function facade() {
  const listeners = new Set<(event: InputEvent) => void>()
  const showMessage = vi.fn()
  const api = {
    Event: { BeforeCommandExecute: 'BeforeCommandExecute' },
    showMessage,
    addEvent: (_name: string, listener: (event: InputEvent) => void) => {
      listeners.add(listener)
      return { dispose: () => listeners.delete(listener) }
    },
  } as unknown as FUniver
  return { api, showMessage, fire: (event: InputEvent) => {
    for (const listener of listeners)
      listener(event)
    return event
  } }
}

const WRITES = [
  ['sheets.command.add-hyper-link', 'link'],
  ['sheets.command.add-rich-hyper-link', 'link'],
  ['sheets.command.update-hyper-link', 'payload'],
  ['sheets.command.update-rich-hyper-link', 'payload'],
] as const

describe('明确链接输入与导航共用平台地址规则', () => {
  it.each([
    [' HTTPS://EXAMPLE.INVALID ', 'https://example.invalid/'],
    ['http://example.invalid', 'http://example.invalid/'],
    ['mailto:person@example.invalid', 'mailto:person@example.invalid'],
    ['/documents/../spaces?name=a b', '/spaces?name=a%20b'],
    ['#gid=sheet-1&range=A1:B3', '#gid=sheet-1&range=A1:B3'],
  ])('规范地址：%s', (input, expected) => {
    expect(normalizeLinkInput(input)).toBe(expected)
    expect(linkUiConfig.urlHandler.normalizeUrl(input)).toBe(expected)
  })

  it.each([undefined, null, {}, [], 1, '', 'example.invalid', 'person@example.invalid', 'javascript:void(0)', 'data:text/plain,private', '//example.invalid/', 'https://user:secret@example.invalid/', 'https://example.invalid/\nprivate', `https://example.invalid/${'a'.repeat(2048)}`])('非法输入明确拒绝：%j', (input) => {
    expect(normalizeLinkInput(input)).toBeNull()
  })

  it('点击后才打开规范地址，使用隔离参数；非法地址和内部锚点不交给外部导航', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    try {
      expect(open).not.toHaveBeenCalled()
      for (const input of ['javascript:void(0)', '//example.invalid/', '#gid=sheet-1&range=A1'])
        linkUiConfig.urlHandler.navigateToOtherWebsite(input)
      expect(open).not.toHaveBeenCalled()
      linkUiConfig.urlHandler.navigateToOtherWebsite('HTTPS://EXAMPLE.INVALID')
      linkUiConfig.urlHandler.navigateToOtherWebsite('/documents/../spaces')
      linkUiConfig.urlHandler.navigateToOtherWebsite('mailto:person@example.invalid')
      expect(open.mock.calls).toEqual([
        ['https://example.invalid/', '_blank', 'noopener,noreferrer'],
        ['/spaces', '_blank', 'noopener,noreferrer'],
        ['mailto:person@example.invalid', '_blank', 'noopener,noreferrer'],
      ])
    }
    finally {
      open.mockRestore()
    }
  })
})

describe('实际四种链接命令在改模型和撤销记录前规范化或拒绝', () => {
  it.each(WRITES)('%s 只替换地址，不改变目标、显示文字、提示和身份', (id, field) => {
    const f = facade()
    installLinkInputPolicy(f.api)
    const link = { payload: 'HTTPS://EXAMPLE.INVALID', display: '保留文字', tooltip: '保留提示', id: 'range-1' }
    const event = f.fire({ id, params: { unitId: 'wb', subUnitId: 'sheet-1', documentId: 'editor', row: 2, column: 1, [field]: link } })
    expect(event.cancel).toBeUndefined()
    expect(event.params).toEqual({ unitId: 'wb', subUnitId: 'sheet-1', documentId: 'editor', row: 2, column: 1, [field]: { ...link, payload: 'https://example.invalid/' } })
    expect(link.payload).toBe('https://example.invalid/')
    expect(f.showMessage).not.toHaveBeenCalled()
  })

  it.each(WRITES)('%s 非法地址整次取消，参数不变，只有固定提示', (id, field) => {
    const f = facade()
    installLinkInputPolicy(f.api)
    const params = { [field]: { payload: 'https://user:secret@example.invalid/', display: '原文私密' } }
    const before = structuredClone(params)
    expect(f.fire({ id, params }).cancel).toBe(true)
    expect(params).toEqual(before)
    expect(f.showMessage).toHaveBeenCalledExactlyOnceWith({ content: '链接地址不能使用，请检查后重试。' })
    expect(JSON.stringify(f.showMessage.mock.calls)).not.toMatch(/secret|example|私密/)
  })

  it.each([undefined, null, [], {}, { link: null }, { link: [] }, { link: { payload: 1 } }])('地址参数不明时取消：%j', (params) => {
    const f = facade()
    installLinkInputPolicy(f.api)
    expect(f.fire({ id: WRITES[0][0], params }).cancel).toBe(true)
  })

  it('需要规范化但不能写入的参数会取消，不让未规范地址落入 SDK', () => {
    const f = facade()
    installLinkInputPolicy(f.api)
    const params = { link: Object.freeze({ payload: 'HTTPS://EXAMPLE.INVALID' }) }
    expect(f.fire({ id: WRITES[0][0], params }).cancel).toBe(true)
    expect(params.link.payload).toBe('HTTPS://EXAMPLE.INVALID')
  })

  it('已取消、取消链接与无关命令不改写或重复提示，销毁后旧策略不再运行', () => {
    const f = facade()
    const policy = installLinkInputPolicy(f.api)
    const params = { link: { payload: 'HTTPS://EXAMPLE.INVALID' } }
    f.fire({ id: WRITES[0][0], params, cancel: true })
    for (const id of ['sheets.command.cancel-hyper-link', 'sheets.command.cancel-rich-hyper-link', 'sheet.command.set-range-values'])
      expect(f.fire({ id, params }).cancel).toBeUndefined()
    expect(params.link.payload).toBe('HTTPS://EXAMPLE.INVALID')
    expect(f.showMessage).not.toHaveBeenCalled()
    policy.dispose()
    f.fire({ id: WRITES[0][0], params })
    expect(params.link.payload).toBe('HTTPS://EXAMPLE.INVALID')
  })
})

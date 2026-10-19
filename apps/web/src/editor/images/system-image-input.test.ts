import type { ImageInputCommands, SelectedInputImage } from '../internal-api/ui.ts'
import type { ImageInputState, SystemImageInputOptions } from './system-image-input.ts'
import { File as NodeFile } from 'node:buffer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { deferred } from '../async-tools.ts'
import { writeSystemImage } from './image-clipboard.ts'
import { readClipboardInput } from './image-input-data.ts'
import { SOURCE } from './image-resources.test-support.ts'
import { installSystemImageInput } from './system-image-input.ts'

vi.mock('./image-clipboard.ts', async importOriginal => ({
  ...await importOriginal<typeof import('./image-clipboard.ts')>(),
  writeSystemImage: vi.fn(),
}))
vi.mock('./image-input-data.ts', async importOriginal => ({
  ...await importOriginal<typeof import('./image-input-data.ts')>(),
  readClipboardInput: vi.fn(),
}))

const cleanups: (() => void)[] = []
const uploaded = { assetId: '11111111-1111-4111-8111-111111111111', url: SOURCE, width: 120, height: 80, bytes: 1, mimeType: 'image/png' as const }
const selected: SelectedInputImage = { drawingId: 'selected', kind: 'float', source: SOURCE }

function setup() {
  const container = document.createElement('div')
  document.body.append(container)
  let current = true
  let handlers: ImageInputCommands | undefined
  const listeners = new Set<() => void>()
  const target = { unitId: 'book', subUnitId: 'sheet', row: 3, column: 2, isCurrent: () => current, subscribe: (listener: () => void) => {
    listeners.add(listener)
    return () => listeners.delete(listener)
  } }
  const bridge: SystemImageInputOptions['bridge'] = {
    capture: vi.fn(() => current ? target : undefined),
    canWriteImage: vi.fn(() => current),
    insertImage: vi.fn(() => current),
    removeImage: vi.fn(() => current),
    pasteTable: vi.fn(async () => current),
    pasteTableEvent: vi.fn(async () => current),
    gridFocused: vi.fn(() => current),
    installCommands: (value) => {
      handlers = value
      return { dispose: () => {
        handlers = undefined
      } }
    },
  }
  const io = { upload: vi.fn<SystemImageInputOptions['io']['upload']>(async () => uploaded), read: vi.fn<SystemImageInputOptions['io']['read']>() }
  const states: ImageInputState[] = []
  const failed = vi.fn()
  const input = installSystemImageInput({ container, bridge, io, changed: state => states.push(state), failed })
  cleanups.push(() => {
    input.dispose()
    container.remove()
  })
  const invalidate = () => {
    current = false
    for (const listener of listeners)
      listener()
  }
  return { container, target, bridge, io, states, failed, input, listeners, invalidate, rejected: (...args: Parameters<ImageInputCommands['rejected']>) => handlers!.rejected(...args), copy: async (cut = false) => handlers!.copy(target, selected, cut), paste: async () => handlers!.paste(target), insert: async (kind: 'float' | 'cell', files?: readonly File[]) => handlers!.insert(kind, files) }
}

function file(name = 'controlled.png', type = 'image/png', size = 1): File {
  return new File([new Uint8Array(size)], name, { type })
}

beforeEach(() => {
  vi.stubGlobal('File', NodeFile)
  vi.mocked(writeSystemImage).mockReset().mockResolvedValue()
  vi.mocked(readClipboardInput).mockReset().mockResolvedValue({ files: [file()] })
})

afterEach(() => {
  for (const cleanup of cleanups.splice(0))
    cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('系统图片操作调度与最终提交', () => {
  it('复制命令同步调用 write；成功后结束任务，不删除图片', async () => {
    const h = setup()
    const pending = deferred<void>()
    vi.mocked(writeSystemImage).mockReturnValueOnce(pending.promise)
    const result = h.copy()
    expect(writeSystemImage).toHaveBeenCalledOnce()
    expect(h.states.at(-1)?.kind).toBe('busy')
    pending.resolve()
    expect(await result).toBe(true)
    expect(h.bridge.removeImage).not.toHaveBeenCalled()
    expect(h.states.at(-1)).toEqual({ kind: 'complete', operation: 'copy', completed: 1, total: 1 })
    expect(h.listeners.size).toBe(0)
  })

  it('剪切等 write 成功后才删除，删除前已解绑目标监听，不把自身删除误报取消', async () => {
    const h = setup()
    const pending = deferred<void>()
    vi.mocked(writeSystemImage).mockReturnValueOnce(pending.promise)
    vi.mocked(h.bridge.removeImage).mockImplementation(() => {
      expect(h.listeners.size).toBe(0)
      h.invalidate()
      return true
    })
    const result = h.copy(true)
    expect(h.bridge.removeImage).not.toHaveBeenCalled()
    pending.resolve()
    expect(await result).toBe(true)
    expect(h.bridge.removeImage).toHaveBeenCalledExactlyOnceWith(h.target, selected)
    expect(h.states.at(-1)?.kind).toBe('complete')
  })

  it.each(['reject', 'invalidate', 'cancel', 'dispose'] as const)('%s 时零删除，迟到 write 不能删除新目标', async (stop) => {
    const h = setup()
    const pending = deferred<void>()
    vi.mocked(writeSystemImage).mockReturnValueOnce(pending.promise)
    const result = h.copy(true)
    if (stop === 'reject')
      pending.reject(new DOMException('hidden detail', 'NotAllowedError'))
    else if (stop === 'invalidate')
      h.invalidate()
    else if (stop === 'cancel')
      h.input.cancel()
    else
      h.input.dispose()
    expect(await result).toBe(false)
    pending.resolve()
    await Promise.resolve()
    expect(h.bridge.removeImage).not.toHaveBeenCalled()
    expect(h.listeners.size).toBe(0)
    expect(JSON.stringify(h.states)).not.toContain('hidden detail')
  })

  it('整批元信息先检查，一个不合格则一个都不读不上传；忙碌时不会创建第二批', async () => {
    const h = setup()
    const valid = file()
    const bytes = vi.spyOn(valid, 'arrayBuffer')
    expect(await h.input.insertFiles([valid, file('wrong.svg', 'image/svg+xml')])).toBe(false)
    expect(h.io.upload).not.toHaveBeenCalled()
    expect(bytes).not.toHaveBeenCalled()
    const pending = deferred<typeof uploaded>()
    h.io.upload.mockReturnValueOnce(pending.promise)
    const first = h.input.insertFiles([valid])
    expect(await h.input.insertFiles([valid])).toBe(false)
    expect(h.io.upload).toHaveBeenCalledOnce()
    pending.resolve(uploaded)
    expect(await first).toBe(true)
  })

  it('批次串行上传后经桥接插入；第二张失败明确保留第一张进度，不重试不泄漏文件名', async () => {
    const h = setup()
    const first = deferred<typeof uploaded>()
    h.io.upload.mockReturnValueOnce(first.promise).mockRejectedValueOnce(new Error('secret.jpg'))
    const result = h.input.insertFiles([file('secret.png'), file('secret.jpg', 'image/jpeg')])
    expect(h.io.upload).toHaveBeenCalledOnce()
    expect(h.bridge.insertImage).not.toHaveBeenCalled()
    first.resolve(uploaded)
    expect(await result).toBe(false)
    expect(h.bridge.insertImage).toHaveBeenCalledExactlyOnceWith(h.target, { source: SOURCE, width: 120, height: 80 }, 'float')
    expect(h.states.at(-1)).toMatchObject({ kind: 'failed', completed: 1, total: 2 })
    expect(JSON.stringify(h.states)).not.toContain('secret')
  })

  it('上传中更换目标立即取消，迟到结果不插入任何位置', async () => {
    const h = setup()
    const pending = deferred<typeof uploaded>()
    h.io.upload.mockReturnValueOnce(pending.promise)
    const result = h.input.insertFiles([file()])
    h.invalidate()
    expect(await result).toBe(false)
    expect(h.io.upload.mock.calls[0]?.[1].aborted).toBe(true)
    pending.resolve(uploaded)
    await Promise.resolve()
    expect(h.bridge.insertImage).not.toHaveBeenCalled()
  })

  it('右键粘贴同步读取；带图片预览的表格只委托原内容，零上传', async () => {
    const h = setup()
    const data = { html: '<table><tr><td>42</td></tr></table>', text: '42', formulaClipboardPayload: 'formula', files: [file()] }
    vi.mocked(readClipboardInput).mockResolvedValueOnce(data)
    const result = h.paste()
    expect(readClipboardInput).toHaveBeenCalledOnce()
    expect(await result).toBe(true)
    expect(h.bridge.pasteTable).toHaveBeenCalledExactlyOnceWith(h.target, { html: data.html, text: data.text, formulaClipboardPayload: data.formulaClipboardPayload })
    expect(h.io.upload).not.toHaveBeenCalled()
  })

  it('没有写入权限时不读文件；多张单元格图片不能互相覆盖', async () => {
    const h = setup()
    vi.mocked(h.bridge.canWriteImage).mockReturnValueOnce(false)
    expect(await h.input.insertFiles([file()])).toBe(false)
    expect(await h.input.insertFiles([file(), file()], 'cell')).toBe(false)
    expect(h.io.upload).not.toHaveBeenCalled()
  })

  it('取消后立即重试，旧任务的迟到收尾不能覆盖新任务的忙碌状态', async () => {
    const h = setup()
    const first = deferred<void>()
    const second = deferred<void>()
    vi.mocked(writeSystemImage).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const old = h.copy()
    h.input.cancel()
    const next = h.copy()
    expect(await old).toBe(false)
    expect(h.states.at(-1)?.kind).toBe('busy')
    first.resolve()
    second.resolve()
    expect(await next).toBe(true)
  })

  it('空文件选择不会被当作普通表格粘贴', async () => {
    const h = setup()
    expect(await h.input.insertFiles([])).toBe(false)
    expect(h.bridge.pasteTable).not.toHaveBeenCalled()
    expect(h.states.at(-1)).toMatchObject({ kind: 'failed', reason: 'empty' })
  })

  it('取消后新的操作即使因无目标而被拒绝，旧任务收尾也不能覆盖这个最新原因', async () => {
    const h = setup()
    const pending = deferred<void>()
    vi.mocked(writeSystemImage).mockReturnValueOnce(pending.promise)
    const old = h.copy()
    h.input.cancel()
    vi.mocked(h.bridge.capture).mockReturnValue(undefined)
    expect(await h.input.insertFiles([file()])).toBe(false)
    expect(await old).toBe(false)
    expect(h.states.at(-1)).toMatchObject({ kind: 'failed', operation: 'insert', reason: 'permission' })
    pending.resolve()
  })
})

function transferEvent(type: 'paste' | 'dragover' | 'drop', files: readonly File[], values: Record<string, string> = {}, types: readonly string[] = ['Files']): Event {
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(event, type === 'paste' ? 'clipboardData' : 'dataTransfer', { value: {
    files,
    types,
    getData: (format: string) => values[format] ?? '',
  } })
  return event
}

describe('编辑器范围内的同步事件与文件对话框', () => {
  it('系统拒绝剪贴板权限时说明浏览器授权，不误报为编辑权限失效', async () => {
    const h = setup()
    vi.mocked(readClipboardInput).mockRejectedValueOnce(new DOMException('denied', 'NotAllowedError'))
    expect(await h.paste()).toBe(false)
    expect(h.states.at(-1)).toMatchObject({ kind: 'failed', operation: 'paste', reason: 'clipboard-permission' })
  })

  it('paste 同步阻止旧 SDK，使用本次事件，不额外读取系统剪贴板', async () => {
    const h = setup()
    const event = transferEvent('paste', [file()])
    const old = vi.fn()
    h.container.addEventListener('paste', old)
    h.container.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
    expect(old).not.toHaveBeenCalled()
    expect(readClipboardInput).not.toHaveBeenCalled()
    expect(h.bridge.pasteTableEvent).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(h.states.at(-1)?.kind).toBe('complete'))
    expect(h.io.upload).toHaveBeenCalledOnce()
  })

  it('文字输入焦点不接管 paste；编辑器外的 paste/drop/dragover 也不接管', () => {
    const h = setup()
    vi.mocked(h.bridge.gridFocused).mockReturnValue(false)
    const paste = transferEvent('paste', [file()])
    h.container.dispatchEvent(paste)
    expect(paste.defaultPrevented).toBe(false)
    for (const type of ['paste', 'drop', 'dragover'] as const) {
      const event = transferEvent(type, [file()])
      document.body.dispatchEvent(event)
      expect(event.defaultPrevented).toBe(false)
    }
    expect(h.io.upload).not.toHaveBeenCalled()
  })

  it('编辑器内文件 dragover/drop 在拒绝路径也同步阻止导航，纯文字拖放保留原行为', async () => {
    const h = setup()
    vi.mocked(h.bridge.capture).mockReturnValue(undefined)
    const drag = transferEvent('dragover', [])
    h.container.dispatchEvent(drag)
    expect(drag.defaultPrevented).toBe(true)
    const drop = transferEvent('drop', [file()])
    h.container.dispatchEvent(drop)
    expect(drop.defaultPrevented).toBe(true)
    const text = transferEvent('drop', [], { 'text/plain': 'ordinary' }, ['text/plain'])
    h.container.dispatchEvent(text)
    expect(text.defaultPrevented).toBe(false)
    await vi.waitFor(() => expect(h.states.at(-1)).toMatchObject({ kind: 'failed', reason: 'permission' }))
    expect(h.io.upload).not.toHaveBeenCalled()
  })

  it('事件带表格 HTML 和预览文件时委托表格，不上传预览', async () => {
    const h = setup()
    vi.mocked(h.bridge.capture).mockReturnValue(undefined)
    vi.mocked(h.bridge.canWriteImage).mockReturnValue(false)
    const event = transferEvent('paste', [file()], { 'text/html': '<table><tr><td>42</td></tr></table>', 'text/plain': '42' })
    h.container.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
    expect(h.bridge.pasteTableEvent).toHaveBeenCalledExactlyOnceWith({ html: '<table><tr><td>42</td></tr></table>', text: '42', formulaClipboardPayload: '' })
    await vi.waitFor(() => expect(h.states.at(-1)?.kind).toBe('complete'))
    expect(h.io.upload).not.toHaveBeenCalled()
    expect(h.bridge.capture).not.toHaveBeenCalled()
    expect(h.bridge.pasteTable).not.toHaveBeenCalled()
    expect(h.io.read).not.toHaveBeenCalled()
  })

  it('同步表格委托的 SDK 权限拒绝不叠加图片失败，异常仍被消费并报告', async () => {
    const h = setup()
    vi.mocked(h.bridge.pasteTableEvent).mockResolvedValueOnce(false)
    const event = () => transferEvent('paste', [file()], { 'text/html': '<table><tr><td>42</td></tr></table>' })
    h.container.dispatchEvent(event())
    await Promise.resolve()
    expect(h.states).toEqual([])
    const error = new Error('controlled SDK failure')
    vi.mocked(h.bridge.pasteTableEvent).mockRejectedValueOnce(error)
    h.container.dispatchEvent(event())
    await vi.waitFor(() => expect(h.failed).toHaveBeenCalledExactlyOnceWith(error))
    expect(h.states.at(-1)).toMatchObject({ kind: 'failed', reason: 'request' })
    expect(h.io.read).not.toHaveBeenCalled()
    expect(h.io.upload).not.toHaveBeenCalled()
  })

  it('菜单插图预检查拒绝保留插入语义，右键拒绝仍为粘贴', () => {
    const h = setup()
    h.rejected('permission', 'insert', 'insert')
    expect(h.states.at(-1)).toMatchObject({ kind: 'failed', operation: 'insert', reason: 'permission' })
    h.rejected('permission', 'insert')
    expect(h.states.at(-1)).toMatchObject({ kind: 'failed', operation: 'paste', reason: 'permission' })
  })

  it.each(['<table><tr><td>42</td></tr></table>', '<b>42</b>', ''])('零文件普通粘贴保留原事件及 SDK 公式读取路径：%s', (html) => {
    const h = setup()
    const event = transferEvent('paste', [], { 'text/html': html, 'text/plain': '42' }, ['text/html', 'text/plain'])
    const original = vi.fn()
    h.container.addEventListener('paste', original)
    h.container.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(false)
    expect(original).toHaveBeenCalledExactlyOnceWith(event)
    expect(h.bridge.capture).not.toHaveBeenCalled()
    expect(h.bridge.pasteTable).not.toHaveBeenCalled()
    expect(h.io.upload).not.toHaveBeenCalled()
    expect(readClipboardInput).not.toHaveBeenCalled()
  })

  it('正式命令同步打开同一文件框，取消不上传；直接 files 走同一输入任务', async () => {
    const h = setup()
    const click = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => {})
    const selecting = h.insert('float')
    expect(click).toHaveBeenCalledOnce()
    h.input.cancel()
    expect(await selecting).toBe(false)
    expect(h.io.upload).not.toHaveBeenCalled()
    expect(h.container.querySelector('input[type=file]')).toBeNull()
    expect(await h.insert('cell', [file()])).toBe(true)
    expect(h.bridge.insertImage).toHaveBeenCalledExactlyOnceWith(h.target, { source: SOURCE, width: 120, height: 80 }, 'cell')
    expect(click).toHaveBeenCalledOnce()
  })

  it('打开文件框前固定目标；accept 四格式，取消会移除临时元素和监听', async () => {
    const h = setup()
    const click = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => {})
    const result = h.input.chooseFiles('float')
    const picker = h.container.querySelector('input[type=file]')
    expect(picker).toBeInstanceOf(HTMLInputElement)
    expect(picker).toHaveProperty('accept', '.png,.jpg,.jpeg,.webp,.gif')
    expect(picker).toHaveProperty('multiple', true)
    expect(click).toHaveBeenCalledOnce()
    h.invalidate()
    expect(await result).toBe(false)
    expect(h.container.querySelector('input[type=file]')).toBeNull()
    expect(h.io.upload).not.toHaveBeenCalled()
    expect(h.listeners.size).toBe(0)
  })

  it('文件框 change 经同一个单元格插入流程，成功后清理文件元素', async () => {
    const h = setup()
    vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => {})
    const result = h.input.chooseFiles('cell')
    const picker = h.container.querySelector('input[type=file]')
    expect(picker).toHaveProperty('multiple', false)
    Object.defineProperty(picker, 'files', { value: [file()] })
    picker?.dispatchEvent(new Event('change'))
    expect(await result).toBe(true)
    expect(h.bridge.insertImage).toHaveBeenCalledWith(h.target, { source: SOURCE, width: 120, height: 80 }, 'cell')
    expect(h.container.querySelector('input[type=file]')).toBeNull()
  })

  it('销毁移除事件；重复销毁不会误移除其他实例', () => {
    const h = setup()
    h.input.dispose()
    h.input.dispose()
    const event = transferEvent('paste', [file()])
    h.container.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(false)
    expect(h.io.upload).not.toHaveBeenCalled()
  })
})

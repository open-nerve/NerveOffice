import { Blob as NodeBlob, File as NodeFile } from 'node:buffer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { deferred } from '../async-tools.ts'
import { FORMULA_CLIPBOARD_MIME_TYPE } from '../internal-api/ui.ts'
import { clipboardEventInput, readClipboardInput } from './image-input-data.ts'
import { classifyImageInput, IMAGE_INPUT_HTML_LIMIT } from './image-input-policy.ts'

const read = vi.fn<() => Promise<ClipboardItem[]>>()
function item(data: Record<string, Blob>): Omit<ClipboardItem, 'getType'> & { readonly getType: ReturnType<typeof vi.fn<(type: string) => Promise<Blob>>> } {
  return {
    types: Object.keys(data),
    presentationStyle: 'unspecified',
    getType: vi.fn(async (type: string) => {
      const value = data[type]
      if (value === undefined)
        throw new Error('missing test clipboard type')
      return value
    }),
  }
}

beforeEach(() => {
  vi.stubGlobal('Blob', NodeBlob)
  vi.stubGlobal('File', NodeFile)
  vi.stubGlobal('navigator', { clipboard: { read } })
  read.mockReset().mockResolvedValue([])
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('只读取本次事件或显式用户动作的剪贴板', () => {
  it('按键事件保留 HTML、文字、自定义公式和 File，不访问异步系统 read', () => {
    const file = new File([new Uint8Array([1])], 'controlled.png', { type: 'image/png' })
    const values: Record<string, string> = { 'text/html': '<b>42</b>', 'text/plain': '42', [FORMULA_CLIPBOARD_MIME_TYPE]: 'formula' }
    const data = new Proxy({}, { get: (_target, key) => {
      if (key === 'files')
        return [file]
      if (key === 'getData')
        return (type: string) => values[type] ?? ''
      throw new Error(`未声明的事件读取：${String(key)}`)
    } }) as DataTransfer
    expect(clipboardEventInput(data)).toEqual({ html: '<b>42</b>', text: '42', formulaClipboardPayload: 'formula', files: [file] })
    expect(read).not.toHaveBeenCalled()
  })

  it('右键在同步阶段 read；表格 HTML、预览 PNG 与公式都保持，分类最终委托表格', async () => {
    const pending = deferred<ClipboardItem[]>()
    read.mockReturnValueOnce(pending.promise)
    const result = readClipboardInput(new AbortController().signal).catch((error: unknown) => error)
    expect(read).toHaveBeenCalledOnce()
    pending.resolve([item({
      'text/html': new Blob(['<table><tr><td>42<img src="data:image/png;base64,AQ=="></td></tr></table>'], { type: 'text/html' }),
      'text/plain': new Blob(['42'], { type: 'text/plain' }),
      [FORMULA_CLIPBOARD_MIME_TYPE]: new Blob(['formula'], { type: FORMULA_CLIPBOARD_MIME_TYPE }),
      'image/png': new Blob([new Uint8Array([1])], { type: 'image/png' }),
    })])
    const data = await result
    expect(data).toMatchObject({ text: '42', formulaClipboardPayload: 'formula' })
    expect(classifyImageInput(await readClipboardInputFrom(data))).toEqual({ kind: 'delegate' })
  })

  it.each([['image/png', 'png'], ['image/jpeg', 'jpg'], ['image/webp', 'webp'], ['image/gif', 'gif']] as const)('%s 使用自有文件名和对应后缀，保留原 Blob 字节', async (type, extension) => {
    read.mockResolvedValueOnce([item({ [type]: new Blob([new Uint8Array([1, 2])], { type }) })])
    const data = await readClipboardInput(new AbortController().signal)
    expect(data.files[0]?.name).toBe(`clipboard.${extension}`)
    expect(data.files[0]?.type).toBe(type)
    expect(new Uint8Array(await data.files[0]!.arrayBuffer())).toEqual(new Uint8Array([1, 2]))
    expect(classifyImageInput(data).kind).toBe('images')
  })

  it('同一 item 的 PNG/JPEG 是同一张图片的候选格式，不当成两张图', async () => {
    const clip = item({ 'image/png': new Blob(['png'], { type: 'image/png' }), 'image/jpeg': new Blob(['jpeg'], { type: 'image/jpeg' }) })
    read.mockResolvedValueOnce([clip])
    const data = await readClipboardInput(new AbortController().signal)
    expect(data.files).toHaveLength(1)
    expect(clip.getType).toHaveBeenCalledExactlyOnceWith('image/png')
  })

  it.each(['table', 'oversize'] as const)('%s HTML 明确委托时不读取可能失败的预览 Blob', async (kind) => {
    const html = kind === 'table' ? '<table><tr><td>42</td></tr></table>' : 'x'.repeat(IMAGE_INPUT_HTML_LIMIT + 1)
    const preview = item({ 'image/png': new Blob(['preview'], { type: 'image/png' }) })
    preview.getType.mockRejectedValue(new Error('不可读取的预览'))
    // 预览可以早于表格出现在 item 数组中；先确定正文，不能按数组先读图。
    read.mockResolvedValueOnce([preview, item({ 'text/html': new Blob([html], { type: 'text/html' }) })])
    await expect(readClipboardInput(new AbortController().signal)).resolves.toMatchObject({ html, files: [] })
    expect(preview.getType).not.toHaveBeenCalled()
  })

  it('可选公式表示读取失败沿用 SDK 回退，仍保留可用表格正文', async () => {
    const html = '<table><tr><td>42</td></tr></table>'
    const clip = item({ 'text/html': new Blob([html]), [FORMULA_CLIPBOARD_MIME_TYPE]: new Blob(['formula']) })
    clip.getType.mockImplementation(async (type) => {
      if (type === FORMULA_CLIPBOARD_MIME_TYPE)
        throw new DOMException('optional representation unavailable', 'NotAllowedError')
      return new Blob([html])
    })
    read.mockResolvedValueOnce([clip])
    await expect(readClipboardInput(new AbortController().signal)).resolves.toMatchObject({ html, files: [] })
  })

  it('等待可选公式 getType 时取消仍及时结束，不能吞掉取消并继续读取图片', async () => {
    const pending = deferred<Blob>()
    const clip = item({ [FORMULA_CLIPBOARD_MIME_TYPE]: new Blob(['formula']), 'image/png': new Blob(['preview']) })
    clip.getType.mockReturnValue(pending.promise)
    read.mockResolvedValueOnce([clip])
    const controller = new AbortController()
    const result = readClipboardInput(controller.signal).catch((error: unknown) => error)
    await vi.waitFor(() => expect(clip.getType).toHaveBeenCalledExactlyOnceWith(FORMULA_CLIPBOARD_MIME_TYPE))
    controller.abort()
    expect(await result).toMatchObject({ name: 'AbortError' })
    pending.resolve(new Blob(['late']))
    await Promise.resolve()
    expect(clip.getType).toHaveBeenCalledOnce()
  })

  it('只含空值时有明确失败；权限拒绝后再次尝试可以读取', async () => {
    await expect(readClipboardInput(new AbortController().signal)).rejects.toMatchObject({ reason: 'empty' })
    const denied = new DOMException('denied', 'NotAllowedError')
    read.mockRejectedValueOnce(denied)
    await expect(readClipboardInput(new AbortController().signal)).rejects.toBe(denied)
    read.mockResolvedValueOnce([item({ 'text/plain': new Blob(['retry'], { type: 'text/plain' }) })])
    expect(await readClipboardInput(new AbortController().signal)).toMatchObject({ text: 'retry', files: [] })
  })

  it('异步 read/getType 等待中取消会及时结束，迟到值不再读；预取消不调用 read', async () => {
    const pending = deferred<ClipboardItem[]>()
    read.mockReturnValueOnce(pending.promise)
    const controller = new AbortController()
    const result = readClipboardInput(controller.signal).catch((error: unknown) => error)
    controller.abort()
    expect(await result).toMatchObject({ name: 'AbortError' })
    const clip = item({ 'text/plain': new Blob(['late']) })
    pending.resolve([clip])
    await Promise.resolve()
    expect(clip.getType).not.toHaveBeenCalled()
    read.mockClear()
    await expect(readClipboardInput(controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(read).not.toHaveBeenCalled()
  })
})

// 先明确成功结构再交给纯分类器，测试不把 unknown 直接当成已读取的数据。
async function readClipboardInputFrom(value: unknown) {
  if (typeof value !== 'object' || value === null || !('files' in value) || !Array.isArray(value.files))
    throw new Error('剪贴板读取应成功')
  return value as Awaited<ReturnType<typeof readClipboardInput>>
}

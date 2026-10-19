import type { IImageIoServiceParam } from '@univerjs/core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { deferred } from '../async-tools.ts'
import { sdkInsertHarness, UPLOADED } from './sdk-image-insert.test-support.ts'
import { SOURCE } from './sdk-image-render.test-support.ts'

const cleanup: (() => void)[] = []
function setup() {
  const h = sdkInsertHarness()
  cleanup.push(h.dispose)
  return h
}
afterEach(() => {
  for (const finish of cleanup.splice(0))
    finish()
  vi.restoreAllMocks()
})
const file = new File(['png'], 'test.png', { type: 'image/png' })

describe('SDK 文件插入的量尺寸经过图片服务', () => {
  it.each(['float', 'cell'] as const)('%s：不直接读取 base64Cache 中的规范地址', async (kind) => {
    const h = setup()
    if (kind === 'float')
      await h.controller.insertFloatImageByFile(file)
    else
      await h.controller.insertCellImageByFile(file)
    expect(h.attempts).not.toContain(SOURCE)
    expect(h.attempts).toContain('blob:https://app.test/resolved')
    expect(h.registered.get(SOURCE)?.src).toBe('blob:https://app.test/resolved')
    expect(UPLOADED.source).toBe(SOURCE)
    expect(UPLOADED.base64Cache).toBe(SOURCE)
  })

  it('URL 读取取消后不退回原地址量尺寸，也不留下未处理拒绝', async () => {
    const h = setup()
    h.getImage.mockRejectedValue(new DOMException('retired', 'AbortError'))
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(await h.controller.insertCellImageByUrl(SOURCE)).toBe(false)
    expect(h.attempts).not.toContain(SOURCE)
    expect(errors).not.toHaveBeenCalled()
  })

  it.each(['float', 'cell'] as const)('%s：上传期间销毁控制器，迟到结果不进入量尺寸或写入', async (kind) => {
    const h = setup()
    const pending = deferred<IImageIoServiceParam | null>()
    h.saveImage.mockReturnValue(pending.promise)
    const result = kind === 'float' ? h.controller.insertFloatImageByFile(file) : h.controller.insertCellImageByFile(file)
    h.controller.dispose()
    pending.resolve(UPLOADED)
    await result
    expect(h.attempts).toHaveLength(0)
    expect(h.registered.size).toBe(0)
  })

  it.each(['float', 'cell'] as const)('%s：上传期间切换工作表，不把迟到结果带到新工作表', async (kind) => {
    const h = setup()
    const pending = deferred<IImageIoServiceParam | null>()
    h.saveImage.mockReturnValue(pending.promise)
    const result = kind === 'float' ? h.controller.insertFloatImageByFile(file) : h.controller.insertCellImageByFile(file)
    const second = h.workbook.getSheetBySheetId('two')
    if (!second)
      throw new Error('缺少第二张测试工作表')
    h.workbook.setActiveSheet(second)
    pending.resolve(UPLOADED)
    await result
    expect(h.attempts).toHaveLength(0)
    expect(h.registered.size).toBe(0)
  })
})

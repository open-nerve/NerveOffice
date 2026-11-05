import { PREDEFINED_HOOK_NAME_PASTE, SheetClipboardService } from '@univerjs/sheets-ui'
import { describe, expect, it, vi } from 'vitest'

type PasteFiles = (files: File[], pasteType: string, target?: unknown) => Promise<boolean>

/** 直接调用已安装 sheets-ui 的 _pasteFiles（补丁所在）：其余依赖只给它会用到的两项 */
function harness() {
  const rejected = vi.fn()
  const executePaste = vi.fn(async () => true)
  const self = { _clipboardHooks: [{ id: 'platform', onPasteFilesRejected: rejected }, { id: 'other' }], _executePaste: executePaste }
  const pasteFiles = (SheetClipboardService.prototype as unknown as { _pasteFiles: PasteFiles })._pasteFiles
  const file = new File([new Uint8Array([1, 2, 3])], 'clipboard-image.png', { type: 'image/png' })
  return { rejected, executePaste, run: async (pasteType: string) => Reflect.apply(pasteFiles, self, [[file], pasteType, undefined]) }
}

describe('M5R-M-12 选择性粘贴遇到纯图片剪贴板（sheets-ui 补丁，D-08a）', () => {
  it.each([
    PREDEFINED_HOOK_NAME_PASTE.SPECIAL_PASTE_VALUE,
    PREDEFINED_HOOK_NAME_PASTE.SPECIAL_PASTE_FORMAT,
    PREDEFINED_HOOK_NAME_PASTE.SPECIAL_PASTE_COL_WIDTH,
    PREDEFINED_HOOK_NAME_PASTE.SPECIAL_PASTE_BESIDES_BORDER,
    PREDEFINED_HOOK_NAME_PASTE.SPECIAL_PASTE_FORMULA,
  ])('%s：不执行粘贴、不生成撤销记录，经钩子交给平台说明', async (pasteType) => {
    const h = harness()
    expect(await h.run(pasteType)).toBe(false)
    expect(h.executePaste).not.toHaveBeenCalled()
    expect(h.rejected).toHaveBeenCalledExactlyOnceWith({ pasteType })
  })

  it('普通粘贴照常交给各钩子生成修改', async () => {
    const h = harness()
    expect(await h.run(PREDEFINED_HOOK_NAME_PASTE.DEFAULT_PASTE)).toBe(true)
    expect(h.executePaste).toHaveBeenCalledOnce()
    expect(h.rejected).not.toHaveBeenCalled()
  })
})

import { describe, expect, it } from 'vitest'
import { imageInputNotice } from './image-input-notice.ts'

describe('图片操作状态的可见说明', () => {
  it.each([
    ['write-source', '操作未完成。涉及的图片不是本平台上传的图片；旧版图片请先按提示确认清理。'],
    ['write-limit', '操作未完成。涉及的图片内容过大或层级过深。'],
    ['write-structure', '操作未完成。内容格式不受支持。'],
    ['write-unsupported', '操作未完成。暂不支持这类图片操作。'],
  ] as const)('写入策略拒绝 %s 显示为编辑操作未完成及有界原因，不提图片加载（M5R-M-10）', (reason, text) => {
    const notice = imageInputNotice({ kind: 'failed', operation: 'edit', reason, completed: 0, total: 0 })
    expect(notice).toBe(text)
    expect(notice).not.toMatch(/显示|重新加载/)
  })

  it('原有输入操作的说明不变，插入进度只在插入与粘贴时出现', () => {
    expect(imageInputNotice({ kind: 'failed', operation: 'paste', reason: 'empty', completed: 0, total: 0 })).toBe('粘贴未完成。没有可粘贴的内容。')
    expect(imageInputNotice({ kind: 'complete', operation: 'insert', completed: 2, total: 2 })).toBe('插入图片已完成。已插入 2/2 张图片。')
    expect(imageInputNotice({ kind: 'failed', operation: 'edit', reason: 'write-limit', completed: 3, total: 5 })).toBe('操作未完成。涉及的图片内容过大或层级过深。')
  })
})

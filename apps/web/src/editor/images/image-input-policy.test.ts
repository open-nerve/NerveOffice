import { ASSET_MAX_BYTES } from '@nerve-office/contracts'
import { describe, expect, it, vi } from 'vitest'
import { classifyImageInput, IMAGE_INPUT_ACCEPT, IMAGE_INPUT_FILE_LIMIT, IMAGE_INPUT_HTML_LIMIT, imageFileInput, ImageFileInputError } from './image-input-policy.ts'

function file(name = 'sample.png', type = 'image/png', size = 1): File {
  const input = new File([new Uint8Array([1])], name, { type })
  Object.defineProperty(input, 'size', { value: size })
  return input
}

describe('图片输入的文件元信息', () => {
  it.each([
    ['png', 'image/png'],
    ['jpg', 'image/jpeg'],
    ['JPEG', 'image/jpeg'],
    ['webp', 'image/webp'],
    ['gif', 'image/gif'],
  ] as const)('%s 与 MIME 匹配，保留既有后缀规范', (extension, mimeType) => {
    const input = file(`source.${extension}`, mimeType)
    expect(imageFileInput(input)).toEqual({ extension: extension.toLowerCase(), mimeType })
  })

  it.each([1, ASSET_MAX_BYTES])('允许 %s 字节边界，校验不读取文件', (size) => {
    const input = file('source.png', 'image/png', size)
    const read = vi.fn(() => {
      throw new Error('元信息阶段不得读字节')
    })
    Object.defineProperty(input, 'arrayBuffer', { value: read })
    expect(imageFileInput(input)).toEqual({ extension: 'png', mimeType: 'image/png' })
    expect(read).not.toHaveBeenCalled()
  })

  it.each([
    ['empty.png', 'image/png', 0, 'size'],
    ['large.png', 'image/png', ASSET_MAX_BYTES + 1, 'size'],
    ['mismatch.png', 'image/jpeg', 1, 'type'],
    ['unknown', 'image/png', 1, 'type'],
    ['sample.bmp', 'image/bmp', 1, 'type'],
    ['sample.svg', 'image/svg+xml', 1, 'type'],
    ['empty-type.png', '', 1, 'type'],
  ] as const)('%s 在读文件之前拒绝，错误不包含原文件名', (name, type, size, reason) => {
    try {
      imageFileInput(file(name, type, size))
      expect.fail('应拒绝文件')
    }
    catch (error) {
      expect(error).toBeInstanceOf(ImageFileInputError)
      expect(error).toMatchObject({ reason })
      expect(String(error)).not.toContain(name)
    }
  })

  it('文件对话框只列四格式，单次上限与当前产品约定一致', () => {
    expect(IMAGE_INPUT_ACCEPT).toBe('.png,.jpg,.jpeg,.webp,.gif')
    expect(IMAGE_INPUT_FILE_LIMIT).toBe(10)
  })
})

describe('表格、图片与文字的输入优先级', () => {
  it.each([
    '<table><tr><td>Excel 单元格</td></tr></table>',
    '<TABLE><TR><TH>标题</TH><TD>42</TD></TR></TABLE>',
    '<table><tr><td></td></tr></table>',
    '<table><tr><td><img src="https://outside.invalid/preview"></td></tr></table>',
  ])('真实表格结构优先，附带预览图不走上传：%s', (html) => {
    expect(classifyImageInput({ html, text: '原文字', files: [file()] })).toEqual({ kind: 'delegate' })
  })

  it('表格优先于不支持、过大或过多的预览文件，表格内容不被图片限制取消', () => {
    const files = Array.from({ length: 11 }, () => file('preview.bmp', 'image/bmp', ASSET_MAX_BYTES + 1))
    expect(classifyImageInput({ html: '<table><tr><td>42</td></tr></table>', files })).toEqual({ kind: 'delegate' })
  })

  it.each([
    '',
    '<img src="https://outside.invalid/image.png">',
    '<a href="https://outside.invalid"><img src="https://outside.invalid/image.png"></a>',
    '<!-- <table><tr><td>假表格</td></tr></table> --><img src="https://outside.invalid/image.png">',
    '&lt;table&gt;&lt;tr&gt;&lt;td&gt;不是表格&lt;/td&gt;&lt;/tr&gt;&lt;/table&gt;',
    '<script>"<table><tr><td>not markup</td></tr></table>"</script>',
  ])('图片文件优先于网页图片包装或伪表格：%s', (html) => {
    const files = [file()]
    expect(classifyImageInput({ html, text: 'https://outside.invalid/image.png', files })).toEqual({ kind: 'images', files })
  })

  it('接受十张，拒绝第十一张；整批先检查，不修改调用者数组或读取字节', () => {
    const files = Object.freeze(Array.from({ length: 10 }, (_, index) => file(`${index}.png`)))
    const reads = files.map((input) => {
      const read = vi.fn(() => {
        throw new Error('分类不得读字节')
      })
      Object.defineProperty(input, 'arrayBuffer', { value: read })
      return read
    })
    expect(classifyImageInput({ files })).toEqual({ kind: 'images', files })
    expect(classifyImageInput({ files: [...files, file()] })).toEqual({ kind: 'reject', reason: 'count' })
    expect(classifyImageInput({ files: [...files.slice(0, 9), file('last.bmp', 'image/bmp')] })).toEqual({ kind: 'reject', reason: 'type' })
    expect(classifyImageInput({ files: [...files.slice(0, 9), file('last.png', 'image/png', ASSET_MAX_BYTES + 1)] })).toEqual({ kind: 'reject', reason: 'size' })
    expect(reads.every(read => read.mock.calls.length === 0)).toBe(true)
    expect(files).toHaveLength(10)
  })

  it.each([
    '<img src="https://outside.invalid/only.png">',
    '<style>img { display: block }</style><img src="/api/assets/example">',
    '<div> \n <img src="data:image/png;base64,AA=="> </div>',
  ])('只有 HTML 图片且没有可用字节时明确拒绝，不抓图：%s', (html) => {
    expect(classifyImageInput({ html, files: [] })).toEqual({ kind: 'reject', reason: 'image-without-file' })
  })

  it.each([
    { text: '普通文字' },
    { html: '<p>文字与 <a href="/doc">链接</a></p>' },
    { html: '<p>正常文字<img src="https://outside.invalid/ignored"></p>' },
    { html: '<!--univer-doc-fragment:受控片段-->' },
    {},
  ])('没有图片文件的普通内容交给既有 SDK：%j', (data) => {
    expect(classifyImageInput({ ...data, files: [] })).toEqual({ kind: 'delegate' })
  })

  it('超长 HTML 不解析也不误判成图片，恰好达到上限仍识别实际表格', () => {
    const start = '<table><tr><td>cell</td></tr></table>'
    const html = start.padEnd(IMAGE_INPUT_HTML_LIMIT, ' ')
    expect(classifyImageInput({ html, files: [file()] })).toEqual({ kind: 'delegate' })
    expect(classifyImageInput({ html: `${html} `, files: [file('preview.bmp', 'image/bmp')] })).toEqual({ kind: 'delegate' })
  })

  it('解析节点始终不连接页面，也不执行其中脚本或修改传入内容', () => {
    const before = document.body.innerHTML
    const html = '<script>document.body.textContent="changed"</script><img src="https://outside.invalid/image">'
    const input = Object.freeze({ html, files: Object.freeze([file()]) })
    expect(classifyImageInput(input).kind).toBe('images')
    expect(document.body.innerHTML).toBe(before)
    expect(input.html).toBe(html)
  })
})

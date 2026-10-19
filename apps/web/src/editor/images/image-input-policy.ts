import type { AssetExtension, AssetMimeType } from '@nerve-office/contracts'
import { ASSET_MAX_BYTES, assetExtensionSchema } from '@nerve-office/contracts'

export const IMAGE_INPUT_FILE_LIMIT = 10
export const IMAGE_INPUT_HTML_LIMIT = 1_048_576
export const IMAGE_INPUT_ACCEPT = '.png,.jpg,.jpeg,.webp,.gif'

const FILE_TYPES: Readonly<Record<AssetExtension, AssetMimeType>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
}

export class ImageFileInputError extends Error {
  override readonly name = 'ImageFileInputError'
  readonly reason: 'size' | 'type'

  constructor(reason: 'size' | 'type') {
    super('图片文件不符合要求')
    this.reason = reason
  }
}

/** 只检查本次输入的元信息，内容真实性仍由已有服务端解码检查。 */
export function imageFileInput(file: File): { extension: AssetExtension, mimeType: AssetMimeType } {
  if (file.size < 1 || file.size > ASSET_MAX_BYTES)
    throw new ImageFileInputError('size')
  const dot = file.name.lastIndexOf('.')
  const extension = assetExtensionSchema.safeParse(dot < 0 ? '' : file.name.slice(dot + 1))
  if (!extension.success || FILE_TYPES[extension.data] !== file.type)
    throw new ImageFileInputError('type')
  return { extension: extension.data, mimeType: FILE_TYPES[extension.data] }
}

export interface ImageInputData {
  readonly html?: string
  readonly text?: string
  readonly files: readonly File[]
}

export type ImageInputDecision
  = | { readonly kind: 'delegate' }
    | { readonly kind: 'images', readonly files: readonly File[] }
    | { readonly kind: 'reject', readonly reason: 'count' | 'size' | 'type' | 'image-without-file' }

/** 只解析本次输入；template 的内容从不连接页面，图片节点不触发加载。 */
export function classifyImageHtml(html: string): 'delegate' | 'image-only' | 'ordinary' {
  // 长表格留给原表格路径；不能因不解析 HTML 就把附带的图片预览当作正文。
  if (html.length > IMAGE_INPUT_HTML_LIMIT)
    return 'delegate'
  const template = document.createElement('template')
  template.innerHTML = html
  if (template.content.querySelector('table td, table th') !== null)
    return 'delegate'
  if (template.content.querySelector('img') !== null) {
    // CSS/脚本是格式或元数据，不把它们误认作可粘贴的正文。
    for (const element of template.content.querySelectorAll('script, style, template, title'))
      element.remove()
    if ((template.content.textContent ?? '').trim() === '')
      return 'image-only'
  }
  return 'ordinary'
}

export function classifyImageInput(data: ImageInputData): ImageInputDecision {
  const html = classifyImageHtml(data.html ?? '')
  if (html === 'delegate')
    return { kind: 'delegate' }
  if (data.files.length > 0) {
    if (data.files.length > IMAGE_INPUT_FILE_LIMIT)
      return { kind: 'reject', reason: 'count' }
    try {
      for (const input of data.files)
        imageFileInput(input)
    }
    catch (error) {
      if (error instanceof ImageFileInputError)
        return { kind: 'reject', reason: error.reason }
      throw error
    }
    return { kind: 'images', files: [...data.files] }
  }
  if (html === 'image-only')
    return { kind: 'reject', reason: 'image-without-file' }
  return { kind: 'delegate' }
}

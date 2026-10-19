import type { AssetMimeType } from '@nerve-office/contracts'
import type { ImageInputData } from './image-input-policy.ts'
import { ASSET_MIME_TYPES } from '@nerve-office/contracts'
import { FORMULA_CLIPBOARD_MIME_TYPE } from '../internal-api/ui.ts'
import { ImageClipboardError } from './image-clipboard.ts'
import { classifyImageHtml, IMAGE_INPUT_FILE_LIMIT } from './image-input-policy.ts'
import { runImageTask } from './image-task.ts'

export interface SystemImageInputData extends ImageInputData {
  readonly formulaClipboardPayload?: string
}

export function clipboardEventInput(data: DataTransfer): SystemImageInputData {
  return {
    files: Array.from(data.files),
    html: data.getData('text/html'),
    text: data.getData('text/plain'),
    formulaClipboardPayload: data.getData(FORMULA_CLIPBOARD_MIME_TYPE),
  }
}

const EXTENSIONS: Readonly<Record<AssetMimeType, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
}

/** read 在第一个 await 前调用；不提前探测权限或自行重试，保留这次用户动作的授权。 */
export async function readClipboardInput(signal: AbortSignal): Promise<SystemImageInputData> {
  signal.throwIfAborted()
  const clipboard = navigator.clipboard
  if (typeof clipboard?.read !== 'function')
    throw new ImageClipboardError('unsupported')
  const items = await runImageTask(signal, async () => clipboard.read())
  const files: File[] = []
  let html: string | undefined
  let text: string | undefined
  let formulaClipboardPayload: string | undefined
  const readText = async (item: ClipboardItem, type: string): Promise<string> => runImageTask(signal, async () => {
    const blob = await item.getType(type)
    signal.throwIfAborted()
    return blob.text()
  })
  for (const item of items) {
    if (html === undefined && item.types.includes('text/html'))
      html = await readText(item, 'text/html')
    if (text === undefined && item.types.includes('text/plain'))
      text = await readText(item, 'text/plain')
    if (formulaClipboardPayload === undefined && item.types.includes(FORMULA_CLIPBOARD_MIME_TYPE)) {
      try {
        formulaClipboardPayload = await readText(item, FORMULA_CLIPBOARD_MIME_TYPE)
      }
      catch {
        // 与原 SDK 一致：可选公式表示不可读时保留正文；取消仍立即终止。
        signal.throwIfAborted()
      }
    }
  }
  // 先确定所有 item 的正文，再决定是否读图。表格预览不能拖住已可用的正文。
  if (classifyImageHtml(html ?? '') !== 'delegate') {
    for (const item of items) {
      const type = ASSET_MIME_TYPES.find(candidate => item.types.includes(candidate))
      // 最多保留上限加一，用于整批拒绝。
      if (type !== undefined && files.length <= IMAGE_INPUT_FILE_LIMIT) {
        const blob = await runImageTask(signal, async () => item.getType(type))
        files.push(new File([blob], `clipboard.${EXTENSIONS[type]}`, { type: blob.type }))
      }
    }
  }
  signal.throwIfAborted()
  if (files.length === 0 && (html ?? '') === '' && (text ?? '') === '')
    throw new ImageClipboardError('empty')
  return { files, html, text, formulaClipboardPayload }
}

import type { CapturedImageTarget, createImageInputBridge } from '../internal-api/ui.ts'
import type { SystemImageInputData } from './image-input-data.ts'
import type { ImageInputTask } from './image-input-task.ts'
import type { PlatformImageIo } from './platform-image-io.ts'
import { ImageDecodeError } from './decode-image.ts'
import { ImageClipboardError, writeSystemImage } from './image-clipboard.ts'
import { clipboardEventInput, readClipboardInput } from './image-input-data.ts'
import { classifyImageInput, IMAGE_INPUT_ACCEPT, ImageFileInputError } from './image-input-policy.ts'
import { createImageInputTasks } from './image-input-task.ts'
import { runImageTask } from './image-task.ts'

export type ImageInputOperation = 'copy' | 'cut' | 'paste' | 'insert'
export type ImageInputReason = 'count' | 'size' | 'type' | 'image-without-file' | 'busy' | 'permission' | 'clipboard-permission' | 'selection' | 'unsupported' | 'empty' | 'timeout' | 'encoding' | 'request'
export type ImageInputState
  = | { readonly kind: 'busy' | 'complete' | 'cancelled', readonly operation: ImageInputOperation, readonly completed: number, readonly total: number }
    | { readonly kind: 'failed', readonly operation: ImageInputOperation, readonly reason: ImageInputReason, readonly completed: number, readonly total: number }

export interface SystemImageInputOptions {
  readonly container: HTMLElement
  readonly bridge: Pick<ReturnType<typeof createImageInputBridge>, 'capture' | 'canWriteImage' | 'insertImage' | 'removeImage' | 'pasteTable' | 'pasteTableEvent' | 'gridFocused' | 'installCommands'>
  readonly io: Pick<PlatformImageIo, 'upload' | 'read'>
  readonly changed: (state: ImageInputState) => void
  readonly failed: (error: unknown) => void
}

class InputRejected extends Error {
  readonly reason: ImageInputReason
  constructor(reason: ImageInputReason) {
    super('图片操作未完成')
    this.reason = reason
  }
}

function failureReason(error: unknown): ImageInputReason {
  if (error instanceof InputRejected || error instanceof ImageClipboardError || error instanceof ImageFileInputError)
    return error.reason
  if (error instanceof ImageDecodeError)
    return error.reason === 'timeout' ? 'timeout' : 'encoding'
  if (error instanceof DOMException && error.name === 'NotAllowedError')
    return 'clipboard-permission'
  return 'request'
}

interface Progress {
  completed: number
  total: number
}

async function pickFiles(container: HTMLElement, multiple: boolean, signal: AbortSignal): Promise<readonly File[]> {
  const input = container.ownerDocument.createElement('input')
  input.type = 'file'
  input.accept = IMAGE_INPUT_ACCEPT
  input.multiple = multiple
  input.hidden = true
  container.append(input)
  let changed = (): void => {}
  let cancelled = (): void => {}
  try {
    return await runImageTask(signal, async () => new Promise<readonly File[]>((resolve, reject) => {
      changed = () => {
        const files = Array.from(input.files ?? [])
        if (files.length === 0)
          reject(new DOMException('文件选择已取消', 'AbortError'))
        else
          resolve(files)
      }
      cancelled = () => reject(new DOMException('文件选择已取消', 'AbortError'))
      input.addEventListener('change', changed)
      input.addEventListener('cancel', cancelled)
      input.click()
    }))
  }
  finally {
    input.removeEventListener('change', changed)
    input.removeEventListener('cancel', cancelled)
    input.remove()
  }
}

export function installSystemImageInput(options: SystemImageInputOptions) {
  const tasks = createImageInputTasks(() => {})
  let disposed = false
  let generation = 0
  const changed = (state: ImageInputState): void => {
    if (!disposed)
      options.changed(state)
  }

  async function perform(operation: ImageInputOperation, target: CapturedImageTarget | undefined, total: number, action: (task: ImageInputTask, progress: Progress) => Promise<void>): Promise<boolean> {
    if (disposed)
      return false
    const progress = { completed: 0, total }
    const busy = tasks.busy()
    // 已取消的旧任务不能覆盖最新失败；忙碌重入仍允许当前任务报告最终结果。
    const id = busy ? generation : ++generation
    const task = target === undefined ? undefined : tasks.start(target)
    if (task === undefined) {
      changed({ kind: 'failed', operation, reason: busy ? 'busy' : 'permission', ...progress })
      return false
    }
    const report = (state: ImageInputState): void => {
      if (id === generation)
        changed(state)
    }
    report({ kind: 'busy', operation, ...progress })
    try {
      await action(task, progress)
      report({ kind: 'complete', operation, ...progress })
      return true
    }
    catch (error) {
      if (task.signal.aborted || (error instanceof DOMException && error.name === 'AbortError')) {
        report({ kind: 'cancelled', operation, ...progress })
      }
      else {
        report({ kind: 'failed', operation, reason: failureReason(error), ...progress })
        if (!disposed && id === generation)
          options.failed(error)
      }
      return false
    }
    finally {
      task.finish()
    }
  }

  async function inputData(target: CapturedImageTarget, data: SystemImageInputData, kind: 'float' | 'cell', task: ImageInputTask, progress: Progress): Promise<void> {
    const decision = classifyImageInput(data)
    if (decision.kind === 'reject')
      throw new InputRejected(decision.reason)
    if (decision.kind === 'delegate') {
      task.check()
      task.finish()
      // 从这里交给 SDK 自己的表格粘贴生命周期，正常更新选区不能取消已经提交的本次操作。
      if (!await options.bridge.pasteTable(target, { html: data.html, text: data.text, formulaClipboardPayload: data.formulaClipboardPayload }))
        throw new InputRejected('permission')
      return
    }
    progress.total = decision.files.length
    if (kind === 'cell' && decision.files.length !== 1)
      throw new InputRejected('selection')
    if (!options.bridge.canWriteImage(target, kind))
      throw new InputRejected('permission')
    for (const file of decision.files) {
      const uploaded = await task.run(async () => options.io.upload(file, task.signal))
      task.check()
      if (!options.bridge.insertImage(target, { source: uploaded.url, width: uploaded.width, height: uploaded.height }, kind))
        throw new InputRejected('permission')
      progress.completed += 1
    }
  }

  async function pasteTableEvent(data: SystemImageInputData): Promise<void> {
    if (disposed)
      return
    if (tasks.busy()) {
      changed({ kind: 'failed', operation: 'paste', reason: 'busy', completed: 0, total: 0 })
      return
    }
    const id = ++generation
    try {
      // 事件已经带齐正文，同步捕获并启动原 SDK；不读取预览，也不先用图片权限挡住只读提示。
      const result = await options.bridge.pasteTableEvent({ html: data.html, text: data.text, formulaClipboardPayload: data.formulaClipboardPayload })
      if (result && id === generation)
        changed({ kind: 'complete', operation: 'paste', completed: 0, total: 0 })
      // SDK 的权限拒绝已经显示原提示；false 不再叠加图片失败。
    }
    catch (error) {
      if (!disposed && id === generation) {
        changed({ kind: 'failed', operation: 'paste', reason: 'request', completed: 0, total: 0 })
        options.failed(error)
      }
    }
  }

  async function chooseFiles(kind: 'float' | 'cell'): Promise<boolean> {
    const target = options.bridge.capture('insert')
    return perform('insert', target, 0, async (task, progress) => {
      if (target === undefined || !options.bridge.canWriteImage(target, kind))
        throw new InputRejected('permission')
      const files = await task.run(async () => pickFiles(options.container, kind === 'float', task.signal))
      await inputData(target, { files }, kind, task, progress)
    })
  }

  const commands = options.bridge.installCommands({
    insert: async (kind, files) => files === undefined ? chooseFiles(kind) : insertFiles(files, kind),
    copy: async (target, image, cut) => perform(cut ? 'cut' : 'copy', target, 1, async (task, progress) => {
      await task.run(async () => writeSystemImage(image.source, task.signal, options.io.read))
      task.check()
      // 最终同步提交前解除监听；自己的删除通知不能把成功剪切误判成外部取消。
      task.finish()
      if (cut && !options.bridge.removeImage(target, image))
        throw new InputRejected('permission')
      progress.completed = 1
    }),
    paste: async target => perform('paste', target, 0, async (task, progress) => {
      const data = await task.run(async () => readClipboardInput(task.signal))
      await inputData(target, data, 'float', task, progress)
    }),
    rejected: (reason, intent, operation) => {
      if (!tasks.busy())
        generation += 1
      changed({ kind: 'failed', operation: operation ?? (intent === 'insert' ? 'paste' : intent), reason, completed: 0, total: 0 })
    },
  })

  async function insertFiles(files: readonly File[], kind: 'float' | 'cell' = 'float'): Promise<boolean> {
    const target = options.bridge.capture('insert')
    return perform('insert', target, files.length, async (task, progress) => {
      if (target === undefined)
        throw new InputRejected('permission')
      if (files.length === 0)
        throw new InputRejected('empty')
      await inputData(target, { files }, kind, task, progress)
    })
  }

  const inEditor = (event: Event): boolean => event.composedPath().includes(options.container)
  const stop = (event: Event): void => {
    event.preventDefault()
    event.stopImmediatePropagation()
  }
  const onPaste = (event: ClipboardEvent): void => {
    const data = event.clipboardData
    if (event.defaultPrevented || data === null || !inEditor(event) || !options.bridge.gridFocused())
      return
    const input = clipboardEventInput(data)
    const ordinaryTable = classifyImageInput(input).kind === 'delegate'
    // 普通表格保留原事件路径，包括 SDK 的可选公式剪贴板补充读取。
    if (input.files.length === 0 && ordinaryTable)
      return
    stop(event)
    if (ordinaryTable) {
      void pasteTableEvent(input)
      return
    }
    const target = options.bridge.capture('insert')
    void perform('paste', target, 0, async (task, progress) => {
      if (target === undefined)
        throw new InputRejected('permission')
      await inputData(target, input, 'float', task, progress)
    })
  }
  const onFileDrop = (event: DragEvent): void => {
    const data = event.dataTransfer
    if (event.defaultPrevented || data === null || !inEditor(event) || (!Array.from(data.types).includes('Files') && data.files.length === 0))
      return
    // 格内文件导航始终同步取消；焦点、只读或格式拒绝都发生在此之后。
    stop(event)
    if (event.type === 'drop')
      void insertFiles(Array.from(data.files))
  }
  const document = options.container.ownerDocument
  document.addEventListener('paste', onPaste, true)
  document.addEventListener('dragover', onFileDrop, true)
  document.addEventListener('drop', onFileDrop, true)

  return {
    insertFiles,
    chooseFiles,
    cancel: tasks.cancel,
    dispose: () => {
      if (disposed)
        return
      disposed = true
      tasks.dispose()
      commands.dispose()
      document.removeEventListener('paste', onPaste, true)
      document.removeEventListener('dragover', onFileDrop, true)
      document.removeEventListener('drop', onFileDrop, true)
    },
  }
}

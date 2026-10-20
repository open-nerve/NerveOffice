interface RecordingOptions {
  readonly container: HTMLElement
  readonly panel: HTMLElement
  readonly run: string
  readonly caseId: string
  readonly readState: () => unknown
}

/** 测试专用被动观察器：只读当前事件，不读取系统剪贴板，也不改变输入路由。 */
export function installImageInputRecording(options: RecordingOptions): () => void {
  const identity = { run: options.run, caseId: options.caseId, pageId: crypto.randomUUID(), href: location.href, userAgent: navigator.userAgent, method: 'observed-events' }
  const records: Record<string, unknown>[] = []
  const timers = new Set<number>()
  const cancelDigests = new Set<() => void>()
  let armed = false
  let disposed = false
  let complete = true
  let sequence = 0
  let recordBytes = 0
  let digestBytes = 0
  let pending = 0
  const arm = document.createElement('button')
  arm.type = 'button'
  arm.textContent = '开始记录受控样本'
  const capture = document.createElement('button')
  capture.type = 'button'
  capture.textContent = '记录当前状态'
  const output = document.createElement('pre')
  output.dataset.slot = 'image-input-test-record'
  output.style.cssText = 'position:fixed;right:8px;bottom:48px;max-width:420px;max-height:160px;overflow:auto;background:white;color:black;border:1px solid #999;font-size:10px;white-space:pre-wrap'
  const render = () => {
    output.textContent = JSON.stringify({ identity, complete: complete && pending === 0, pending, records })
  }
  const append = (type: string, fields: Record<string, unknown> = {}): number | undefined => {
    if (disposed || !armed)
      return undefined
    const value = { seq: sequence + 1, at: new Date().toISOString(), type, ...fields }
    const bytes = new TextEncoder().encode(JSON.stringify(value)).byteLength
    if (records.length >= 128 || recordBytes + bytes > 1_048_576) {
      complete = false
      armed = false
      render()
      return undefined
    }
    sequence++
    recordBytes += bytes
    records.push(value)
    render()
    return sequence
  }
  const gap = (reason: string, fields: Record<string, unknown> = {}) => {
    if (disposed || !armed)
      return
    complete = false
    append('evidence-gap', { reason, ...fields })
  }
  const digest = async (file: File, inputSequence: number, index: number) => {
    if (file.size === 0 || file.size > 5 * 1024 * 1024 || digestBytes + file.size > 32 * 1024 * 1024) {
      gap('文件摘要超过本轮字节预算', { inputSequence, index })
      return
    }
    digestBytes += file.size
    pending++
    render()
    let cancel = () => {}
    let timer = 0
    const cancelled = new Promise<never>((_resolve, reject) => {
      cancel = () => reject(new Error('摘要已取消或超时'))
      timer = window.setTimeout(cancel, 10_000)
      timers.add(timer)
      cancelDigests.add(cancel)
    })
    try {
      const hash = await Promise.race([
        file.arrayBuffer().then(async (bytes) => {
          if (disposed || !armed)
            throw new Error('记录已经结束')
          return crypto.subtle.digest('SHA-256', bytes)
        }),
        cancelled,
      ])
      append('file-digest', { inputSequence, index, sha256: Array.from(new Uint8Array(hash), n => n.toString(16).padStart(2, '0')).join('') })
    }
    catch {
      gap('文件摘要失败或超时', { inputSequence, index })
    }
    finally {
      window.clearTimeout(timer)
      timers.delete(timer)
      cancelDigests.delete(cancel)
      pending--
      if (!disposed)
        render()
    }
  }
  const belongs = (event: Event) => event.target instanceof Node && options.container.contains(event.target)
  const observe = (event: Event) => {
    if (!armed || disposed || !belongs(event))
      return
    const transfer = event.type === 'drop' ? (event as DragEvent).dataTransfer : (event as ClipboardEvent).clipboardData
    const files = Array.from(transfer?.files ?? [])
    let html = ''
    let text = ''
    try {
      html = transfer?.getData('text/html').slice(0, 16_384) ?? ''
      text = transfer?.getData('text/plain').slice(0, 4096) ?? ''
    }
    catch {
      gap('事件文本读取失败')
    }
    const inputSequence = append(event.type, {
      isTrusted: event.isTrusted,
      defaultPrevented: event.defaultPrevented,
      types: Array.from(transfer?.types ?? []),
      files: files.slice(0, 10).map(file => ({ type: file.type, size: file.size })),
      html,
      text,
    })
    if (inputSequence === undefined)
      return
    if (files.length > 10) {
      gap('事件文件超过 10 个，未读取字节', { inputSequence })
    }
    else {
      files.forEach((file, index) => {
        void digest(file, inputSequence, index)
      })
    }
    const timer = window.setTimeout(() => {
      timers.delete(timer)
      append('event-settled', { inputSequence, defaultPrevented: event.defaultPrevented })
    }, 0)
    timers.add(timer)
  }
  const onKey = (event: KeyboardEvent) => {
    if (armed && belongs(event) && (event.metaKey || event.ctrlKey) && !event.altKey && !event.repeat && /^[cxv]$/i.test(event.key))
      append('clipboard-key', { key: event.key.toLowerCase(), isTrusted: event.isTrusted })
  }
  const onArm = () => {
    if (disposed || arm.disabled)
      return
    armed = true
    arm.disabled = true
    append('armed')
  }
  const onCapture = () => {
    if (!armed || disposed)
      return
    try {
      append('state', { value: options.readState() })
    }
    catch {
      gap('当前编辑器状态不可用')
    }
  }
  arm.addEventListener('click', onArm)
  capture.addEventListener('click', onCapture)
  const eventTypes = ['paste', 'copy', 'cut', 'drop'] as const
  eventTypes.forEach(type => window.addEventListener(type, observe, { capture: true, passive: true }))
  window.addEventListener('keydown', onKey, { capture: true, passive: true })
  options.panel.append(arm, capture, output)
  render()
  return () => {
    if (disposed)
      return
    disposed = true
    cancelDigests.forEach(cancel => cancel())
    cancelDigests.clear()
    eventTypes.forEach(type => window.removeEventListener(type, observe, true))
    window.removeEventListener('keydown', onKey, true)
    timers.forEach(timer => window.clearTimeout(timer))
    timers.clear()
    arm.removeEventListener('click', onArm)
    capture.removeEventListener('click', onCapture)
    arm.remove()
    capture.remove()
    output.remove()
  }
}

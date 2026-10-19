import { afterEach, describe, expect, it, vi } from 'vitest'
import { installImageInputRecording } from './image-input-recording.ts'

const cleanups: (() => void)[] = []
afterEach(() => {
  cleanups.splice(0).forEach(dispose => dispose())
  document.body.replaceChildren()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

function fixture() {
  vi.useFakeTimers()
  const container = document.createElement('div')
  const panel = document.createElement('div')
  document.body.append(container, panel)
  const readState = vi.fn(() => ({ snapshot: { sheets: {} }, selected: ['image-1'], changeSeq: 7 }))
  const dispose = installImageInputRecording({ container, panel, run: 'calibration', caseId: 'synthetic', readState })
  cleanups.push(dispose)
  const button = (label: string) => {
    const value = Array.from(panel.querySelectorAll('button')).find(item => item.textContent === label)
    if (!value)
      throw new Error(`缺少 ${label}`)
    return value
  }
  const report = () => JSON.parse(panel.querySelector('pre')!.textContent) as { complete: boolean, pending: number, records: Record<string, unknown>[], identity: Record<string, unknown> }
  return { container, panel, readState, dispose, report, arm: () => button('开始记录受控样本').click(), capture: () => button('记录当前状态').click() }
}

function paste(target: HTMLElement, files: File[] = []) {
  const event = new Event('paste', { bubbles: true, cancelable: true })
  const getData = vi.fn((type: string) => type === 'text/html' ? '<table><tr><td>样本</td></tr></table>' : '样本')
  Object.defineProperty(event, 'clipboardData', { value: { types: ['Files', 'text/html', 'text/plain'], files, getData } })
  target.dispatchEvent(event)
  return { event, getData }
}

function file(size = 3) {
  const value = new File([new Uint8Array(size)], '受控.png', { type: 'image/png' })
  const arrayBuffer = vi.fn(async () => new Uint8Array([1, 2, 3]).buffer)
  Object.defineProperty(value, 'arrayBuffer', { value: arrayBuffer })
  return { value, arrayBuffer }
}

describe('图片原生取证面板', () => {
  it('显式开启前不读取事件数据或状态；容器外输入始终不记录', async () => {
    const f = fixture()
    const source = file()
    const before = paste(f.container, [source.value])
    f.capture()
    expect(before.getData).not.toHaveBeenCalled()
    expect(source.arrayBuffer).not.toHaveBeenCalled()
    expect(f.readState).not.toHaveBeenCalled()
    f.arm()
    const count = f.report().records.length
    const outside = paste(document.body, [source.value])
    await vi.runAllTimersAsync()
    expect(outside.getData).not.toHaveBeenCalled()
    expect(f.report().records).toHaveLength(count)
  })

  it('保留原事件、合成资格和最终取消结果；只按显式动作读取状态', async () => {
    const f = fixture()
    f.arm()
    const receiver = vi.fn((event: Event) => event.preventDefault())
    f.container.addEventListener('paste', receiver)
    const { event } = paste(f.container)
    await vi.runAllTimersAsync()
    expect(receiver).toHaveBeenCalledWith(event)
    expect(f.readState).not.toHaveBeenCalled()
    const input = f.report().records.find(item => item.type === 'paste')!
    expect(input).toMatchObject({ isTrusted: false, defaultPrevented: false, html: '<table><tr><td>样本</td></tr></table>', text: '样本' })
    expect(f.report().records).toContainEqual(expect.objectContaining({ type: 'event-settled', inputSequence: input.seq, defaultPrevented: true }))
    f.capture()
    expect(f.readState).toHaveBeenCalledOnce()
    expect(f.report().records).toContainEqual(expect.objectContaining({ type: 'state', value: { snapshot: { sheets: {} }, selected: ['image-1'], changeSeq: 7 } }))
    expect(f.report().identity).toMatchObject({ run: 'calibration', caseId: 'synthetic', method: 'observed-events' })
  })

  it('仅摘要本次有界文件，关联原事件，不保存文件名', async () => {
    const f = fixture()
    vi.spyOn(crypto.subtle, 'digest').mockResolvedValue(new Uint8Array([0xAB, 0xCD]).buffer)
    const source = file()
    f.arm()
    paste(f.container, [source.value])
    await vi.runAllTimersAsync()
    const input = f.report().records.find(item => item.type === 'paste')!
    expect(source.arrayBuffer).toHaveBeenCalledOnce()
    expect(f.report().records).toContainEqual(expect.objectContaining({ type: 'file-digest', inputSequence: input.seq, index: 0, sha256: 'abcd' }))
    expect(JSON.stringify(f.report())).not.toContain('受控.png')
  })

  it('超大或过多文件明确标记不完整且不读取字节', async () => {
    const f = fixture()
    const source = file(5 * 1024 * 1024 + 1)
    f.arm()
    paste(f.container, [source.value])
    paste(f.container, Array.from<File>({ length: 11 }).fill(source.value))
    await vi.runAllTimersAsync()
    expect(source.arrayBuffer).not.toHaveBeenCalled()
    expect(f.report().complete).toBe(false)
    expect(f.report().records).toContainEqual(expect.objectContaining({ type: 'evidence-gap' }))
  })

  it('摘要在途时不能声明完整，摘要到齐后才允许完整记录', async () => {
    const f = fixture()
    vi.spyOn(crypto.subtle, 'digest').mockResolvedValue(new Uint8Array([0xAB]).buffer)
    let finish!: (value: ArrayBuffer) => void
    const source = file()
    source.arrayBuffer.mockReturnValue(new Promise((resolve) => {
      finish = resolve
    }))
    f.arm()
    paste(f.container, [source.value])
    f.capture()
    expect(f.report()).toMatchObject({ complete: false, pending: 1 })
    finish(new Uint8Array([1, 2, 3]).buffer)
    await vi.advanceTimersByTimeAsync(1)
    expect(f.report()).toMatchObject({ complete: true, pending: 0 })
    expect(f.report().records).toContainEqual(expect.objectContaining({ type: 'file-digest', sha256: 'ab' }))
  })

  it('摘要超时明确留下缺口，迟到字节不能补成成功或留下定时器', async () => {
    const f = fixture()
    let finish!: (value: ArrayBuffer) => void
    const source = file()
    source.arrayBuffer.mockReturnValue(new Promise((resolve) => {
      finish = resolve
    }))
    f.arm()
    paste(f.container, [source.value])
    await vi.advanceTimersByTimeAsync(10_001)
    expect(f.report()).toMatchObject({ complete: false, pending: 0 })
    expect(f.report().records).toContainEqual(expect.objectContaining({ type: 'evidence-gap' }))
    finish(new Uint8Array([1, 2, 3]).buffer)
    await vi.runAllTimersAsync()
    expect(f.report().records.some(item => item.type === 'file-digest')).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('销毁移除监听并忽略迟到摘要，重复销毁无副作用', async () => {
    const f = fixture()
    let finish!: (value: ArrayBuffer) => void
    const source = file()
    source.arrayBuffer.mockReturnValue(new Promise((resolve) => {
      finish = resolve
    }))
    f.arm()
    paste(f.container, [source.value])
    const output = f.panel.querySelector('pre')!
    const last = output.textContent
    f.dispose()
    finish(new Uint8Array([1, 2, 3]).buffer)
    await vi.runAllTimersAsync()
    const later = paste(f.container)
    expect(later.getData).not.toHaveBeenCalled()
    expect(output.textContent).toBe(last)
    expect(f.panel.childElementCount).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
    expect(() => f.dispose()).not.toThrow()
  })

  it('只观察带修饰键的复制剪切粘贴，记录满后明确停止而不悄悄丢旧记录', () => {
    const f = fixture()
    f.arm()
    const initial = f.report().records.length
    f.container.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }))
    f.container.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', bubbles: true }))
    expect(f.report().records).toHaveLength(initial)
    for (let i = 0; i < 140; i++)
      f.container.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', metaKey: true, bubbles: true }))
    const report = f.report()
    expect(report.complete).toBe(false)
    expect(report.records.length).toBeLessThanOrEqual(128)
    expect(report.records[0]).toMatchObject({ type: 'armed', seq: 1 })
    expect(report.records[1]).toMatchObject({ type: 'clipboard-key', key: 'c', isTrusted: false })
  })
})

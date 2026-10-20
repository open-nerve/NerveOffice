import type { installSystemImageInput } from '../images/system-image-input.ts'
import { installImageInputRecording } from './image-input-recording.ts'

interface ImageInputControlOptions {
  readonly container: HTMLElement
  readonly input: ReturnType<typeof installSystemImageInput>
  readonly pageUi: Node | undefined
}

/** 只由 e2e 动态入口加载；只为现有正式输入添加测试 UI/记录器，生产没有查询开关和测试按钮。 */
export function installImageInputControl(options: ImageInputControlOptions) {
  const value = new URLSearchParams(location.search).get('imageInput')
  if (value === null)
    return undefined
  if (value !== 'enabled')
    throw new Error('无法识别图片输入测试开关')
  const query = new URLSearchParams(location.search)
  const recordRun = query.get('nativeImageRun')
  const recordCase = query.get('nativeImageCase')
  if (recordRun !== null && (!/^[\w-]{1,80}$/.test(recordRun) || recordCase === null || !/^[\w-]{1,80}$/.test(recordCase)))
    throw new Error('原生图片记录要求明确的 run/case')
  const input = options.input
  const panel = document.createElement('div')
  panel.dataset.slot = 'image-input-test-controls'
  panel.style.cssText = 'position:fixed;bottom:8px;left:8px;z-index:10000;background:white;color:black;padding:6px;display:flex;gap:8px'
  const preserveFocus = (event: MouseEvent): void => event.preventDefault()
  panel.addEventListener('mousedown', preserveFocus)
  const actions: readonly [string, () => void][] = [
    ['测试：插入浮图', () => { void input.chooseFiles('float') }],
    ['测试：插入单元格图片', () => { void input.chooseFiles('cell') }],
    ['测试：取消图片操作', input.cancel],
  ]
  const removals = actions.map(([label, action]) => {
    const button = document.createElement('button')
    button.type = 'button'
    button.textContent = label
    button.addEventListener('click', action)
    panel.append(button)
    return () => button.removeEventListener('click', action)
  })
  ;(options.pageUi ?? options.container).appendChild(panel)
  const stopRecording = recordRun === null || recordCase === null
    ? undefined
    : installImageInputRecording({
        container: options.container,
        panel,
        run: recordRun,
        caseId: recordCase,
        readState: () => {
          const probe = window.__nerveEditorProbe
          if (probe === undefined)
            throw new Error('编辑器探针未就绪')
          return { snapshot: JSON.parse(probe.snapshot()) as unknown, selected: probe.images.selected(), changeSeq: probe.changeSeq() }
        },
      })
  let disposed = false
  return {
    input,
    dispose: () => {
      if (disposed)
        return
      disposed = true
      stopRecording?.()
      panel.removeEventListener('mousedown', preserveFocus)
      removals.forEach(remove => remove())
      panel.remove()
    },
  }
}

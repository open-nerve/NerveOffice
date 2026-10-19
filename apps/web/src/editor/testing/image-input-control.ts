import type { Univer } from '@univerjs/core'
import type { EditorAccess } from '../editor-access.ts'
import type { EditorImageAccess } from '../images/platform-image-io.ts'
import type { SystemImageInputOptions } from '../images/system-image-input.ts'
import { installSystemImageInput } from '../images/system-image-input.ts'
import { createImageInputBridge } from '../internal-api/ui.ts'

interface ImageInputControlOptions extends Pick<SystemImageInputOptions, 'container' | 'io' | 'changed' | 'failed'> {
  readonly univer: Univer
  readonly unitId: string
  readonly access: EditorAccess
  readonly identity: EditorImageAccess
  readonly pageUi: Node | undefined
  readonly enabled: (value: boolean) => void
}

/** 只由 e2e 动态入口加载；调用正式桥接与任务实现，生产没有查询开关和测试按钮。 */
export function installImageInputControl(options: ImageInputControlOptions) {
  const value = new URLSearchParams(location.search).get('imageInput')
  if (value === null)
    return undefined
  if (value !== 'enabled')
    throw new Error('无法识别图片输入测试开关')
  const owner = options.identity.owner ?? options.identity.current()?.user.id
  const bridge = createImageInputBridge(options.univer, options.container, {
    unitId: options.unitId,
    origin: location.origin,
    available: intent => navigator.onLine && owner !== undefined && options.identity.current()?.user.id === owner && (intent === 'copy' || options.access === 'edit'),
    subscribe: options.identity.subscribe,
  })
  let input: ReturnType<typeof installSystemImageInput>
  try {
    input = installSystemImageInput({ ...options, bridge })
  }
  catch (error) {
    bridge.dispose()
    throw error
  }
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
  options.enabled(true)
  let disposed = false
  return {
    input,
    dispose: () => {
      if (disposed)
        return
      disposed = true
      options.enabled(false)
      input.dispose()
      bridge.dispose()
      panel.removeEventListener('mousedown', preserveFocus)
      removals.forEach(remove => remove())
      panel.remove()
    },
  }
}

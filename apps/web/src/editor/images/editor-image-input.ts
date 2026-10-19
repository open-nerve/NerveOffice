import type { Univer } from '@univerjs/core'
import type { EditorAccess } from '../editor-access.ts'
import type { EditorImageAccess } from './platform-image-io.ts'
import type { SystemImageInputOptions } from './system-image-input.ts'
import { createImageInputBridge } from '../internal-api/ui.ts'
import { installSystemImageInput } from './system-image-input.ts'

interface EditorImageInputOptions extends Pick<SystemImageInputOptions, 'container' | 'io' | 'changed' | 'failed'> {
  readonly univer: Univer
  readonly unitId: string
  readonly access: EditorAccess
  readonly identity: EditorImageAccess
}

/** 一个就绪编辑器拥有一套输入任务；身份、选区和权限变化由桥接使原任务失效。 */
export function installEditorImageInput(options: EditorImageInputOptions) {
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
  let disposed = false
  return {
    input,
    dispose: () => {
      if (disposed)
        return
      disposed = true
      input.dispose()
      bridge.dispose()
    },
  }
}

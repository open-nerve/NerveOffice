import type { IDisposable, Univer } from '@univerjs/core'
import { DOCS_NORMAL_EDITOR_UNIT_ID_KEY, EDITOR_ACTIVATED, FOCUSING_FX_BAR_EDITOR, FOCUSING_SHEET } from '@univerjs/core'
import { DocSelectionManagerService } from '@univerjs/docs'
import { DocSelectionRenderService, IEditorService } from '@univerjs/docs-ui'
import { IRenderManagerService } from '@univerjs/engine-render'
import { IShortcutService, KeyCode, MetaKeys } from '@univerjs/ui'
import { injectorOf } from './injector.ts'

/** SDK 原绑定只处理网格；本实例只补正常单元格编辑器的非空富文本选区。 */
export function installRichLinkShortcut(univer: Univer, available: () => boolean): IDisposable {
  const injector = injectorOf(univer)
  const editors = injector.get(IEditorService)
  const selections = injector.get(DocSelectionManagerService)
  const renders = injector.get(IRenderManagerService)
  let disposed = false
  const shortcut = injector.get(IShortcutService).registerShortcut({
    id: 'sheet.operation.insert-hyper-link-toolbar',
    binding: KeyCode.K | MetaKeys.CTRL_COMMAND,
    priority: 1,
    preconditions: context => !disposed && available()
      && Boolean(context.getContextValue(FOCUSING_SHEET))
      && Boolean(context.getContextValue(EDITOR_ACTIVATED))
      && !context.getContextValue(FOCUSING_FX_BAR_EDITOR)
      && editors.getFocusId() === DOCS_NORMAL_EDITOR_UNIT_ID_KEY
      && (selections.getTextRanges({ unitId: DOCS_NORMAL_EDITOR_UNIT_ID_KEY, subUnitId: DOCS_NORMAL_EDITOR_UNIT_ID_KEY })?.some(range => range.collapsed === false) ?? false),
    eventPreconditions: event => !disposed && !event.isComposing && event.target === document.activeElement
      && (renders.getRenderUnitById(DOCS_NORMAL_EDITOR_UNIT_ID_KEY)?.with(DocSelectionRenderService).isFocusing ?? false),
  })
  return { dispose: () => {
    if (disposed)
      return
    disposed = true
    shortcut.dispose()
  } }
}

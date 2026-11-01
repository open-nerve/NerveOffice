import type { CsvController, CsvProblem } from './csv-controller.ts'
import { useId, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { messages } from '../../shared/i18n/index.ts'
import { editorMessages } from '../../shared/i18n/zh-cn/editor.ts'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../../shared/ui/dialog.tsx'
import { Button } from '../../shared/ui/index.ts'

const text = editorMessages.csv
const problems: Readonly<Record<CsvProblem, string>> = text.problems

export function CsvEntry({ controller, fallbackFocus }: { controller: CsvController, fallbackFocus: () => void }) {
  const view = useSyncExternalStore(controller.subscribe, controller.view)
  const { dialog } = view
  const open = dialog.kind !== 'closed'
  const [portalContainer, setPortalContainer] = useState<HTMLDivElement | null>(null)
  const [closed, setClosed] = useState(true)
  const fileId = useId()
  const fileInputRef = useRef<HTMLInputElement>(null)
  const sheetId = useId()
  const problem = view.problem === undefined ? undefined : problems[view.problem]
  const notice = view.notice === undefined ? undefined : text[view.notice]
  const preview = dialog.kind === 'import' ? dialog.preview : undefined
  // 预览保留 CSV 的原行列位置；按源坐标标识，不随内容重复或异步重读丢掉单元格身份。
  const previewRows = useMemo(() => preview?.rows.map((values, row) => ({
    address: `R${row + 1}`,
    cells: values.map((value, column) => ({ address: `R${row + 1}C${column + 1}`, value })),
  })), [preview])

  return (
    <div ref={setPortalContainer} data-slot="csv-entry" className="flex flex-wrap items-center gap-2 px-3 pb-2">
      {(view.canImport || view.canExport || open) && (
        <>
          <Button
            size="sm"
            variant="outline"
            disabled={!view.canImport}
            title={text.importHint}
            onClick={(event) => {
              event.currentTarget.focus()
              controller.openImport()
            }}
          >
            {text.import}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={!view.canExport}
            onClick={(event) => {
              event.currentTarget.focus()
              controller.openExport()
            }}
          >
            {text.export}
          </Button>
        </>
      )}
      {!open && closed && (problem ?? notice) !== undefined && <p role={problem !== undefined ? 'alert' : 'status'} className="text-sm text-muted-foreground">{problem ?? notice}</p>}
      <Dialog open={open} onOpenChange={next => !next && controller.cancel()}>
        {dialog.kind !== 'closed' && (
          <DialogContent
            portalContainer={portalContainer}
            className="max-h-[calc(100%-2rem)] overflow-auto sm:max-w-2xl"
            fallbackFocus={fallbackFocus}
            onOpenAutoFocus={() => setClosed(false)}
            onClosed={() => setClosed(true)}
          >
            <DialogHeader>
              <DialogTitle>{dialog.kind === 'import' ? text.import : text.export}</DialogTitle>
              <DialogDescription>{dialog.kind === 'import' ? text.importDescription : text.exportDescription}</DialogDescription>
            </DialogHeader>
            {dialog.kind === 'import'
              ? (
                  <>
                    <label htmlFor={fileId} className="text-sm font-medium">{text.file}</label>
                    <input
                      ref={fileInputRef}
                      id={fileId}
                      type="file"
                      accept=".csv,text/csv"
                      disabled={dialog.stage === 'reading' || dialog.stage === 'applying'}
                      className="sr-only"
                      tabIndex={-1}
                      onChange={(event) => {
                        const file = event.currentTarget.files?.[0]
                        event.currentTarget.value = ''
                        if (file)
                          void controller.chooseFile(file)
                      }}
                    />
                    <Button className="justify-self-start" variant="outline" disabled={dialog.stage === 'reading' || dialog.stage === 'applying'} onClick={() => fileInputRef.current?.click()}>
                      {dialog.fileName === undefined ? text.chooseFile : text.replaceFile}
                    </Button>
                    {dialog.fileName !== undefined && <p className="truncate text-sm">{dialog.fileName}</p>}
                    {dialog.preview !== undefined && (
                      <>
                        <p className="text-sm">{text.dimensions(dialog.preview.rowCount, dialog.preview.columnCount)}</p>
                        <div className="max-h-64 overflow-auto rounded border">
                          <table className="w-full text-sm">
                            <caption className="sr-only">{text.preview}</caption>
                            <tbody>
                              {previewRows?.map(row => (
                                <tr key={row.address}>
                                  {row.cells.map(cell => <td key={cell.address} className="max-w-48 overflow-hidden border px-2 py-1 text-ellipsis whitespace-pre">{cell.value}</td>)}
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                        <p className="text-xs text-muted-foreground">{text.previewLimit}</p>
                      </>
                    )}
                    {dialog.stage === 'reading' && <p role="status">{text.reading}</p>}
                    {dialog.stage === 'preview' && !view.canImport && <p role="status" className="text-sm text-muted-foreground">{text.awaitWritable}</p>}
                  </>
                )
              : (
                  <>
                    <label htmlFor={sheetId} className="text-sm font-medium">{text.sheet}</label>
                    <select
                      id={sheetId}
                      value={dialog.selected}
                      disabled={dialog.stage === 'preparing'}
                      className="h-9 rounded-md border bg-background px-3 text-sm"
                      onChange={event => controller.selectSheet(event.currentTarget.value)}
                    >
                      {dialog.sheets.map(sheet => <option key={sheet.id} value={sheet.id}>{sheet.name}</option>)}
                    </select>
                    <p className="text-sm text-muted-foreground">{text.protection}</p>
                  </>
                )}
            {problem !== undefined && <p role="alert" className="text-sm text-destructive">{problem}</p>}
            <DialogFooter>
              <Button variant="outline" onClick={controller.cancel}>{messages.common.cancel}</Button>
              {dialog.kind === 'import'
                ? (
                    <Button disabled={dialog.stage !== 'preview' || !view.canImport} aria-busy={dialog.stage === 'applying'} onClick={() => void controller.confirmImport()}>
                      {dialog.stage === 'applying' ? text.applying : text.confirm}
                    </Button>
                  )
                : (
                    <Button disabled={dialog.stage !== 'choosing' || !view.canExport} aria-busy={dialog.stage === 'preparing'} onClick={() => void controller.exportSelected()}>
                      {dialog.stage === 'preparing' ? text.preparing : text.download}
                    </Button>
                  )}
            </DialogFooter>
          </DialogContent>
        )}
      </Dialog>
    </div>
  )
}

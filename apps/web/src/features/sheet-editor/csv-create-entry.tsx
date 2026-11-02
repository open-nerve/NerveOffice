import type { CsvCreation, CsvCreationProblem } from './csv-create-controller.ts'
import { documentPagePath } from '@nerve-office/contracts'
import { useId, useRef, useSyncExternalStore } from 'react'
import { editorMessages } from '../../shared/i18n/zh-cn/editor.ts'
import { connectionState } from '../../shared/lib/connection-state.ts'
import { Button } from '../../shared/ui/index.ts'
import { CsvPreviewTable } from './csv-preview.tsx'

const text = editorMessages.csvCreate
const problems: Readonly<Record<CsvCreationProblem, string>> = { ...editorMessages.csv.problems, ...text.problems }

export function CsvCreateEntry({ controller, backHref, loginHref }: { controller: CsvCreation, backHref: string, loginHref?: string }) {
  const view = useSyncExternalStore(controller.subscribe, controller.view)
  const connection = useSyncExternalStore(connectionState.subscribe, connectionState.view)
  const inputRef = useRef<HTMLInputElement>(null)
  const chooseRef = useRef<HTMLButtonElement>(null)
  const id = useId()
  const busy = ['loading', 'reading', 'confirming', 'creating', 'opening', 'importing'].includes(view.stage)
  const ended = ['invalid', 'done', 'replayed'].includes(view.stage)
  const canChoose = view.creation === 'none' && !busy && !ended && view.destination !== undefined
  const problem = view.problem === undefined ? undefined : problems[view.problem]
  return (
    <section aria-label={text.title} className={view.creation === 'created' ? 'space-y-2 border-b px-3 py-2' : 'mx-auto max-w-2xl space-y-4 p-6'}>
      <h1 className="text-lg font-semibold">{text.title}</h1>
      {!ended && view.creation !== 'created' && <p className="text-sm text-muted-foreground">{text.description}</p>}
      {view.destination !== undefined && <p className="text-sm">{text.destination(view.destination.spaceName, view.destination.folderName)}</p>}
      {!ended && (
        <>
          <label htmlFor={id} className="sr-only">{editorMessages.csv.file}</label>
          <input
            ref={inputRef}
            id={id}
            type="file"
            accept=".csv,text/csv"
            disabled={!canChoose}
            className="sr-only"
            tabIndex={-1}
            onChange={(event) => {
              const file = event.currentTarget.files?.[0]
              event.currentTarget.value = ''
              if (file)
                void controller.chooseFile(file)
            }}
          />
          <Button ref={chooseRef} variant="outline" disabled={!canChoose} onClick={() => inputRef.current?.click()}>
            {view.fileName === undefined ? editorMessages.csv.chooseFile : editorMessages.csv.replaceFile}
          </Button>
          {view.fileName !== undefined && <p className="truncate text-sm">{view.fileName}</p>}
          {view.creation !== 'created' && view.preview !== undefined && <CsvPreviewTable preview={view.preview} />}
          {busy && <p role="status">{view.stage === 'reading' ? editorMessages.csv.reading : text.working}</p>}
          {!connection.available && <p role="status">{text.problems.offline}</p>}
          <div className="flex flex-wrap gap-2">
            {view.creation === 'none' && view.fileName !== undefined && (
              <Button
                variant="outline"
                disabled={busy && view.stage !== 'reading'}
                onClick={() => {
                  controller.cancel()
                  chooseRef.current?.focus()
                }}
              >
                {text.cancel}
              </Button>
            )}
            {view.stage === 'failed'
              ? <Button disabled={!connection.available} onClick={() => void controller.retry()}>{text.retry}</Button>
              : <Button disabled={view.stage !== 'preview' || !connection.available} onClick={() => void controller.confirm()}>{text.confirm}</Button>}
          </div>
        </>
      )}
      {problem !== undefined && <p role="alert" className="text-sm text-destructive">{problem}</p>}
      {view.stage === 'done' && <p role="status">{text.done}</p>}
      {view.stage === 'replayed' && <p role="status">{text.replayed}</p>}
      {view.document !== undefined && <a className="text-sm underline" href={documentPagePath(view.document.id)}>{text.openCreated}</a>}
      {view.problem === 'identity' && loginHref !== undefined && <a className="block text-sm underline" href={loginHref}>{text.login}</a>}
      <a className="block text-sm underline" href={backHref}>{text.back}</a>
    </section>
  )
}

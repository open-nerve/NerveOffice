import type { CsvExportCell, CsvTable } from '../../shared/csv/index.ts'
import type { CsvEditor, CsvFile } from './csv-controller.ts'
import { createCsvController } from './csv-controller.ts'

export function pending<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

export function csvFile(text: string, name = '示例.csv'): CsvFile {
  const bytes = new TextEncoder().encode(text)
  return { name, size: bytes.byteLength, arrayBuffer: async () => bytes.buffer }
}

/** 控制器的宿主端口：只替换 SDK/会话/下载边界，解析与编码使用真实实现。 */
export function csvFixture() {
  const state = {
    present: true,
    current: true,
    writable: true,
    formulasPending: false,
    composing: false,
    input: 'none' as ReturnType<CsvEditor['uncommittedInput']>,
    settled: true,
    body: '原正文',
    title: '预算',
  }
  const events: string[] = []
  const inserted: CsvTable[] = []
  const downloads: { bytes: Uint8Array, name: string }[] = []
  const data: Record<string, CsvExportCell[][]> = {
    first: [[{ text: '甲', kind: 'text' }]],
    second: [[{ text: '=1+2', kind: 'text' }, { text: '-12.50', kind: 'number' }]],
  }
  const steps = {
    prepare: async (): Promise<void> => {},
    commit: async (): Promise<boolean> => {
      if (state.input === 'pending')
        state.body = '用户刚输入的文字'
      state.input = 'none'
      return true
    },
    panels: async (): Promise<void> => {},
    formulas: async (): Promise<'settled' | 'timeout'> => 'settled',
    read: (id: string): CsvExportCell[][] => {
      const rows = data[id]
      if (!rows)
        throw new Error('未知表')
      return rows
    },
    insert: (table: CsvTable): string => {
      inserted.push(table)
      return 'new-sheet'
    },
    download: (bytes: Uint8Array, name: string): void => { downloads.push({ bytes, name }) },
  }
  const editor: CsvEditor = {
    csv: {
      sheets: () => [{ id: 'first', name: '第一页', active: false }, { id: 'second', name: '第二页', active: true }],
      read: (id) => {
        events.push(`read:${id}`)
        return steps.read(id)
      },
      insert: (table) => {
        events.push('insert')
        return steps.insert(table)
      },
    },
    commitCellEditing: async () => {
      events.push('commit')
      return steps.commit()
    },
    settlePanels: async () => {
      events.push('panels')
      return steps.panels()
    },
    settleFormulas: async () => {
      events.push('formulas')
      return steps.formulas()
    },
    formulasSettled: () => state.settled,
    composing: () => state.composing,
    uncommittedInput: () => state.input,
  }
  const target = { editor, current: () => state.current, writable: () => state.writable, formulasPending: () => state.formulasPending }
  const controller = createCsvController({
    current: () => state.present ? target : undefined,
    prepareImport: async () => {
      events.push('prepare')
      return steps.prepare()
    },
    title: () => state.title,
    download: (bytes, name) => steps.download(bytes, name),
  })
  return { state, events, inserted, downloads, data, steps, editor, target, controller }
}

import type { CsvPreview } from './csv-file.ts'
import { useMemo } from 'react'
import { editorMessages } from '../../shared/i18n/zh-cn/editor.ts'

/** 预览保留源坐标，只渲染有界文本；不把 CSV 当作 HTML。 */
export function CsvPreviewTable({ preview }: { preview: CsvPreview }) {
  const rows = useMemo(() => preview.rows.map((values, row) => ({
    address: `R${row + 1}`,
    cells: values.map((value, column) => ({ address: `R${row + 1}C${column + 1}`, value })),
  })), [preview])
  return (
    <>
      <p className="text-sm">{editorMessages.csv.dimensions(preview.rowCount, preview.columnCount)}</p>
      <div className="max-h-64 overflow-auto rounded border">
        <table className="w-full text-sm">
          <caption className="sr-only">{editorMessages.csv.preview}</caption>
          <tbody>
            {rows.map(row => (
              <tr key={row.address}>
                {row.cells.map(cell => <td key={cell.address} className="max-w-48 overflow-hidden border px-2 py-1 text-ellipsis whitespace-pre">{cell.value}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-muted-foreground">{editorMessages.csv.previewLimit}</p>
    </>
  )
}

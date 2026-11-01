import type { IWorkbookData } from '@univerjs/core'
import { measureJsonText, RESOURCE_DATA_DEPTH, SNAPSHOT_MAX_RAW_BYTES } from '@nerve-office/contracts'
import { CsvOperationError } from './csv-operation-error.ts'

/** 只检查候选的容量；结构与资源的完整合法性仍由原打开自检/服务端负责。 */
export function assertCsvSnapshot(snapshot: IWorkbookData): void {
  const text = JSON.stringify(snapshot)
  const count = { entries: 0 }
  if (new TextEncoder().encode(text).byteLength > SNAPSHOT_MAX_RAW_BYTES
    || measureJsonText(text, 1, count) !== undefined) {
    throw new CsvOperationError('capacity')
  }
  for (const resource of snapshot.resources ?? []) {
    if (resource.data !== '' && measureJsonText(resource.data, RESOURCE_DATA_DEPTH, count) !== undefined)
      throw new CsvOperationError('capacity')
  }
}

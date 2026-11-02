export type CsvOperationReason = 'unavailable' | 'read-only' | 'sheet-missing' | 'capacity' | 'formula-pending' | 'insert-failed'

export class CsvOperationError extends Error {
  override readonly name = 'CsvOperationError'
  readonly reason: CsvOperationReason

  constructor(reason: CsvOperationReason) {
    super(`CSV ${reason}`)
    this.reason = reason
  }
}

// 把应用的日志收进内存，按行解析成对象（应用的日志是 JSON，每行一条）。
export type LogEntry = Record<string, unknown>

export interface LogCapture {
  /** 交给 createApplication 的 logDestination */
  destination: { write: (line: string) => void }
  /** 原始文本，用来断言"没有出现"某个值 */
  text: () => string
  entries: () => LogEntry[]
}

export function captureLogs(): LogCapture {
  const lines: string[] = []
  return {
    destination: { write: line => void lines.push(line) },
    text: () => lines.join(''),
    entries: () => lines.map(line => JSON.parse(line) as LogEntry),
  }
}

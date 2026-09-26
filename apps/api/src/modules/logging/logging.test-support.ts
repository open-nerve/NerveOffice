// 测试用：把 pino 的输出收进内存，按行解析成对象。
import type { DestinationStream } from 'pino'

export interface LogCapture {
  destination: DestinationStream
  entries: () => Record<string, unknown>[]
}

export function captureLogs(): LogCapture {
  const lines: string[] = []
  return {
    destination: { write: (line: string) => void lines.push(line) },
    entries: () => lines.map(line => JSON.parse(line) as Record<string, unknown>),
  }
}

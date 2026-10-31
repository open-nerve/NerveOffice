/** 仅供有界容器协议读取：拒绝每层重复键、深度溢出和非有限 JSON 数值。 */
import { Buffer } from 'node:buffer'

export function parseContainerJson(raw: string): unknown {
  if (Buffer.byteLength(raw) > 64 * 1024)
    throw new Error('container-json-size')
  const stack: (Set<string> | undefined)[] = []
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index]
    if (char === '{' || char === '[') {
      stack.push(char === '{' ? new Set() : undefined)
      if (stack.length > 64)
        throw new Error('container-json-depth')
    }
    else if (char === '}' || char === ']') {
      stack.pop()
    }
    else if (char === '"') {
      const start = index
      for (index += 1; index < raw.length; index += 1) {
        if (raw[index] === '\\')
          index += 1
        else if (raw[index] === '"')
          break
      }
      // JSON.parse validates escapes, control characters and the closing quote.
      const key: unknown = JSON.parse(raw.slice(start, index + 1))
      let next = index + 1
      while (next < raw.length && /[ \t\r\n]/.test(raw.charAt(next)))
        next += 1
      if (raw[next] === ':' && typeof key === 'string') {
        const keys = stack.at(-1)
        if (keys === undefined || keys.has(key))
          throw new Error('container-json-duplicate-key')
        keys.add(key)
      }
    }
  }
  // Syntax is still checked by the native parser; no decision uses its last-key-wins result.
  return JSON.parse(raw, (_key, value: unknown) => {
    if (typeof value === 'number' && !Number.isFinite(value))
      throw new Error('container-json-number')
    return value
  }) as unknown
}

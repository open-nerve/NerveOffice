/**
 * "包含关键词"的 LIKE / ILIKE 模式：关键词里的 \、%、_ 转义，按字面匹配（PostgreSQL 默认的转义字符是反斜杠）。
 * 例如搜索"50%"不会匹配所有以 50 开头的名字。
 */
export function containsPattern(keyword: string): string {
  return `%${keyword.replaceAll(/[\\%_]/g, match => `\\${match}`)}%`
}

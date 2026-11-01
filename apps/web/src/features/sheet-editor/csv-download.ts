function filenamePart(value: string, fallback: string): string {
  const encoder = new TextEncoder()
  let result = ''
  let bytes = 0
  // 留出组合分隔符与扩展名；中文/emoji 文件名也不会超过常见文件系统的 255 字节上限。
  for (const char of value) {
    const code = char.charCodeAt(0)
    const safe = code < 32 || code === 127 || '/\\:*?"<>|'.includes(char) ? '_' : char
    bytes += encoder.encode(safe).byteLength
    if (bytes > 112 || result.length + safe.length > 79)
      break
    result += safe
  }
  return result.trim() || fallback
}

export function csvFilename(title: string, sheet: string): string {
  return `${filenamePart(title, '表格')}-${filenamePart(sheet, '工作表')}.csv`
}

/** 下载不持久化 bytes；即使挂载或点击失败，本轮 DOM 与 Blob URL 也会释放。 */
export function downloadCsv(bytes: Uint8Array, filename: string): void {
  const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: 'text/csv;charset=utf-8' }))
  let anchor: HTMLAnchorElement | undefined
  try {
    anchor = document.createElement('a')
    anchor.href = url
    anchor.download = filename
    anchor.hidden = true
    document.body.append(anchor)
    anchor.click()
  }
  finally {
    anchor?.remove()
    URL.revokeObjectURL(url)
  }
}

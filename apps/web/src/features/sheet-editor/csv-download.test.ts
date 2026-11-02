import { afterEach, describe, expect, it, vi } from 'vitest'
import { csvFilename, downloadCsv } from './csv-download.ts'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('CSV 下载资源', () => {
  it.each([false, true])('下载点击失败=%s 时仍移除 anchor 并释放本轮 URL', (fails) => {
    const created: Blob[] = []
    const released: string[] = []
    vi.stubGlobal('URL', { createObjectURL: (blob: Blob) => {
      created.push(blob)
      return 'blob:本轮'
    }, revokeObjectURL: (url: string) => {
      released.push(url)
    } })
    const seen: { name: string, href: string, attached: boolean }[] = []
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      seen.push({ name: this.download, href: this.getAttribute('href')!, attached: this.isConnected })
      if (fails)
        throw new Error('下载拒绝')
    })
    const run = () => downloadCsv(new Uint8Array([239, 187, 191, 49]), '预算-表.csv')
    if (fails)
      expect(run).toThrow('下载拒绝')
    else run()
    expect(seen).toEqual([{ name: '预算-表.csv', href: 'blob:本轮', attached: true }])
    expect(created[0]?.size).toBe(4)
    expect(created[0]?.type).toBe('text/csv;charset=utf-8')
    expect(document.querySelector('a[download]')).toBeNull()
    expect(released).toEqual(['blob:本轮'])
  })

  it('文件名不携带路径、控制符或无界标题，仍保留中文和扩展名', () => {
    expect(csvFilename('预算/2026\n', '../第一\\页:*?"<>|')).toBe('预算_2026_-.._第一_页_______.csv')
    expect(csvFilename('', '')).toBe('表格-工作表.csv')
    const long = csvFilename('字'.repeat(1_000), '表'.repeat(1_000))
    expect(long.length).toBeLessThanOrEqual(164)
    expect(new TextEncoder().encode(long).byteLength).toBeLessThanOrEqual(240)
    expect(long.endsWith('.csv')).toBe(true)
  })
})

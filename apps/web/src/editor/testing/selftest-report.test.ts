// 页面自检的结果（selftest-report.ts）：编码之后放进地址、收集端解开；不是这个格式的一律拒绝；什么算通过；
// 入口页登录之后跳去的编辑器页的地址。
import type { SelftestReport } from './selftest-report.ts'
import { DOCUMENT_PAGE_PATTERN, documentPagePath } from '@nerve-office/contracts'
import { describe, expect, it } from 'vitest'
import { decodeSelftestReport, encodeSelftestReport, isSelftestScenario, NEXT_PARAM, nextProblem, parseSelftestReport, reportUrl, RESULT_PARAM, SELFTEST_PARAM, SELFTEST_REPORT_FORMAT, selftestEditorUrl, selftestPassed, SelftestReportError } from './selftest-report.ts'

function report(overrides: Partial<SelftestReport> = {}): SelftestReport {
  return {
    format: SELFTEST_REPORT_FORMAT,
    scenario: 'read-only',
    documentId: '01a0fb60-a504-7c95-8bdf-8aeaec893aaf',
    userAgent: 'Mozilla/5.0 (Macintosh) Safari/605.1.15',
    startedAt: '2026-10-04T01:00:00.000Z',
    finishedAt: '2026-10-04T01:00:09.000Z',
    page: { state: 'ready', readOnly: true },
    visibility: ['2026-10-04T01:00:00.000Z visible'],
    checks: [{ id: 'facade.筛选', pass: true, detail: '取消了 sheet.mutation.set-filter-range', ms: 3 }],
    pageErrors: [],
    consoleErrors: [],
    ignoredNotices: [],
    ...overrides,
  }
}

/** 按收集端的写法编码任意文字（gzip、base64url）：构造不是自检结果的输入 */
async function gzipBase64Url(text: string): Promise<string> {
  const plain = new TextEncoder().encode(text)
  const source = new ReadableStream<Uint8Array<ArrayBuffer>>({
    start(controller) {
      controller.enqueue(plain)
      controller.close()
    },
  })
  const bytes = new Uint8Array(await new Response(source.pipeThrough(new CompressionStream('gzip'))).arrayBuffer())
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

describe('页面自检的结果：编码与解开', () => {
  it('编码之后只有地址里不用转义的字符，解开之后与原来的相同（含中文、formulaValues 与切换的耗时）', async () => {
    const original = report({
      formulaValues: { 'sheet-1!G2': '苹果-12', 'sheet-1!B7': 70 },
      consoleErrors: ['警告：一段很长的文字'.repeat(40)],
      timings: [{ id: 'switch.enter', ms: { ready: 431.2, steady: 3390, content: null } }],
    })
    const encoded = await encodeSelftestReport(original)
    expect(encoded).toMatch(/^[\w-]+$/)
    expect(await decodeSelftestReport(encoded)).toEqual(original)
  })

  it('结果加在 next 的查询参数上，next 原有的参数保留', () => {
    const url = new URL(reportUrl('http://127.0.0.1:4300/report?step=2', 'abc_-'))
    expect(url.searchParams.get('step')).toBe('2')
    expect(url.searchParams.get(RESULT_PARAM)).toBe('abc_-')
  })

  it('解不开的一律拒绝：不是 base64url、不是 gzip、不是 JSON、不是这个格式', async () => {
    await expect(decodeSelftestReport('a+b/c=')).rejects.toBeInstanceOf(SelftestReportError)
    await expect(decodeSelftestReport('bm90IGd6aXA')).rejects.toBeInstanceOf(SelftestReportError)
    await expect(decodeSelftestReport(await gzipBase64Url('{不是 JSON'))).rejects.toThrow('不是 JSON')
    await expect(decodeSelftestReport(await gzipBase64Url(JSON.stringify({ format: 'other' })))).rejects.toThrow(SELFTEST_REPORT_FORMAT)
  })

  it.each([
    ['少了 scenario', { scenario: undefined }],
    ['checks 不是数组', { checks: {} }],
    ['某项检查缺了 pass', { checks: [{ id: 'x', detail: '', ms: 1 }] }],
    ['页面的状态不认识', { page: { state: 'unknown' } }],
    ['页面错误不是字符串', { pageErrors: [1] }],
    ['formulaValues 不是对象', { formulaValues: [] }],
    ['timings 不是数组', { timings: {} }],
    ['某项计时缺了 id', { timings: [{ ms: {} }] }],
    ['计时里有不是数字的值', { timings: [{ id: 'switch.enter', ms: { ready: '431' } }] }],
    ['计时里有不是有限的数', { timings: [{ id: 'switch.enter', ms: { ready: Number.NaN } }] }],
    ['failure 不是字符串', { failure: 1 }],
  ])('字段不对时拒绝：%s', (_case, overrides) => {
    expect(() => parseSelftestReport({ ...report(), ...overrides })).toThrow(SelftestReportError)
  })
})

describe('页面自检的结果只交给本机（M3-P2 复核 B7）', () => {
  it('本机的源可以：127.0.0.1 与 localhost，端口不限（驱动脚本的收集端、E2E 拦下的地址）', () => {
    for (const next of ['http://127.0.0.1:4200/report?step=2', 'http://localhost:51234/selftest-collector/report', 'http://127.0.0.1/report', 'http://LOCALHOST:8080/'])
      expect(nextProblem(next), next).toBeUndefined()
  })

  it('别的一律不行：别的主机、https、看着像本机的主机名、带账户的、IPv6 的本机、不是 http 的、不是完整的地址', () => {
    const rejected = ['http://selftest-collector.invalid/report', 'https://127.0.0.1:4200/report', 'http://127.0.0.1.example.com/', 'http://localhost.example.com/', 'http://user:secret@127.0.0.1:4200/', 'http://[::1]:4200/', 'javascript:alert(1)', 'data:text/html,x', '/report', '']
    for (const next of rejected)
      expect(nextProblem(next), next).toEqual(expect.any(String))
    expect(nextProblem('https://collector.example/report?step=1')).toBe('next 只能是本机的地址（http://127.0.0.1:<端口> 或 http://localhost:<端口>），这里是 https://collector.example')
    expect(nextProblem('javascript:alert(1)')).toBe('next 只能是本机的地址（http://127.0.0.1:<端口> 或 http://localhost:<端口>），这里是 javascript:')
    expect(nextProblem('/report')).toBe('next 不是一个完整的地址')
  })

  it('reportUrl 同样拒绝（兜底：调用方先用 nextProblem 核对、把原因写在页面上）', () => {
    expect(() => reportUrl('https://collector.example/report', 'abc')).toThrow(SelftestReportError)
  })
})

describe('页面自检的入口页：登录之后跳去的编辑器页（M3-P2 复核 B4）', () => {
  it('路径与 contracts 的 documentPagePath 相同（托管与开发服务器按 DOCUMENT_PAGE_PATTERN 交给编辑器页），带着场景与 next', () => {
    const documentId = '01a0fb60-a504-7c95-8bdf-8aeaec893aaf'
    const next = 'http://127.0.0.1:4200/report?step=3'
    const url = new URL(selftestEditorUrl('http://127.0.0.1:4100', documentId, 'enter-exit', next))
    expect(url.origin).toBe('http://127.0.0.1:4100')
    expect(url.pathname).toBe(documentPagePath(documentId))
    expect(DOCUMENT_PAGE_PATTERN.test(url.pathname)).toBe(true)
    expect(Object.fromEntries(url.searchParams)).toEqual({ [SELFTEST_PARAM]: 'enter-exit', [NEXT_PARAM]: next })
  })

  it('文档 id 里有路径的分隔符与查询串的字符时转义：跳不出编辑器页的路径，也加不进别的参数', () => {
    const url = new URL(selftestEditorUrl('http://127.0.0.1:4100', '../admin?next=x', 'read-only', 'http://127.0.0.1:4200/'))
    expect(url.pathname).toBe('/documents/..%2Fadmin%3Fnext%3Dx')
    expect(url.searchParams.get(NEXT_PARAM)).toBe('http://127.0.0.1:4200/')
  })
})

describe('页面自检的结果：什么算通过', () => {
  it('页面就绪、有检查、每项都通过、没有页面错误与 console.error、没有没跑完的原因', () => {
    expect(selftestPassed(report())).toBe(true)
    expect(selftestPassed(report({ checks: [] }))).toBe(false)
    expect(selftestPassed(report({ checks: [{ id: 'x', pass: false, detail: '', ms: 1 }] }))).toBe(false)
    expect(selftestPassed(report({ pageErrors: ['TypeError: x'] }))).toBe(false)
    expect(selftestPassed(report({ consoleErrors: ['出错了'] }))).toBe(false)
    expect(selftestPassed(report({ page: { state: 'timeout' } }))).toBe(false)
    expect(selftestPassed(report({ page: { state: 'hidden', detail: '页面在后台' } }))).toBe(false)
    expect(selftestPassed(report({ failure: '编辑器页没有就绪' }))).toBe(false)
  })

  it('场景只认登记的四个', () => {
    expect(['read-only', 'read-only-formulas', 'edit-chrome', 'enter-exit'].every(isSelftestScenario)).toBe(true)
    expect(isSelftestScenario('editing')).toBe(false)
  })
})

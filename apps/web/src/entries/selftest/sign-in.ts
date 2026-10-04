// 页面自检的入口页（M3-P2 设计 §3.5，只在测试构建里）：从地址的 # 片段读测试账户与要跑的场景，同源登录，再整页跳到编辑器页，
// 带上 selftest=<场景> 与 next=<自检结束之后跳去的地址>（驱动脚本起的收集端，tests/e2e/safari/selftest.ts）。
// 片段的写法（URLSearchParams）：user、password、document（文档 id）、scenario（场景）、next。
// 片段不发给服务器、不进访问日志；读完马上从地址里去掉，浏览器的历史记录里也就没有测试账户的密码。
// 登录失败或片段不全时，同样把结果（failure 写明原因）带到 next：驱动脚本不必等到超时。
import type { SelftestReport } from '../../editor/testing/selftest-report.ts'
import { documentPagePath, sessionResponseSchema } from '@nerve-office/contracts'
import { encodeSelftestReport, NEXT_PARAM, reportUrl, SELFTEST_PARAM, SELFTEST_REPORT_FORMAT } from '../../editor/testing/selftest-report.ts'
import { apiRequest } from '../../shared/api/index.ts'

function show(text: string): void {
  const status = document.getElementById('status')
  if (status !== null)
    status.textContent = text
}

function failureReport(scenario: string, documentId: string, startedAt: string, failure: string): SelftestReport {
  return {
    format: SELFTEST_REPORT_FORMAT,
    scenario,
    documentId,
    userAgent: navigator.userAgent,
    startedAt,
    finishedAt: new Date().toISOString(),
    page: { state: 'failed', detail: failure },
    visibility: [`${startedAt} ${document.visibilityState}`],
    checks: [],
    pageErrors: [],
    consoleErrors: [],
    ignoredNotices: [],
    failure,
  }
}

async function main(): Promise<void> {
  const startedAt = new Date().toISOString()
  const fragment = new URLSearchParams(window.location.hash.slice(1))
  history.replaceState(null, '', `${window.location.pathname}${window.location.search}`)
  const user = fragment.get('user') ?? ''
  const password = fragment.get('password') ?? ''
  const documentId = fragment.get('document') ?? ''
  const scenario = fragment.get('scenario') ?? ''
  const next = fragment.get(NEXT_PARAM)
  if (next === null) {
    show('地址的 # 片段里没有 next：不知道结果交给谁')
    return
  }
  try {
    if (user === '' || password === '' || documentId === '' || scenario === '')
      throw new Error('地址的 # 片段不全：要有 user、password、document、scenario 与 next')
    show(`以 ${user} 登录…`)
    await apiRequest('/api/auth/login', { method: 'POST', body: { username: user, password }, schema: sessionResponseSchema })
  }
  catch (error) {
    const failure = `登录失败：${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`
    show(failure)
    window.location.replace(reportUrl(next, await encodeSelftestReport(failureReport(scenario, documentId, startedAt, failure))))
    return
  }
  const target = new URL(documentPagePath(documentId), window.location.origin)
  target.searchParams.set(SELFTEST_PARAM, scenario)
  target.searchParams.set(NEXT_PARAM, next)
  show(`打开 ${target.pathname}…`)
  window.location.replace(target.href)
}

void main()

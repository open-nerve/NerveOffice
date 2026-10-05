// 页面自检的入口页（M3-P2 设计 §3.5，只在测试构建里）：从地址的 # 片段读测试账户与要跑的场景，同源登录，再整页跳到编辑器页，
// 带上 selftest=<场景> 与 next=<自检结束之后跳去的地址>（驱动脚本起的收集端，tests/e2e/safari/selftest.ts）。
// 片段的写法（URLSearchParams）：user、password、document（文档 id）、scenario（场景）、next，可选的 formula（公式模式，
// 测试构建的开关：main 是主线程模式，M3-P4 设计 §3.14；原样带到编辑器页的地址上）。
// 片段不发给服务器、不进访问日志；读完马上用 replaceState 从地址栏与会话历史里去掉。
// 跳到编辑器页之前在 sessionStorage 里暂停定时的自动保存（SELFTEST_AUTOSAVE_HOLD，M3-P4 S7 审查 B1）。
// next 只能是本机的地址（nextProblem，M3-P2 复核 B7）：不是时不登录、不跳转，原因写在页面上。
// 登录失败或片段不全时，同样把结果（failure 写明原因）带到 next：驱动脚本不必等到超时。
// 不引用平台页面与编辑器页共用的任何模块（contracts、shared/api、zod 都不用，登录用原生的 fetch；M3-P2 复核 B4）：
// 引用了，那些模块在测试构建里成了三个入口共用的，分块的拆法随之改变，平台页面与编辑器页的入口块就与生产构建的不同，
// E2E 测的不再是生产的样子。只引用结果的格式（editor/testing/selftest-report.ts，它不引用任何模块；lint 只放行它）
import type { SelftestReport } from '../../editor/testing/selftest-report.ts'
import { encodeSelftestReport, FORMULA_MODE_PARAM, FORMULA_MODE_VALUES, formulaModeOfValue, NEXT_PARAM, nextProblem, reportUrl, SELFTEST_AUTOSAVE_HOLD, SELFTEST_REPORT_FORMAT, selftestEditorUrl } from '../../editor/testing/selftest-report.ts'

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

/** 错误回答里的错误码与说明（与接口的错误格式 { error: { code, message } } 相同）；读不出来时说明为什么 */
async function errorOf(response: Response): Promise<string> {
  try {
    const body = await response.json() as { readonly error?: { readonly code?: unknown, readonly message?: unknown } }
    const parts = [body.error?.code, body.error?.message].filter(part => typeof part === 'string')
    return parts.length === 0 ? '（回答里没有错误的说明）' : parts.join(' ')
  }
  catch {
    return '（回答不是 JSON）'
  }
}

/**
 * 登录：与平台页面的登录同一个接口（POST /api/auth/login，JSON 的请求体）。登录是公开的接口，新打开的页面还没有 CSRF 令牌，
 * 平台页面的请求层这时也不带它；同源的请求由浏览器带上 Origin。登录成功时服务端下发会话的 Cookie，回答的内容这里用不到
 */
async function signIn(username: string, password: string): Promise<void> {
  const response = await fetch('/api/auth/login', {
    method: 'POST',
    headers: { 'accept': 'application/json', 'content-type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({ username, password }),
  })
  if (!response.ok)
    throw new Error(`登录的回答是 ${response.status}：${await errorOf(response)}`)
}

async function main(): Promise<void> {
  const startedAt = new Date().toISOString()
  const fragment = new URLSearchParams(window.location.hash.slice(1))
  history.replaceState(null, '', `${window.location.pathname}${window.location.search}`)
  const user = fragment.get('user') ?? ''
  const password = fragment.get('password') ?? ''
  const documentId = fragment.get('document') ?? ''
  const scenario = fragment.get('scenario') ?? ''
  const formula = formulaModeOfValue(fragment.get(FORMULA_MODE_PARAM))
  const next = fragment.get(NEXT_PARAM)
  if (next === null) {
    show('地址的 # 片段里没有 next：不知道结果交给谁')
    return
  }
  const problem = nextProblem(next)
  if (problem !== undefined) {
    show(`不登录、不跳转：${problem}`)
    return
  }
  try {
    if (user === '' || password === '' || documentId === '' || scenario === '')
      throw new Error('地址的 # 片段不全：要有 user、password、document、scenario 与 next')
    if (formula === null)
      throw new Error(`地址的 # 片段里 ${FORMULA_MODE_PARAM} 只能是 ${Object.values(FORMULA_MODE_VALUES).join(' 或 ')}`)
    show(`以 ${user} 登录…`)
    await signIn(user, password)
  }
  catch (error) {
    const failure = `登录失败：${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`
    show(failure)
    window.location.replace(reportUrl(next, await encodeSelftestReport(failureReport(scenario, documentId, startedAt, failure))))
    return
  }
  const target = selftestEditorUrl(window.location.origin, documentId, scenario, next, formula ?? undefined)
  holdTimedAutosave()
  show(`打开 ${new URL(target).pathname}…`)
  window.location.replace(target)
}

/**
 * 打开编辑器页之前暂停定时的自动保存（SELFTEST_AUTOSAVE_HOLD，M3-P4 S7 审查 B1）：不验证自动保存的场景从打开起就不会按时上传，
 * 与 Playwright 的夹具默认的一样；捕获时机的场景开始时自己放开。sessionStorage 写不进去（隐私模式等）时照样跳转：自检开始时还会再暂停一次
 */
function holdTimedAutosave(): void {
  try {
    sessionStorage.setItem(SELFTEST_AUTOSAVE_HOLD.key, SELFTEST_AUTOSAVE_HOLD.value)
  }
  catch {
    // 见上
  }
}

void main()

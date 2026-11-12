// CI 的接线（规范 §9，M2-P6 第 6 片复核 S1）：plan.test.ts 只守住 plan.ts 这一层（两个分片合起来与完整的一套相同），
// .github/workflows/ci.yml 实际跑哪个分片、E2E 的浏览器矩阵里有哪些、有没有容器 E2E 的 job，原来都没有检查——
// 工作流里漏了一个分片、矩阵里少了一个浏览器，CI 照样全绿。这里解析工作流，与 plan.ts 和 E2E 的浏览器表核对。
// 不让检查悄悄少跑的写法一并拦下（复核第二批 S-1）：矩阵的 exclude、include，执行检查的 job 与步骤上的 if，
// 步骤级的 env 改掉 CI 或 E2E_BROWSERS。
import process from 'node:process'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { commandText, readText } from '../shared/repo.ts'
import { parseArgs, planSteps } from './plan.ts'
import { parseWorkflow, PLAYWRIGHT_CONFIG, playwrightBrowsers, runsChecks, stepLabel, verifyArgs, workflowWith as workflowTextWith } from './workflow.test-support.ts'

const WORKFLOW = '.github/workflows/ci.yml'
// eslint-disable-next-line no-template-curly-in-string -- GitHub Actions 的表达式原文，不是模板字符串
const MATRIX_BROWSER = '${{ matrix.browser }}'
// eslint-disable-next-line no-template-curly-in-string -- GitHub Actions 的表达式原文，只在 WebKit 分片启用现有补证
const WEBKIT_LOGIN_POPUP_DIAGNOSTIC = '${{ matrix.browser == \'webkit\' && \'1\' || \'\' }}'

const workflow = parseWorkflow(readText(WORKFLOW))

/**
 * CI 与本机完整的一套（pnpm verify 不带参数）只差这两步（plan.ts）：数据库由服务容器提供，CI 不执行 database；
 * CI 另加漏洞扫描 audit。除此之外，工作流的各个分片合起来要恰好是本机完整的一套
 */
const LOCAL_ONLY_STEPS: readonly string[] = ['database']
const CI_ONLY_STEPS: readonly string[] = ['audit']

/**
 * 工作流的分片与本机完整的一套是否等价（Codex 评审 CX7）：每一处 pnpm verify 都用 CI 上真正执行的那个 parseArgs 解析，
 * 拿解析出的全部选项算出这个 job 真正执行的步骤（planSteps），各个 job 合起来与本机完整的一套比较。
 * 原来只取解析结果里的分片名、比较时另造一份固定的选项（fast 为假），工作流里多写一个 --fast，no-e2e 那片实际只跑
 * lint、类型检查、单元测试与静态检查（少了集成测试与覆盖率、产物门禁），这条核对照样通过。
 * 返回不等价之处的说明，等价时为空
 */
function shardingProblems(text: string): string[] {
  const runs = Object.entries(parseWorkflow(text).jobs).flatMap(([id, job]) => verifyArgs(job).map(args => ({ id, parsed: parseArgs(args) })))
  const problems: string[] = []
  const shards: { readonly id: string, readonly scope: string, readonly steps: readonly string[] }[] = []
  for (const { id, parsed } of runs) {
    if (!parsed.ok)
      problems.push(`${id}：pnpm verify 不认得这些参数（${parsed.error}）`)
    else if (!parsed.options.ci)
      problems.push(`${id}：CI 上要带 --ci`)
    else
      shards.push({ id, scope: parsed.options.scope ?? 'all', steps: planSteps(parsed.options).map(step => step.id) })
  }
  // 每个分片只跑一次：verify 跑 no-e2e，e2e（按浏览器的矩阵）跑 e2e
  const scopes = shards.map(shard => `${shard.id}:${shard.scope}`)
  if (scopes.join(' ') !== 'verify:no-e2e e2e:e2e')
    problems.push(`分片应为 verify:no-e2e 与 e2e:e2e，实际是 ${scopes.join('、') || '（没有）'}`)
  const local = parseArgs([])
  if (!local.ok)
    throw new Error(`本机的 pnpm verify 不带参数却解析失败：${local.error}`)
  const expected = new Set([...planSteps(local.options).map(step => step.id).filter(id => !LOCAL_ONLY_STEPS.includes(id)), ...CI_ONLY_STEPS])
  const actual = new Set(shards.flatMap(shard => shard.steps))
  const missing = [...expected].filter(id => !actual.has(id))
  const extra = [...actual].filter(id => !expected.has(id))
  if (missing.length > 0 || extra.length > 0)
    problems.push(`各分片合起来与本机完整的一套不同：少了 ${missing.join('、') || '（无）'}，多了 ${extra.join('、') || '（无）'}`)
  return problems
}

/** 在内存里改 ci.yml 的文字（不改文件）：要换掉的那一段必须恰好出现一次 */
function workflowWith(original: string, replacement: string): string {
  return workflowTextWith(WORKFLOW, original, replacement)
}

describe('US-M1-11 CI 的接线与 pnpm verify 的分片一致（规范 §9）', () => {
  it('推送 main 之后与每周定时各执行一次', () => {
    expect(workflow.on.push?.branches).toEqual(['main'])
    expect(workflow.on.schedule?.length).toBe(1)
  })

  it('verify 与 e2e 两个 job 按工作流里真实的参数执行的步骤，合起来与本机完整的一套相同（另加漏洞扫描、数据库由服务容器提供），每个分片只跑一次；参数都是 pnpm verify 认得的', () => {
    expect(shardingProblems(readText(WORKFLOW))).toEqual([])
  })

  // CX7 的变异原先由步骤等价性核对发现少跑的步骤；M5-P8 S4（独立审查 M-1）起 parseArgs 直接拒绝 --fast 与分片同给，
  // 分片名不变而实际步骤变少的写法在解析这一步就拦下，变异照样不能通过
  it.each([
    ['no-e2e 那片多了 --fast：少跑集成测试与覆盖率、产物门禁', 'run: pnpm verify --ci --keep-going --scope=no-e2e', 'run: pnpm verify --ci --keep-going --fast --scope=no-e2e', 'verify', 'no-e2e'],
    ['e2e 那片多了 --fast：不构建、不跑 E2E', 'run: pnpm verify --ci --keep-going --scope=e2e', 'run: pnpm verify --ci --fast --keep-going --scope=e2e', 'e2e', 'e2e'],
  ])('改变计划的参数（Codex 评审 CX7 的变异，在内存里改工作流的文字）：%s，解析即拒绝', (_name, original, replacement, job, scope) => {
    const problems = shardingProblems(workflowWith(original, replacement))
    expect(problems[0]).toMatch(new RegExp(`^${job}：pnpm verify 不认得这些参数（--fast 不分片：快速门禁只有一套步骤，不能与 --scope=${scope} 一起给。`))
  })

  it('verify 那片改成跑完整的一套（--scope=all）：E2E 跑两遍，分片的核对失败', () => {
    const problems = shardingProblems(workflowWith('run: pnpm verify --ci --keep-going --scope=no-e2e', 'run: pnpm verify --ci --keep-going --scope=all'))
    expect(problems).toEqual(['分片应为 verify:no-e2e 与 e2e:e2e，实际是 verify:all、e2e:e2e'])
  })

  it('E2E 的浏览器矩阵是浏览器表里的全部浏览器（本机三个，另加 Edge），每片只跑自己的浏览器，装的也是它', () => {
    const e2e = workflow.jobs.e2e
    expect(e2e).toBeDefined()
    // 矩阵里只有 browser 一项：exclude 去掉某个浏览器、include 给某片另加变量，都会让实际跑的组合与列出的不同（复核第二批 S-1）
    expect(Object.keys(e2e?.strategy?.matrix ?? {}), '矩阵只有 browser（不用 exclude、include）').toEqual(['browser'])
    const matrix = z.strictObject({ browser: z.array(z.string()) }).parse(e2e?.strategy?.matrix)
    const browsers = playwrightBrowsers(readText(PLAYWRIGHT_CONFIG))
    expect(browsers).toEqual(expect.arrayContaining(['chromium', 'chrome', 'webkit', 'msedge']))
    expect([...matrix.browser].sort()).toEqual([...browsers].sort())
    // 不设 E2E_BROWSERS 时每片都跑全部浏览器；一片失败不取消别的片
    expect(e2e?.env?.E2E_BROWSERS).toBe(MATRIX_BROWSER)
    expect(e2e?.strategy?.['fail-fast']).toBe(false)
    expect(e2e?.steps.some(step => (step.run ?? '').includes(`playwright install --with-deps ${MATRIX_BROWSER}`))).toBe(true)
  })

  it('另有容器 E2E 的 job（生产镜像，规范 §9）', () => {
    expect(workflow.jobs.container?.steps.some(step => step.run?.trim() === 'pnpm test:e2e:container')).toBe(true)
  })

  it('仅 WebKit 整批外层窗口增加 30 分钟，原六项与独立退出收尾窗口保持', () => {
    // 固定条件表达式约束真实工作流；不另造 GitHub 表达式求值器。
    // eslint-disable-next-line no-template-curly-in-string -- GitHub Actions 的表达式原文
    expect(workflow.jobs.e2e?.['timeout-minutes']).toBe('${{ matrix.browser == \'webkit\' && 170 || 140 }}')
    const steps = workflow.jobs.e2e!.steps
    const checking = steps.filter(runsChecks)
    expect(checking).toHaveLength(1)
    // eslint-disable-next-line no-template-curly-in-string -- GitHub Actions 的表达式原文
    expect(checking[0]?.['timeout-minutes']).toBe('${{ matrix.browser == \'webkit\' && 145 || 115 }}')
    expect(steps.find(step => step.id === 'e2e-quiescence')?.['timeout-minutes']).toBe(17)
    expect(workflow.jobs.verify?.['timeout-minutes']).toBe(45)
    expect(workflow.jobs.container?.['timeout-minutes']).toBe(45)
  })

  it('登录 popup 导航补证只在 WebKit 矩阵启用，不影响其他浏览器、verify 或容器；全局与步骤不能覆盖开关', () => {
    expect(workflow.env?.E2E_LOGIN_POPUP_DIAGNOSTIC).toBeUndefined()
    // 固定条件表达式直接约束真实工作流，不另造 GitHub 表达式求值器。
    expect(workflow.jobs.e2e?.env?.E2E_LOGIN_POPUP_DIAGNOSTIC).toBe(WEBKIT_LOGIN_POPUP_DIAGNOSTIC)
    for (const [id, job] of Object.entries(workflow.jobs)) {
      if (id !== 'e2e')
        expect(job.env?.E2E_LOGIN_POPUP_DIAGNOSTIC, id).toBeUndefined()
      for (const step of job.steps)
        expect(step.env?.E2E_LOGIN_POPUP_DIAGNOSTIC, stepLabel(id, step)).toBeUndefined()
    }
  })

  it('关闭阶段补证（含协议记录）只在 Chrome、Edge 分片启用，不能扩大到其他 job 或被步骤覆盖', () => {
    expect(workflow.env?.E2E_CONTEXT_CLOSE_DIAGNOSTIC).toBeUndefined()
    // eslint-disable-next-line no-template-curly-in-string -- 实际 GitHub 矩阵开关，不另造表达式求值器
    expect(workflow.jobs.e2e?.env?.E2E_CONTEXT_CLOSE_DIAGNOSTIC).toBe('${{ (matrix.browser == \'chrome\' || matrix.browser == \'msedge\') && \'1\' || \'\' }}')
    for (const [id, job] of Object.entries(workflow.jobs)) {
      if (id !== 'e2e')
        expect(job.env?.E2E_CONTEXT_CLOSE_DIAGNOSTIC, id).toBeUndefined()
      for (const step of job.steps)
        expect(step.env?.E2E_CONTEXT_CLOSE_DIAGNOSTIC, stepLabel(id, step)).toBeUndefined()
    }
  })

  it('CI 上 E2E 重试一次，出现重试（重试之后才通过）就让这次运行失败；本机不重试（规范 §8.4，M2-P6 第 6 片复核 M4）', () => {
    // 取 Playwright 解析之后的配置（列举用例时输出的 config）：与 CI 上真正生效的是同一份
    const resolved = (ci: boolean): { failOnFlakyTests: boolean, retries: number[] } => {
      const output = commandText('pnpm', ['--silent', '--filter', '@nerve-office/e2e', 'run', 'list'], { env: { ...process.env, CI: ci ? 'true' : '', E2E_BROWSERS: 'chromium' } })
      const { config } = z.object({ config: z.object({ failOnFlakyTests: z.boolean(), projects: z.array(z.object({ retries: z.number() })) }) }).parse(JSON.parse(output))
      return { failOnFlakyTests: config.failOnFlakyTests, retries: [...new Set(config.projects.map(project => project.retries))] }
    }
    expect(resolved(true)).toEqual({ failOnFlakyTests: true, retries: [1] })
    expect(resolved(false)).toEqual({ failOnFlakyTests: false, retries: [0] })
  }, 60_000)

  it('每个 job 都在 CI=true 下执行（E2E 的重试与"出现重试即失败"按它生效，playwright.config.ts），没有哪一步或哪个 job 失败了也算通过（只有三步只读磁盘诊断例外，D-09）', () => {
    for (const [id, job] of Object.entries(workflow.jobs)) {
      expect(job.env?.CI, id).toBe('true')
      expect(job['continue-on-error'], id).toBeUndefined()
      for (const step of job.steps) {
        // 磁盘诊断失败只告警，不影响后续步骤与 job 结论（M5R-M-18）；其余任何一步都不能失败了也算通过
        expect(step['continue-on-error'], stepLabel(id, step)).toBe(step.run?.startsWith('python3 -B tools/test-resources/ci_disk_diagnostic.py ') === true ? true : undefined)
        // 步骤级的 env 盖过 job 的：CI 改掉了重试与"出现重试即失败"就不生效，E2E_BROWSERS 改掉了每片都跑同一个浏览器（复核第二批 S-1）
        expect(Object.keys(step.env ?? {}).filter(name => ['CI', 'E2E_BROWSERS', 'NERVE_TEST_RESOURCE_POLICY', 'NERVE_TEST_LSOF_MODE'].includes(name)), stepLabel(id, step)).toEqual([])
      }
    }
  })

  it('只有固定托管 Ubuntu job 显式使用 VM 回收策略；不再把数据库服务身份当作资源例外', () => {
    expect(Object.keys(workflow.jobs)).toEqual(['verify', 'e2e', 'container'])
    for (const [id, job] of Object.entries(workflow.jobs)) {
      expect(job['runs-on'], id).toBe('ubuntu-24.04')
      expect(job.env?.NERVE_TEST_RESOURCE_POLICY, id).toBe('github-hosted-vm')
      expect(job.env?.NERVE_TEST_LSOF_MODE, id).toBe('github-ubuntu-sudo')
      expect(job.env?.NERVE_TEST_CI_POSTGRES_SERVICE_ID, id).toBeUndefined()
      for (const step of job.steps)
        expect(step.env?.NERVE_TEST_CI_POSTGRES_SERVICE_ID, stepLabel(id, step)).toBeUndefined()
    }
  })

  it('资源能力不成立时在安装依赖与浏览器前停止，预检失败也保存有界回执', () => {
    for (const [id, job] of Object.entries(workflow.jobs)) {
      const preflight = job.steps.findIndex(step => step.id === 'resource-preflight')
      expect(preflight, id).toBeGreaterThanOrEqual(0)
      const step = job.steps[preflight]!
      expect(step.run?.trim()).toBe('python3 -B tools/test-resources/run.py ci-preflight -- /usr/bin/true')
      expect(step.if, id).toBeUndefined()
      expect(step['continue-on-error'], id).toBeUndefined()
      expect(step['timeout-minutes'], id).toBe(3)
      expect(preflight, id).toBeGreaterThan(job.steps.findIndex(item => item.uses?.startsWith('actions/checkout@')))
      expect(preflight, id).toBeLessThan(job.steps.findIndex(item => item.uses?.startsWith('actions/setup-node@')))
      expect(preflight, id).toBeLessThan(job.steps.findIndex(runsChecks))
      const receiptIndex = job.steps.findIndex(item => item.id === 'resource-preflight-receipt')
      expect(receiptIndex, id).toBe(preflight + 1)
      const receipt = job.steps[receiptIndex]!
      expect(receipt.if, id).toBe('always()')
      expect(receipt.run?.trim()).toBe('python3 -B tools/test-resources/ci_preflight_receipt.py')
      expect(receipt['timeout-minutes'], id).toBe(1)
      expect(receipt['continue-on-error'], id).toBeUndefined()
      const installing = job.steps.flatMap((item, index) => (
        item.uses?.startsWith('actions/setup-node@')
        || item.uses?.startsWith('pnpm/action-setup@')
        || /(?:^|\n)\s*pnpm (?:install\b|.*\bplaywright install\b)/.test(item.run ?? '')
      )
        ? [index]
        : [])
      expect(installing.length, id).toBeGreaterThanOrEqual(3)
      for (const index of installing)
        expect(index, stepLabel(id, job.steps[index]!)).toBeGreaterThan(receiptIndex)
    }
  })

  it.each(['verify', 'container'])('%s 的失败产品报告也先核验资源归属与稳定导出；资源核验失败不得上传', (id) => {
    const steps = workflow.jobs[id]!.steps
    const checking = steps.findIndex(runsChecks)
    const resource = steps.findIndex(step => step.id === 'resource-check')
    const upload = steps.findIndex(step => step.id === 'resource-upload')
    expect(resource).toBeGreaterThan(checking)
    expect(steps[resource]?.run?.trim()).toBe('python3 -B tools/test-resources/check_ci_resources.py')
    expect(steps[resource]?.if).toBe('always()')
    expect(steps[resource]?.['continue-on-error']).toBeUndefined()
    expect(upload).toBeGreaterThan(resource)
    expect(steps[upload]?.uses?.startsWith('actions/upload-artifact@')).toBe(true)
    expect(steps[upload]?.if).toBe('always() && steps.resource-check.outcome == \'success\'')
    expect(steps[upload]?.['continue-on-error']).toBeUndefined()
    const reports = z.object({
      'path': z.string(),
      'include-hidden-files': z.boolean().optional(),
      'if-no-files-found': z.string().optional(),
    }).parse(steps[upload]?.with)
    if (id === 'verify') {
      expect(reports.path).toBe('.test-resources/runs/*/reports/portable/test-results/')
      expect(reports['include-hidden-files']).toBe(true)
      expect(reports['if-no-files-found']).toBe('error')
    }
    else {
      expect(reports.path.trim().split('\n')).toEqual([
        'tests/e2e/playwright-report/',
        'tests/e2e/test-results/',
        '.test-resources/runs/*/reports/portable/test-results/',
      ])
      expect(reports['include-hidden-files']).toBe(true)
    }
  })

  it('归档与报告上传必须经过退出和稳定报告核验；归档失败不能回退上传原始 profile', () => {
    const steps = workflow.jobs.e2e!.steps
    const prepare = steps.findIndex(step => step.id === 'e2e-prepare')
    expect(prepare).toBeGreaterThanOrEqual(0)
    expect(prepare).toBeLessThan(steps.findIndex(runsChecks))
    // GitHub 在分配 runner 前解析 job env，那里不能读取 runner.temp（CI 39729684486）。
    // prepare 的 step env 才能解析它；登记成功后经 GITHUB_ENV 交给后续检查与收尾。
    expect(workflow.jobs.e2e?.env?.NERVE_CI_E2E_STATE).toBeUndefined()
    // eslint-disable-next-line no-template-curly-in-string -- GitHub Actions 表达式原文
    expect(steps[prepare]?.env?.NERVE_CI_E2E_STATE).toBe('${{ runner.temp }}/nerve-e2e-${{ github.run_id }}-${{ github.run_attempt }}-${{ matrix.browser }}')
    expect(steps[prepare]?.run?.trim().split('\n')).toEqual([
      'node tools/src/ci/e2e-cli.ts prepare',
      'printf \'NERVE_CI_E2E_STATE=%s\\n\' "$NERVE_CI_E2E_STATE" >> "$GITHUB_ENV"',
    ])
    const quiescence = steps.findIndex(step => step.id === 'e2e-quiescence')
    expect(quiescence).toBeGreaterThan(steps.findIndex(runsChecks))
    expect(steps[quiescence]?.if).toBe('always() && steps.e2e-prepare.outcome == \'success\'')
    const reportCheck = steps.findIndex(step => step.id === 'e2e-report-check')
    expect(reportCheck).toBeGreaterThan(quiescence)
    expect(steps[reportCheck]?.run?.trim()).toBe('node tools/src/ci/e2e-cli.ts reports')
    for (const id of ['profile-archive', 'e2e-upload']) {
      const index = steps.findIndex(step => step.id === id)
      expect(index, id).toBeGreaterThan(quiescence)
      expect(index, id).toBeGreaterThan(reportCheck)
    }
    const archive = steps.findIndex(step => step.id === 'profile-archive')
    const upload = steps.findIndex(step => step.id === 'e2e-upload')
    expect(steps[archive]?.if).toBe('always() && steps.e2e-quiescence.outcome == \'success\' && steps.e2e-report-check.outcome == \'success\'')
    expect(steps[archive]?.run?.trim()).toBe('python3 -B tools/test-resources/pack_ci_profiles.py')
    expect(upload).toBeGreaterThan(archive)
    expect(steps[upload]?.if).toBe('always() && steps.e2e-quiescence.outcome == \'success\' && steps.e2e-report-check.outcome == \'success\' && steps.profile-archive.outcome == \'success\'')
    const reports = z.object({ 'path': z.string(), 'include-hidden-files': z.boolean().optional() }).parse(steps[upload]?.with)
    expect(reports.path.trim().split('\n')).toEqual([
      'tests/e2e/playwright-report/',
      'tests/e2e/test-results/',
      '.test-resources/runs/*/reports/portable/test-results/',
      '.test-resources/runs/*/reports/transport/',
      '!tests/e2e/test-results/persistent-profiles/**',
    ])
    expect(reports['include-hidden-files']).toBe(true)
    expect(steps.find(step => step.id === 'e2e-diagnostics')?.if).toBe('always() && steps.e2e-diagnostics-prepare.outcome == \'success\'')
    expect(steps.find(step => step.id === 'e2e-diagnostics-prepare')?.if).toBe('always() && steps.e2e-prepare.outcome == \'success\'')
    expect(steps.find(step => step.id === 'e2e-report-check')?.['continue-on-error']).toBeUndefined()
    expect(steps.find(step => step.id === 'e2e-report-check')?.if).toBe('always() && steps.e2e-prepare.outcome == \'success\'')
  })

  it('verify 在依赖安装前后与结束时独立收取磁盘诊断；诊断失败只告警、不跳过或否决 verify（D-09），原检查不被包装或放行', () => {
    const steps = workflow.jobs.verify!.steps
    const command = 'python3 -B tools/test-resources/ci_disk_diagnostic.py '
    const before = steps.findIndex(step => step.run === `${command}before-install`)
    const after = steps.findIndex(step => step.run === `${command}after-install`)
    const ended = steps.findIndex(step => step.run === `${command}after-verify`)
    const install = steps.findIndex(step => step.run === 'pnpm install --frozen-lockfile')
    const verify = steps.findIndex(step => step.run === 'pnpm verify --ci --keep-going --scope=no-e2e')
    expect(before).toBeGreaterThan(0)
    expect(before).toBeLessThan(install)
    expect(after).toBeGreaterThan(install)
    expect(after).toBeLessThan(verify)
    expect(ended).toBeGreaterThan(verify)
    for (const index of [before, after, ended]) {
      expect(steps[index]?.['timeout-minutes']).toBe(2)
      expect(steps[index]?.['continue-on-error']).toBe(true)
      expect(steps[index]?.env).toBeUndefined()
    }
    expect(steps[before]?.if).toBeUndefined()
    expect(steps[after]?.if).toBe('always()')
    expect(steps[ended]?.if).toBe('always()')
    expect(steps[verify]?.if).toBeUndefined()
    expect(steps[verify]?.['continue-on-error']).toBeUndefined()
    for (const id of ['e2e', 'container'])
      expect(workflow.jobs[id]?.steps.some(step => step.run?.includes('ci_disk_diagnostic.py'))).toBe(false)
  })

  it('产品检查不会被条件跳过；报告上传必须等待所属资源核验，失败诊断仍独立上传', () => {
    const checking = Object.entries(workflow.jobs).filter(([, job]) => job.steps.some(runsChecks))
    // 三个 job 各执行一种检查：verify 与 e2e 的 pnpm verify，container 的容器 E2E
    expect(checking.map(([id]) => id)).toEqual(['verify', 'e2e', 'container'])
    for (const [id, job] of checking) {
      expect(job.if, `${id}：job 不带 if`).toBeUndefined()
      for (const step of job.steps) {
        const archive = id === 'e2e' && step.id === 'profile-archive'
        const e2eUpload = id === 'e2e' && step.id === 'e2e-upload'
        const resourceCheck = id !== 'e2e' && step.id === 'resource-check'
        const resourceUpload = id !== 'e2e' && step.id === 'resource-upload'
        const ownedCleanup = id === 'e2e' && ['e2e-quiescence', 'e2e-report-check', 'e2e-diagnostics-prepare'].includes(String(step.id))
        const diagnostics = id === 'e2e' && step.id === 'e2e-diagnostics'
        const allowed = archive
          ? ['always() && steps.e2e-quiescence.outcome == \'success\' && steps.e2e-report-check.outcome == \'success\'']
          : e2eUpload
            ? ['always() && steps.e2e-quiescence.outcome == \'success\' && steps.e2e-report-check.outcome == \'success\' && steps.profile-archive.outcome == \'success\'']
            : resourceCheck
              ? ['always()']
              : resourceUpload
                ? ['always() && steps.resource-check.outcome == \'success\'']
                : ownedCleanup
                  ? ['always() && steps.e2e-prepare.outcome == \'success\'']
                  : diagnostics
                    ? ['always() && steps.e2e-diagnostics-prepare.outcome == \'success\'']
                    : runsChecks(step) ? [undefined] : [undefined, 'always()']
        expect(allowed, stepLabel(id, step)).toContain(step.if)
      }
    }
  })
})

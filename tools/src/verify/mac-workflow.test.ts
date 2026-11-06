// 托管 Mac 的接线（M5-P8 S4，DEF-074；P8 设计 §4 的“Mac 工作流结构”）：mac.yml 照开发机的方式在托管 Intel Mac 上跑本机完整门禁，
// 接受依据是“两片合起来恰好是本机完整门禁、本机的三个浏览器都跑、另有生产容器 E2E、资源工具是严格本机模式”。
// plan.test.ts 只在 plan 层证明两片等价；这里解析工作流本身，与 plan.ts、E2E 的浏览器表核对，并拦下让检查悄悄少跑的写法
// （与 ci-workflow.test.ts 用同一套判断，S4 独立审查 I-1）。
import type { Step } from './workflow.test-support.ts'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { readText } from '../shared/repo.ts'
import { parseArgs, planSteps } from './plan.ts'
import { parseWorkflow, PLAYWRIGHT_CONFIG, playwrightBrowsers, runsChecks, stepLabel, verifyArgs, workflowWith } from './workflow.test-support.ts'

const WORKFLOW = '.github/workflows/mac.yml'
const RUNNER = 'macos-26-intel'
const PHASE_BRANCH = 'm5-p8-final-closeout'
// eslint-disable-next-line no-template-curly-in-string -- GitHub Actions 的表达式原文，不是模板字符串
const MATRIX_BROWSER = '${{ matrix.browser }}'
// eslint-disable-next-line no-template-curly-in-string -- GitHub Actions 的表达式原文，与 ci.yml 的迁移门禁基准相同
const MIGRATIONS_BASE = '${{ github.event_name == \'push\' && github.event.before || \'\' }}'
/** 资源工具的托管策略开关：托管 Mac 用严格本机模式，工作流里任何一层都不能设（S4 计划 §2） */
const RESOURCE_POLICY_VARIABLES: readonly string[] = ['NERVE_TEST_RESOURCE_POLICY', 'NERVE_TEST_LSOF_MODE']

const workflow = parseWorkflow(readText(WORKFLOW))

/**
 * 工作流的分片与本机完整的一套是否等价：每一处 pnpm verify 都用 parseArgs 解析，拿解析出的全部选项算出这个 job 真正执行的步骤，
 * 各个 job 合起来与本机 pnpm verify（不带参数）比较。本机模式两片都先启动开发数据库、都清理与构建，重复的只有这三步（plan.test.ts）。
 * 返回不等价之处的说明，等价时为空
 */
function shardingProblems(text: string): string[] {
  const runs = Object.entries(parseWorkflow(text).jobs).flatMap(([id, job]) => verifyArgs(job).map(args => ({ id, parsed: parseArgs(args) })))
  const problems: string[] = []
  const shards: { readonly id: string, readonly scope: string, readonly steps: readonly string[] }[] = []
  for (const { id, parsed } of runs) {
    if (!parsed.ok)
      problems.push(`${id}：pnpm verify 不认得这些参数（${parsed.error}）`)
    else if (parsed.options.ci)
      problems.push(`${id}：托管 Mac 照本机模式运行，不带 --ci`)
    else
      shards.push({ id, scope: parsed.options.scope ?? 'all', steps: planSteps(parsed.options).map(step => step.id) })
  }
  const scopes = shards.map(shard => `${shard.id}:${shard.scope}`)
  if (scopes.join(' ') !== 'verify:no-e2e e2e:e2e')
    problems.push(`分片应为 verify:no-e2e 与 e2e:e2e，实际是 ${scopes.join('、') || '（没有）'}`)
  const local = parseArgs([])
  if (!local.ok)
    throw new Error(`本机的 pnpm verify 不带参数却解析失败：${local.error}`)
  const expected = new Set(planSteps(local.options).map(step => step.id))
  const actual = new Set(shards.flatMap(shard => shard.steps))
  const missing = [...expected].filter(id => !actual.has(id))
  const extra = [...actual].filter(id => !expected.has(id))
  if (missing.length > 0 || extra.length > 0)
    problems.push(`各分片合起来与本机完整的一套不同：少了 ${missing.join('、') || '（无）'}，多了 ${extra.join('、') || '（无）'}`)
  return problems
}

/** playwright.config.ts 里不设 E2E_BROWSERS 时本机默认跑的浏览器（CI 另加的不算） */
function localDefaultBrowsers(source: string): string[] {
  const list = /^const browsers = process\.env\.E2E_BROWSERS\?\.split\(','\) \?\? \[((?:'\w+', )+)\.\.\.\(CI \? \['\w+'\] : \[\]\)\]$/m.exec(source)?.[1]
  if (list === undefined)
    throw new Error(`${PLAYWRIGHT_CONFIG} 里找不到默认浏览器的写法：改了写法，同步这里的解析`)
  return [...list.matchAll(/'(\w+)'/g)].map(match => match[1] ?? '')
}

function checkingStep(id: string): { index: number, step: Step } {
  const steps = workflow.jobs[id]?.steps ?? []
  const indexes = steps.flatMap((step, index) => runsChecks(step) ? [index] : [])
  expect(indexes, `${id} 恰好有一步执行检查`).toHaveLength(1)
  return { index: indexes[0]!, step: steps[indexes[0]!]! }
}

describe('M5-P8 托管 Mac 的接线：照开发机的方式跑本机完整门禁（DEF-074）', () => {
  it('只由推送本 Phase 的唯一分支与手动触发运行：不随 main 推送、不定时，不改 ci.yml 的原六项', () => {
    expect(workflow.on.push?.branches).toEqual([PHASE_BRANCH])
    expect(Object.keys(workflow.on).sort()).toEqual(['push', 'workflow_dispatch'])
  })

  it('三个 job 都在托管 Intel Mac 上运行：Apple 芯片版不能跑 Docker（S3 探测）', () => {
    expect(Object.keys(workflow.jobs)).toEqual(['verify', 'e2e', 'container'])
    for (const [id, job] of Object.entries(workflow.jobs))
      expect(job['runs-on'], id).toBe(RUNNER)
  })

  it('verify 与 e2e 按工作流里真实的参数执行的步骤，合起来与本机完整的一套相同，每个分片只跑一次；都不带 --ci', () => {
    expect(shardingProblems(readText(WORKFLOW))).toEqual([])
  })

  it.each([
    ['no-e2e 那片带上 --ci：改成 CI 模式（不启动开发库、tests 只跑覆盖率）', 'run: pnpm verify --keep-going --scope=no-e2e', 'run: pnpm verify --ci --keep-going --scope=no-e2e', 'verify：托管 Mac 照本机模式运行，不带 --ci'],
    ['e2e 那片多了 --fast：只跑快速门禁', 'run: pnpm verify --keep-going --scope=e2e', 'run: pnpm verify --fast --keep-going --scope=e2e', 'e2e：pnpm verify 不认得这些参数'],
    ['verify 那片改成跑完整的一套：E2E 跑两遍', 'run: pnpm verify --keep-going --scope=no-e2e', 'run: pnpm verify --keep-going --scope=all', '分片应为 verify:no-e2e 与 e2e:e2e，实际是 verify:all、e2e:e2e'],
  ])('改变计划的参数（在内存里改工作流的文字）：%s，等价性核对失败', (_name, original, replacement, problem) => {
    expect(shardingProblems(workflowWith(WORKFLOW, original, replacement)).join('\n')).toContain(problem)
  })

  it('E2E 的浏览器矩阵是本机默认的全部浏览器，每片只跑自己的浏览器，装的也是它；一片失败不取消别的片', () => {
    const e2e = workflow.jobs.e2e
    expect(Object.keys(e2e?.strategy?.matrix ?? {}), '矩阵只有 browser（不用 exclude、include）').toEqual(['browser'])
    const matrix = z.strictObject({ browser: z.array(z.string()) }).parse(e2e?.strategy?.matrix)
    const config = readText(PLAYWRIGHT_CONFIG)
    const browsers = localDefaultBrowsers(config)
    expect(browsers).toEqual(['chromium', 'chrome', 'webkit'])
    expect(playwrightBrowsers(config)).toEqual(expect.arrayContaining(browsers))
    expect([...matrix.browser].sort()).toEqual([...browsers].sort())
    expect(e2e?.strategy?.['fail-fast']).toBe(false)
    const { index, step } = checkingStep('e2e')
    expect(step.env?.E2E_BROWSERS).toBe(MATRIX_BROWSER)
    const install = e2e!.steps.findIndex(item => (item.run ?? '').trim() === `pnpm --filter @nerve-office/e2e exec playwright install ${MATRIX_BROWSER}`)
    expect(install).toBeGreaterThanOrEqual(0)
    expect(install).toBeLessThan(index)
  })

  it('另有容器 E2E 的 job（生产镜像，默认 Chromium）', () => {
    expect(checkingStep('container').step.run?.trim()).toBe('pnpm test:e2e:container')
  })

  it('本机模式：执行检查的每一步把 CI 置空，资源工具不设托管策略，E2E_BROWSERS 只在 e2e 那一步', () => {
    for (const name of [...RESOURCE_POLICY_VARIABLES, 'CI', 'E2E_BROWSERS'])
      expect(workflow.env?.[name], `工作流级 ${name}`).toBeUndefined()
    for (const [id, job] of Object.entries(workflow.jobs)) {
      for (const name of [...RESOURCE_POLICY_VARIABLES, 'CI', 'E2E_BROWSERS'])
        expect(job.env?.[name], `${id} 的 job 级 ${name}`).toBeUndefined()
      const { step: checking } = checkingStep(id)
      for (const step of job.steps) {
        const label = stepLabel(id, step)
        for (const name of RESOURCE_POLICY_VARIABLES)
          expect(step.env?.[name], label).toBeUndefined()
        expect(step.env?.CI, label).toBe(step === checking ? '' : undefined)
        if (id !== 'e2e' || step !== checking)
          expect(step.env?.E2E_BROWSERS, label).toBeUndefined()
      }
    }
  })

  it('检查不会被条件跳过，也没有失败了也算通过的 job 或步骤；收尾的探测与上传总是执行', () => {
    for (const [id, job] of Object.entries(workflow.jobs)) {
      expect(job.if, `${id}：job 不带 if`).toBeUndefined()
      expect(job['continue-on-error'], id).toBeUndefined()
      for (const step of job.steps) {
        const label = stepLabel(id, step)
        expect(step['continue-on-error'], label).toBeUndefined()
        expect(runsChecks(step) ? [undefined] : [undefined, 'always()'], label).toContain(step.if)
      }
    }
  })

  it('verify 取完整历史，迁移门禁的基准与 ci.yml 相同（ADR-005）', () => {
    const steps = workflow.jobs.verify!.steps
    const checkout = z.object({ 'fetch-depth': z.number() }).loose().parse(steps.find(step => step.uses?.startsWith('actions/checkout@'))?.with)
    expect(checkout['fetch-depth']).toBe(0)
    expect(checkingStep('verify').step.env?.GATE_MIGRATIONS_BASE).toBe(MIGRATIONS_BASE)
  })

  /**
   * deploy/Dockerfile 用了只有 BuildKit 才支持的 RUN --mount。Homebrew 的 docker 只是命令行，不带 buildx；没装时 docker build 退回旧构建器，
   * 生产镜像构建报“the --mount option requires BuildKit”（托管 Mac 第 2 轮 run 42256375539 的容器 job）。开发机的 Docker Desktop 自带 buildx，
   * 所以每个 job 起 Docker 时与 compose 一起装上并链接 buildx，在检查之前核对两个插件都能用
   */
  it('每个 job 在检查之前起 colima，Docker 工具链与开发机一致：compose 与 buildx 两个插件都装上、链接并核对', () => {
    expect(readText('deploy/Dockerfile')).toMatch(/^RUN --mount=/m)
    for (const [id, job] of Object.entries(workflow.jobs)) {
      const setups = job.steps.flatMap((step, index) => /^colima start\b/m.test(step.run ?? '') ? [index] : [])
      expect(setups, `${id} 恰好起一次 colima`).toHaveLength(1)
      expect(setups[0], id).toBeLessThan(checkingStep(id).index)
      const lines = (job.steps[setups[0]!]!.run ?? '').split('\n').map(line => line.trim())
      expect(lines, id).toContain('brew install colima docker docker-compose docker-buildx')
      for (const plugin of ['docker-compose', 'docker-buildx'])
        expect(lines, `${id}：${plugin}`).toContain(`ln -sfn "$(brew --prefix)/opt/${plugin}/bin/${plugin}" "$HOME/.docker/cli-plugins/${plugin}"`)
      expect(lines, id).toContain('docker compose version')
      expect(lines, id).toContain('docker buildx version')
    }
  })

  it('每个 job 先后记录开始与结束时的环境事实，并总是上传本轮台账', () => {
    for (const [id, job] of Object.entries(workflow.jobs)) {
      const runs = job.steps.map(step => (step.run ?? '').trim())
      const start = runs.indexOf('python3 -B tools/test-resources/ci_mac_probe.py system')
      const end = runs.indexOf('python3 -B tools/test-resources/ci_mac_probe.py final')
      const { index } = checkingStep(id)
      expect(start, id).toBeGreaterThanOrEqual(0)
      expect(start, id).toBeLessThan(index)
      expect(end, id).toBeGreaterThan(index)
      expect(job.steps[end]?.if, id).toBe('always()')
      const uploads = job.steps.filter(step => step.uses?.startsWith('actions/upload-artifact@'))
      expect(uploads, id).toHaveLength(1)
      expect(uploads[0]?.if, id).toBe('always()')
      const upload = z.object({ 'path': z.string(), 'include-hidden-files': z.boolean() }).loose().parse(uploads[0]?.with)
      expect(upload.path.trim().split('\n'), id).toContain('.test-resources/runs/*/run.json')
      expect(upload['include-hidden-files'], id).toBe(true)
      if (id !== 'verify')
        expect(upload.path.trim().split('\n'), id).toContain('!tests/e2e/test-results/persistent-profiles/**')
    }
  })
})

// CI 的接线（规范 §9，M2-P6 第 6 片复核 S1）：plan.test.ts 只守住 plan.ts 这一层（两个分片合起来与完整的一套相同），
// .github/workflows/ci.yml 实际跑哪个分片、E2E 的浏览器矩阵里有哪些、有没有容器 E2E 的 job，原来都没有检查——
// 工作流里漏了一个分片、矩阵里少了一个浏览器，CI 照样全绿。这里解析工作流，与 plan.ts 和 E2E 的浏览器表核对。
// 不让检查悄悄少跑的写法一并拦下（复核第二批 S-1）：矩阵的 exclude、include，执行检查的 job 与步骤上的 if，
// 步骤级的 env 改掉 CI 或 E2E_BROWSERS。
import process from 'node:process'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { z } from 'zod'
import { commandText, readText } from '../shared/repo.ts'
import { parseArgs, planSteps } from './plan.ts'

const WORKFLOW = '.github/workflows/ci.yml'
/** E2E 的浏览器表（playwright.config.ts 的 BROWSERS）：本机跑前三个，CI 另加 Edge（规范 §8.2） */
const PLAYWRIGHT_CONFIG = 'tests/e2e/playwright.config.ts'
// eslint-disable-next-line no-template-curly-in-string -- GitHub Actions 的表达式原文，不是模板字符串
const MATRIX_BROWSER = '${{ matrix.browser }}'

const stepSchema = z.object({
  'name': z.string().optional(),
  'run': z.string().optional(),
  'uses': z.string().optional(),
  'if': z.unknown().optional(),
  'env': z.record(z.string(), z.unknown()).optional(),
  'continue-on-error': z.unknown().optional(),
}).loose()
const jobSchema = z.object({
  'name': z.string().optional(),
  'if': z.unknown().optional(),
  'env': z.record(z.string(), z.unknown()).optional(),
  'strategy': z.object({ 'fail-fast': z.boolean().optional(), 'matrix': z.record(z.string(), z.unknown()).optional() }).loose().optional(),
  'steps': z.array(stepSchema),
  'continue-on-error': z.unknown().optional(),
}).loose()
const workflowSchema = z.object({
  on: z.object({
    push: z.object({ branches: z.array(z.string()) }).loose().optional(),
    schedule: z.array(z.object({ cron: z.string() })).optional(),
  }).loose(),
  jobs: z.record(z.string(), jobSchema),
})

type Workflow = z.infer<typeof workflowSchema>
type Job = z.infer<typeof jobSchema>
type Step = z.infer<typeof stepSchema>

function parseWorkflow(text: string): Workflow {
  return workflowSchema.parse(parse(text))
}

const workflow = parseWorkflow(readText(WORKFLOW))

/** 一个 job 里执行 pnpm verify 的各步的参数（只认 run 里以 pnpm verify 开头的一行） */
function verifyArgs(job: Job): string[][] {
  return job.steps.flatMap(step => (step.run ?? '').split('\n').map(line => line.trim().split(/\s+/)).filter(words => words[0] === 'pnpm' && words[1] === 'verify').map(words => words.slice(2)))
}

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

/** 在内存里改工作流的文字（不改文件）：要换掉的那一段必须恰好出现一次，否则说明工作流改了写法，用例要跟着改 */
function workflowWith(original: string, replacement: string): string {
  const text = readText(WORKFLOW)
  expect(text.split(original).length - 1, `工作流里应恰好有一处：${original}`).toBe(1)
  return text.replace(original, replacement)
}

/** 这一步执行检查：pnpm verify 或容器 E2E（run 里有一行以它开头） */
function runsChecks(step: Step): boolean {
  return (step.run ?? '').split('\n').some(line => /^pnpm (?:verify|test:e2e:container)(?:\s|$)/.test(line.trim()))
}

function stepLabel(id: string, step: Step): string {
  return `${id}：${step.name ?? step.uses ?? step.run ?? ''}`
}

/** playwright.config.ts 里浏览器表的名字：const BROWSERS … = { 名字: …, … } */
function playwrightBrowsers(source: string): string[] {
  const block = /^const BROWSERS\b[^=]*= \{\n([\s\S]*?)^\}$/m.exec(source)?.[1]
  if (block === undefined)
    throw new Error(`${PLAYWRIGHT_CONFIG} 里找不到 const BROWSERS = { … }：改了写法，同步这里的解析`)
  return [...block.matchAll(/^ {2}(\w+): /gm)].map(match => match[1] ?? '')
}

describe('US-M1-11 CI 的接线与 pnpm verify 的分片一致（规范 §9）', () => {
  it('推送 main 之后与每周定时各执行一次', () => {
    expect(workflow.on.push?.branches).toEqual(['main'])
    expect(workflow.on.schedule?.length).toBe(1)
  })

  it('verify 与 e2e 两个 job 按工作流里真实的参数执行的步骤，合起来与本机完整的一套相同（另加漏洞扫描、数据库由服务容器提供），每个分片只跑一次；参数都是 pnpm verify 认得的', () => {
    expect(shardingProblems(readText(WORKFLOW))).toEqual([])
  })

  it.each([
    ['no-e2e 那片多了 --fast：少跑集成测试与覆盖率、产物门禁', 'run: pnpm verify --ci --keep-going --scope=no-e2e', 'run: pnpm verify --ci --keep-going --fast --scope=no-e2e', ['tests', 'artifact-gates']],
    ['e2e 那片多了 --fast：不构建、不跑 E2E', 'run: pnpm verify --ci --keep-going --scope=e2e', 'run: pnpm verify --ci --fast --keep-going --scope=e2e', ['build-e2e', 'e2e']],
  ])('改变计划的参数（Codex 评审 CX7 的变异，在内存里改工作流的文字）：%s，等价性核对失败', (_name, original, replacement, missing) => {
    const problems = shardingProblems(workflowWith(original, replacement))
    expect(problems).toHaveLength(1)
    for (const step of missing)
      expect(problems[0]).toMatch(new RegExp(`少了 [^，]*${step}`))
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

  it('每个 job 都在 CI=true 下执行（E2E 的重试与"出现重试即失败"按它生效，playwright.config.ts），没有哪一步或哪个 job 失败了也算通过', () => {
    for (const [id, job] of Object.entries(workflow.jobs)) {
      expect(job.env?.CI, id).toBe('true')
      expect(job['continue-on-error'], id).toBeUndefined()
      for (const step of job.steps) {
        expect(step['continue-on-error'], stepLabel(id, step)).toBeUndefined()
        // 步骤级的 env 盖过 job 的：CI 改掉了重试与"出现重试即失败"就不生效，E2E_BROWSERS 改掉了每片都跑同一个浏览器（复核第二批 S-1）
        expect(Object.keys(step.env ?? {}).filter(name => ['CI', 'E2E_BROWSERS'].includes(name)), stepLabel(id, step)).toEqual([])
      }
    }
  })

  it('检查不会被条件跳过：执行 pnpm verify 与容器 E2E 的 job 与步骤都不带 if，这些 job 里其余步骤的 if 只能是 always()（上传报告）（复核第二批 S-1）', () => {
    const checking = Object.entries(workflow.jobs).filter(([, job]) => job.steps.some(runsChecks))
    // 三个 job 各执行一种检查：verify 与 e2e 的 pnpm verify，container 的容器 E2E
    expect(checking.map(([id]) => id)).toEqual(['verify', 'e2e', 'container'])
    for (const [id, job] of checking) {
      expect(job.if, `${id}：job 不带 if`).toBeUndefined()
      for (const step of job.steps)
        expect(runsChecks(step) ? [undefined] : [undefined, 'always()'], stepLabel(id, step)).toContain(step.if)
    }
  })
})

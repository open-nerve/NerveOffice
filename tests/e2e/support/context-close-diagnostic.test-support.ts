import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'

const outcomeSchema = z.object({
  suites: z.array(z.object({
    specs: z.array(z.object({ tests: z.array(z.object({ results: z.array(z.object({ status: z.string() })) })) })),
  })),
})

/** 只换 browser 边界；正式项目 wrapper 与 Playwright 默认 context/_contextFactory 均实际执行。 */
export function runCloseFixtureModel(mode: 'complete' | 'pending') {
  const root = mkdtempSync(join(tmpdir(), `nerve-close-model-${mode}-`))
  const sourceRoot = fileURLToPath(new URL('../../../', import.meta.url))
  let canRemove = true
  try {
    const evidence = join(process.env.NERVE_TEST_OUTPUT_DIR ?? root, `context-close-model-${mode}`)
    mkdirSync(evidence, { recursive: true })
    const specDir = join(root, 'tests/e2e/specs/local-drafts')
    mkdirSync(specDir, { recursive: true })
    const output = join(root, 'output')
    const bodyProof = join(root, 'body-finished.json')
    const results = join(evidence, 'playwright.json')
    const config = join(root, 'playwright.config.mjs')
    writeFileSync(config, `export default ${JSON.stringify({
      testDir: specDir,
      outputDir: output,
      workers: 1,
      retries: 0,
      timeout: 3_000,
      projects: [{ name: 'chrome', use: { browserName: 'chromium', trace: 'off', screenshot: 'off', video: 'off' } }],
      reporter: [['json', { outputFile: results }]],
    })}`)
    writeFileSync(join(specDir, 'catalog-boundaries.spec.ts'), `
import { EventEmitter } from 'node:events'
import { writeFileSync } from 'node:fs'
import { test as projectTest, expect } from ${JSON.stringify(join(sourceRoot, 'tests/e2e/support/fixtures.ts'))}
const test = projectTest.extend({
  browser: [async ({}, use) => {
    const browser = new EventEmitter()
    browser._connection = { headers: [] }
    browser.newContext = async () => {
      const context = new EventEmitter()
      context.browser = () => browser
      context.exposeBinding = async () => {}
      context.addInitScript = async () => {}
      context.request = { dispose: () => ${mode === 'pending' ? 'new Promise(() => {})' : 'Promise.resolve()'} }
      context.tracing = { stopChunk: () => Promise.resolve() }
      context.close = () => context.request.dispose().then(() => context.tracing.stopChunk()).then(() => { context.emit('close') })
      return context
    }
    await use(browser)
    browser.emit('disconnected')
  }, { scope: 'worker' }],
})
test('另一页换人后旧草稿页重新聚焦，不再显示原账户已完成副本的标题和链接', async ({ context }, info) => {
  expect(context).toBeDefined()
  // 没有手工 close：后续只由底层默认夹具收尾。
  writeFileSync(${JSON.stringify(bodyProof)}, JSON.stringify({ bodyFinished: true, output: info.outputPath('context-close-diagnostic.json') }))
})
`)
    const require = createRequire(import.meta.url)
    const cli = join(dirname(require.resolve('playwright/package.json')), 'cli.js')
    const env: NodeJS.ProcessEnv = { ...process.env, E2E_CONTEXT_CLOSE_DIAGNOSTIC: '1' }
    delete env.NODE_V8_COVERAGE
    delete env.NERVE_TEST_COVERAGE_DIR
    canRemove = false
    const result = spawnSync(process.execPath, [cli, 'test', '--config', config], {
      cwd: sourceRoot,
      env,
      encoding: 'utf8',
      timeout: 15_000,
      maxBuffer: 1024 * 1024,
    })
    canRemove = result.error === undefined && result.signal === null
    writeFileSync(join(evidence, 'stdout.log'), result.stdout ?? '')
    writeFileSync(join(evidence, 'stderr.log'), result.stderr ?? '')
    writeFileSync(join(evidence, 'process.json'), JSON.stringify({ mode, fixtureModelOnly: true, browserStarted: false, status: result.status, signal: result.signal, error: result.error === undefined ? null : 'child-process-error' }))
    if (!canRemove)
      throw new Error('默认关闭夹具模型的 Node 调度器没有正常退出；保留临时根等待外层核对')
    if (!existsSync(results))
      throw new Error(`默认关闭夹具模型没有报告：${result.stderr}`)
    const reports = existsSync(output)
      ? readdirSync(output, { recursive: true }).filter((path): path is string => typeof path === 'string' && path.endsWith('/context-close-diagnostic.json')).map(path => readFileSync(join(output, path), 'utf8'))
      : []
    for (const [index, report] of reports.entries())
      writeFileSync(join(evidence, `diagnostic-${index}.json`), report)
    return {
      status: result.status,
      bodyFinished: existsSync(bodyProof),
      statuses: outcomeSchema.parse(JSON.parse(readFileSync(results, 'utf8'))).suites.flatMap(suite => suite.specs.flatMap(spec => spec.tests.flatMap(test => test.results.map(item => item.status)))),
      reports: reports.map((text): unknown => JSON.parse(text)),
    }
  }
  finally {
    // 超时/信号不证明 worker 已退出；只在调度器正常退出后删除自己的小型模型。
    if (canRemove)
      rmSync(root, { recursive: true, force: true })
  }
}

/** FIFO 反例必须隔离在单一 Node 子进程；旧阻塞实现不能卡住 Vitest 事件循环。 */
export function runReportFifoReplacementModel() {
  const root = mkdtempSync(join(tmpdir(), 'nerve-close-fifo-'))
  let canRemove = true
  try {
    const evidence = join(process.env.NERVE_TEST_OUTPUT_DIR ?? root, 'context-close-fifo-model')
    mkdirSync(evidence, { recursive: true })
    const fifo = join(root, 'replacement.fifo')
    const marker = join(root, 'original-called')
    const prior = join(root, 'previous-report.json')
    const prepared = spawnSync('/usr/bin/mkfifo', [fifo], { timeout: 1_000, encoding: 'utf8', maxBuffer: 16 * 1024 })
    if (prepared.status !== 0)
      throw new Error('本轮 FIFO 样例创建失败')
    const source = fileURLToPath(new URL('./context-close-diagnostic.ts', import.meta.url))
    const script = `
import { EventEmitter } from 'node:events'
import { renameSync, statSync, writeFileSync } from 'node:fs'
import { watchContextCloseDiagnostic } from ${JSON.stringify(source)}
const browser = new EventEmitter()
const context = new EventEmitter()
context.browser = () => browser
context.request = { dispose: () => Promise.resolve() }
context.tracing = { stopChunk: () => Promise.resolve() }
context.close = () => { writeFileSync(${JSON.stringify(marker)}, 'called'); return Promise.resolve() }
const annotations = []
const path = ${JSON.stringify(join(root, 'context-close-diagnostic.json'))}
watchContextCloseDiagnostic(context, {
  file: '/repo/tests/e2e/specs/local-drafts/catalog-boundaries.spec.ts',
  title: '另一页换人后旧草稿页重新聚焦，不再显示原账户已完成副本的标题和链接',
  retry: 0, project: { name: 'chrome', outputDir: ${JSON.stringify(root)} },
  outputPath: () => path, annotations, attachments: [],
})
renameSync(path, ${JSON.stringify(prior)})
renameSync(${JSON.stringify(fifo)}, path)
await context.close()
console.log(JSON.stringify({ annotations, fifoPreserved: statSync(path).isFIFO() }))
`
    // 固定脚本不创建后代；exit/signal 是此唯一生产者的 wait 结果。
    canRemove = false
    const result = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
      encoding: 'utf8',
      timeout: 1_500,
      killSignal: 'SIGKILL',
      maxBuffer: 16 * 1024,
    })
    canRemove = result.status !== null || result.signal !== null
    writeFileSync(join(evidence, 'stdout.log'), result.stdout ?? '')
    writeFileSync(join(evidence, 'stderr.log'), result.stderr ?? '')
    writeFileSync(join(evidence, 'process.json'), JSON.stringify({ fixtureModelOnly: true, browserStarted: false, singleNodeProcess: true, status: result.status, signal: result.signal, error: result.error === undefined ? null : 'child-process-error' }))
    if (existsSync(prior) && statSync(prior).isFile() && statSync(prior).size <= 32 * 1024)
      writeFileSync(join(evidence, 'last-complete-report.json'), readFileSync(prior))
    const summary = result.stdout?.trim()
      ? z.object({ annotations: z.array(z.object({ type: z.string(), description: z.string() })), fifoPreserved: z.boolean() }).parse(JSON.parse(result.stdout))
      : undefined
    return { status: result.status, signal: result.signal, originalCalled: existsSync(marker), summary }
  }
  finally {
    if (canRemove)
      rmSync(root, { recursive: true, force: true })
  }
}

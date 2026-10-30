import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { z } from 'zod'
import { readJson, REPO_ROOT } from '../shared/repo.ts'

export const ORDINARY_FILE = 'tests/integration/src/ordinary.test.ts'
export const CAPACITY_FILE = 'tests/integration/src/assets/asset-references-bulk.test.ts'

const scheduledSchema = z.array(z.object({ file: z.string(), project: z.string(), groupOrder: z.number() }))
const resultSchema = z.object({
  testResults: z.array(z.object({
    assertionResults: z.array(z.object({ title: z.string(), status: z.string() })),
  })),
})

/** 只替换 DB setup 和样例根；选择器、include/exclude 与组次序均来自正式入口和配置。 */
export function runCapacityFixture(failure: 'none' | 'ordinary' | 'capacity') {
  const directory = mkdtempSync(join(tmpdir(), 'nerve-capacity-project-'))
  let canRemove = true
  try {
    // 普通 pnpm test / pre-push 不要求外部报告口；该路径的报告随小夹具回收。
    const evidence = join(process.env.NERVE_TEST_OUTPUT_DIR ?? directory, `capacity-project-${failure}`)
    mkdirSync(evidence, { recursive: true })
    const events = join(evidence, 'events.jsonl')
    const scheduled = join(evidence, 'scheduled.json')
    const results = join(evidence, 'vitest.json')
    const require = createRequire(import.meta.url)
    const vitestDirectory = dirname(require.resolve('vitest/package.json'))
    const vitest = join(vitestDirectory, 'dist/index.js')
    const cli = join(vitestDirectory, 'vitest.mjs')
    const manifest = z.object({ scripts: z.object({ 'test:integration': z.string() }) }).parse(readJson('package.json'))
    const [, invocation] = manifest.scripts['test:integration'].split(' -- vitest run ')
    if (invocation === undefined)
      throw new Error('集成入口没有受管的 vitest run')
    const args = invocation.trim().split(/\s+/)
    const shared = `
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { afterAll, expect, it } from ${JSON.stringify(pathToFileURL(vitest).href)}
const event = name => appendFileSync(${JSON.stringify(events)}, JSON.stringify(name) + '\\n')
`
    for (const file of [ORDINARY_FILE, CAPACITY_FILE])
      mkdirSync(join(directory, file, '..'), { recursive: true })
    writeFileSync(join(directory, ORDINARY_FILE), `${shared}
afterAll(async () => {
  event('ordinary-teardown-start')
  await writeFile(${JSON.stringify(join(directory, 'released'))}, 'released')
  event('ordinary-teardown-finished')
})
it('ordinary', () => { event('ordinary-test'); expect(${JSON.stringify(failure)}).not.toBe('ordinary') })
`)
    writeFileSync(join(directory, CAPACITY_FILE), `${shared}
it('capacity', () => {
  event('capacity-start')
  expect(readFileSync(${JSON.stringify(join(directory, 'released'))}, 'utf8')).toBe('released')
  expect(${JSON.stringify(failure)}).not.toBe('capacity')
})
`)
    const reporter = join(directory, 'reporter.mjs')
    writeFileSync(reporter, `
import { realpathSync, writeFileSync } from 'node:fs'
import { relative } from 'node:path'
export default class {
  onTestRunStart(specifications) {
    writeFileSync(${JSON.stringify(scheduled)}, JSON.stringify(specifications.map(spec => ({
      file: relative(realpathSync(${JSON.stringify(directory)}), spec.moduleId),
      project: spec.project.name, groupOrder: spec.project.config.sequence.groupOrder,
    }))))
  }
}
`)
    const config = join(directory, 'vitest.config.mjs')
    writeFileSync(config, `
import actual from ${JSON.stringify(pathToFileURL(join(REPO_ROOT, 'vitest.config.ts')).href)}
export default {
  root: ${JSON.stringify(directory)},
  test: {
    projects: actual.test.projects.filter(project => ['integration', 'integration-capacity'].includes(project.test?.name)).map(project => ({
      ...project, root: ${JSON.stringify(directory)},
      test: { ...project.test, root: ${JSON.stringify(directory)}, setupFiles: [] },
    })),
    coverage: { enabled: false },
    reporters: [${JSON.stringify(reporter)}, 'json'], outputFile: ${JSON.stringify(results)},
  },
}
`)
    // 子进程不继承外层 V8 覆盖率输出；只有两份小夹具，绝不重新扫描/执行本文件。
    const env = { ...process.env }
    delete env.NODE_V8_COVERAGE
    delete env.NERVE_TEST_COVERAGE_DIR
    // 超时/信号不能证明 Vitest 的 worker 都已退出；此时保留本轮根，由外层运行器核对并收尾。
    canRemove = false
    const result = spawnSync(process.execPath, [cli, 'run', '--config', config, ...args], {
      cwd: directory,
      env,
      encoding: 'utf8',
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    })
    canRemove = result.error === undefined && result.signal === null
    writeFileSync(join(evidence, 'stdout.log'), result.stdout)
    writeFileSync(join(evidence, 'stderr.log'), result.stderr)
    writeFileSync(join(evidence, 'process.json'), JSON.stringify({ args, status: result.status, signal: result.signal, error: result.error?.message }))
    if (result.error !== undefined || result.signal !== null)
      throw new Error(`容量调度子进程未正常退出：${result.error?.message ?? result.signal}`)
    if (!existsSync(results) || !existsSync(scheduled))
      throw new Error(`容量调度子进程没有报告：${result.stderr}`)
    return {
      status: result.status,
      events: readFileSync(events, 'utf8').trim().split('\n').map(line => z.string().parse(JSON.parse(line))),
      scheduled: scheduledSchema.parse(JSON.parse(readFileSync(scheduled, 'utf8'))),
      tests: resultSchema.parse(JSON.parse(readFileSync(results, 'utf8'))).testResults.flatMap(file => file.assertionResults),
    }
  }
  finally {
    if (canRemove)
      rmSync(directory, { recursive: true, force: true })
  }
}

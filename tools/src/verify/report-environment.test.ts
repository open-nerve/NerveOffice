import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
import { z } from 'zod'
import { REPO_ROOT } from '../shared/repo.ts'

const CANARY = 'synthetic-report-environment-canary'
const DATABASE = 'postgresql://catalog:synthetic-only@127.0.0.1:1/catalog'
const E2E = join(REPO_ROOT, 'tests/e2e')
const require = createRequire(join(E2E, 'package.json'))
const testPackage = dirname(require.resolve('@playwright/test/package.json'))
const cli = join(testPackage, 'cli.js')

/** 绝不把运行 Agent/CI 的真实凭据送进可能失败并留报告的回归。 */
function isolatedEnvironment(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    TMPDIR: tmpdir(),
    TMP: tmpdir(),
    TEMP: tmpdir(),
    NERVE_TEST_DATABASE_URL: DATABASE,
    NERVE_REPORT_ENV_CANARY: CANARY,
  }
}

function listConfiguration(config: string): string {
  const result = spawnSync(process.execPath, [cli, 'test', '--config', config, '--list', '--reporter=json', '--grep=^$', '--pass-with-no-tests'], {
    cwd: E2E,
    env: isolatedEnvironment(),
    encoding: 'utf8',
    timeout: 15_000,
    maxBuffer: 1024 * 1024,
  })
  expect(result.error).toBeUndefined()
  expect(result.signal).toBeNull()
  expect(result.status).toBe(0)
  return result.stdout
}

it.each(['playwright.config.ts', 'playwright.measure.config.ts', 'playwright.local-save.config.ts'])('正式 %s 的只读 JSON 不序列化继承环境', (config) => {
  const output = listConfiguration(config)
  // 只断言布尔值，失败输出不转储整份配置。
  expect(output.includes(CANARY)).toBe(false)
  expect(output.includes(DATABASE)).toBe(false)
  expect(output.includes('NERVE_REPORT_ENV_CANARY')).toBe(false)
}, 20_000)

it('正式 webServer 仍继承运行环境，真实 JSON 和 HTML 报告不含继承值', () => {
  const directory = mkdtempSync(join(tmpdir(), 'nerve-report-environment-'))
  let canRemove = true
  try {
    const listed = z.object({ config: z.object({ webServer: z.object({ url: z.string() }).passthrough() }) }).parse(JSON.parse(listConfiguration('playwright.config.ts')))
    const actualServer = listed.config.webServer
    const report = join(directory, 'results.json')
    const html = join(directory, 'html')
    const server = join(directory, 'server.mjs')
    const config = join(directory, 'playwright.config.mjs')
    // 只响应是否取得预期环境；不回传或记录任何变量值。
    writeFileSync(server, `
import http from 'node:http'
const inherited = process.env.NERVE_REPORT_ENV_CANARY === ${JSON.stringify(CANARY)}
  && process.env.NERVE_TEST_DATABASE_URL === ${JSON.stringify(DATABASE)}
  && process.env.E2E_DATABASE_URL?.startsWith('postgresql://catalog:synthetic-only@127.0.0.1:1/')
http.createServer((request, response) => {
  response.writeHead(200, { 'Content-Type': 'application/json' })
  response.end(JSON.stringify({ inherited: Boolean(inherited) }))
}).listen(Number(process.env.E2E_PORT), '127.0.0.1')
`)
    writeFileSync(join(directory, 'inherit.spec.mjs'), `
import { test, expect } from ${JSON.stringify(pathToFileURL(join(testPackage, 'index.mjs')).href)}
test('inherited environment reaches the server', async () => {
  const response = await fetch('http://127.0.0.1:' + process.env.E2E_PORT + '/check')
  expect(await response.json()).toEqual({ inherited: true })
})
`)
    // 服务 URL/超时/关闭信号和环境行为取自真实配置，只替换产品服务与用例。
    const shellQuote = (value: string) => `'${value.replaceAll('\'', '\'\\\'\'')}'`
    writeFileSync(config, `
export default {
  testDir: ${JSON.stringify(directory)}, testMatch: 'inherit.spec.mjs',
  outputDir: ${JSON.stringify(join(directory, 'output'))},
  projects: [{ name: 'environment', use: {} }], workers: 1, retries: 0,
  reporter: [['json', { outputFile: ${JSON.stringify(report)} }], ['html', { outputFolder: ${JSON.stringify(html)}, open: 'never' }]],
  webServer: { ...${JSON.stringify(actualServer)}, command: ${JSON.stringify(`${shellQuote(process.execPath)} ${shellQuote(server)}`)}, stdout: 'ignore' },
}
`)
    canRemove = false
    const result = spawnSync(process.execPath, [cli, 'test', '--config', config], {
      cwd: E2E,
      env: { ...isolatedEnvironment(), E2E_PORT: new URL(actualServer.url).port, E2E_DATABASE_URL: 'postgresql://catalog:synthetic-only@127.0.0.1:1/report_fixture' },
      encoding: 'utf8',
      timeout: 20_000,
      maxBuffer: 1024 * 1024,
    })
    canRemove = result.error === undefined && result.signal === null
    expect(result.error).toBeUndefined()
    expect(result.signal).toBeNull()
    expect(result.status).toBe(0)
    const text = readFileSync(report, 'utf8')
    const stats = z.object({ stats: z.object({ expected: z.number(), unexpected: z.number(), skipped: z.number(), flaky: z.number() }) }).parse(JSON.parse(text)).stats
    expect(stats).toMatchObject({ expected: 1, unexpected: 0, skipped: 0, flaky: 0 })
    expect(text.includes(CANARY)).toBe(false)
    expect(text.includes(DATABASE)).toBe(false)
    // HTML 报告的数据是内嵌 ZIP；检查展开后的真实内容，不能仅查 HTML 明文。
    const inspected = spawnSync('python3', ['-c', `
import base64,io,json,re,sys,zipfile
from pathlib import Path
data=Path(sys.argv[1]).read_bytes()
match=re.search(rb'data:application/zip;base64,([A-Za-z0-9+/=]+)',data)
assert match, 'missing real HTML report payload'
with zipfile.ZipFile(io.BytesIO(base64.b64decode(match[1],validate=True))) as archive:
    payloads=[data]+[archive.read(item) for item in archive.infolist()]
print(json.dumps({'leaked':any(value.encode() in payload for payload in payloads for value in sys.argv[2:])}))
`, join(html, 'index.html'), CANARY, DATABASE], { env: isolatedEnvironment(), encoding: 'utf8', timeout: 5000, maxBuffer: 1024 })
    expect(inspected.status).toBe(0)
    expect(z.object({ leaked: z.boolean() }).parse(JSON.parse(inspected.stdout)).leaked).toBe(false)
  }
  finally {
    if (canRemove)
      rmSync(directory, { recursive: true, force: true })
  }
}, 30_000)

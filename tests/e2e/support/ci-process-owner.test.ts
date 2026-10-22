import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { afterEach, expect, it } from 'vitest'

const directories: string[] = []
afterEach(() => {
  for (const path of directories.splice(0))
    rmSync(path, { recursive: true, force: true })
})

function forkWith(environment: NodeJS.ProcessEnv, owner: string | undefined) {
  const root = mkdtempSync(join(tmpdir(), 'nerve-ci-fork-'))
  directories.push(root)
  const worker = join(root, 'worker.cjs')
  writeFileSync(worker, `process.send({keys:Object.keys(process.env).filter(k=>k!=='__CF_USER_TEXT_ENCODING').sort(),owner:process.env.NERVE_TEST_CI_E2E_OWNER,secretPresent:process.env.NERVE_PARENT_CREDENTIAL!==undefined,nodeArgs:process.execArgv,limits:[process.env.MALLOC_ARENA_MAX,process.env.UV_THREADPOOL_SIZE,process.env.VIPS_DISC_THRESHOLD]});process.disconnect();`)
  const env = { ...process.env, NERVE_TEST_CI_E2E_OWNER: owner, NERVE_PARENT_CREDENTIAL: 'synthetic-secret-not-to-inherit' }
  return spawnSync(process.execPath, ['--import', new URL('./ci-process-owner.ts', import.meta.url).href, '--input-type=module', '-e', `import {fork} from 'node:child_process';const c=fork(${JSON.stringify(worker)},[],{env:${JSON.stringify(environment)},execArgv:['--no-deprecation'],serialization:'advanced',stdio:['ignore','ignore','inherit','ipc']});c.on('message',m=>process.stdout.write(JSON.stringify(m)));c.on('exit',code=>process.exit(code??1));`], { env, encoding: 'utf8', timeout: 5000 })
}

it.each([
  ['计算池', {}, []],
  ['图片处理', { MALLOC_ARENA_MAX: '2', UV_THREADPOOL_SIZE: '1', VIPS_DISC_THRESHOLD: '256m' }, ['MALLOC_ARENA_MAX', 'UV_THREADPOOL_SIZE', 'VIPS_DISC_THRESHOLD']],
] as const)('真实 %s fork 只加归属 UUID，保留白名单/Node 参数且不继承父凭据', (_name, environment, keys) => {
  const owner = randomUUID()
  const result = forkWith(environment, owner)
  expect(result.status, result.stderr).toBe(0)
  expect(JSON.parse(result.stdout)).toEqual({ keys: [...keys, 'NERVE_TEST_CI_E2E_OWNER'].sort(), owner, secretPresent: false, nodeArgs: ['--no-deprecation'], limits: keys.length === 0 ? [null, null, null] : ['2', '1', '256m'] })
  // 同一标记还会经过迁移和 API 的配置入口；新增的 NERVE_ 键必须属于既有测试保留域。
  expect(JSON.parse(result.stdout)).toHaveProperty('keys', expect.arrayContaining([expect.stringMatching(/^NERVE_TEST_[A-Z0-9_]+$/)]))
})

it('未启用监督器时不追加环境；非法标记在启动前拒绝且不回显', () => {
  const normal = forkWith({}, undefined)
  expect(normal.status, normal.stderr).toBe(0)
  expect(JSON.parse(normal.stdout)).toEqual({ keys: [], secretPresent: false, nodeArgs: ['--no-deprecation'], limits: [null, null, null] })
  const invalid = forkWith({}, 'private-invalid-marker')
  expect(invalid.status).toBe(1)
  expect(invalid.stdout).toBe('')
  expect(invalid.stderr).not.toContain('private-invalid-marker')
})

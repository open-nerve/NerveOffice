import type { BoundedCapture } from './container-e2e-resources.ts'
import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { afterEach, expect, it } from 'vitest'
import { z } from 'zod'
import { REPO_ROOT } from '../shared/repo.ts'
import { ContainerRunResources } from './container-e2e-resources.ts'
import { createSettings } from './container-e2e.ts'

const FIRST = '0199a2c4-1111-7000-8000-111111111111'
const SECOND = '0199a2c4-1111-7000-8000-222222222222'
const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function root(): string {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'nerve-container-ownership-')))
  roots.push(directory)
  return directory
}

it('相同 PID 的两次运行仍由不同 UUID 隔离项目与镜像命名空间', () => {
  const input = { pid: 4242, runId: FIRST, composeFile: '/repo/compose.yaml', envFile: '/owned/test.env', httpsPort: 18443, databasePort: 15432 }
  const first = createSettings(input)
  const second = createSettings({ ...input, runId: SECOND })
  expect(first.project).not.toBe(second.project)
  expect(first.image).not.toBe(second.image)
  expect(first.project).toBe(`nerve-office-e2e-${FIRST}`)
})

it('真实 CLI 不凭已消失 PID 删除未登记的其他项目、标签或临时目录', () => {
  const directory = root()
  const temporary = join(directory, 'tmp')
  const binaries = join(directory, 'bin')
  const output = join(directory, 'output')
  for (const path of [temporary, binaries, output])
    mkdirSync(path)
  const foreign = join(temporary, 'nerve-office-e2e-2147483646-foreign')
  mkdirSync(foreign)
  writeFileSync(join(foreign, 'keep'), 'other task')
  const calls = join(directory, 'calls.jsonl')
  const docker = join(binaries, 'docker')
  writeFileSync(docker, `#!${process.execPath}
import fs from 'node:fs'
const args = process.argv.slice(2)
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + '\\n')
if (args[0] === 'compose' && args[1] === 'ls') process.stdout.write(JSON.stringify([{ Name: 'nerve-office-e2e-2147483646' }]))
else if (args[0] === 'image' && args[1] === 'ls') process.stdout.write('nerve-office:e2e-2147483646\\n')
else if (args[0] === 'build') process.exit(1)
`)
  chmodSync(docker, 0o700)
  const result = spawnSync(process.execPath, ['tools/src/deploy/container-e2e-cli.ts'], {
    cwd: REPO_ROOT,
    env: { ...process.env, PATH: `${binaries}:${process.env.PATH ?? ''}`, TMPDIR: temporary, NERVE_TEST_OUTPUT_DIR: output, NERVE_TEST_RUN_ID: FIRST, NERVE_TEST_RUN_DIR: join(directory, 'missing-parent') },
    encoding: 'utf8',
    timeout: 15_000,
  })
  expect(result.error).toBeUndefined()
  expect(result.status).not.toBe(0)
  const operations: string[][] = existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n').map(line => z.array(z.string()).parse(JSON.parse(line))) : []
  expect(operations.filter(args => args.includes('down') || args.includes('rm'))).toEqual([])
  expect(readFileSync(join(foreign, 'keep'), 'utf8')).toBe('other task')
})

interface DockerObject {
  kind: string
  id: string
  name: string
  run: string | null
  repo: string | null
  project: string | null
}

function fixture() {
  const repo = root()
  const directory = join(repo, '.test-resources/runs', FIRST)
  const scratch = join(directory, 'scratch')
  const temporary = join(scratch, 'tmp/env')
  mkdirSync(temporary, { recursive: true })
  const marker = { version: 1, file: 'container-resources.json' }
  writeFileSync(join(directory, 'run.json'), JSON.stringify({ runId: FIRST, repo, kind: 'container', containerResources: marker }))
  const initial = { version: 1, runId: FIRST, repo, scratch, state: 'unclaimed' }
  const ledger = join(directory, 'container-resources.json')
  writeFileSync(ledger, JSON.stringify(initial))
  const settings = createSettings({ runId: FIRST, composeFile: join(repo, 'compose.yaml'), envFile: join(temporary, 'test.env'), httpsPort: 1, databasePort: 2 })
  writeFileSync(settings.envFile, 'private-key-must-stay-local', { mode: 0o600 })
  const objects: DockerObject[] = []
  const commands: string[][] = []
  const state = { daemon: 'test-daemon', failing: false, refusedKind: '', autoRemove: false }
  const capture: BoundedCapture = (input) => {
    const args = [...input]
    commands.push(args)
    if (state.failing)
      return { status: 1, stdout: '', stderr: 'not absence' }
    let stdout = ''
    if (args[0] === 'info') {
      stdout = state.daemon
    }
    else if (args[1] === 'ls') {
      const filter = args[args.indexOf('--filter') + 1] ?? ''
      stdout = objects.filter(object => object.kind === args[0] && (
        filter.startsWith('name=')
          ? object.name.includes(filter.slice(5))
          : filter.startsWith('reference=')
            ? object.name === filter.slice(10)
            : filter.startsWith('label=org.nerve-office.test.run=')
              ? object.run === filter.split('=').at(-1)
              : object.project === filter.split('=').at(-1)))
        .map(object => object.kind === 'image' ? object.name : object.id)
        .join('\n')
    }
    else if (args[1] === 'inspect') {
      const object = objects.find(object => object.kind === args[0] && (object.id === args.at(-1) || object.name === args.at(-1)))
      if (object === undefined)
        return { status: 1, stdout: '', stderr: 'missing' }
      stdout = JSON.stringify(object)
    }
    else if (args[1] === 'stop' && state.autoRemove) {
      const index = objects.findIndex(object => object.kind === 'container' && object.id === args[2])
      if (index >= 0)
        objects.splice(index, 1)
    }
    else if (args[1] === 'rm') {
      if (state.refusedKind === args[0])
        return { status: 1, stdout: '', stderr: 'external reference' }
      const index = objects.findIndex(object => object.kind === args[0] && (object.id === args[2] || object.name === args[2]))
      if (index < 0)
        return { status: 1, stdout: '', stderr: 'missing' }
      objects.splice(index, 1)
    }
    return { status: 0, stdout, stderr: '' }
  }
  const context = { directory, runId: FIRST, repo, scratch }
  const resources = new ContainerRunResources(context, settings, capture)
  function populate(run = FIRST, repoHash = resources.repoHash) {
    const project = `nerve-office-e2e-${run}`
    objects.push(
      { kind: 'container', id: `${run}-app-v2`, name: `${project}-app-1`, run, repo: repoHash, project },
      { kind: 'network', id: `${run}-network`, name: `${project}_default`, run, repo: repoHash, project },
      { kind: 'volume', id: `${project}_assets`, name: `${project}_assets`, run, repo: repoHash, project },
      { kind: 'image', id: 'sha256:1234', name: `nerve-office:e2e-${run}`, run, repo: repoHash, project: null },
    )
  }
  return { resources, settings, objects, commands, state, populate, ledger, context, capture, initial }
}

it('已退出的轮次只释放本 UUID；合法重建的 app 新 ID 可闭合，重复清理安全', () => {
  const f = fixture()
  f.populate(SECOND, 'other-worktree')
  const foreign = structuredClone(f.objects)
  f.resources.reserve()
  f.resources.producerIntent()
  f.resources.producerStarted(42)
  f.populate()
  f.resources.producerStopped(42, true)
  expect(f.resources.cleanup()).toBe(true)
  expect(f.objects).toEqual(foreign)
  expect(f.resources.cleanup()).toBe(true)
  expect(f.objects).toEqual(foreign)
  expect(readFileSync(f.settings.envFile, 'utf8')).toBe('private-key-must-stay-local')
  const recorded: unknown = JSON.parse(readFileSync(f.ledger, 'utf8'))
  expect(recorded).toMatchObject({ state: 'closed', producers: [], closure: { absent: { containers: [], networks: [], volumes: [], images: [] } } })
  expect(readFileSync(f.ledger, 'utf8')).not.toContain('private-key')
  expect(f.commands.flat()).not.toContain('--force')
})

it('已有同 UUID 名称的陌生对象拒绝 reserve，仍是未使用台账', () => {
  const f = fixture()
  f.populate(FIRST, 'unknown-repo')
  expect(() => f.resources.reserve()).toThrow('docker-namespace-not-empty')
  expect(JSON.parse(readFileSync(f.ledger, 'utf8'))).toEqual(f.initial)
  expect(f.objects).toHaveLength(4)
})

it.each(['query', 'daemon', 'label', 'producer', 'intent'])('%s 无法确认时不删除本轮对象并保留待处理台账', (failure) => {
  const f = fixture()
  f.resources.reserve()
  f.populate()
  if (failure === 'query')
    f.state.failing = true
  if (failure === 'daemon')
    f.state.daemon = 'different-daemon'
  if (failure === 'label' && f.objects[0])
    f.objects[0].repo = 'unknown-repo'
  if (failure === 'producer' || failure === 'intent') {
    f.resources.producerIntent()
    if (failure === 'producer') {
      f.resources.producerStarted(42)
      f.resources.producerStopped(42, false)
    }
  }
  const before = structuredClone(f.objects)
  expect(f.resources.cleanup()).toBe(false)
  expect(f.objects).toEqual(before)
  expect(JSON.parse(readFileSync(f.ledger, 'utf8'))).toMatchObject({ state: 'pending' })
})

it('外部引用使网络删除失败时保留后续资源；不通过 force 绕过引用', () => {
  const f = fixture()
  f.resources.reserve()
  f.populate()
  f.state.refusedKind = 'network'
  expect(f.resources.cleanup()).toBe(false)
  expect(f.objects.map(object => object.kind)).toEqual(['network'])
  expect(f.commands.flat()).not.toContain('--force')
})

it('登记生产者意向已持久化，启动失败前的缺口不能被当作已退出', () => {
  const f = fixture()
  f.resources.reserve()
  f.resources.producerIntent()
  expect(JSON.parse(readFileSync(f.ledger, 'utf8'))).toMatchObject({ state: 'reserved', producers: [null] })
  expect(f.resources.cleanup()).toBe(false)
  f.resources.producerStopped(undefined, true)
  expect(f.resources.cleanup()).toBe(true)
})

it.each(['build', 'env'])('有效父记录的真实 CLI 在 %s 失败后收尾，仍保留旧 PID/其他 UUID 与临时目录', (failure) => {
  const f = fixture()
  const source = join(f.context.repo, 'tools/src')
  mkdirSync(join(source, 'deploy'), { recursive: true })
  mkdirSync(join(source, 'shared'))
  for (const name of ['container-e2e-cli', 'container-e2e-json', 'container-e2e', 'container-e2e-process', 'container-e2e-resources', 'container-image-checks', 'native-image-materials'])
    copyFileSync(join(REPO_ROOT, `tools/src/deploy/${name}.ts`), join(source, `deploy/${name}.ts`))
  copyFileSync(join(REPO_ROOT, 'tools/src/shared/repo.ts'), join(source, 'shared/repo.ts'))
  symlinkSync(join(REPO_ROOT, 'tools/node_modules'), join(f.context.repo, 'node_modules'), 'dir')
  writeFileSync(join(f.context.repo, 'package.json'), JSON.stringify({ type: 'module', version: '0.0.0' }))
  const bin = join(f.context.repo, 'bin')
  const output = join(f.context.scratch, 'tests/e2e/test-results')
  mkdirSync(bin)
  mkdirSync(output, { recursive: true })
  const foreign = join(f.context.scratch, 'tmp/nerve-office-e2e-2147483646-foreign')
  mkdirSync(foreign)
  writeFileSync(join(foreign, 'keep'), 'other-task')
  const calls = join(f.context.repo, 'calls.jsonl')
  const image = join(f.context.repo, 'owned-image')
  const docker = join(bin, 'docker')
  writeFileSync(docker, `#!${process.execPath}
import fs from 'node:fs'
const args = process.argv.slice(2)
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + '\\n')
const ledger = JSON.parse(fs.readFileSync(${JSON.stringify(f.ledger)}, 'utf8'))
if (args[0] === 'info') {
  if (${JSON.stringify(failure)} === 'env' && ledger.state === 'unclaimed') {
    const base = ${JSON.stringify(join(f.context.scratch, 'tmp'))}
    const name = fs.readdirSync(base).find(name => name.startsWith('nerve-office-e2e-' + ledger.runId + '-'))
    fs.mkdirSync(base + '/' + name + '/test.env')
  }
  process.stdout.write('test-daemon')
}
else if (args[0] === 'build') {
  if (ledger.state !== 'reserved' || ledger.producers.length !== 1 || ledger.producers[0] !== process.pid) throw new Error('not-registered-before-build')
  if (!args.includes('org.nerve-office.test.run=' + ledger.runId) || !args.includes('org.nerve-office.test.repo=' + ledger.repoHash)) throw new Error('missing-labels')
  if ((fs.statSync(ledger.temporaryDirectory + '/test.env').mode & 0o777) !== 0o600) throw new Error('unsafe-env')
  fs.writeFileSync(${JSON.stringify(image)}, 'owned-tag')
  process.exit(1)
}
else if (args[0] === 'compose' && args[1] === 'ls') process.stdout.write(JSON.stringify([{ Name: 'nerve-office-e2e-2147483646' }]))
else if (args[0] === 'image' && args[1] === 'ls') {
  const filter = args[args.indexOf('--filter') + 1]
  if (filter === 'reference=nerve-office:e2e-*') process.stdout.write('nerve-office:e2e-2147483646\\n')
  else if (fs.existsSync(${JSON.stringify(image)})) process.stdout.write(${JSON.stringify(f.settings.image)})
}
else if (args[0] === 'image' && args[1] === 'inspect') process.stdout.write(JSON.stringify({ id:'sha256:1234', name:ledger.image, run:ledger.runId, repo:ledger.repoHash, project:null }))
else if (args[0] === 'image' && args[1] === 'rm' && args[2] === ledger.image) fs.unlinkSync(${JSON.stringify(image)})
`)
  chmodSync(docker, 0o700)
  const result = spawnSync(process.execPath, [join(source, 'deploy/container-e2e-cli.ts')], {
    cwd: f.context.repo,
    encoding: 'utf8',
    timeout: 15_000,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}`, TMPDIR: join(f.context.scratch, 'tmp'), NERVE_TEST_OUTPUT_DIR: output, NERVE_TEST_RUN_ID: FIRST, NERVE_TEST_RUN_DIR: f.context.directory, NERVE_TEST_SCRATCH: f.context.scratch },
  })
  expect(result.error).toBeUndefined()
  expect(result.status, result.stderr).toBe(1)
  const operations = readFileSync(calls, 'utf8').trim().split('\n').map(line => z.array(z.string()).parse(JSON.parse(line)))
  expect(operations.some(args => args[0] === 'build')).toBe(failure === 'build')
  expect(existsSync(image)).toBe(false)
  expect(JSON.parse(readFileSync(f.ledger, 'utf8')), result.stdout + result.stderr).toMatchObject({ state: 'closed' })
  expect(operations.filter(args => args.includes('down'))).toEqual([])
  expect(operations.filter(args => args.includes('rm'))).toEqual(failure === 'build' ? [['image', 'rm', f.settings.image]] : [])
  expect(readFileSync(join(foreign, 'keep'), 'utf8')).toBe('other-task')
  expect(readFileSync(f.settings.envFile, 'utf8')).toBe('private-key-must-stay-local')
})

it('一次性容器 stop 后自动删除时，成功列表证明不存在即可继续闭合', () => {
  const f = fixture()
  f.resources.reserve()
  f.populate()
  f.state.autoRemove = true
  expect(f.resources.cleanup()).toBe(true)
  expect(f.objects).toEqual([])
})

it('单个卷删除被拒不跳过其他已验证的独立镜像标签；最终仍 pending', () => {
  const f = fixture()
  f.resources.reserve()
  f.populate()
  f.state.refusedKind = 'volume'
  expect(f.resources.cleanup()).toBe(false)
  expect(f.objects.map(object => object.kind)).toEqual(['volume'])
  expect(JSON.parse(readFileSync(f.ledger, 'utf8'))).toMatchObject({ state: 'pending' })
})

it('日志收集也先核对本轮 daemon 与容器标签，不读取换 daemon 后的同名项目', () => {
  const f = fixture()
  f.resources.reserve()
  f.populate()
  expect(f.resources.canCollect()).toBe(true)
  f.state.daemon = 'different-daemon'
  expect(f.resources.canCollect()).toBe(false)
  expect(f.objects).toHaveLength(4)
})

it.each(['state', 'escaped-state', 'parent-marker', 'number'])('歧义 JSON %s 在任何 Docker 调用前拒绝，保留环境', (mode) => {
  const f = fixture()
  const path = mode === 'parent-marker' ? join(f.context.directory, 'run.json') : f.ledger
  let raw = readFileSync(path, 'utf8')
  if (mode === 'parent-marker')
    raw = raw.replace('"version":1', '"version":2,"version":1')
  else if (mode === 'number')
    raw = raw.replace('"version":1', '"version":1e309,"version":1')
  else
    raw = raw.replace('"state":"unclaimed"', mode === 'state' ? '"state":"reserved","state":"unclaimed"' : '"state":"reserved","st\\u0061te":"unclaimed"')
  writeFileSync(path, raw)
  expect(() => new ContainerRunResources(f.context, f.settings, f.capture)).toThrow()
  expect(f.commands).toEqual([])
  expect(readFileSync(f.settings.envFile, 'utf8')).toBe('private-key-must-stay-local')
  expect(readFileSync(path, 'utf8')).toBe(raw)
})

it('重复闭合保留曾真实核对的对象与镜像身份', () => {
  const f = fixture()
  f.resources.reserve()
  f.populate()
  expect(f.resources.cleanup()).toBe(true)
  const before: unknown = JSON.parse(readFileSync(f.ledger, 'utf8'))
  expect(f.resources.cleanup()).toBe(true)
  const after: unknown = JSON.parse(readFileSync(f.ledger, 'utf8'))
  const observations = z.object({ observed: z.unknown(), observedImageIds: z.unknown() })
  expect(observations.parse(after)).toEqual(observations.parse(before))
})

it('inspect 的重复身份字段拒绝整个删除集合', () => {
  const f = fixture()
  const resources = new ContainerRunResources(f.context, f.settings, (args) => {
    const result = f.capture(args)
    if (args[1] === 'inspect')
      return { ...result, stdout: result.stdout.replace(`"run":"${FIRST}"`, `"run":"foreign","run":"${FIRST}"`) }
    return result
  })
  resources.reserve()
  f.populate()
  expect(resources.cleanup()).toBe(false)
  expect(f.objects).toHaveLength(4)
  expect(f.commands.filter(args => args[1] === 'stop' || args[1] === 'rm')).toEqual([])
  expect(JSON.parse(readFileSync(f.ledger, 'utf8'))).toMatchObject({ state: 'pending' })
})

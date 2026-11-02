import type { ResourceCapture } from './container-e2e-resources.ts'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { LinuxBrowserCache } from './linux-browser-cache.ts'
import { PLAYWRIGHT_IMAGE } from './linux-browser.ts'

const roots: string[] = []
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })))

function fixture(present = false) {
  const directory = mkdtempSync(join(tmpdir(), 'nerve-linux-cache-'))
  roots.push(directory)
  const state = { present, daemon: 'daemon-one', used: false, extraTag: false, queryFailed: false }
  const calls: string[][] = []
  function capture(args: readonly string[]): ResourceCapture {
    calls.push([...args])
    const ok = (value: unknown) => ({ status: 0, stdout: typeof value === 'string' ? value : JSON.stringify(value), stderr: '' })
    if (state.queryFailed)
      return { status: 1, stdout: '', stderr: 'unavailable' }
    if (args[0] === 'info')
      return ok(state.daemon)
    if (args[0] === 'image' && args[1] === 'inspect') {
      return state.present
        ? ok({ id: `sha256:${'a'.repeat(64)}`, bytes: 100, os: 'linux', arch: 'arm64', tags: state.extraTag ? ['other-project:keep'] : null, digests: [PLAYWRIGHT_IMAGE] })
        : { status: 1, stdout: '', stderr: `Error response from daemon: No such image: ${PLAYWRIGHT_IMAGE}` }
    }
    if (args[0] === 'container' && args[1] === 'ls')
      return ok(state.used ? 'container-foreign' : '')
    if (args[0] === 'image' && args[1] === 'rm') {
      state.present = false
      return ok('removed')
    }
    throw new Error('unexpected query')
  }
  const cache = new LinuxBrowserCache(directory, 'run-one', capture)
  return { state, calls, cache, directory, record: () => JSON.parse(readFileSync(join(directory, 'linux-browser-image.json'), 'utf8')) as { state: string } }
}

it('拉取前持久登记；成功或失败结束只非强制删除本轮新增且未共享的 digest', () => {
  const { cache, state, calls, record } = fixture()
  expect(cache.reserve()).toBe(true)
  expect(record().state).toBe('intent')
  state.present = true
  cache.acquired()
  expect(cache.release(true)).toBe(true)
  expect(record().state).toBe('released')
  expect(calls.filter(args => args[1] === 'rm')).toEqual([['image', 'rm', PLAYWRIGHT_IMAGE]])
  expect(cache.release(true)).toBe(true)
  expect(calls.filter(args => args[1] === 'rm')).toHaveLength(1)
})

it('既有镜像只借用，其他容器或新引用出现时保留共享镜像', () => {
  const existing = fixture(true)
  expect(existing.cache.reserve()).toBe(false)
  expect(existing.cache.release(true)).toBe(true)
  expect(existing.calls.some(args => args[1] === 'rm')).toBe(false)
  for (const field of ['used', 'extraTag'] as const) {
    const { cache, state, calls, record } = fixture()
    cache.reserve()
    state.present = true
    cache.acquired()
    state[field] = true
    expect(cache.release(true)).toBe(true)
    expect(record().state).toBe('shared')
    expect(calls.some(args => args[1] === 'rm')).toBe(false)
  }
})

it('中断拉取未确认退出、daemon 改变或查询失败都不删除', () => {
  for (const problem of ['producer', 'daemon', 'query']) {
    const { cache, state, calls, record } = fixture()
    cache.reserve()
    state.present = true
    cache.acquired()
    if (problem === 'daemon')
      state.daemon = 'other-daemon'
    if (problem === 'query')
      state.queryFailed = true
    expect(cache.release(problem !== 'producer')).toBe(false)
    expect(record().state).toBe('uncertain')
    expect(calls.some(args => args[1] === 'rm')).toBe(false)
  }
})

it.each(['identity', 'bytes', 'bom'])('同 UUID 台账被改写也不取得删除权或覆盖未知台账：%s', (mode) => {
  const { cache, state, calls, directory } = fixture()
  cache.reserve()
  state.present = true
  cache.acquired()
  const path = join(directory, 'linux-browser-image.json')
  const original = readFileSync(path, 'utf8')
  const changed = mode === 'identity' ? original.replace('daemon-one', 'other-daemon') : mode === 'bom' ? `\uFEFF${original}` : `${original} `
  writeFileSync(path, changed)
  expect(cache.release(true)).toBe(false)
  expect(calls.some(args => args[1] === 'rm')).toBe(false)
  expect(readFileSync(path, 'utf8')).toBe(changed)
})

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { claimProfile } from './profile-claim.ts'

const complete = { completed: true, continuous: true, cleanupSucceeded: true }

let directory: string
let ledger: string
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'nerve-profile-claim-test-'))
  ledger = join(directory, 'pages.json')
  writeFileSync(ledger, '{}')
})
afterEach(() => rmSync(directory, { recursive: true, force: true }))

it('未完整收尾的运行留下持久 claim，另一次运行不能按已知当前页重新认领', () => {
  claimProfile(ledger, 'run-a')
  expect(() => claimProfile(ledger, 'run-b')).toThrow()
  expect(readFileSync(`${ledger}.active`, 'utf8')).toContain('run-a')
})

it('失效清单写盘失败也不能恢复资格，正常资源清理不删除 claim', () => {
  claimProfile(ledger, 'run-a')
  expect(() => writeFileSync(directory, 'invalidated')).toThrow()
  expect(() => claimProfile(ledger, 'run-b')).toThrow()
})

it('只有持有原样 claim 的正常收尾才可释放，不能删除被替换的 claim', () => {
  const first = claimProfile(ledger, 'run-a')
  expect(first.release(complete)).toBe(true)
  const second = claimProfile(ledger, 'run-b')
  writeFileSync(`${ledger}.active`, '{"runId":"someone-else"}')
  expect(() => second.release(complete)).toThrow()
  expect(readFileSync(`${ledger}.active`, 'utf8')).toContain('someone-else')
})

it.each([{ completed: false }, { continuous: false }, { cleanupSucceeded: false }])('中止、活动后返回已知 URL 或清理失败均不能释放：%j', (failed) => {
  const first = claimProfile(ledger, 'run-a')
  expect(first.release({ ...complete, ...failed })).toBe(false)
  expect(() => claimProfile(ledger, 'run-b')).toThrow()
})

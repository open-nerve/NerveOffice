import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { managedOutputPath, managedVmTemporaryRoot, requireManagedVm } from './managed-output.ts'

const directories: string[] = []
function setup(): { scratch: string, output: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'nerve-managed-output-')))
  directories.push(root)
  const scratch = join(root, 'scratch')
  const output = join(scratch, 'tests/e2e/test-results')
  mkdirSync(output, { recursive: true })
  writeFileSync(join(root, 'run.json'), JSON.stringify({ version: 1, runId: '11111111-1111-4111-8111-111111111111', status: 'running' }))
  vi.stubEnv('NERVE_TEST_RUN_ID', '11111111-1111-4111-8111-111111111111')
  vi.stubEnv('NERVE_TEST_SCRATCH', scratch)
  vi.stubEnv('NERVE_TEST_OUTPUT_DIR', output)
  return { scratch, output }
}
afterEach(() => {
  vi.unstubAllEnvs()
  for (const root of directories.splice(0))
    rmSync(root, { recursive: true, force: true })
})

describe('测试入口的实际资源归属', () => {
  it('服务日志和控制文件使用本轮独占输出', () => {
    const { output } = setup()
    expect(managedOutputPath('e2e-server.log')).toBe(join(output, 'e2e-server.log'))
    expect(managedOutputPath('e2e-server.json')).toBe(join(output, 'e2e-server.json'))
  })
  it('拒绝未经过运行器的实际测试及路径逃逸', () => {
    vi.stubEnv('NERVE_TEST_RUN_ID', undefined)
    expect(() => managedOutputPath('results.json')).toThrow(/运行器/)
    setup()
    expect(() => managedOutputPath('../other')).toThrow(/文件名/)
  })
  it('拒绝输出父目录指向其他目录', () => {
    const { scratch } = setup()
    const business = join(scratch, '..', 'business')
    mkdirSync(business)
    rmSync(join(scratch, 'tests/e2e'), { recursive: true })
    symlinkSync(business, join(scratch, 'tests/e2e'))
    expect(() => managedOutputPath('results.json')).toThrow(/归属|链接/)
  })
  it('拒绝旧身份或篡改后的输出位置', () => {
    setup()
    vi.stubEnv('NERVE_TEST_RUN_ID', '22222222-2222-4222-8222-222222222222')
    expect(() => managedOutputPath('results.json')).toThrow(/归属/)
    setup()
    vi.stubEnv('NERVE_TEST_OUTPUT_DIR', '/tmp/unowned')
    expect(() => managedOutputPath('results.json')).toThrow(/归属/)
  })
  it('已登记的本轮 VM 短路径可用，长度适合 SSH mux', () => {
    const { scratch } = setup()
    const runId = randomUUID()
    const root = join(realpathSync('/tmp'), `nerve-vm-${runId}`)
    mkdirSync(root)
    directories.push(root)
    writeFileSync(join(dirname(scratch), 'run.json'), JSON.stringify({ version: 1, runId, status: 'running', shortRoot: root, repo: 'fixture' }))
    writeFileSync(join(root, 'owner.json'), JSON.stringify({ runId, repo: 'fixture', kind: 'vm-short-path' }))
    vi.stubEnv('NERVE_TEST_RUN_ID', runId)
    vi.stubEnv('NERVE_TEST_SHORT_ROOT', root)
    expect(managedVmTemporaryRoot()).toBe(root)
    expect(join(root, 'ssh-123456/control').length).toBeLessThan(100)
  })
  it('VM 短路径不能借用其他任务的临时目录', () => {
    setup()
    vi.stubEnv('NERVE_TEST_SHORT_ROOT', '/tmp/other-task')
    expect(() => managedVmTemporaryRoot()).toThrow(/短路径/)
  })
  it('VM 入口仅接受本轮目录内的资源和结果，不认领外部磁盘', () => {
    const { scratch, output } = setup()
    const directory = join(scratch, 'vm')
    mkdirSync(directory)
    const disk = join(directory, 'disk.img')
    writeFileSync(disk, 'tiny synthetic sample')
    expect(() => requireManagedVm({ directory, disk }, join(output, 'vm-result'))).not.toThrow()
    expect(() => requireManagedVm({ directory, disk: '/tmp/business.img' }, join(output, 'vm-result'))).toThrow(/本轮/)
    expect(() => requireManagedVm({ directory, disk }, '/tmp/other-result')).toThrow(/本轮/)
  })
  it('VM 目录中的外部磁盘链接也不能通过', () => {
    const { scratch, output } = setup()
    const directory = join(scratch, 'vm')
    mkdirSync(directory)
    const disk = join(directory, 'disk.img')
    symlinkSync(join(scratch, 'tests'), disk)
    expect(() => requireManagedVm({ directory, disk }, join(output, 'vm-result'))).toThrow(/链接/)
  })
})

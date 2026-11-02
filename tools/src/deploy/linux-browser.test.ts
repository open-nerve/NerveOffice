import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { expect, it } from 'vitest'
import { REPO_ROOT } from '../shared/repo.ts'
import { ContainerRunResources } from './container-e2e-resources.ts'
import { createSettings } from './container-e2e.ts'
import { browserPlan, budgetProblem, GIB, guestExitStatus, PLAYWRIGHT_IMAGE, stopWithMeter, withLinuxCleanup } from './linux-browser.ts'

it('只生成原生隔离的一条校准和十三条故事，不修改原 timeout/retry/trace', () => {
  const plan = browserPlan('nerve-office-e2e-example', '/owned/scratch', ['run=one', 'repo=two'])
  expect(plan.groups.map(group => [group.name, group.count])).toEqual([['calibration', 1], ['stories', 13]])
  expect(plan.runner).toContain(PLAYWRIGHT_IMAGE)
  expect(plan.runner).toContain('--pull=never')
  expect(plan.runner).toContain('--memory=4g')
  expect(plan.runner).toContain('--cpus=3')
  expect(plan.runner).toContain('--shm-size=1g')
  const args = plan.runner.join(' ')
  expect(args).not.toMatch(/privileged|docker\.sock|ipc=host|network=host|pid=host|amd64/)
  expect(plan.groups.flatMap(group => group.args)).not.toEqual(expect.arrayContaining(['--retries=0', '--timeout=300000']))
  expect(plan.groups.every(group => group.args.includes('--workers=1') && group.args.includes('--project=chromium'))).toBe(true)
})

it('预算在 16 GiB 或空间少于 12 GiB 时停止；未知采样不能放行', () => {
  expect(budgetProblem({ workspace: 0, scratch: 1, writable: 2, database: 3, image: 4, available: 13 * GIB })).toBeUndefined()
  expect(budgetProblem({ workspace: 0, scratch: 10 * GIB, writable: GIB, database: 0, image: 5 * GIB, available: 20 * GIB })).toBe('environment-budget')
  expect(budgetProblem({ workspace: 0, scratch: 0, writable: 0, database: 0, image: 0, available: 12 * GIB - 1 })).toBe('disk-reserve')
  expect(budgetProblem({ workspace: 0, scratch: Number.NaN, writable: 0, database: 0, image: 0, available: 20 * GIB })).toBe('measurement-invalid')
})

it('两轮内部卷隔离，runner 不把宿主文件作为工作目录或 init 映射', () => {
  const first = browserPlan('run-first', '/scratch/first', ['run=first'])
  const second = browserPlan('run-second', '/scratch/second', ['run=second'])
  expect(first.runner.join(' ')).toContain('run-first_assets:/owned')
  expect(first.runner).not.toContain('--init')
  expect(first.runner.join(' ')).not.toContain('/scratch/first:/')
  expect(first.runner.join(' ')).toContain('volume-subpath=node,readonly')
  expect(second.runner.join(' ')).not.toContain('/scratch/first')
  expect(first.database.join(' ')).toContain('run-first_pgdata')
  expect(second.database.join(' ')).toContain('run-second_pgdata')
})

it('真实准备命令之后可用原 Store 创建归属，不留下未登记管理目录', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'nerve-linux-store-')))
  try {
    const owned = join(root, 'owned')
    const toolchain = join(root, 'toolchain')
    mkdirSync(toolchain)
    writeFileSync(join(toolchain, 'tiny-node'), 'tiny fixture')
    const quote = (path: string) => `'${path.replaceAll('\'', '\'\\\'\'')}'`
    const command = browserPlan('example', '/unused', []).preparation.at(-1)!.replaceAll('/owned', quote(owned)).replaceAll('/usr/local/.', `${quote(toolchain)}/.`)
    execFileSync('/bin/sh', ['-eu', '-c', command])
    const repo = join(owned, 'source')
    execFileSync('python3', ['-B', '-c', 'import sys; from pathlib import Path; sys.path.insert(0, sys.argv[1]); from lifecycle import Store; Store(Path(sys.argv[2]))', join(REPO_ROOT, 'tools/test-resources'), repo])
    expect(JSON.parse(readFileSync(join(repo, '.test-resources/owner.json'), 'utf8'))).toEqual({
      version: 1,
      purpose: 'nerve-office-test-resources',
      repo,
    })
    expect(existsSync(join(repo, '.test-resources/runs'))).toBe(true)
    expect(readFileSync(join(owned, 'node/tiny-node'), 'utf8')).toBe('tiny fixture')
  }
  finally {
    rmSync(root, { recursive: true, force: true })
  }
})

it.each([0, 1, 130])('成功、失败与中断（%i）都先停止写入、导出，再闭合容器和卷', async (status) => {
  const events: string[] = []
  const result = await withLinuxCleanup({
    body: async () => {
      events.push('body')
      return status
    },
    quiesce: async () => {
      events.push('quiesce')
      return true
    },
    close: async () => {
      events.push('close')
      return true
    },
    collect: async () => {
      events.push('collect')
      return { safeToRelease: true, passed: status === 0 }
    },
    release: async (closed) => {
      events.push(`release:${closed}`)
      return true
    },
  })
  expect(events).toEqual(['body', 'quiesce', 'collect', 'close', 'release:true'])
  expect(result.status).toBe(status)
})

it('创建中途抛错仍清理；未闭合时不读取报告、不给镜像删除许可', async () => {
  const events: string[] = []
  const result = await withLinuxCleanup({
    body: async () => { throw new Error('setup failed') },
    quiesce: async () => false,
    close: async () => {
      events.push('unsafe-close')
      return false
    },
    collect: async () => {
      events.push('unsafe-copy')
      return { safeToRelease: false, passed: false }
    },
    release: async (closed) => {
      events.push(`release:${closed}`)
      return false
    },
  })
  expect(result.status).toBe(1)
  expect(events).toEqual(['release:false'])
  expect(result.errors).toEqual(['execution-failed', 'container-not-quiescent', 'container-not-closed', 'image-not-handled'])
})

it('Linux 的实际 env 路径能通过既有父协议 reserve 并闭合空命名空间', () => {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'nerve-linux-parent-')))
  try {
    const runId = '0199a2c4-1111-7000-8000-111111111111'
    const directory = join(repo, '.test-resources/runs', runId)
    const scratch = join(directory, 'scratch')
    const plan = browserPlan(`nerve-office-e2e-${runId}`, scratch, [])
    const envFile = plan.runner[plan.runner.indexOf('--env-file') + 1]!
    mkdirSync(dirname(envFile), { recursive: true })
    writeFileSync(join(directory, 'run.json'), JSON.stringify({ runId, repo, kind: 'container', containerResources: { version: 1, file: 'container-resources.json' } }))
    writeFileSync(join(directory, 'container-resources.json'), JSON.stringify({ version: 1, runId, repo, scratch, state: 'unclaimed' }))
    const settings = createSettings({ runId, envFile, composeFile: join(repo, 'unused'), httpsPort: 1, databasePort: 2 })
    const resources = new ContainerRunResources({ directory, runId, repo, scratch }, settings, args => ({ status: 0, stdout: args[0] === 'info' ? 'daemon' : '', stderr: '' }))
    expect(() => resources.reserve()).not.toThrow()
    expect(resources.cleanup()).toBe(true)
  }
  finally {
    rmSync(repo, { recursive: true, force: true })
  }
})

it('Docker 客户端零退出不能代替 guest 停止、零退出且无 OOM', () => {
  expect(guestExitStatus(0, { running: false, exit: 0, oom: false })).toBe(0)
  expect(guestExitStatus(0, { running: true, exit: 0, oom: false })).toBe(1)
  expect(guestExitStatus(0, { running: false, exit: 137, oom: true })).toBe(1)
  expect(guestExitStatus(130, { running: false, exit: 0, oom: false })).toBe(130)
})

it('导出不完整时保留内部卷；有界失败证据完整时允许清理而不改产品失败', async () => {
  for (const safeToRelease of [true, false]) {
    const events: string[] = []
    const result = await withLinuxCleanup({
      body: async () => 1,
      quiesce: async () => true,
      collect: async () => ({ safeToRelease, passed: false }),
      close: async () => {
        events.push('delete-volume')
        return true
      },
      release: async () => true,
    })
    expect(result.status).toBe(1)
    expect(events).toEqual(safeToRelease ? ['delete-volume'] : [])
    expect(result.closed).toBe(safeToRelease)
  }
})

it('内部卷容量计入环境上限，不因宿主 scratch 较小而漏算', () => {
  expect(budgetProblem({ scratch: 0, workspace: 11 * GIB, database: 0, writable: 0, image: 5 * GIB, available: 30 * GIB })).toBe('environment-budget')
})

it('容量或句柄采样失败仍结束本轮计量器，并保持停止失败结果', async () => {
  for (const fail of ['writers', 'measurement']) {
    const events: string[] = []
    await expect(stopWithMeter({
      writers: [
        () => {
          events.push('writers')
          if (fail === 'writers')
            throw new Error('writer-stop-failed')
        },
        () => { events.push('remaining-writer-stopped') },
      ],
      measure: async () => {
        events.push('measure')
        throw new Error('container-oom')
      },
      meter: () => { events.push('meter-stopped') },
    })).rejects.toThrow()
    expect(events).toContain('remaining-writer-stopped')
    expect(events.at(-1)).toBe('meter-stopped')
  }
})

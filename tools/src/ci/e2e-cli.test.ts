import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT } from '../shared/repo.ts'

const cli = new URL('./e2e-cli.ts', import.meta.url).href

function prepare(directory: string, browser: string): number | null {
  // prepare 只写 owner 文件，不查询 /proc 或发送信号。非 Linux 的小型测试仅模拟这个平台入口；
  // 真实 Linux 运行/软停止契约仍由 e2e-process.test-support.ts 在 CI 中执行。
  const platform = process.platform === 'linux' ? '' : 'Object.defineProperty(process,"platform",{value:"linux"});'
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `${platform}process.argv[2]='prepare';await import(${JSON.stringify(cli)});`], {
    cwd: REPO_ROOT,
    env: { ...process.env, CI: 'true', NERVE_CI_E2E_STATE: directory, E2E_BROWSERS: browser },
    encoding: 'utf8',
    timeout: 5000,
  })
  expect(result.error).toBeUndefined()
  expect(result.signal).toBeNull()
  return result.status
}

describe('CI prepare 的真实文件契约（不运行进程监督或浏览器）', () => {
  it('CLI 在启动前把固定分片预算写入独占 owner，后续环境变化不能覆盖它', () => {
    const root = mkdtempSync(join(tmpdir(), 'nerve-ci-prepare-'))
    try {
      for (const [browser, runMs] of [['', 5_400_000], ['chromium', 5_400_000], ['chrome', 5_400_000], ['msedge', 5_400_000], ['webkit', 7_200_000]] as const) {
        const directory = join(root, browser || 'default')
        expect(prepare(directory, browser), browser).toBe(0)
        const original = readFileSync(join(directory, 'owner.json'), 'utf8')
        expect(JSON.parse(original) as unknown, browser).toMatchObject({
          root: realpathSync(REPO_ROOT),
          budgets: { runMs, cleanupMs: 900_000, forceMs: 60_000, pollMs: 250 },
        })
        expect(prepare(directory, browser === 'webkit' ? 'chrome' : 'webkit'), browser).toBe(1)
        expect(readFileSync(join(directory, 'owner.json'), 'utf8')).toBe(original)
      }
    }
    finally { rmSync(root, { recursive: true, force: true }) }
  }, 20_000)
})

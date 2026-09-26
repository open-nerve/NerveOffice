// 迁移门禁的装配：用临时 git 仓库验证读取基准的各种情况（审查 B4、B5、B10）。
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { gitIn, migrationsBaseRef, readAt, runMigrationsGate } from './migrations-gate.ts'
import { MIGRATIONS_DIR } from './migrations.ts'

const ZERO = '00000000-0000-0000-0000-000000000000'
let root: string

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

function write(path: string, content: string): void {
  const absolute = join(root, path)
  mkdirSync(dirname(absolute), { recursive: true })
  writeFileSync(absolute, content)
}

function commit(message: string): string {
  git('add', '-A')
  git('commit', '-q', '-m', message)
  return git('rev-parse', 'HEAD').trim()
}

/** 写入合规的迁移：journal、SQL 与快照（prevId 连成链）。 */
function writeMigrations(tags: string[]): void {
  const entries = tags.map((tag, idx) => ({ idx, version: '7', when: 1000 * (idx + 1), tag, breakpoints: true }))
  write(`${MIGRATIONS_DIR}/meta/_journal.json`, JSON.stringify({ version: '7', dialect: 'postgresql', entries }))
  for (const [idx, tag] of tags.entries()) {
    write(`${MIGRATIONS_DIR}/${tag}.sql`, `CREATE TABLE t${idx} (id int);\n`)
    write(`${MIGRATIONS_DIR}/meta/${String(idx).padStart(4, '0')}_snapshot.json`, JSON.stringify({ id: `id-${idx}`, prevId: idx === 0 ? ZERO : `id-${idx - 1}` }))
  }
}

function gate(env: NodeJS.ProcessEnv = {}): ReturnType<typeof runMigrationsGate> {
  return runMigrationsGate({ root, env, git: gitIn(root) })
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'nerve-migrations-gate-'))
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 'gate@example.com')
  git('config', 'user.name', 'gate')
  git('config', 'commit.gpgsign', 'false')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('迁移门禁的装配', () => {
  it('非 ASCII 的文件名从 git 原样读出（-z，不转义）', () => {
    write(`${MIGRATIONS_DIR}/说明.txt`, '中文文件名')
    commit('中文文件名')
    expect(gitIn(root).listFiles('HEAD', MIGRATIONS_DIR)).toEqual([`${MIGRATIONS_DIR}/说明.txt`])
    expect(readAt(gitIn(root), 'HEAD')).toEqual(new Map([['说明.txt', '中文文件名']]))
  })

  it('分支上的迁移与 main 的分叉点比较：新迁移追加在末尾通过；改动已合并的迁移失败', () => {
    writeMigrations(['0000_first'])
    commit('第一个迁移')
    git('switch', '-q', '-c', 'feature')
    writeMigrations(['0000_first', '0001_second'])
    expect(gate().violations).toEqual([])
    write(`${MIGRATIONS_DIR}/0000_first.sql`, 'DROP TABLE t0;\n')
    expect(gate().violations).toMatchObject([{ rule: 'migrations/immutable', subject: '0000_first.sql' }])
  })

  it('一次推送含多个提交：用推送之前的提交作基准，中间提交里的改动也能发现', () => {
    writeMigrations(['0000_first'])
    const beforePush = commit('已推送的 main')
    write(`${MIGRATIONS_DIR}/0000_first.sql`, 'DROP TABLE t0;\n')
    commit('改了已合并的迁移')
    write('README.md', '无关的改动')
    commit('无关的提交')
    // 只和 HEAD^1 比，改动在更早的提交里，发现不了；这正是 CI 的推送事件要传入推送之前的提交的原因
    expect(gate({ GITHUB_ACTIONS: 'true' }).violations).toEqual([])
    expect(gate({ GITHUB_ACTIONS: 'true', GATE_MIGRATIONS_BASE: beforePush }).violations).toMatchObject([{ rule: 'migrations/immutable' }])
  })

  it('取不到基准时失败，不静默通过', () => {
    writeMigrations(['0000_first'])
    commit('第一个迁移')
    expect(gate({ GATE_MIGRATIONS_BASE: 'no-such-ref' }).violations).toMatchObject([{ rule: 'migrations/base' }])
  })
})

describe('migrationsBaseRef', () => {
  const mergeBase = (): string => 'abc123'

  it('指定的基准优先：CI 的推送事件传入推送之前的提交', () => {
    expect(migrationsBaseRef({ GATE_MIGRATIONS_BASE: 'deadbeef', GITHUB_ACTIONS: 'true' }, mergeBase)).toBe('deadbeef')
  })

  it('新建分支的推送里"推送之前的提交"是全零：视为没有指定', () => {
    expect(migrationsBaseRef({ GATE_MIGRATIONS_BASE: '0000000000000000000000000000000000000000', GITHUB_ACTIONS: 'true' }, mergeBase)).toBe('HEAD^1')
  })

  it('CI 的定时与手动触发用 HEAD^1；本机用与 main 的分叉点', () => {
    expect(migrationsBaseRef({ GITHUB_ACTIONS: 'true' }, mergeBase)).toBe('HEAD^1')
    expect(migrationsBaseRef({}, mergeBase)).toBe('abc123')
    expect(migrationsBaseRef({ GATE_MIGRATIONS_BASE: '' }, mergeBase)).toBe('abc123')
  })
})

import type { CommandOutput } from '../shared/repo.ts'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runSchemaGate } from './schema-gate.ts'

let migrations: string

const IN_SYNC: CommandOutput = { stdout: 'No schema changes, nothing to migrate 😴\n', stderr: '' }

beforeEach(() => {
  migrations = mkdtempSync(join(tmpdir(), 'nerve-schema-gate-'))
  mkdirSync(join(migrations, 'meta'))
  writeFileSync(join(migrations, '0000_first.sql'), 'CREATE TABLE t (id int);')
  writeFileSync(join(migrations, 'meta', '_journal.json'), '{}')
})

afterEach(() => {
  rmSync(migrations, { recursive: true, force: true })
})

describe('表定义与迁移同步', () => {
  it('drizzle-kit 说没有变化、没有生成文件：同步', () => {
    expect(runSchemaGate(migrations, () => IN_SYNC).violations).toEqual([])
  })

  it('按表定义会生成新的迁移：表定义改了却没有生成迁移', () => {
    const result = runSchemaGate(migrations, (outDir) => {
      writeFileSync(join(outDir, '0001_drift.sql'), 'ALTER TABLE t ADD COLUMN x int;')
      return { stdout: '[✓] Your SQL migration file ➜ 0001_drift.sql', stderr: '' }
    })
    expect(result.violations).toMatchObject([{ rule: 'schema/drift', detail: expect.stringContaining('0001_drift.sql') as unknown }])
  })

  it('需要人工确认的变更（例如改列名）：drizzle-kit 只写标准错误、不生成文件，也要失败', () => {
    const result = runSchemaGate(migrations, () => ({ stdout: '', stderr: 'Interactive prompts require a TTY terminal (process.stdin.isTTY or process.stdout.isTTY is false).\n' }))
    expect(result.violations).toMatchObject([{ rule: 'schema/unknown', detail: expect.stringContaining('TTY') as unknown }])
  })

  it('说没有变化，但标准错误里有内容：同样不算同步（复验 F7）', () => {
    const result = runSchemaGate(migrations, () => ({ stdout: IN_SYNC.stdout, stderr: 'Error: failed to load schema\n' }))
    expect(result.violations).toMatchObject([{ rule: 'schema/unknown', detail: expect.stringContaining('failed to load schema') as unknown }])
  })

  it('没有任何输出也不算同步', () => {
    expect(runSchemaGate(migrations, () => ({ stdout: '', stderr: '' })).violations).toMatchObject([{ rule: 'schema/unknown' }])
  })

  it('在副本上生成，不改动仓库里的迁移目录', () => {
    runSchemaGate(migrations, (outDir) => {
      writeFileSync(join(outDir, '0001_drift.sql'), 'x')
      return IN_SYNC
    })
    expect(() => writeFileSync(join(migrations, '0001_drift.sql'), '', { flag: 'wx' })).not.toThrow()
  })
})

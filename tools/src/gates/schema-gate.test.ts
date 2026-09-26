import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runSchemaGate } from './schema-gate.ts'

let migrations: string

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
  it('按表定义生成不出新文件：同步', () => {
    expect(runSchemaGate(migrations, () => {}).violations).toEqual([])
  })

  it('按表定义会生成新的迁移：表定义改了却没有生成迁移', () => {
    const result = runSchemaGate(migrations, (outDir) => {
      writeFileSync(join(outDir, '0001_drift.sql'), 'ALTER TABLE t ADD COLUMN x int;')
    })
    expect(result.violations).toMatchObject([{ rule: 'schema/drift', detail: expect.stringContaining('0001_drift.sql') as unknown }])
  })

  it('在副本上生成，不改动仓库里的迁移目录', () => {
    runSchemaGate(migrations, (outDir) => {
      writeFileSync(join(outDir, '0001_drift.sql'), 'x')
    })
    expect(() => writeFileSync(join(migrations, '0001_drift.sql'), '', { flag: 'wx' })).not.toThrow()
  })
})

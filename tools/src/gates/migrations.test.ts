import { describe, expect, it } from 'vitest'
import { checkMigrations } from './migrations.ts'

function journal(entries: { idx: number, when: number, tag: string }[]): string {
  return JSON.stringify({ version: '7', dialect: 'postgresql', entries: entries.map(entry => ({ ...entry, version: '7', breakpoints: true })) })
}

const FIRST = { idx: 0, when: 1000, tag: '0000_first' }
const SECOND = { idx: 1, when: 2000, tag: '0001_second' }

/** 一个合规的迁移目录：journal、SQL 与快照齐全。 */
function files(entries: typeof FIRST[], overrides: Record<string, string | undefined> = {}): Map<string, string> {
  const map = new Map<string, string>([['meta/_journal.json', journal(entries)]])
  for (const entry of entries) {
    map.set(`${entry.tag}.sql`, `-- ${entry.tag}\nCREATE TABLE t${entry.idx} (id int);`)
    map.set(`meta/${String(entry.idx).padStart(4, '0')}_snapshot.json`, `{"id":"${entry.tag}"}`)
  }
  for (const [path, content] of Object.entries(overrides)) {
    if (content === undefined)
      map.delete(path)
    else
      map.set(path, content)
  }
  return map
}

function rules(violations: { rule: string }[]): string[] {
  return violations.map(violation => violation.rule)
}

describe('checkMigrations：迁移目录本身', () => {
  it('合规：journal、SQL 与快照齐全，序号连续，时间戳递增', () => {
    expect(checkMigrations(files([FIRST, SECOND]), undefined)).toEqual([])
  })

  it('还没有任何迁移时通过', () => {
    expect(checkMigrations(new Map(), undefined)).toEqual([])
  })

  it('有 SQL 却没有 journal，或 journal 不合法', () => {
    expect(rules(checkMigrations(new Map([['0000_x.sql', 'SELECT 1']]), undefined))).toEqual(['migrations/journal'])
    expect(rules(checkMigrations(new Map([['meta/_journal.json', '{']]), undefined))).toEqual(['migrations/journal'])
  })

  it('序号不连续、时间戳没有递增、名称重复', () => {
    expect(rules(checkMigrations(files([FIRST, { ...SECOND, idx: 2 }]), undefined))).toContain('migrations/sequence')
    expect(checkMigrations(files([FIRST, { ...SECOND, when: 1000 }]), undefined)).toMatchObject([{ rule: 'migrations/sequence', subject: '0001_second' }])
    expect(rules(checkMigrations(files([FIRST, { ...SECOND, tag: FIRST.tag }]), undefined))).toContain('migrations/sequence')
  })

  it('缺少 SQL 或快照；有不在 journal 里的 SQL', () => {
    expect(checkMigrations(files([FIRST], { '0000_first.sql': undefined }), undefined)).toMatchObject([{ rule: 'migrations/files', detail: '缺少 0000_first.sql' }])
    expect(checkMigrations(files([FIRST], { 'meta/0000_snapshot.json': undefined }), undefined)).toMatchObject([{ rule: 'migrations/files' }])
    expect(checkMigrations(files([FIRST], { '0001_orphan.sql': 'SELECT 1' }), undefined)).toMatchObject([{ rule: 'migrations/files', subject: '0001_orphan.sql' }])
  })
})

describe('checkMigrations：与基准版本比较（已合并的迁移只向前）', () => {
  const base = files([FIRST])

  it('合规：基准里的迁移原样保留，新迁移追加在末尾', () => {
    expect(checkMigrations(files([FIRST, SECOND]), base)).toEqual([])
    expect(checkMigrations(base, base)).toEqual([])
  })

  it('已合并的 SQL 或快照被修改', () => {
    expect(checkMigrations(files([FIRST, SECOND], { '0000_first.sql': 'DROP TABLE t0;' }), base)).toMatchObject([{ rule: 'migrations/immutable', subject: '0000_first.sql' }])
    expect(checkMigrations(files([FIRST], { 'meta/0000_snapshot.json': '{}' }), base)).toMatchObject([{ rule: 'migrations/immutable', subject: 'meta/0000_snapshot.json' }])
  })

  it('已合并的迁移被删除、改名或调整了时间戳', () => {
    expect(rules(checkMigrations(new Map(), base))).toContain('migrations/immutable')
    expect(rules(checkMigrations(files([{ ...FIRST, tag: '0000_renamed' }]), base))).toContain('migrations/immutable')
    expect(rules(checkMigrations(files([{ ...FIRST, when: 999 }]), base))).toContain('migrations/immutable')
  })

  it('新迁移插在已合并的迁移前面', () => {
    const inserted = files([{ idx: 0, when: 500, tag: '0000_early' }, { ...FIRST, idx: 1 }])
    expect(rules(checkMigrations(inserted, base))).toContain('migrations/immutable')
  })

  it('基准版本的 journal 不合法时报告出来，不当作没有基准', () => {
    expect(rules(checkMigrations(files([FIRST]), new Map([['meta/_journal.json', 'x']])))).toEqual(['migrations/base'])
  })
})

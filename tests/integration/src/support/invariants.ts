// 只由服务保证、数据库里没有约束的数据不变量（M2-P6 复核 B 的 B5）：每一条是一条查询，返回违反它的行。
// 集成测试的库在删掉之前扫一遍（database.ts 的 drop）：任何一个用例（含并发交错）留下的违反都会让那个测试文件失败，
// 并列出违反的行；结构性改动的并发用例另在每条用例之后直接核对（documents/structure-locks.test.ts）。
// 阳性对照（每一条都造一次违反，扫描报得出来）见 invariants.test.ts。
import type pg from 'pg'

/** 每一条不变量：编号与说明 → 返回违反它的行的查询 */
export const INVARIANTS: Readonly<Record<string, string>> = {
  'I1 父子文件夹在同一个空间里':
    'SELECT c.id FROM folders c JOIN folders p ON p.id = c.parent_id WHERE c.space_id <> p.space_id',
  'I2 层数是父文件夹的层数加一':
    'SELECT c.id, c.depth, p.depth AS parent_depth FROM folders c JOIN folders p ON p.id = c.parent_id WHERE c.depth <> p.depth + 1',
  'I3 文档与它所在的文件夹在同一个空间里':
    'SELECT d.id FROM documents d JOIN folders f ON f.id = d.folder_id WHERE d.space_id <> f.space_id',
  'I4 回收站里的文件夹下面没有正常状态的文件夹':
    `SELECT c.id FROM folders c JOIN folders p ON p.id = c.parent_id WHERE c.status = 'active' AND p.status = 'trashed'`,
  'I5 回收站里的文件夹下面没有正常状态的文档':
    `SELECT d.id FROM documents d JOIN folders f ON f.id = d.folder_id WHERE d.status = 'active' AND f.status = 'trashed'`,
  'I6 删除单元里的文档与删除单元在同一个空间里':
    'SELECT d.id FROM documents d JOIN trash_entries t ON t.id = d.trash_entry_id WHERE d.space_id <> t.space_id',
  'I7 删除单元里的文件夹与删除单元在同一个空间里':
    'SELECT f.id FROM folders f JOIN trash_entries t ON t.id = f.trash_entry_id WHERE f.space_id <> t.space_id',
  'I8 删除单元不是空的':
    `SELECT t.id FROM trash_entries t
     WHERE NOT EXISTS (SELECT 1 FROM documents d WHERE d.trash_entry_id = t.id) AND NOT EXISTS (SELECT 1 FROM folders f WHERE f.trash_entry_id = t.id)`,
  'I9 文档的删除单元里恰好一份文档、没有文件夹':
    `SELECT t.id FROM trash_entries t WHERE t.kind = 'document'
       AND ((SELECT count(*) FROM documents d WHERE d.trash_entry_id = t.id) <> 1 OR EXISTS (SELECT 1 FROM folders f WHERE f.trash_entry_id = t.id))`,
  'I10 文件夹的删除单元恰好有一个根':
    `SELECT t.id FROM trash_entries t WHERE t.kind = 'folder'
       AND (SELECT count(*) FROM folders f WHERE f.trash_entry_id = t.id
              AND (f.parent_id IS NULL OR NOT EXISTS (SELECT 1 FROM folders p WHERE p.id = f.parent_id AND p.trash_entry_id = t.id))) <> 1`,
  'I11 文件夹的删除单元里的文档在同一单的文件夹里':
    `SELECT d.id FROM documents d JOIN trash_entries t ON t.id = d.trash_entry_id AND t.kind = 'folder'
       LEFT JOIN folders f ON f.id = d.folder_id WHERE f.trash_entry_id IS DISTINCT FROM d.trash_entry_id`,
  'I12 删除单元的原空间就是它所在的空间':
    'SELECT t.id FROM trash_entries t WHERE t.origin_space_id <> t.space_id',
  'I13 文档的删除单元的原位置就是那份文档的文件夹':
    `SELECT t.id FROM trash_entries t JOIN documents d ON d.trash_entry_id = t.id
     WHERE t.kind = 'document' AND t.origin_parent_id IS DISTINCT FROM d.folder_id`,
  'I14 文件夹的删除单元的原位置就是根的父文件夹':
    `SELECT t.id FROM trash_entries t JOIN folders f ON f.trash_entry_id = t.id
       AND (f.parent_id IS NULL OR NOT EXISTS (SELECT 1 FROM folders p WHERE p.id = f.parent_id AND p.trash_entry_id = t.id))
     WHERE t.kind = 'folder' AND t.origin_parent_id IS DISTINCT FROM f.parent_id`,
  'I15 空间成员只属于团队空间':
    `SELECT m.space_id, m.user_id FROM space_members m JOIN spaces s ON s.id = m.space_id WHERE s.type <> 'team'`,
}

/** 每条不变量最多列出几行：够定位，不把整张表打进错误信息 */
const ROWS_PER_INVARIANT = 5

export interface InvariantViolation {
  readonly invariant: string
  readonly rows: readonly Record<string, unknown>[]
}

/** 在这个连接的库上扫一遍：返回被违反的不变量与违反它的行（最多 ROWS_PER_INVARIANT 行） */
export async function invariantViolations(client: pg.Client): Promise<InvariantViolation[]> {
  const violations: InvariantViolation[] = []
  for (const [invariant, query] of Object.entries(INVARIANTS)) {
    const { rows } = await client.query<Record<string, unknown>>(`${query} LIMIT ${ROWS_PER_INVARIANT}`)
    if (rows.length > 0)
      violations.push({ invariant, rows })
  }
  return violations
}

/**
 * after 里比 before 多出来的违反（按不变量与行比较）：同一个库里逐条用例核对时，只报这条用例新造出来的，
 * 前面的用例失败时留下的不再让后面的每一条都跟着失败
 */
export function violationsSince(before: readonly InvariantViolation[], after: readonly InvariantViolation[]): InvariantViolation[] {
  const seen = new Set(before.flatMap(violation => violation.rows.map(row => `${violation.invariant}\n${JSON.stringify(row)}`)))
  return after.flatMap((violation) => {
    const rows = violation.rows.filter(row => !seen.has(`${violation.invariant}\n${JSON.stringify(row)}`))
    return rows.length === 0 ? [] : [{ invariant: violation.invariant, rows }]
  })
}

/** 错误信息里的一段：每条被违反的不变量一行，带着违反它的行 */
export function describeViolations(violations: readonly InvariantViolation[]): string {
  return violations.map(violation => `${violation.invariant}：${JSON.stringify(violation.rows)}`).join('\n')
}

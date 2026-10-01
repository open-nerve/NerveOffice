// 迁移与表定义一致（M2-P6 复核 B 的 B4）：门禁 schema 只比较表定义与 drizzle-kit 的快照，不看迁移的 SQL——手写或改过的迁移
// （0016、0017 的生成列，去掉一条 CHECK，把外键改成 CASCADE，新加一个悄悄删掉约束的迁移）与表定义不一致时，门禁与别的用例都发现不了。
// 这里建两个库：一个执行全部迁移（测试的模板库），一个执行 drizzle-kit 按表定义从空库生成的建库语句（与 pnpm db:generate 同一条路径：
// 表定义 → 快照 → 与空快照的差异 → SQL），逐项比较 public 模式里的这些对象：表与视图（种类、持久性、行级安全、存储参数、视图的定义）、
// 列（类型、可空、默认值、生成列的表达式、标识列、排序规则）、约束（CHECK 的定义、外键与它的动作、唯一、主键、排除）、
// 索引（完整定义，含部分索引的条件）、触发器（定义与启用状态）、函数（完整定义：参数、返回、语言、易变性与 SECURITY DEFINER 等属性、
// 配置参数与函数体，M2-P6 第 3 片复验）、规则（不属于视图的那些，同上）、行级策略、自定义类型（枚举的值、域的约束等）、扩展与模式。
// 两边都经 PostgreSQL 反解析，写法不同、意思相同的不算不一致。不比较：权限与所有者、注释、统计信息、序列的参数（只比较有没有）。
// 表定义里写不出来、只在迁移里手写的对象连同完整定义列在 HAND_WRITTEN 里：多一个、少一个、改了定义（包括函数体）都会失败。
// 取代复验 S1 只核对 spaces.name_key 表达式的那一条用例：生成列的表达式在"列"一项里逐字比较。
import type pg from 'pg'
import type { TestDatabase } from '../support/database.ts'
import { TABLE_DEFINITIONS } from '@nerve-office/api/testing'
import { generateDrizzleJson, generateMigration } from 'drizzle-kit/api'
import { afterAll, describe, expect, it } from 'vitest'
import { createTestDatabase } from '../support/database.ts'

/**
 * 只在迁移里手写的对象（表定义写不出触发器与函数），每一项是目录里的一行（格式见 CATALOG）；函数连同完整定义（属性与函数体，
 * PostgreSQL 反解析出的原样文本），函数体改成空操作、改成 SECURITY DEFINER 都会与这里对不上：
 * - 审计事件只追加（0001，P2 设计 §3.8）：UPDATE、DELETE 与 TRUNCATE 由触发器拒绝；
 * - 文档的写入代次只增不减（0019，M2-P6 复核 B 的 G5）。
 * 新加手写的对象时在这里登记，并在迁移的注释里写明它为什么只能手写
 */
const HAND_WRITTEN = [
  `FUNCTION CREATE OR REPLACE FUNCTION public.audit_events_reject_change()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  RAISE EXCEPTION 'audit_events 只追加，不允许 %', TG_OP;
END;
$function$`,
  'TRIGGER CREATE TRIGGER audit_events_append_only BEFORE DELETE OR UPDATE ON public.audit_events FOR EACH ROW EXECUTE FUNCTION audit_events_reject_change() ENABLED O',
  'TRIGGER CREATE TRIGGER audit_events_no_truncate BEFORE TRUNCATE ON public.audit_events FOR EACH STATEMENT EXECUTE FUNCTION audit_events_reject_change() ENABLED O',
  `FUNCTION CREATE OR REPLACE FUNCTION public.documents_reject_write_epoch_decrease()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  RAISE EXCEPTION '文档的写入代次只增不减：% 不能从 % 改成 %', OLD.id, OLD.write_epoch, NEW.write_epoch
    USING ERRCODE = 'check_violation', CONSTRAINT = 'documents_write_epoch_monotonic', TABLE = 'documents', COLUMN = 'write_epoch';
END;
$function$`,
  'TRIGGER CREATE TRIGGER documents_write_epoch_monotonic BEFORE UPDATE ON public.documents FOR EACH ROW WHEN ((new.write_epoch < old.write_epoch)) EXECUTE FUNCTION documents_reject_write_epoch_decrease() ENABLED O',
]

/**
 * 目录的每一类对象一条查询，每个对象一行文本（类别打头）。只看 public 模式：迁移器的记录表在 drizzle 模式里，不属于表定义。
 * - 列不比较顺序：后加的列排在表的最后，与表定义里的位置不同不算不一致；
 * - 约束不含 PostgreSQL 18 起登记在 pg_constraint 里的 NOT NULL（contype n）：可空已经在列里比较，它们的名字随建法不同；
 * - 函数不含扩展带来的（扩展另成一行），比较完整定义（pg_get_functiondef；聚合函数没有这样的定义，只比较签名）；
 * - 规则不含视图自带的那一条（_RETURN，视图的定义已在"表"一项里比较）
 */
const CATALOG = `
SELECT format('TABLE %s kind=%s persistence=%s rls=%s/%s options=%s%s', c.relname, c.relkind, c.relpersistence, c.relrowsecurity, c.relforcerowsecurity,
              coalesce(array_to_string(c.reloptions, ','), ''), CASE WHEN c.relkind IN ('v', 'm') THEN ' AS ' || pg_get_viewdef(c.oid) ELSE '' END) AS line
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
UNION ALL
SELECT format('COLUMN %s.%s %s%s%s%s%s', c.relname, a.attname, format_type(a.atttypid, a.atttypmod),
              CASE WHEN a.attnotnull THEN ' NOT NULL' ELSE '' END,
              CASE WHEN a.attgenerated <> '' THEN format(' GENERATED ALWAYS AS (%s) %s', pg_get_expr(d.adbin, d.adrelid), CASE a.attgenerated WHEN 's' THEN 'STORED' ELSE 'VIRTUAL' END)
                   WHEN d.adbin IS NOT NULL THEN ' DEFAULT ' || pg_get_expr(d.adbin, d.adrelid)
                   ELSE '' END,
              CASE WHEN a.attidentity <> '' THEN ' IDENTITY ' || a.attidentity::text ELSE '' END,
              CASE WHEN a.attcollation <> 0 AND a.attcollation <> t.typcollation THEN ' COLLATE ' || co.collname ELSE '' END)
  FROM pg_attribute a
  JOIN pg_class c ON c.oid = a.attrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_type t ON t.oid = a.atttypid
  LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
  LEFT JOIN pg_collation co ON co.oid = a.attcollation
 WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'f') AND a.attnum > 0 AND NOT a.attisdropped
UNION ALL
SELECT format('CONSTRAINT %s %s %s', c.relname, con.conname, pg_get_constraintdef(con.oid))
  FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND con.contype <> 'n'
UNION ALL
SELECT 'INDEX ' || indexdef FROM pg_indexes WHERE schemaname = 'public'
UNION ALL
SELECT format('TRIGGER %s ENABLED %s', pg_get_triggerdef(tg.oid), tg.tgenabled)
  FROM pg_trigger tg JOIN pg_class c ON c.oid = tg.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND NOT tg.tgisinternal
UNION ALL
SELECT 'FUNCTION ' || CASE WHEN p.prokind = 'a' THEN format('AGGREGATE %s(%s)', p.proname, pg_get_function_identity_arguments(p.oid))
                            ELSE rtrim(pg_get_functiondef(p.oid), E'\\n') END
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND NOT EXISTS (SELECT 1 FROM pg_depend dep WHERE dep.classid = 'pg_proc'::regclass AND dep.objid = p.oid AND dep.deptype = 'e')
UNION ALL
SELECT format('RULE %s ENABLED %s', pg_get_ruledef(r.oid), r.ev_enabled)
  FROM pg_rewrite r JOIN pg_class c ON c.oid = r.ev_class JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND r.rulename <> '_RETURN'
UNION ALL
SELECT format('POLICY %s %s %s %s %s %s %s', tablename, policyname, permissive, roles, cmd, qual, with_check) FROM pg_policies WHERE schemaname = 'public'
UNION ALL
SELECT format('TYPE %s %s %s %s', ty.typname, ty.typtype,
              (SELECT string_agg(e.enumlabel, ',' ORDER BY e.enumsortorder) FROM pg_enum e WHERE e.enumtypid = ty.oid),
              (SELECT string_agg(pg_get_constraintdef(dc.oid), ' ' ORDER BY dc.conname) FROM pg_constraint dc WHERE dc.contypid = ty.oid))
  FROM pg_type ty JOIN pg_namespace n ON n.oid = ty.typnamespace
 WHERE n.nspname = 'public'
   AND (ty.typtype IN ('e', 'd', 'r', 'm') OR (ty.typtype = 'c' AND EXISTS (SELECT 1 FROM pg_class c WHERE c.oid = ty.typrelid AND c.relkind = 'c')))
UNION ALL
SELECT 'EXTENSION ' || extname FROM pg_extension
UNION ALL
SELECT 'SCHEMA ' || nspname FROM pg_namespace WHERE nspname NOT LIKE 'pg\\_%' AND nspname NOT IN ('information_schema', 'drizzle')
`

async function catalogOf(database: TestDatabase): Promise<string[]> {
  return database.query(async client => (await client.query<{ line: string }>(CATALOG)).rows.map(row => row.line).sort())
}

/** drizzle-kit 按表定义从空库生成的建库语句：与 pnpm db:generate 生成第一个迁移时同一条路径 */
async function statementsFromTableDefinitions(): Promise<string[]> {
  return generateMigration(generateDrizzleJson({}), generateDrizzleJson({ ...TABLE_DEFINITIONS }))
}

async function execute(client: pg.Client, statements: readonly string[]): Promise<void> {
  await client.query('BEGIN')
  try {
    for (const statement of statements)
      await client.query(statement)
    await client.query('COMMIT')
  }
  catch (error) {
    await client.query('ROLLBACK')
    throw error
  }
}

const databases: TestDatabase[] = []

afterAll(async () => {
  for (const database of databases.splice(0))
    await database.drop()
})

describe('迁移建出的库与按表定义建出的库逐项一致（M2-P6 复核 B 的 B4）', () => {
  it('列、约束、索引、触发器、函数等逐项相同；只在迁移里手写的对象恰好是登记的那几个', async () => {
    const migrated = await createTestDatabase()
    const fromTables = await createTestDatabase({ migrated: false })
    databases.push(migrated, fromTables)
    await fromTables.query(async client => execute(client, await statementsFromTableDefinitions()))

    const [migratedCatalog, tablesCatalog] = await Promise.all([catalogOf(migrated), catalogOf(fromTables)])
    // 目录确实读到了东西（不是两边都空才相等）：P4 的层数与"回收站 ⇔ 有删除单元"的 CHECK、父文件夹与删除单元的外键都在里面
    for (const anchor of [
      /^CONSTRAINT folders folders_depth_check CHECK /,
      /^CONSTRAINT folders folders_trash_entry_check CHECK /,
      /^CONSTRAINT documents documents_trash_entry_check CHECK /,
      /^CONSTRAINT folders folders_parent_id_folders_id_fk FOREIGN KEY \(parent_id\) REFERENCES folders\(id\) ON DELETE RESTRICT$/,
      /^CONSTRAINT documents documents_trash_entry_id_trash_entries_id_fk FOREIGN KEY \(trash_entry_id\) REFERENCES trash_entries\(id\) ON DELETE RESTRICT$/,
      /^COLUMN spaces\.name_key text NOT NULL GENERATED ALWAYS AS \(NORMALIZE\(casefold\(lower\(btrim\(/,
      /^INDEX CREATE INDEX folders_trash_entry_idx ON public\.folders USING btree \(trash_entry_id\) WHERE \(trash_entry_id IS NOT NULL\)$/,
    ])
      expect(migratedCatalog.some(line => anchor.test(line)), String(anchor)).toBe(true)

    const inTables = new Set(tablesCatalog)
    const inMigrated = new Set(migratedCatalog)
    expect({
      onlyInMigrations: migratedCatalog.filter(line => !inTables.has(line)),
      onlyInTableDefinitions: tablesCatalog.filter(line => !inMigrated.has(line)),
    }).toEqual({ onlyInMigrations: [...HAND_WRITTEN].sort(), onlyInTableDefinitions: [] })
  })
})

-- 团队空间名称的判重键把显示成空白的非格式字符也当空白（M2-P6 复验 R-M1）：盲文空白 U+2800、契丹小字填充符 U+16FE4、
-- 乐谱的空符头 U+1D159。名称的入口从这一版起拒绝它们，但之前写进去的名称里可能有，看起来与不带它们的名称一样
-- （例如末尾多一个盲文空白的"财务部"）。判重键是生成列（表定义里的 nameKeyOf）：改它的表达式时整张表按新的表达式重算
-- （PostgreSQL 17 起的 SET EXPRESSION）。先删唯一索引、按新的键检查已有的重名、再建回来，有重名时中止并列出冲突的空间
-- （与 0016 的做法相同），而不是只报出唯一索引建不起来的第一组。
-- 边界（M2-P6 复验第二轮 S2）：对入口收紧之前写进去的名称，判重键只照顾上面这三个字符。名称的入口在 M2-P6 第 1 片的修复之前
-- 还放行、之后拒绝的看不见的字符——零宽空格 U+200B、词连接符 U+2060、BOM U+FEFF、软连字符 U+00AD、韩文填充符 U+3164
-- （以及 U+115F、U+1160、U+FFA0）、双向控制字符等——判重键里既不去掉、也不当空白：名称里夹着它们时，与不带它们的名称
-- 看起来一样、判重键不同。只有跑过第 1 片之前的 M2 构建、并且那时写进过这样的名称的库才会有；M2 还没有部署，只有开发库可能遇到，
-- 在管理界面改名即可。判重的算法不为它们改：它们在入口一律拒绝，新的名称里不会再有。
DROP INDEX "spaces_team_name_key";--> statement-breakpoint
ALTER TABLE "spaces" ALTER COLUMN "name_key" SET EXPRESSION AS (normalize(casefold(lower(btrim(regexp_replace(regexp_replace(normalize("spaces"."name", NFKC), '[\u200C-\u200D\u034F\u180B-\u180D\u180F\uFE00-\uFE0F\U000E0020-\U000E007F\U000E0100-\U000E01EF\u180E]', '', 'g'), '[\u0009-\u000D\u0020\u0085\u00A0\u1680\u2000-\u200A\u2028-\u2029\u202F\u205F\u3000\u2800\U00016FE4\U0001D159]+', ' ', 'g'), ' '))), NFKC));--> statement-breakpoint
-- 已有的团队空间按新的判重键有重名时，建唯一索引之前中止，列出每一组冲突的空间（id 与名称），整个迁移回滚，库还是 0016 的样子。
-- 先在管理界面把其中一个改名再执行迁移
DO $$
DECLARE
  conflicts text;
BEGIN
  SELECT string_agg(duplicated.spaces, '；' ORDER BY duplicated.spaces)
    INTO conflicts
    FROM (
      SELECT string_agg(format('%s %L', id, name), '、' ORDER BY id) AS spaces
        FROM "spaces"
       WHERE type = 'team'
       GROUP BY name_key
      HAVING count(*) > 1
    ) AS duplicated;
  IF conflicts IS NOT NULL THEN
    RAISE EXCEPTION '团队空间的名称按新的判重规则有重名（看起来一样的名称算同一个名字），先改名再执行迁移：%', conflicts;
  END IF;
END
$$;
--> statement-breakpoint
CREATE UNIQUE INDEX "spaces_team_name_key" ON "spaces" USING btree ("name_key") WHERE "spaces"."type" = 'team';
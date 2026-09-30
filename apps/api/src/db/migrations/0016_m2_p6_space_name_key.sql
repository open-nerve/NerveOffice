-- 团队空间名称的判重改按判重键（M2-P6 复核 B 的 M-1）：看起来一样的名称（夹着放行的格式字符、全角与半角、连续空格、
-- 希腊字母词尾的 σ 与 ς 等）算同一个名字。判重键是数据库算的生成列（表定义里的 nameKeyOf），已有的行在加列时一起算好。
DROP INDEX "spaces_team_name_key";--> statement-breakpoint
ALTER TABLE "spaces" ADD COLUMN "name_key" text GENERATED ALWAYS AS (normalize(casefold(lower(btrim(regexp_replace(regexp_replace(normalize("spaces"."name", NFKC), '[\u200C-\u200D\u034F\u180B-\u180D\u180F\uFE00-\uFE0F\U000E0020-\U000E007F\U000E0100-\U000E01EF\u180E]', '', 'g'), '[\u0009-\u000D\u0020\u0085\u00A0\u1680\u2000-\u200A\u2028-\u2029\u202F\u205F\u3000]+', ' ', 'g'), ' '))), NFKC)) STORED NOT NULL;--> statement-breakpoint
-- 已有的团队空间按新的判重键有重名时，建唯一索引之前中止，列出每一组冲突的空间（id 与名称），整个迁移回滚。
-- M2 还没有部署，只有开发库可能遇到：先在管理界面把其中一个改名再执行迁移，或者重建开发库（pnpm db:down 之后删掉数据卷）
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
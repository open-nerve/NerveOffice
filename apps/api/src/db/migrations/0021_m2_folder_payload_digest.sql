-- 新建文件夹的幂等按不可变的请求摘要判断（M2 Codex 评审 CX6）：原来同一个 requestId 的重试拿请求与文件夹现在的名称、位置比较，
-- 建好之后改名或移动过，原样的重试被判成冲突；载荷不同、却碰巧与现状相同的请求反而被当成重放。现在新建时存下请求的摘要
-- （与修订记录的 payload_digest 同一个做法），之后不改。
-- 已有的行按现在的空间、父文件夹与名称回填，写法与 documents 模块的 folderCreatedPayloadDigest 逐字相同：
-- sha256(UTF-8 编码的 'folder-created' \n 空间 \n 父文件夹（没有时为空）\n 名称)，uuid::text 是小写带连字符的写法，与契约统一之后的 id 相同。
-- 建好之后改过名或移动过的旧行，回填的是现在的样子，不是当初的请求（当初的请求没有存下来）：对它们原样重发当初的请求仍是冲突，
-- 与迁移之前的行为相同；M2 没有部署，只有开发库有这样的行。集成测试（database/migrations-with-data）经接口原样重发迁移之前建的
-- 文件夹的新建请求，核对这里回填的与服务算的一致。
-- 先加可空的列、回填，再设 NOT NULL 与 CHECK：drizzle-kit 生成的"ADD COLUMN … NOT NULL"在已有行的表上执行不了
ALTER TABLE "folders" ADD COLUMN "payload_digest" bytea;--> statement-breakpoint
UPDATE "folders" SET "payload_digest" = sha256(convert_to('folder-created' || E'\n' || "space_id"::text || E'\n' || coalesce("parent_id"::text, '') || E'\n' || "name", 'UTF8'));--> statement-breakpoint
ALTER TABLE "folders" ALTER COLUMN "payload_digest" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "folders" ADD CONSTRAINT "folders_payload_digest_check" CHECK (octet_length("folders"."payload_digest") = 32);

-- 保存协议加固（M3-P3 设计 §3.4，只做加法）：
-- - document_contents：规范化的内容哈希（32 字节）与这一版非空的资源名，两列同时写（同时为空或同时有值）。存量为空，第一次写入时补上
--   （"内容相同不递增"把空的哈希当作不同；"不缩水"在资源名为空时解析上一版）；
-- - documents：最后一次写入的客户端构建（1–64 个字符，可空：新建与存量没有）、"公式待更新"（not null default false：PostgreSQL 11 起只改目录，
--   不重写表；存量一律没有标记）；sdk_version 不改结构，P3 起记客户端上报、服务端核对过的值；
-- - document_revisions：每次写入的内容哈希与客户端构建（都可空：存量、新建与复制没有构建），created_at 的索引给保留期的清理（§3.9）；
-- - document_save_receipts（新）：内容相同、修订号没变的那次保存的确认（§3.7），requestId 主键，结果（修订号与它的时间）原样留着给重放；
--   随文档级联删除，保存的人 restrict；created_at 与 document_id 的索引。
-- 新的 CHECK 加在已有的表上时照样验证存量：存量的新列都是空的（或默认的 false），都通过。建索引期间挡住这张表的写入（v0.1 的表很小）
CREATE TABLE "document_save_receipts" (
	"request_id" uuid PRIMARY KEY NOT NULL,
	"document_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"payload_digest" "bytea" NOT NULL,
	"saved_by" uuid NOT NULL,
	"saved_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_save_receipts_revision_check" CHECK ("document_save_receipts"."revision" >= 1),
	CONSTRAINT "document_save_receipts_payload_digest_check" CHECK (octet_length("document_save_receipts"."payload_digest") = 32)
);
--> statement-breakpoint
ALTER TABLE "document_contents" ADD COLUMN "content_hash" "bytea";--> statement-breakpoint
ALTER TABLE "document_contents" ADD COLUMN "resource_names" text[];--> statement-breakpoint
ALTER TABLE "document_revisions" ADD COLUMN "content_hash" "bytea";--> statement-breakpoint
ALTER TABLE "document_revisions" ADD COLUMN "client_build" text;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "client_build" text;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "formulas_pending" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "document_save_receipts" ADD CONSTRAINT "document_save_receipts_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_save_receipts" ADD CONSTRAINT "document_save_receipts_saved_by_users_id_fk" FOREIGN KEY ("saved_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "document_save_receipts_created_idx" ON "document_save_receipts" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "document_save_receipts_document_idx" ON "document_save_receipts" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "document_revisions_created_idx" ON "document_revisions" USING btree ("created_at");--> statement-breakpoint
ALTER TABLE "document_contents" ADD CONSTRAINT "document_contents_content_hash_check" CHECK (octet_length("document_contents"."content_hash") = 32);--> statement-breakpoint
ALTER TABLE "document_contents" ADD CONSTRAINT "document_contents_envelope_check" CHECK (("document_contents"."content_hash" IS NULL) = ("document_contents"."resource_names" IS NULL));--> statement-breakpoint
ALTER TABLE "document_revisions" ADD CONSTRAINT "document_revisions_content_hash_check" CHECK (octet_length("document_revisions"."content_hash") = 32);--> statement-breakpoint
ALTER TABLE "document_revisions" ADD CONSTRAINT "document_revisions_client_build_check" CHECK (char_length("document_revisions"."client_build") BETWEEN 1 AND 64);--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_client_build_check" CHECK (char_length("documents"."client_build") BETWEEN 1 AND 64);
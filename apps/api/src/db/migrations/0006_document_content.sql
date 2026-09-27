-- M1-P4：文档的当前内容与修订记录，documents 补上修订号、unitId、插件档案、格式版本与 SDK 版本；审计动作加上 documents.content_saved（P4 设计 §3.2，只做加法）。
CREATE TABLE "document_contents" (
	"document_id" uuid PRIMARY KEY NOT NULL,
	"snapshot" "bytea" NOT NULL,
	"raw_bytes" integer NOT NULL,
	"stored_bytes" integer NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_contents_raw_bytes_check" CHECK ("document_contents"."raw_bytes" BETWEEN 1 AND 5242880),
	CONSTRAINT "document_contents_stored_bytes_check" CHECK ("document_contents"."stored_bytes" = octet_length("document_contents"."snapshot") AND "document_contents"."stored_bytes" BETWEEN 1 AND 5242880)
);
--> statement-breakpoint
CREATE TABLE "document_revisions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"document_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"kind" text NOT NULL,
	"request_id" uuid NOT NULL,
	"payload_digest" "bytea" NOT NULL,
	"client_instance_id" uuid,
	"local_seq" integer,
	"saved_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_revisions_document_revision_key" UNIQUE("document_id","revision"),
	CONSTRAINT "document_revisions_request_id_key" UNIQUE("request_id"),
	CONSTRAINT "document_revisions_revision_check" CHECK ("document_revisions"."revision" >= 1),
	CONSTRAINT "document_revisions_kind_check" CHECK ("document_revisions"."kind" IN ('created', 'saved')),
	CONSTRAINT "document_revisions_created_check" CHECK (("document_revisions"."kind" = 'created') = ("document_revisions"."revision" = 1)),
	CONSTRAINT "document_revisions_payload_digest_check" CHECK (octet_length("document_revisions"."payload_digest") = 32),
	CONSTRAINT "document_revisions_local_seq_check" CHECK ("document_revisions"."local_seq" >= 0),
	CONSTRAINT "document_revisions_source_check" CHECK (("document_revisions"."client_instance_id" IS NULL) = ("document_revisions"."kind" = 'created') AND ("document_revisions"."client_instance_id" IS NULL) = ("document_revisions"."local_seq" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "audit_events" DROP CONSTRAINT "audit_events_action_check";--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "revision" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
-- 已有的行（只在开发与测试库里，P3 之后还没有部署）先按默认值补齐，再去掉默认值：新建的文档必须写明这几列。
-- 这些行没有内容，打开时按数据不一致处理（P4 设计 §3.2、§3.5.4）
ALTER TABLE "documents" ADD COLUMN "unit_id" text DEFAULT gen_random_uuid()::text NOT NULL;--> statement-breakpoint
ALTER TABLE "documents" ALTER COLUMN "unit_id" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "profile" text DEFAULT 'sheet@1' NOT NULL;--> statement-breakpoint
ALTER TABLE "documents" ALTER COLUMN "profile" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "format_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "documents" ALTER COLUMN "format_version" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "sdk_version" text DEFAULT '1.0.1' NOT NULL;--> statement-breakpoint
ALTER TABLE "documents" ALTER COLUMN "sdk_version" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "document_contents" ADD CONSTRAINT "document_contents_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_revisions" ADD CONSTRAINT "document_revisions_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_revisions" ADD CONSTRAINT "document_revisions_saved_by_users_id_fk" FOREIGN KEY ("saved_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_unit_id_key" UNIQUE("unit_id");--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_action_check" CHECK ("audit_events"."action" IN ('auth.login_succeeded', 'auth.login_failed', 'auth.logout', 'users.admin_initialized', 'documents.created', 'documents.content_saved'));--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_revision_check" CHECK ("documents"."revision" >= 1);--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_profile_check" CHECK ("documents"."profile" IN ('sheet@1'));--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_format_version_check" CHECK ("documents"."format_version" IN (1));--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_sdk_version_check" CHECK (char_length("documents"."sdk_version") BETWEEN 1 AND 64);
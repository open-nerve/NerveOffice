CREATE TABLE "document_checkpoint_assets" (
	"checkpoint_id" uuid NOT NULL,
	"asset_id" uuid NOT NULL,
	CONSTRAINT "document_checkpoint_assets_pkey" PRIMARY KEY("checkpoint_id","asset_id")
);
--> statement-breakpoint
CREATE TABLE "document_checkpoints" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"source_document_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"hour_bucket" timestamp with time zone,
	"event_id" uuid,
	"title" text NOT NULL,
	"document_type" text NOT NULL,
	"unit_id" text NOT NULL,
	"profile" text NOT NULL,
	"format_version" integer NOT NULL,
	"sdk_version" text NOT NULL,
	"client_build" text,
	"revision" integer NOT NULL,
	"formulas_pending" boolean NOT NULL,
	"snapshot" "bytea" NOT NULL,
	"raw_bytes" integer NOT NULL,
	"stored_bytes" integer NOT NULL,
	"content_hash" "bytea",
	"snapshot_hash" "bytea" NOT NULL,
	"resource_names" text[],
	"saved_by" uuid NOT NULL,
	"saved_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "document_checkpoints_kind_check" CHECK ("document_checkpoints"."kind" IN ('hourly', 'before_delete', 'before_upgrade')),
	CONSTRAINT "document_checkpoints_type_check" CHECK ("document_checkpoints"."document_type" IN ('sheet')),
	CONSTRAINT "document_checkpoints_title_check" CHECK (char_length("document_checkpoints"."title") BETWEEN 1 AND 200),
	CONSTRAINT "document_checkpoints_profile_check" CHECK (char_length("document_checkpoints"."profile") BETWEEN 1 AND 64),
	CONSTRAINT "document_checkpoints_format_check" CHECK ("document_checkpoints"."format_version" >= 1),
	CONSTRAINT "document_checkpoints_sdk_check" CHECK (char_length("document_checkpoints"."sdk_version") BETWEEN 1 AND 64),
	CONSTRAINT "document_checkpoints_client_check" CHECK (char_length("document_checkpoints"."client_build") BETWEEN 1 AND 64),
	CONSTRAINT "document_checkpoints_revision_check" CHECK ("document_checkpoints"."revision" >= 1),
	CONSTRAINT "document_checkpoints_raw_bytes_check" CHECK ("document_checkpoints"."raw_bytes" BETWEEN 1 AND 5242880),
	CONSTRAINT "document_checkpoints_stored_bytes_check" CHECK ("document_checkpoints"."stored_bytes" = octet_length("document_checkpoints"."snapshot") AND "document_checkpoints"."stored_bytes" BETWEEN 1 AND 5242880),
	CONSTRAINT "document_checkpoints_content_hash_check" CHECK (octet_length("document_checkpoints"."content_hash") = 32),
	CONSTRAINT "document_checkpoints_snapshot_hash_check" CHECK ("document_checkpoints"."snapshot_hash" = sha256("document_checkpoints"."snapshot")),
	CONSTRAINT "document_checkpoints_envelope_check" CHECK (("document_checkpoints"."content_hash" IS NULL) = ("document_checkpoints"."resource_names" IS NULL)),
	CONSTRAINT "document_checkpoints_clock_check" CHECK (isfinite("document_checkpoints"."created_at") AND isfinite("document_checkpoints"."expires_at") AND isfinite("document_checkpoints"."saved_at")),
	CONSTRAINT "document_checkpoints_kind_fields_check" CHECK (("document_checkpoints"."kind" = 'hourly') = ("document_checkpoints"."hour_bucket" IS NOT NULL) AND ("document_checkpoints"."kind" = 'hourly') = ("document_checkpoints"."event_id" IS NULL)),
	CONSTRAINT "document_checkpoints_hour_check" CHECK ("document_checkpoints"."hour_bucket" IS NULL OR "document_checkpoints"."hour_bucket" = date_trunc('hour', "document_checkpoints"."created_at" AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'),
	CONSTRAINT "document_checkpoints_expiry_check" CHECK ("document_checkpoints"."expires_at" = "document_checkpoints"."created_at" + CASE WHEN "document_checkpoints"."kind" = 'hourly' THEN interval '168 hours' ELSE interval '720 hours' END)
);
--> statement-breakpoint
CREATE TABLE "document_history_buckets" (
	"document_id" uuid NOT NULL,
	"hour_bucket" timestamp with time zone NOT NULL,
	CONSTRAINT "document_history_buckets_pkey" PRIMARY KEY("document_id","hour_bucket"),
	CONSTRAINT "document_history_buckets_hour_check" CHECK (isfinite("document_history_buckets"."hour_bucket") AND "document_history_buckets"."hour_bucket" = date_trunc('hour', "document_history_buckets"."hour_bucket" AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')
);
--> statement-breakpoint
ALTER TABLE "document_checkpoint_assets" ADD CONSTRAINT "document_checkpoint_assets_checkpoint_id_document_checkpoints_id_fk" FOREIGN KEY ("checkpoint_id") REFERENCES "public"."document_checkpoints"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_checkpoint_assets" ADD CONSTRAINT "document_checkpoint_assets_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_checkpoints" ADD CONSTRAINT "document_checkpoints_saved_by_users_id_fk" FOREIGN KEY ("saved_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_history_buckets" ADD CONSTRAINT "document_history_buckets_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "document_checkpoint_assets_asset_idx" ON "document_checkpoint_assets" USING btree ("asset_id");--> statement-breakpoint
CREATE UNIQUE INDEX "document_checkpoints_hour_key" ON "document_checkpoints" USING btree ("source_document_id","hour_bucket") WHERE "document_checkpoints"."kind" = 'hourly';--> statement-breakpoint
CREATE UNIQUE INDEX "document_checkpoints_event_key" ON "document_checkpoints" USING btree ("source_document_id","kind","event_id") WHERE "document_checkpoints"."kind" <> 'hourly';--> statement-breakpoint
CREATE INDEX "document_checkpoints_list_idx" ON "document_checkpoints" USING btree ("source_document_id","kind","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "document_checkpoints_expiry_idx" ON "document_checkpoints" USING btree ("expires_at","id");--> statement-breakpoint
CREATE INDEX "document_history_buckets_expiry_idx" ON "document_history_buckets" USING btree ("hour_bucket");
--> statement-breakpoint
-- Drizzle 表定义不能表达触发器；在 schema-parity 中登记完整定义。
-- 用户清除与过期允许 DELETE，但任何元数据或正文 UPDATE 都不能覆盖历史。
CREATE FUNCTION "document_checkpoints_reject_update"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '历史检查点不可覆盖：%', OLD.id
    USING ERRCODE = 'check_violation', CONSTRAINT = 'document_checkpoints_immutable', TABLE = 'document_checkpoints';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "document_checkpoints_immutable" BEFORE UPDATE ON "document_checkpoints"
  FOR EACH ROW EXECUTE FUNCTION "document_checkpoints_reject_update"();

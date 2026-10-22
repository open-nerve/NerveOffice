CREATE TABLE "document_upgrade_barrier" (
	"id" integer PRIMARY KEY NOT NULL,
	"active_batch_id" uuid,
	CONSTRAINT "document_upgrade_barrier_singleton_check" CHECK ("document_upgrade_barrier"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE "document_upgrade_batches" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"target_version" text NOT NULL,
	"status" text DEFAULT 'preparing' NOT NULL,
	"source_count" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"failure_code" text,
	CONSTRAINT "document_upgrade_batches_target_check" CHECK ("document_upgrade_batches"."target_version" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$'),
	CONSTRAINT "document_upgrade_batches_status_check" CHECK ("document_upgrade_batches"."status" IN ('preparing', 'failed', 'ready', 'released', 'aborted')),
	CONSTRAINT "document_upgrade_batches_count_check" CHECK ("document_upgrade_batches"."source_count" >= 0),
	CONSTRAINT "document_upgrade_batches_failure_check" CHECK ("document_upgrade_batches"."failure_code" IN ('source_changed', 'source_incomplete', 'checkpoint_incomplete', 'database_failure')),
	CONSTRAINT "document_upgrade_batches_failure_state_check" CHECK (("document_upgrade_batches"."status" = 'failed') = ("document_upgrade_batches"."failure_code" IS NOT NULL)),
	CONSTRAINT "document_upgrade_batches_completion_check" CHECK (("document_upgrade_batches"."status" NOT IN ('ready','released') OR "document_upgrade_batches"."completed_at" IS NOT NULL) AND ("document_upgrade_batches"."status" NOT IN ('preparing','failed') OR "document_upgrade_batches"."completed_at" IS NULL)),
	CONSTRAINT "document_upgrade_batches_clock_check" CHECK (isfinite("document_upgrade_batches"."created_at") AND isfinite("document_upgrade_batches"."updated_at") AND ("document_upgrade_batches"."completed_at" IS NULL OR isfinite("document_upgrade_batches"."completed_at")))
);
--> statement-breakpoint
CREATE TABLE "document_upgrade_sources" (
	"batch_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"checkpoint_id" uuid,
	CONSTRAINT "document_upgrade_sources_pkey" PRIMARY KEY("batch_id","document_id"),
	CONSTRAINT "document_upgrade_sources_revision_check" CHECK ("document_upgrade_sources"."revision" >= 1)
);
--> statement-breakpoint
ALTER TABLE "document_upgrade_barrier" ADD CONSTRAINT "document_upgrade_barrier_active_batch_id_document_upgrade_batches_id_fk" FOREIGN KEY ("active_batch_id") REFERENCES "public"."document_upgrade_batches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_upgrade_sources" ADD CONSTRAINT "document_upgrade_sources_batch_id_document_upgrade_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."document_upgrade_batches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_upgrade_sources" ADD CONSTRAINT "document_upgrade_sources_checkpoint_id_document_checkpoints_id_fk" FOREIGN KEY ("checkpoint_id") REFERENCES "public"."document_checkpoints"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "document_upgrade_sources_checkpoint_idx" ON "document_upgrade_sources" USING btree ("checkpoint_id");--> statement-breakpoint
INSERT INTO "document_upgrade_barrier" ("id") VALUES (1);--> statement-breakpoint
-- 源写先尝试共享锁；已有业务锁的事务不能反向等待升级的全局独占锁。
-- 行锁读取阻止旧 REPEATABLE READ 快照把已经冻结的屏障当作开放。
CREATE FUNCTION document_upgrade_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE active_batch uuid;
BEGIN
  IF NOT pg_try_advisory_xact_lock_shared(hashtextextended('nerve-office:document-upgrade-writes', 0)) THEN
    RAISE EXCEPTION 'document upgrade is preparing' USING ERRCODE = '55P03';
  END IF;
  SELECT active_batch_id INTO active_batch FROM document_upgrade_barrier WHERE id = 1 FOR SHARE;
  IF NOT FOUND OR active_batch IS NOT NULL THEN
    RAISE EXCEPTION 'document writes are frozen for upgrade' USING ERRCODE = '55P03';
  END IF;
  RETURN NULL;
EXCEPTION WHEN serialization_failure THEN
  RAISE EXCEPTION 'document upgrade barrier changed' USING ERRCODE = '55P03';
END $$;--> statement-breakpoint
CREATE TRIGGER document_upgrade_guard_membership BEFORE INSERT OR DELETE OR TRUNCATE ON documents
  FOR EACH STATEMENT EXECUTE FUNCTION document_upgrade_guard();--> statement-breakpoint
CREATE TRIGGER document_upgrade_guard_material BEFORE UPDATE OF id,title,type,unit_id,profile,format_version,sdk_version,client_build,revision,formulas_pending ON documents
  FOR EACH STATEMENT EXECUTE FUNCTION document_upgrade_guard();--> statement-breakpoint
CREATE TRIGGER document_upgrade_guard BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON document_contents
  FOR EACH STATEMENT EXECUTE FUNCTION document_upgrade_guard();--> statement-breakpoint
CREATE TRIGGER document_upgrade_guard BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON document_asset_links
  FOR EACH STATEMENT EXECUTE FUNCTION document_upgrade_guard();--> statement-breakpoint
CREATE TRIGGER document_upgrade_guard BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON document_revisions
  FOR EACH STATEMENT EXECUTE FUNCTION document_upgrade_guard();

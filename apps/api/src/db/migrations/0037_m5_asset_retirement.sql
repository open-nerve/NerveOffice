CREATE TABLE "asset_object_deletions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"sha256" text NOT NULL,
	"generation" uuid,
	"storage_key" text NOT NULL,
	"bytes" integer NOT NULL,
	"unreferenced_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "asset_object_deletions_key_key" UNIQUE("storage_key"),
	CONSTRAINT "asset_object_deletions_hash_check" CHECK ("asset_object_deletions"."sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "asset_object_deletions_key_check" CHECK ("asset_object_deletions"."storage_key" = 'objects/' || left("asset_object_deletions"."sha256", 2) || '/' || "asset_object_deletions"."sha256" || CASE WHEN "asset_object_deletions"."generation" IS NULL THEN '' ELSE '.' || "asset_object_deletions"."generation"::text END),
	CONSTRAINT "asset_object_deletions_bytes_check" CHECK ("asset_object_deletions"."bytes" BETWEEN 1 AND 5242880),
	CONSTRAINT "asset_object_deletions_time_check" CHECK (isfinite("asset_object_deletions"."unreferenced_at") AND isfinite("asset_object_deletions"."created_at") AND "asset_object_deletions"."unreferenced_at" <= "asset_object_deletions"."created_at" AND ("asset_object_deletions"."completed_at" IS NULL OR (isfinite("asset_object_deletions"."completed_at") AND "asset_object_deletions"."completed_at" >= "asset_object_deletions"."created_at")))
);
--> statement-breakpoint
ALTER TABLE "audit_events" DROP CONSTRAINT "audit_events_action_check";--> statement-breakpoint
ALTER TABLE "asset_object_claims" ADD COLUMN "unreferenced_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "asset_objects" ADD COLUMN "unreferenced_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "asset_object_deletions_pending_idx" ON "asset_object_deletions" USING btree ("id") WHERE "asset_object_deletions"."completed_at" IS NULL;--> statement-breakpoint
ALTER TABLE "asset_object_claims" ADD CONSTRAINT "asset_object_claims_candidate_time_check" CHECK ("asset_object_claims"."unreferenced_at" IS NULL OR isfinite("asset_object_claims"."unreferenced_at"));--> statement-breakpoint
ALTER TABLE "asset_objects" ADD CONSTRAINT "asset_objects_candidate_time_check" CHECK ("asset_objects"."unreferenced_at" IS NULL OR isfinite("asset_objects"."unreferenced_at"));--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_action_check" CHECK ("audit_events"."action" IN ('auth.login_succeeded', 'auth.login_failed', 'auth.logout', 'users.admin_initialized', 'documents.created', 'documents.content_saved', 'auth.link_rejected', 'users.invited', 'users.invitation_revoked', 'users.invitation_accepted', 'users.password_changed', 'users.password_change_failed', 'users.password_reset_issued', 'users.password_reset_completed', 'users.disabled', 'users.enabled', 'users.system_role_changed', 'spaces.created', 'spaces.renamed', 'spaces.visibility_changed', 'spaces.archived', 'spaces.restored', 'spaces.member_added', 'spaces.member_role_changed', 'spaces.member_removed', 'spaces.admin_joined', 'documents.transferred', 'folders.created', 'folders.renamed', 'folders.moved', 'documents.renamed', 'documents.moved', 'documents.copied', 'documents.history_restored', 'documents.history_cleared', 'documents.checkpoints_expired', 'assets.records_collected', 'assets.retirement_queued', 'assets.bytes_reclaimed', 'documents.upgrade_prepared', 'documents.upgrade_ready', 'documents.upgrade_failed', 'documents.upgrade_released', 'documents.upgrade_aborted', 'documents.deleted', 'documents.restored', 'documents.purged', 'folders.deleted', 'folders.restored', 'folders.purged', 'users.password_reset_revoked', 'users.login_unlocked', 'documents.shared', 'documents.share_changed', 'documents.share_revoked', 'documents.conflict_copied', 'documents.edit_taken_over', 'users.local_key_revoked'));
--> statement-breakpoint
-- 表定义不能表达身份和完成状态的单向更新；回执与永久文件标记一起保留。
CREATE FUNCTION public.asset_object_deletions_preserve_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.id, NEW.sha256, NEW.generation, NEW.storage_key, NEW.bytes, NEW.unreferenced_at, NEW.created_at)
      IS DISTINCT FROM ROW(OLD.id, OLD.sha256, OLD.generation, OLD.storage_key, OLD.bytes, OLD.unreferenced_at, OLD.created_at)
      OR (OLD.completed_at IS NOT NULL AND NEW.completed_at IS DISTINCT FROM OLD.completed_at) THEN
    RAISE EXCEPTION '资源退休回执不可改写：%', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'asset_object_deletions_identity', TABLE = 'asset_object_deletions';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER asset_object_deletions_identity BEFORE UPDATE ON public.asset_object_deletions
  FOR EACH ROW EXECUTE FUNCTION public.asset_object_deletions_preserve_identity();

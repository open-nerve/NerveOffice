CREATE TABLE "space_members" (
	"space_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "space_members_pkey" PRIMARY KEY("space_id","user_id"),
	CONSTRAINT "space_members_role_check" CHECK ("space_members"."role" IN ('viewer', 'editor', 'admin'))
);
--> statement-breakpoint
ALTER TABLE "audit_events" DROP CONSTRAINT "audit_events_action_check";--> statement-breakpoint
ALTER TABLE "spaces" DROP CONSTRAINT "spaces_type_check";--> statement-breakpoint
ALTER TABLE "spaces" DROP CONSTRAINT "spaces_status_check";--> statement-breakpoint
ALTER TABLE "spaces" DROP CONSTRAINT "spaces_personal_check";--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "write_epoch" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "spaces" ADD COLUMN "created_by" uuid;--> statement-breakpoint
ALTER TABLE "space_members" ADD CONSTRAINT "space_members_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "space_members" ADD CONSTRAINT "space_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "space_members_user_idx" ON "space_members" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "spaces" ADD CONSTRAINT "spaces_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "spaces_team_name_key" ON "spaces" USING btree (lower("name")) WHERE "spaces"."type" = 'team';--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_action_check" CHECK ("audit_events"."action" IN ('auth.login_succeeded', 'auth.login_failed', 'auth.logout', 'users.admin_initialized', 'documents.created', 'documents.content_saved', 'auth.link_rejected', 'users.invited', 'users.invitation_revoked', 'users.invitation_accepted', 'users.password_changed', 'users.password_change_failed', 'users.password_reset_issued', 'users.password_reset_completed', 'users.disabled', 'users.enabled', 'users.system_role_changed', 'spaces.created', 'spaces.renamed', 'spaces.visibility_changed', 'spaces.archived', 'spaces.restored', 'spaces.member_added', 'spaces.member_role_changed', 'spaces.member_removed', 'spaces.admin_joined', 'documents.transferred'));--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_write_epoch_check" CHECK ("documents"."write_epoch" >= 0);--> statement-breakpoint
ALTER TABLE "spaces" ADD CONSTRAINT "spaces_team_check" CHECK ("spaces"."type" <> 'team' OR ("spaces"."owner_user_id" IS NULL AND "spaces"."created_by" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "spaces" ADD CONSTRAINT "spaces_type_check" CHECK ("spaces"."type" IN ('personal', 'team'));--> statement-breakpoint
ALTER TABLE "spaces" ADD CONSTRAINT "spaces_status_check" CHECK ("spaces"."status" IN ('active', 'archived'));--> statement-breakpoint
ALTER TABLE "spaces" ADD CONSTRAINT "spaces_personal_check" CHECK ("spaces"."type" <> 'personal' OR ("spaces"."owner_user_id" IS NOT NULL AND "spaces"."created_by" IS NULL AND NOT "spaces"."visible_to_all" AND "spaces"."status" = 'active'));
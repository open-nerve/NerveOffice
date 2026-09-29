CREATE TABLE "folders" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"space_id" uuid NOT NULL,
	"parent_id" uuid,
	"name" text NOT NULL,
	"created_by" uuid NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"trash_entry_id" uuid,
	"depth" integer NOT NULL,
	"request_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "folders_request_id_key" UNIQUE("request_id"),
	CONSTRAINT "folders_name_check" CHECK (char_length("folders"."name") BETWEEN 1 AND 100),
	CONSTRAINT "folders_status_check" CHECK ("folders"."status" IN ('active', 'trashed')),
	CONSTRAINT "folders_depth_check" CHECK ("folders"."depth" BETWEEN 1 AND 10),
	CONSTRAINT "folders_root_depth_check" CHECK (("folders"."parent_id" IS NULL) = ("folders"."depth" = 1)),
	CONSTRAINT "folders_trash_entry_check" CHECK (("folders"."trash_entry_id" IS NULL) = ("folders"."status" = 'active'))
);
--> statement-breakpoint
CREATE TABLE "trash_entries" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"space_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"deleted_by" uuid NOT NULL,
	"deleted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"origin_space_id" uuid NOT NULL,
	"origin_parent_id" uuid,
	"title" text NOT NULL,
	CONSTRAINT "trash_entries_kind_check" CHECK ("trash_entries"."kind" IN ('document', 'folder')),
	CONSTRAINT "trash_entries_title_check" CHECK (char_length("trash_entries"."title") BETWEEN 1 AND 200),
	CONSTRAINT "trash_entries_expires_check" CHECK ("trash_entries"."expires_at" > "trash_entries"."deleted_at")
);
--> statement-breakpoint
ALTER TABLE "audit_events" DROP CONSTRAINT "audit_events_action_check";--> statement-breakpoint
ALTER TABLE "audit_events" DROP CONSTRAINT "audit_events_target_type_check";--> statement-breakpoint
ALTER TABLE "documents" DROP CONSTRAINT "documents_status_check";--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "folder_id" uuid;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "trash_entry_id" uuid;--> statement-breakpoint
ALTER TABLE "folders" ADD CONSTRAINT "folders_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "folders" ADD CONSTRAINT "folders_parent_id_folders_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."folders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "folders" ADD CONSTRAINT "folders_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "folders" ADD CONSTRAINT "folders_trash_entry_id_trash_entries_id_fk" FOREIGN KEY ("trash_entry_id") REFERENCES "public"."trash_entries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trash_entries" ADD CONSTRAINT "trash_entries_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trash_entries" ADD CONSTRAINT "trash_entries_deleted_by_users_id_fk" FOREIGN KEY ("deleted_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "folders_space_parent_name_idx" ON "folders" USING btree ("space_id","parent_id","name");--> statement-breakpoint
CREATE INDEX "folders_trash_entry_idx" ON "folders" USING btree ("trash_entry_id") WHERE "folders"."trash_entry_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "trash_entries_space_deleted_idx" ON "trash_entries" USING btree ("space_id","deleted_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "trash_entries_expires_idx" ON "trash_entries" USING btree ("expires_at");--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_folder_id_folders_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."folders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_trash_entry_id_trash_entries_id_fk" FOREIGN KEY ("trash_entry_id") REFERENCES "public"."trash_entries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "documents_space_folder_updated_idx" ON "documents" USING btree ("space_id","folder_id","updated_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "documents_trash_entry_idx" ON "documents" USING btree ("trash_entry_id") WHERE "documents"."trash_entry_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_action_check" CHECK ("audit_events"."action" IN ('auth.login_succeeded', 'auth.login_failed', 'auth.logout', 'users.admin_initialized', 'documents.created', 'documents.content_saved', 'auth.link_rejected', 'users.invited', 'users.invitation_revoked', 'users.invitation_accepted', 'users.password_changed', 'users.password_change_failed', 'users.password_reset_issued', 'users.password_reset_completed', 'users.disabled', 'users.enabled', 'users.system_role_changed', 'spaces.created', 'spaces.renamed', 'spaces.visibility_changed', 'spaces.archived', 'spaces.restored', 'spaces.member_added', 'spaces.member_role_changed', 'spaces.member_removed', 'spaces.admin_joined', 'documents.transferred', 'folders.created', 'folders.renamed', 'folders.moved'));--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_target_type_check" CHECK ("audit_events"."target_type" IN ('user', 'space', 'document', 'invitation', 'folder', 'trash_entry'));--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_trash_entry_check" CHECK (("documents"."trash_entry_id" IS NULL) = ("documents"."status" = 'active'));--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_status_check" CHECK ("documents"."status" IN ('active', 'trashed'));
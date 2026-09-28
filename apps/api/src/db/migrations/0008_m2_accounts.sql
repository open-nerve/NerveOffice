CREATE TABLE "auth_invitations" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"username" text NOT NULL,
	"display_name" text NOT NULL,
	"token_hash" "bytea" NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"accepted_user_id" uuid,
	"revoked_at" timestamp with time zone,
	"revoked_by" uuid,
	CONSTRAINT "auth_invitations_token_hash_check" CHECK (octet_length("auth_invitations"."token_hash") = 32),
	CONSTRAINT "auth_invitations_username_check" CHECK ("auth_invitations"."username" ~ '^[a-z0-9][a-z0-9._-]{2,31}$'),
	CONSTRAINT "auth_invitations_display_name_check" CHECK (char_length("auth_invitations"."display_name") BETWEEN 1 AND 64),
	CONSTRAINT "auth_invitations_expiry_check" CHECK ("auth_invitations"."expires_at" > "auth_invitations"."created_at"),
	CONSTRAINT "auth_invitations_accepted_check" CHECK (("auth_invitations"."accepted_at" IS NULL) = ("auth_invitations"."accepted_user_id" IS NULL)),
	CONSTRAINT "auth_invitations_revoked_check" CHECK (("auth_invitations"."revoked_at" IS NULL) = ("auth_invitations"."revoked_by" IS NULL)),
	CONSTRAINT "auth_invitations_outcome_check" CHECK ("auth_invitations"."accepted_at" IS NULL OR "auth_invitations"."revoked_at" IS NULL)
);
--> statement-breakpoint
CREATE TABLE "auth_password_resets" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" "bytea" NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "auth_password_resets_token_hash_check" CHECK (octet_length("auth_password_resets"."token_hash") = 32),
	CONSTRAINT "auth_password_resets_expiry_check" CHECK ("auth_password_resets"."expires_at" > "auth_password_resets"."created_at"),
	CONSTRAINT "auth_password_resets_outcome_check" CHECK ("auth_password_resets"."used_at" IS NULL OR "auth_password_resets"."revoked_at" IS NULL)
);
--> statement-breakpoint
ALTER TABLE "audit_events" DROP CONSTRAINT "audit_events_action_check";--> statement-breakpoint
ALTER TABLE "audit_events" DROP CONSTRAINT "audit_events_target_type_check";--> statement-breakpoint
ALTER TABLE "auth_sessions" DROP CONSTRAINT "auth_sessions_revoked_reason_check";--> statement-breakpoint
ALTER TABLE "users" DROP CONSTRAINT "users_status_check";--> statement-breakpoint
ALTER TABLE "auth_invitations" ADD CONSTRAINT "auth_invitations_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_invitations" ADD CONSTRAINT "auth_invitations_accepted_user_id_users_id_fk" FOREIGN KEY ("accepted_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_invitations" ADD CONSTRAINT "auth_invitations_revoked_by_users_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_password_resets" ADD CONSTRAINT "auth_password_resets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_password_resets" ADD CONSTRAINT "auth_password_resets_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "auth_invitations_token_hash_key" ON "auth_invitations" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "auth_invitations_open_username_key" ON "auth_invitations" USING btree ("username") WHERE "auth_invitations"."accepted_at" IS NULL AND "auth_invitations"."revoked_at" IS NULL;--> statement-breakpoint
CREATE INDEX "auth_invitations_created_at_idx" ON "auth_invitations" USING btree ("created_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "auth_password_resets_token_hash_key" ON "auth_password_resets" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "auth_password_resets_open_user_key" ON "auth_password_resets" USING btree ("user_id") WHERE "auth_password_resets"."used_at" IS NULL AND "auth_password_resets"."revoked_at" IS NULL;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_action_check" CHECK ("audit_events"."action" IN ('auth.login_succeeded', 'auth.login_failed', 'auth.logout', 'users.admin_initialized', 'documents.created', 'documents.content_saved', 'auth.link_rejected', 'users.invited', 'users.invitation_revoked', 'users.invitation_accepted', 'users.password_changed', 'users.password_reset_issued', 'users.password_reset_completed', 'users.disabled', 'users.enabled', 'users.system_role_changed'));--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_target_type_check" CHECK ("audit_events"."target_type" IN ('user', 'space', 'document', 'invitation'));--> statement-breakpoint
ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_revoked_reason_check" CHECK ("auth_sessions"."revoked_reason" IN ('logout', 'replaced', 'disabled', 'password_changed', 'password_reset'));--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_status_check" CHECK ("users"."status" IN ('active', 'disabled'));
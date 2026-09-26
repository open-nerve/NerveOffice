CREATE TABLE "auth_login_throttles" (
	"key_hash" "bytea" PRIMARY KEY NOT NULL,
	"failures" integer NOT NULL,
	"window_started_at" timestamp with time zone NOT NULL,
	"locked_until" timestamp with time zone,
	CONSTRAINT "auth_login_throttles_key_hash_check" CHECK (octet_length("auth_login_throttles"."key_hash") = 32),
	CONSTRAINT "auth_login_throttles_failures_check" CHECK ("auth_login_throttles"."failures" >= 1)
);
--> statement-breakpoint
CREATE TABLE "auth_sessions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"idle_expires_at" timestamp with time zone NOT NULL,
	"absolute_expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_reason" text,
	CONSTRAINT "auth_sessions_token_hash_check" CHECK (octet_length("auth_sessions"."token_hash") = 32),
	CONSTRAINT "auth_sessions_expiry_check" CHECK ("auth_sessions"."idle_expires_at" <= "auth_sessions"."absolute_expires_at"),
	CONSTRAINT "auth_sessions_revoked_reason_check" CHECK ("auth_sessions"."revoked_reason" IN ('logout', 'replaced')),
	CONSTRAINT "auth_sessions_revoked_check" CHECK (("auth_sessions"."revoked_at" IS NULL) = ("auth_sessions"."revoked_reason" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "auth_login_throttles_window_started_at_idx" ON "auth_login_throttles" USING btree ("window_started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "auth_sessions_token_hash_key" ON "auth_sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "auth_sessions_user_idx" ON "auth_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "auth_sessions_idle_expires_at_idx" ON "auth_sessions" USING btree ("idle_expires_at");
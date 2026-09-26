CREATE TABLE "spaces" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"type" text NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"owner_user_id" uuid,
	"visible_to_all" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "spaces_type_check" CHECK ("spaces"."type" IN ('personal')),
	CONSTRAINT "spaces_status_check" CHECK ("spaces"."status" IN ('active')),
	CONSTRAINT "spaces_name_check" CHECK (char_length("spaces"."name") BETWEEN 1 AND 100),
	CONSTRAINT "spaces_personal_check" CHECK ("spaces"."type" <> 'personal' OR ("spaces"."owner_user_id" IS NOT NULL AND NOT "spaces"."visible_to_all"))
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"username" text NOT NULL,
	"display_name" text NOT NULL,
	"password_hash" text NOT NULL,
	"system_role" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_username_check" CHECK ("users"."username" ~ '^[a-z0-9][a-z0-9._-]{2,31}$'),
	CONSTRAINT "users_display_name_check" CHECK (char_length("users"."display_name") BETWEEN 1 AND 64),
	CONSTRAINT "users_password_hash_check" CHECK ("users"."password_hash" LIKE '$argon2id$%'),
	CONSTRAINT "users_system_role_check" CHECK ("users"."system_role" IN ('admin', 'member')),
	CONSTRAINT "users_status_check" CHECK ("users"."status" IN ('active'))
);
--> statement-breakpoint
ALTER TABLE "spaces" ADD CONSTRAINT "spaces_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "spaces_personal_owner_key" ON "spaces" USING btree ("owner_user_id") WHERE "spaces"."type" = 'personal';--> statement-breakpoint
CREATE UNIQUE INDEX "users_username_key" ON "users" USING btree ("username");
CREATE TABLE "documents" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"space_id" uuid NOT NULL,
	"type" text NOT NULL,
	"title" text NOT NULL,
	"created_by" uuid NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "documents_type_check" CHECK ("documents"."type" IN ('sheet')),
	CONSTRAINT "documents_status_check" CHECK ("documents"."status" IN ('active')),
	CONSTRAINT "documents_title_check" CHECK (char_length("documents"."title") BETWEEN 1 AND 200)
);
--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "documents_space_updated_idx" ON "documents" USING btree ("space_id","updated_at" DESC NULLS LAST,"id" DESC NULLS LAST);
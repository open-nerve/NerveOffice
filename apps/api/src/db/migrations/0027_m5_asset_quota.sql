CREATE TABLE "asset_object_claims" (
	"sha256" text PRIMARY KEY NOT NULL,
	"bytes" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "asset_object_claims_hash_check" CHECK ("asset_object_claims"."sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "asset_object_claims_bytes_check" CHECK ("asset_object_claims"."bytes" BETWEEN 1 AND 5242880)
);
--> statement-breakpoint
CREATE TABLE "asset_objects" (
	"sha256" text PRIMARY KEY NOT NULL,
	"storage_key" text NOT NULL,
	"mime_type" text NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"frames" integer NOT NULL,
	"bytes" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "asset_objects_hash_check" CHECK ("asset_objects"."sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "asset_objects_key_check" CHECK ("asset_objects"."storage_key" = 'objects/' || left("asset_objects"."sha256", 2) || '/' || "asset_objects"."sha256"),
	CONSTRAINT "asset_objects_mime_check" CHECK ("asset_objects"."mime_type" IN ('image/png', 'image/jpeg', 'image/webp', 'image/gif')),
	CONSTRAINT "asset_objects_bytes_check" CHECK ("asset_objects"."bytes" BETWEEN 1 AND 5242880),
	CONSTRAINT "asset_objects_dimensions_check" CHECK ("asset_objects"."width" BETWEEN 1 AND 8192 AND "asset_objects"."height" BETWEEN 1 AND 8192),
	CONSTRAINT "asset_objects_frames_check" CHECK ("asset_objects"."frames" BETWEEN 1 AND 100 AND ("asset_objects"."mime_type" IN ('image/gif', 'image/webp') OR "asset_objects"."frames" = 1)),
	CONSTRAINT "asset_objects_pixels_check" CHECK ("asset_objects"."width"::bigint * "asset_objects"."height" <= 16000000 AND "asset_objects"."width"::bigint * "asset_objects"."height" * "asset_objects"."frames" <= 32000000)
);
--> statement-breakpoint
CREATE TABLE "asset_quota" (
	"id" integer PRIMARY KEY NOT NULL,
	"used_bytes" bigint DEFAULT 0 NOT NULL,
	"used_assets" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "asset_quota_singleton_check" CHECK ("asset_quota"."id" = 1),
	CONSTRAINT "asset_quota_bytes_check" CHECK ("asset_quota"."used_bytes" BETWEEN 0 AND 1099511627776),
	CONSTRAINT "asset_quota_count_check" CHECK ("asset_quota"."used_assets" BETWEEN 0 AND 1000000)
);
--> statement-breakpoint
CREATE TABLE "assets" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"uploader_id" uuid NOT NULL,
	"object_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_uploader_id_users_id_fk" FOREIGN KEY ("uploader_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_object_hash_asset_objects_sha256_fk" FOREIGN KEY ("object_hash") REFERENCES "public"."asset_objects"("sha256") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "assets_uploader_created_idx" ON "assets" USING btree ("uploader_id","created_at");--> statement-breakpoint
CREATE INDEX "assets_object_idx" ON "assets" USING btree ("object_hash");
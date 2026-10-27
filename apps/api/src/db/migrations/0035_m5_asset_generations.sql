ALTER TABLE "asset_objects" DROP CONSTRAINT "asset_objects_key_check";--> statement-breakpoint
ALTER TABLE "asset_object_claims" ADD COLUMN "generation" uuid;--> statement-breakpoint
ALTER TABLE "asset_objects" ADD COLUMN "generation" uuid;--> statement-breakpoint
ALTER TABLE "asset_objects" ADD CONSTRAINT "asset_objects_key_check" CHECK ("asset_objects"."storage_key" = 'objects/' || left("asset_objects"."sha256", 2) || '/' || "asset_objects"."sha256" || CASE WHEN "asset_objects"."generation" IS NULL THEN '' ELSE '.' || "asset_objects"."generation"::text END);
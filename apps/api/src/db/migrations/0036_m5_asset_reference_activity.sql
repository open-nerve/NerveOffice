CREATE TABLE "asset_reference_activity" (
	"asset_id" uuid NOT NULL,
	"transaction_id" bigint NOT NULL,
	CONSTRAINT "asset_reference_activity_asset_id_transaction_id_pk" PRIMARY KEY("asset_id","transaction_id"),
	CONSTRAINT "asset_reference_activity_transaction_check" CHECK ("asset_reference_activity"."transaction_id" > 0)
);
--> statement-breakpoint
ALTER TABLE "assets" ADD COLUMN "unreferenced_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "asset_reference_activity" ADD CONSTRAINT "asset_reference_activity_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_candidate_time_check" CHECK ("assets"."unreferenced_at" IS NULL OR isfinite("assets"."unreferenced_at"));
--> statement-breakpoint
-- 表定义不能表达引用触发器。只追加本事务活动，不升级引用方已有的共享资源锁。
CREATE FUNCTION public.asset_reference_activity_note() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.asset_id = NEW.asset_id THEN
    RETURN NEW;
  END IF;
  INSERT INTO public.asset_reference_activity (asset_id, transaction_id)
    VALUES (NEW.asset_id, pg_current_xact_id()::text::bigint)
    ON CONFLICT DO NOTHING;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER document_assets_note_reference AFTER INSERT OR UPDATE OF asset_id ON public.document_asset_links
  FOR EACH ROW EXECUTE FUNCTION public.asset_reference_activity_note();
--> statement-breakpoint
CREATE TRIGGER checkpoint_assets_note_reference AFTER INSERT OR UPDATE OF asset_id ON public.document_checkpoint_assets
  FOR EACH ROW EXECUTE FUNCTION public.asset_reference_activity_note();

-- 表定义不能表达 transition table。批量 INSERT 只执行一次活动写入，避免逐关系调用 PL/pgSQL。
-- 只读取实际新增关系；活动仍以资源/本事务号去重，保留 FK、回滚和 GC 消费协议。
CREATE FUNCTION public.asset_reference_activity_note_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  reference_transaction_id bigint := pg_current_xact_id()::text::bigint;
BEGIN
  INSERT INTO public.asset_reference_activity (asset_id, transaction_id)
    SELECT asset_id, reference_transaction_id
    FROM (SELECT DISTINCT asset_id FROM inserted_asset_references) AS referenced
    ORDER BY asset_id
    ON CONFLICT DO NOTHING;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
DROP TRIGGER document_assets_note_reference ON public.document_asset_links;
--> statement-breakpoint
DROP TRIGGER checkpoint_assets_note_reference ON public.document_checkpoint_assets;
--> statement-breakpoint
CREATE TRIGGER document_assets_note_reference AFTER INSERT ON public.document_asset_links
  REFERENCING NEW TABLE AS inserted_asset_references
  FOR EACH STATEMENT EXECUTE FUNCTION public.asset_reference_activity_note_insert();
--> statement-breakpoint
CREATE TRIGGER checkpoint_assets_note_reference AFTER INSERT ON public.document_checkpoint_assets
  REFERENCING NEW TABLE AS inserted_asset_references
  FOR EACH STATEMENT EXECUTE FUNCTION public.asset_reference_activity_note_insert();
--> statement-breakpoint
-- UPDATE 仍使用 0036 的逐行新旧值判断；同值更新不制造活动，也不改变升级写入屏障。
CREATE TRIGGER document_assets_note_reference_update AFTER UPDATE OF asset_id ON public.document_asset_links
  FOR EACH ROW EXECUTE FUNCTION public.asset_reference_activity_note();
--> statement-breakpoint
CREATE TRIGGER checkpoint_assets_note_reference_update AFTER UPDATE OF asset_id ON public.document_checkpoint_assets
  FOR EACH ROW EXECUTE FUNCTION public.asset_reference_activity_note();

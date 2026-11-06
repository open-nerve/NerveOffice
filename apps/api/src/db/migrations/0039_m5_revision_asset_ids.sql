-- M5-P7（审查 M5R-I-02，需求方决定 D-01；S14 审查 B1/B3）：每一版修订记下正文里存在、却没有登记关系的图片标识，之后以这一版为基准的写入不升级它们，其余标识按原规则授权。
-- 已有的修订为空（未知），不回填：SQL 解不开 gzip 正文；保存在锁下按当前正文回退。空数组没有维度（array_ndims 为 NULL）。
ALTER TABLE "document_revisions" ADD COLUMN "unlinked_asset_ids" uuid[];--> statement-breakpoint
ALTER TABLE "document_revisions" ADD CONSTRAINT "document_revisions_unlinked_asset_ids_check" CHECK ("document_revisions"."unlinked_asset_ids" IS NULL OR array_ndims("document_revisions"."unlinked_asset_ids") IS NULL OR array_ndims("document_revisions"."unlinked_asset_ids") = 1);

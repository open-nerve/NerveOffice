-- M5-P7（审查 M5R-I-02，需求方决定 D-01）：每一版修订记下正文提取到的完整图片标识，下一次写入只为新出现的标识授权。
-- 已有的修订为空（未知），不回填：SQL 解不开 gzip 正文；保存在锁下按当前正文回退。空数组没有维度（array_ndims 为 NULL）。
ALTER TABLE "document_revisions" ADD COLUMN "asset_ids" uuid[];--> statement-breakpoint
ALTER TABLE "document_revisions" ADD CONSTRAINT "document_revisions_asset_ids_check" CHECK ("document_revisions"."asset_ids" IS NULL OR array_ndims("document_revisions"."asset_ids") IS NULL OR array_ndims("document_revisions"."asset_ids") = 1);

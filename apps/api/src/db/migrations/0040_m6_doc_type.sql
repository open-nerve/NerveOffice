-- 文档类型加上文字文档（M6 总设计 §6.1，M6-P1 设计 §3.3）：documents.type 与 document_checkpoints.document_type 加 'doc'，
-- documents.profile 加 'doc@1'。CHECK 按 DOCUMENT_TYPES、DOCUMENT_PROFILES 全量重列（与 0023 同一个写法）。
-- 只做加法：已有的行都是表格（sheet、sheet@1），重建约束时照样通过验证；表结构与数据不变。检查点表的 profile 是自由文本，不涉及。
ALTER TABLE "document_checkpoints" DROP CONSTRAINT "document_checkpoints_type_check";--> statement-breakpoint
ALTER TABLE "documents" DROP CONSTRAINT "documents_type_check";--> statement-breakpoint
ALTER TABLE "documents" DROP CONSTRAINT "documents_profile_check";--> statement-breakpoint
ALTER TABLE "document_checkpoints" ADD CONSTRAINT "document_checkpoints_type_check" CHECK ("document_checkpoints"."document_type" IN ('sheet', 'doc'));--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_type_check" CHECK ("documents"."type" IN ('sheet', 'doc'));--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_profile_check" CHECK ("documents"."profile" IN ('sheet@1', 'doc@1'));
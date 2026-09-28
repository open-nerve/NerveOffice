-- documents.unit_id 不再唯一（Codex 评审 CX5）：复制文档时快照原样复制，不改写 unitId，两份文档的 unitId 相同（00 号计划书 §8.3）。
ALTER TABLE "documents" DROP CONSTRAINT "documents_unit_id_key";
-- 本机密钥（M3-P6 设计 §3.2，只做加法）：
-- - 新表 user_local_keys（local-keys 模块）：主键 (user_id, version)，账户外键 restrict（账户只停用不删除）；版本从 1 起；
--   master_key_id（主密钥的标识，16 字节）与 wrapped_key（包装之后的密钥，60 字节：IV 12 ‖ 密文 32 ‖ 标签 16）同时为空或同时有值，
--   当前的（revoked_at 为空）有密钥材料、吊销的没有（吊销时擦成 NULL）；revoked_at 不早于 created_at；部分唯一索引保证每人至多一把当前的。
--   新表是空的：第一次取用时生成第 1 版，存量账户不用补发，迁移也不需要主密钥；
-- - 审计的动作加上吊销本机密钥（users.local_key_revoked：对象是账户，明细是被吊销的那一版）。CHECK 按 AUDIT_ACTIONS 全量重列
--   （与 0020、0023、0025 同一个写法），已有的审计行的动作都在新的列表里，重建约束时照样通过验证。重建约束期间挡住审计表的写入（v0.1 的表很小）
CREATE TABLE "user_local_keys" (
	"user_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"master_key_id" "bytea",
	"wrapped_key" "bytea",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "user_local_keys_pkey" PRIMARY KEY("user_id","version"),
	CONSTRAINT "user_local_keys_version_check" CHECK ("user_local_keys"."version" >= 1),
	CONSTRAINT "user_local_keys_master_key_id_check" CHECK (octet_length("user_local_keys"."master_key_id") = 16),
	CONSTRAINT "user_local_keys_wrapped_key_check" CHECK (octet_length("user_local_keys"."wrapped_key") = 60),
	CONSTRAINT "user_local_keys_material_check" CHECK (("user_local_keys"."wrapped_key" IS NULL) = ("user_local_keys"."master_key_id" IS NULL)),
	CONSTRAINT "user_local_keys_current_check" CHECK (("user_local_keys"."revoked_at" IS NULL) = ("user_local_keys"."wrapped_key" IS NOT NULL)),
	CONSTRAINT "user_local_keys_revoked_at_check" CHECK ("user_local_keys"."revoked_at" >= "user_local_keys"."created_at")
);
--> statement-breakpoint
ALTER TABLE "audit_events" DROP CONSTRAINT "audit_events_action_check";--> statement-breakpoint
ALTER TABLE "user_local_keys" ADD CONSTRAINT "user_local_keys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "user_local_keys_current_key" ON "user_local_keys" USING btree ("user_id") WHERE "user_local_keys"."revoked_at" IS NULL;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_action_check" CHECK ("audit_events"."action" IN ('auth.login_succeeded', 'auth.login_failed', 'auth.logout', 'users.admin_initialized', 'documents.created', 'documents.content_saved', 'auth.link_rejected', 'users.invited', 'users.invitation_revoked', 'users.invitation_accepted', 'users.password_changed', 'users.password_change_failed', 'users.password_reset_issued', 'users.password_reset_completed', 'users.disabled', 'users.enabled', 'users.system_role_changed', 'spaces.created', 'spaces.renamed', 'spaces.visibility_changed', 'spaces.archived', 'spaces.restored', 'spaces.member_added', 'spaces.member_role_changed', 'spaces.member_removed', 'spaces.admin_joined', 'documents.transferred', 'folders.created', 'folders.renamed', 'folders.moved', 'documents.renamed', 'documents.moved', 'documents.copied', 'documents.deleted', 'documents.restored', 'documents.purged', 'folders.deleted', 'folders.restored', 'folders.purged', 'users.password_reset_revoked', 'users.login_unlocked', 'documents.shared', 'documents.share_changed', 'documents.share_revoked', 'documents.conflict_copied', 'documents.edit_taken_over', 'users.local_key_revoked'));
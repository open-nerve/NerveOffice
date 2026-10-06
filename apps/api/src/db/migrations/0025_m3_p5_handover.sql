-- 交接规则（M3-P5 设计 §3.2，只做加法）：
-- - document_edit_leases 加三组列，都可空，存量都是空的（不带默认值的加列只改目录，不重写表）：
--   请求编辑（单槽）：request_id、requested_by（请求方，账户 restrict）、request_session_id（请求方的登录，同 session_id 不做外键）、
--   requested_at、request_expires_at（请求方每次续期往后推）五列同时为空或同时有值；request_declined_at（持有者选了"继续编辑"）
--   只在有请求时有值；到期晚于发出；请求方不是持有者。
--   交出之后的保留：reserved_for（账户 restrict）、reserved_until 两列同时为空或同时有值，只在明确结束的原因是 handed_over 时有
--   （没有明确结束时 end_reason 为空，用 IS NOT DISTINCT FROM 比较，空不算相等）。
--   接管标记：taken_over_token_digest（这一代接管的那一代的令牌摘要，32 字节）与 takeover（self、forced）两列同时为空或同时有值。
--   明确结束的原因加上 handed_over（交给了请求编辑的人）。这几组列都按主键找，不另建索引；
-- - 审计的动作加上强制接管（documents.edit_taken_over：对象是文档，明细是被接管的人）。CHECK 按 AUDIT_ACTIONS 全量重列
--   （与 0020、0023 同一个写法）。
-- 新的 CHECK 加在已有的表上时照样验证存量：存量的新列都是空的，已有的结束原因与审计动作都在新的列表里，都通过。
-- 重建约束期间挡住这两张表的写入（v0.1 的表很小）
ALTER TABLE "audit_events" DROP CONSTRAINT "audit_events_action_check";--> statement-breakpoint
ALTER TABLE "document_edit_leases" DROP CONSTRAINT "document_edit_leases_end_reason_check";--> statement-breakpoint
ALTER TABLE "document_edit_leases" ADD COLUMN "request_id" uuid;--> statement-breakpoint
ALTER TABLE "document_edit_leases" ADD COLUMN "requested_by" uuid;--> statement-breakpoint
ALTER TABLE "document_edit_leases" ADD COLUMN "request_session_id" uuid;--> statement-breakpoint
ALTER TABLE "document_edit_leases" ADD COLUMN "requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "document_edit_leases" ADD COLUMN "request_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "document_edit_leases" ADD COLUMN "request_declined_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "document_edit_leases" ADD COLUMN "reserved_for" uuid;--> statement-breakpoint
ALTER TABLE "document_edit_leases" ADD COLUMN "reserved_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "document_edit_leases" ADD COLUMN "taken_over_token_digest" "bytea";--> statement-breakpoint
ALTER TABLE "document_edit_leases" ADD COLUMN "takeover" text;--> statement-breakpoint
ALTER TABLE "document_edit_leases" ADD CONSTRAINT "document_edit_leases_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_edit_leases" ADD CONSTRAINT "document_edit_leases_reserved_for_users_id_fk" FOREIGN KEY ("reserved_for") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_action_check" CHECK ("audit_events"."action" IN ('auth.login_succeeded', 'auth.login_failed', 'auth.logout', 'users.admin_initialized', 'documents.created', 'documents.content_saved', 'auth.link_rejected', 'users.invited', 'users.invitation_revoked', 'users.invitation_accepted', 'users.password_changed', 'users.password_change_failed', 'users.password_reset_issued', 'users.password_reset_completed', 'users.disabled', 'users.enabled', 'users.system_role_changed', 'spaces.created', 'spaces.renamed', 'spaces.visibility_changed', 'spaces.archived', 'spaces.restored', 'spaces.member_added', 'spaces.member_role_changed', 'spaces.member_removed', 'spaces.admin_joined', 'documents.transferred', 'folders.created', 'folders.renamed', 'folders.moved', 'documents.renamed', 'documents.moved', 'documents.copied', 'documents.deleted', 'documents.restored', 'documents.purged', 'folders.deleted', 'folders.restored', 'folders.purged', 'users.password_reset_revoked', 'users.login_unlocked', 'documents.shared', 'documents.share_changed', 'documents.share_revoked', 'documents.conflict_copied', 'documents.edit_taken_over'));--> statement-breakpoint
ALTER TABLE "document_edit_leases" ADD CONSTRAINT "document_edit_leases_request_check" CHECK (("document_edit_leases"."request_id" IS NULL) = ("document_edit_leases"."requested_by" IS NULL) AND ("document_edit_leases"."request_id" IS NULL) = ("document_edit_leases"."request_session_id" IS NULL) AND ("document_edit_leases"."request_id" IS NULL) = ("document_edit_leases"."requested_at" IS NULL) AND ("document_edit_leases"."request_id" IS NULL) = ("document_edit_leases"."request_expires_at" IS NULL));--> statement-breakpoint
ALTER TABLE "document_edit_leases" ADD CONSTRAINT "document_edit_leases_request_declined_check" CHECK ("document_edit_leases"."request_declined_at" IS NULL OR "document_edit_leases"."request_id" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "document_edit_leases" ADD CONSTRAINT "document_edit_leases_request_expiry_check" CHECK ("document_edit_leases"."request_expires_at" > "document_edit_leases"."requested_at");--> statement-breakpoint
ALTER TABLE "document_edit_leases" ADD CONSTRAINT "document_edit_leases_requester_check" CHECK ("document_edit_leases"."requested_by" <> "document_edit_leases"."holder_id");--> statement-breakpoint
ALTER TABLE "document_edit_leases" ADD CONSTRAINT "document_edit_leases_reservation_check" CHECK (("document_edit_leases"."reserved_for" IS NULL) = ("document_edit_leases"."reserved_until" IS NULL));--> statement-breakpoint
ALTER TABLE "document_edit_leases" ADD CONSTRAINT "document_edit_leases_reservation_end_check" CHECK ("document_edit_leases"."reserved_for" IS NULL OR "document_edit_leases"."end_reason" IS NOT DISTINCT FROM 'handed_over');--> statement-breakpoint
ALTER TABLE "document_edit_leases" ADD CONSTRAINT "document_edit_leases_taken_over_check" CHECK (("document_edit_leases"."taken_over_token_digest" IS NULL) = ("document_edit_leases"."takeover" IS NULL));--> statement-breakpoint
ALTER TABLE "document_edit_leases" ADD CONSTRAINT "document_edit_leases_taken_over_token_digest_check" CHECK (octet_length("document_edit_leases"."taken_over_token_digest") = 32);--> statement-breakpoint
ALTER TABLE "document_edit_leases" ADD CONSTRAINT "document_edit_leases_takeover_check" CHECK ("document_edit_leases"."takeover" IN ('self', 'forced'));--> statement-breakpoint
ALTER TABLE "document_edit_leases" ADD CONSTRAINT "document_edit_leases_end_reason_check" CHECK ("document_edit_leases"."end_reason" IN ('released', 'revoked', 'handed_over'));
-- 单独授权（M2-P5 设计 §3.3）：一个人在一份文档上的查看者或编辑者授权，主键 (document_id, user_id)，另加 (user_id) 的索引
-- 给"与我共享"与"可访问文档"的授权那一半。永久删除文档时授权随外键级联删除（ADR-016 的连带）；被授权人与最后设置它的人
-- 不是同一个（不能给自己，CHECK 兜底）。审计的动作加上分享的三个（documents.shared、share_changed、share_revoked），
-- CHECK 按 AUDIT_ACTIONS 全量重列。只做加法：已有的表与数据不变，新表是空的。
CREATE TABLE "document_grants" (
	"document_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text NOT NULL,
	"granted_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_grants_pkey" PRIMARY KEY("document_id","user_id"),
	CONSTRAINT "document_grants_role_check" CHECK ("document_grants"."role" IN ('viewer', 'editor')),
	CONSTRAINT "document_grants_not_self_check" CHECK ("document_grants"."user_id" <> "document_grants"."granted_by")
);
--> statement-breakpoint
ALTER TABLE "audit_events" DROP CONSTRAINT "audit_events_action_check";--> statement-breakpoint
ALTER TABLE "document_grants" ADD CONSTRAINT "document_grants_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_grants" ADD CONSTRAINT "document_grants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_grants" ADD CONSTRAINT "document_grants_granted_by_users_id_fk" FOREIGN KEY ("granted_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "document_grants_user_idx" ON "document_grants" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_action_check" CHECK ("audit_events"."action" IN ('auth.login_succeeded', 'auth.login_failed', 'auth.logout', 'users.admin_initialized', 'documents.created', 'documents.content_saved', 'auth.link_rejected', 'users.invited', 'users.invitation_revoked', 'users.invitation_accepted', 'users.password_changed', 'users.password_change_failed', 'users.password_reset_issued', 'users.password_reset_completed', 'users.disabled', 'users.enabled', 'users.system_role_changed', 'spaces.created', 'spaces.renamed', 'spaces.visibility_changed', 'spaces.archived', 'spaces.restored', 'spaces.member_added', 'spaces.member_role_changed', 'spaces.member_removed', 'spaces.admin_joined', 'documents.transferred', 'folders.created', 'folders.renamed', 'folders.moved', 'documents.renamed', 'documents.moved', 'documents.copied', 'documents.deleted', 'documents.restored', 'documents.purged', 'folders.deleted', 'folders.restored', 'folders.purged', 'users.password_reset_revoked', 'users.login_unlocked', 'documents.shared', 'documents.share_changed', 'documents.share_revoked'));
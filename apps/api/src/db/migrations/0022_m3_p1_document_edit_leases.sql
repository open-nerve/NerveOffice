-- 编辑租约（M3-P1 设计 §3.3）：每份文档至多一行（主键 document_id），新的申请改写这一行，成为新的一代。
-- 持有者（账户 restrict；按它的索引给停用、移出空间、取消授权时按人找租约）、绑定的登录（不做外键：会话行过期之后会被清理）
-- 与标签页、令牌的 SHA-256 摘要（32 字节）、这一代的代次（申请时文档的代次加一，至少是 1）、申请、续租、到期与最后活动的时间
-- （到期晚于续租、最后活动不晚于续租），明确结束（释放、收回写入权）的时间与原因（两列同时为空或同时有值）。
-- 永久删除文档时随外键级联删除。只做加法：新表是空的，已有的表与数据不变；M2 的存量文档没有租约，write_epoch 照旧。
CREATE TABLE "document_edit_leases" (
	"document_id" uuid PRIMARY KEY NOT NULL,
	"holder_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"client_instance_id" uuid NOT NULL,
	"token_digest" "bytea" NOT NULL,
	"write_epoch" integer NOT NULL,
	"acquired_at" timestamp with time zone NOT NULL,
	"renewed_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_active_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"end_reason" text,
	CONSTRAINT "document_edit_leases_token_digest_check" CHECK (octet_length("document_edit_leases"."token_digest") = 32),
	CONSTRAINT "document_edit_leases_write_epoch_check" CHECK ("document_edit_leases"."write_epoch" >= 1),
	CONSTRAINT "document_edit_leases_expiry_check" CHECK ("document_edit_leases"."expires_at" > "document_edit_leases"."renewed_at"),
	CONSTRAINT "document_edit_leases_last_active_check" CHECK ("document_edit_leases"."last_active_at" <= "document_edit_leases"."renewed_at"),
	CONSTRAINT "document_edit_leases_end_reason_check" CHECK ("document_edit_leases"."end_reason" IN ('released', 'revoked')),
	CONSTRAINT "document_edit_leases_ended_check" CHECK (("document_edit_leases"."ended_at" IS NULL) = ("document_edit_leases"."end_reason" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "document_edit_leases" ADD CONSTRAINT "document_edit_leases_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_edit_leases" ADD CONSTRAINT "document_edit_leases_holder_id_users_id_fk" FOREIGN KEY ("holder_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "document_edit_leases_holder_idx" ON "document_edit_leases" USING btree ("holder_id");
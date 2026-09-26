CREATE TABLE "audit_events" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"action" text NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" uuid,
	"target_type" text,
	"target_id" uuid,
	"source" text NOT NULL,
	"request_id" text,
	"client_ip" "inet",
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "audit_events_action_check" CHECK ("audit_events"."action" IN ('auth.login_succeeded', 'auth.login_failed', 'auth.logout', 'users.admin_initialized', 'documents.created')),
	CONSTRAINT "audit_events_actor_type_check" CHECK ("audit_events"."actor_type" IN ('user', 'system', 'anonymous')),
	CONSTRAINT "audit_events_actor_check" CHECK (("audit_events"."actor_type" = 'user') = ("audit_events"."actor_id" IS NOT NULL)),
	CONSTRAINT "audit_events_target_type_check" CHECK ("audit_events"."target_type" IN ('user', 'space', 'document')),
	CONSTRAINT "audit_events_target_check" CHECK (("audit_events"."target_type" IS NULL) = ("audit_events"."target_id" IS NULL)),
	CONSTRAINT "audit_events_source_check" CHECK ("audit_events"."source" IN ('http', 'cli')),
	CONSTRAINT "audit_events_http_request_id_check" CHECK ("audit_events"."source" <> 'http' OR "audit_events"."request_id" IS NOT NULL),
	CONSTRAINT "audit_events_client_ip_check" CHECK ("audit_events"."source" = 'http' OR "audit_events"."client_ip" IS NULL),
	CONSTRAINT "audit_events_details_check" CHECK (jsonb_typeof("audit_events"."details") = 'object' AND octet_length("audit_events"."details"::text) <= 8192)
);
--> statement-breakpoint
CREATE INDEX "audit_events_occurred_at_idx" ON "audit_events" USING btree ("occurred_at");--> statement-breakpoint
CREATE INDEX "audit_events_actor_idx" ON "audit_events" USING btree ("actor_id","occurred_at") WHERE "audit_events"."actor_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "audit_events_target_idx" ON "audit_events" USING btree ("target_type","target_id","occurred_at") WHERE "audit_events"."target_id" IS NOT NULL;
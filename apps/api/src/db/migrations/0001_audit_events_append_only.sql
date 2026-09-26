-- 审计事件只追加（P2 设计 §3.8，ADR-005）：UPDATE、DELETE、TRUNCATE 一律报错，代码写错也改不了审计记录。
-- 以后要按保留期清理时，另行设计受控的清理路径（M7）。
CREATE FUNCTION "audit_events_reject_change"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_events 只追加，不允许 %', TG_OP;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "audit_events_append_only" BEFORE UPDATE OR DELETE ON "audit_events"
  FOR EACH ROW EXECUTE FUNCTION "audit_events_reject_change"();
--> statement-breakpoint
CREATE TRIGGER "audit_events_no_truncate" BEFORE TRUNCATE ON "audit_events"
  FOR EACH STATEMENT EXECUTE FUNCTION "audit_events_reject_change"();

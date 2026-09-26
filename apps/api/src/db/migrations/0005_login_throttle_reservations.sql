-- 登录限流改为先占用名额、再验证（P3 审查 A1）：验证成功时退回名额，计数可以回到 0。
ALTER TABLE "auth_login_throttles" DROP CONSTRAINT "auth_login_throttles_failures_check";--> statement-breakpoint
ALTER TABLE "auth_login_throttles" ADD CONSTRAINT "auth_login_throttles_failures_check" CHECK ("auth_login_throttles"."failures" >= 0);
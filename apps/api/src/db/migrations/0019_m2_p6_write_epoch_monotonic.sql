-- 文档的写入代次只增不减（M2-P6 复核 B 的 G5）：删除、跨空间移动与转移在同一个事务里给它加一，收回写入权；
-- M3 的编辑租约与保存按"代次没变"条件写入（00 号计划书 §6.4）。代次一旦变小，已经失效的旧租约就可能重新对得上，
-- 收回的写入权又回来了。现在只靠服务的写法保证（每一处都是 write_epoch + 1），M3 要依赖它，所以在数据库里兜底：
-- 更新时新值小于旧值就拒绝，报成违反约束（SQLSTATE 23514，约束名写触发器名），与 CHECK 失败同类，整条语句连同事务回滚。
-- 不变与变大照常放行；WHEN 条件在调用函数之前判断，正常的更新不进函数。
-- 触发器不在表定义里（drizzle 的表定义写不出触发器）：集成测试"迁移建出的库与按表定义建出的库一致"把它与审计表的触发器
-- 一起列在手写对象的白名单里（database/schema-parity.test.ts）。
CREATE FUNCTION "documents_reject_write_epoch_decrease"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '文档的写入代次只增不减：% 不能从 % 改成 %', OLD.id, OLD.write_epoch, NEW.write_epoch
    USING ERRCODE = 'check_violation', CONSTRAINT = 'documents_write_epoch_monotonic', TABLE = 'documents', COLUMN = 'write_epoch';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "documents_write_epoch_monotonic" BEFORE UPDATE ON "documents"
  FOR EACH ROW WHEN (NEW.write_epoch < OLD.write_epoch) EXECUTE FUNCTION "documents_reject_write_epoch_decrease"();

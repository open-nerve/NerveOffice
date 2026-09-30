/**
 * 按 id 的顺序（id 已由契约统一成小写，小写的 UUID 文本与数据库里 uuid 的顺序一致）：
 * 一个事务里要锁多行（多个账户、多个空间、多份文档）时都按这个顺序取锁，方向相反的两个操作同时发生也不成环（ADR-007）。
 * 顺便去重：同一个 id 只取一次锁。
 */
export function inIdOrder(ids: readonly string[]): string[] {
  return [...new Set(ids)].sort()
}

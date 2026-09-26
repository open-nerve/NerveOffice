import { z } from 'zod'

/**
 * 定稿的 CSP 不允许 eval（没有 'unsafe-eval'）。关掉 zod 的 JIT：它就不会用 new Function 探测能否执行动态代码，
 * 否则浏览器会报一条 CSP 违规（即使 zod 接住了异常）。入口在渲染之前调用（ADR-008）。
 */
export function configureZodForCsp(): void {
  z.config({ jitless: true })
}

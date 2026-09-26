// 有副作用的模块：被导入即关闭 zod 的 JIT（ADR-008）。
// 定稿的 CSP 不允许 eval（没有 'unsafe-eval'）。zod 4 在构造对象结构时就读取 jitless：没有关掉时，
// 它用 new Function 探测能否执行动态代码，即使接住了异常，浏览器仍记一条 CSP 违规，而且不写进控制台。
// contracts 在模块求值时就构造结构，所以这个模块必须在它们之前执行：每个入口把它作为第一个导入（审查 B1）。
import { z } from 'zod'

z.config({ jitless: true })

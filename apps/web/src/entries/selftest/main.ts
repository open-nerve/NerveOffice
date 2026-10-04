// 页面自检的入口页（selftest.html，只在测试构建里）：按顺序执行的几步，只写副作用导入（与别的入口相同，ADR-008）。
// 1. 先关掉 zod 的 JIT：必须在任何 zod 结构（contracts）构造之前
import '../../shared/lib/zod-jitless.ts'
// 2. 登录，跳到编辑器页
import './sign-in.ts'

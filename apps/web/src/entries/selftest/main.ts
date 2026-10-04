// 页面自检的入口页（selftest.html，只在测试构建里）：只写副作用导入（与别的入口相同，ADR-008）。
// 不像别的入口那样先引入 shared/lib/zod-jitless.ts：这个入口页不用 zod，也不引用平台页面与编辑器页共用的任何模块（M3-P2 复核 B4，见 sign-in.ts）
// 登录，跳到编辑器页
import './sign-in.ts'

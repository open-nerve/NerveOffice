// 平台页面的入口：按顺序执行的几步，只写副作用导入。
// 导入排序规则只把副作用导入排在最后、不调整它们之间的先后，这里写的顺序就是执行的顺序；不要在这里加普通的导入，它会被排到前面先执行。
// 1. 先关掉 zod 的 JIT：必须在任何 zod 结构（contracts）构造之前（zod-jitless.ts，审查 B1）
import '../../shared/lib/zod-jitless.ts'
// 2. 样式
import '../../app/styles.css'
// 3. 建路由与请求缓存，挂载应用
import './mount.tsx'

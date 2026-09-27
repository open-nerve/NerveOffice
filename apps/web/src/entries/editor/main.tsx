// 编辑器页的入口：按顺序执行的几步，只写副作用导入（与平台页面的入口相同，ADR-008）。
// 1. 先关掉 zod 的 JIT：必须在任何 zod 结构（contracts）构造之前
import '../../shared/lib/zod-jitless.ts'
// 2. 页面的样式（不含 Tailwind 的基础重置）；Univer 的样式随编辑器按档案导入
import './styles.css'
// 3. 挂上页头、快捷键与离开提示，载入文档
import './mount.tsx'

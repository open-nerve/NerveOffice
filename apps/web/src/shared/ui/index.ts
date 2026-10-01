// 界面组件的桶文件。带第三方运行时的重组件（弹窗 dialog.tsx：Radix Dialog，约 12 KiB gzip）不经这里导出，用到的地方直接引用它的文件：
// web 没有声明 sideEffects（zod-jitless 与样式都有副作用，不能笼统声明），引用桶文件的模块会连带它再导出的每个模块；
// 按需加载的管理界面用到的组件就被打进与首屏共用的块，进了平台页面与编辑器页的首屏（M2-P1 审查 B2，门禁 budgets）
export { Alert, AlertDescription, AlertTitle } from './alert.tsx'
export { Badge } from './badge.tsx'
export { buttonVariants } from './button-variants.ts'
export { Button } from './button.tsx'
export type { ButtonProps } from './button.tsx'
export { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from './card.tsx'
export { FieldProblem } from './field-problem.tsx'
export { Input } from './input.tsx'
export { Label } from './label.tsx'
export { NativeSelect } from './native-select.tsx'
export { Notice } from './notice.tsx'
export { PersonName } from './person-name.tsx'
export { Phrase } from './phrase.tsx'
export { Skeleton } from './skeleton.tsx'
export { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from './table.tsx'

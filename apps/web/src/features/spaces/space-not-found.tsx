import { useEffect, useRef } from 'react'
import { messages } from '../../shared/i18n/index.ts'
import { Alert, AlertDescription } from '../../shared/ui/index.ts'

/**
 * 空间看不到了（与不存在一致）的说明，空间页与成员页共用。页内的操作被拒绝（新建表格、改名、移出成员）之后重新请求得到 404，
 * 页头或成员表连同有焦点的按钮一起卸载，焦点落到 body：交给这条说明（与管理界面的无权限说明同一个做法，M2-P2 复验）。
 * 焦点在别处（例如刚点的导航链接）时不抢
 */
export function SpaceNotFound() {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (document.activeElement === null || document.activeElement === document.body)
      ref.current?.focus()
  }, [])
  return (
    <Alert ref={ref} tabIndex={-1} variant="destructive">
      <AlertDescription>{messages.spaces.notFound}</AlertDescription>
    </Alert>
  )
}

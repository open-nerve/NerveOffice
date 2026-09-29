import { documentPagePath } from '@nerve-office/contracts'
import { useMutation } from '@tanstack/react-query'
import { FilePlus2 } from 'lucide-react'
import { useRef } from 'react'
import { describeError, isAccessDenied, isDefiniteRejection } from '../../shared/api/index.ts'
import { messages } from '../../shared/i18n/index.ts'
import { usePageLocation } from '../../shared/lib/page-location.ts'
import { Alert, AlertDescription, Button } from '../../shared/ui/index.ts'
import { createDocument } from './documents-api.ts'

interface NewSheetButtonProps {
  readonly spaceId: string
  /** 建在哪个文件夹里；null 表示空间的根目录（M2-P4） */
  readonly folderId?: string | null
  /**
   * 新建按访问权限被拒绝（403：不能在这里新建了，例如空间刚被归档；404：空间看不到了）：页面上显示的权限已经过时，
   * 由页面重新请求（M2-P2 复验）。页头在 features/spaces，这里不反向引用它（会成环），由页面传入
   */
  readonly onDenied?: () => void
}

/**
 * 新建表格（US-M1-04，P4 设计 §3.7.4，M2-P2 设计 §3.10）：建在当前位置，建好之后整页打开编辑器页（另一个入口）。
 * 一次点击生成一个 requestId：结果未知之后再点，沿用同一个，服务端只建一份；确定失败（4xx）之后再点，换一个新的（审查 B6）。
 *
 * 在文件夹里新建也是一次请求：目标文件夹随请求给出（契约 createDocumentRequestSchema 的 folderId），
 * 服务端在同一个事务里判断它并写进去，不存在"建好了却没能移进来"的中间状态。
 */
export function NewSheetButton({ spaceId, folderId = null, onDenied }: NewSheetButtonProps) {
  const page = usePageLocation()
  const requestIdRef = useRef<string>(undefined)
  const mutation = useMutation({
    // 建在空间根目录时不带 folderId：契约里省略就是根目录，请求与 M2-P4 之前一样
    mutationFn: async (requestId: string) => createDocument({ type: 'sheet', requestId, spaceId, ...(folderId === null ? {} : { folderId }) }),
    onSuccess: document => page.assign(documentPagePath(document.id)),
    onError: (error) => {
      // 确定被拒绝（4xx）才换 requestId：结果未知时沿用同一个，再点不会建出第二份
      if (isDefiniteRejection(error))
        requestIdRef.current = undefined
      if (isAccessDenied(error))
        onDenied?.()
    },
  })
  // 建好之后页面正在离开：按钮保持进行中，不能再建一份
  const busy = mutation.isPending || mutation.isSuccess

  function create(): void {
    if (busy)
      return
    requestIdRef.current ??= crypto.randomUUID()
    mutation.mutate(requestIdRef.current)
  }

  const error = mutation.isError ? describeError(mutation.error) : undefined
  return (
    <div className="flex flex-col items-end gap-2">
      {/* 进行中用 aria-disabled：按钮变成 disabled 时焦点会丢（审查 B13）；重复点击由 create 挡住 */}
      <Button aria-disabled={busy} onClick={create}>
        <FilePlus2 aria-hidden="true" />
        {busy ? messages.documents.creating : messages.documents.create}
      </Button>
      {error !== undefined && (
        <Alert variant="destructive">
          <AlertDescription>
            <p>{messages.documents.createFailed(error.message)}</p>
            {error.requestId !== undefined && <p>{messages.common.requestId(error.requestId)}</p>}
          </AlertDescription>
        </Alert>
      )}
    </div>
  )
}

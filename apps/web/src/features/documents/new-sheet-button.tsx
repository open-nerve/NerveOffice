import { documentPagePath } from '@nerve-office/contracts'
import { useMutation } from '@tanstack/react-query'
import { FilePlus2 } from 'lucide-react'
import { useRef } from 'react'
import { describeError, isAccessDenied, isDefiniteRejection } from '../../shared/api/index.ts'
import { messages } from '../../shared/i18n/index.ts'
import { usePageLocation } from '../../shared/lib/page-location.ts'
import { Alert, AlertDescription, Button } from '../../shared/ui/index.ts'
import { createDocument, moveDocument } from './documents-api.ts'

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
 * 在文件夹里新建时分两步：新建接口没有"建在哪个文件夹"（契约 createDocumentRequestSchema），所以建完再移进来。
 * 第二步失败时不换 requestId：再点一次不会又建一份，只是重试移动（新建重放返回的是同一份文档）。
 */
export function NewSheetButton({ spaceId, folderId = null, onDenied }: NewSheetButtonProps) {
  const page = usePageLocation()
  const requestIdRef = useRef<string>(undefined)
  /** 这一次的 requestId 是否已经建出了文档：建出来之后失败的只可能是移动那一步 */
  const createdRef = useRef(false)
  const mutation = useMutation({
    mutationFn: async (requestId: string) => {
      const created = await createDocument({ type: 'sheet', requestId, spaceId })
      createdRef.current = true
      if (folderId === null || created.folderId === folderId)
        return created
      return moveDocument(created.id, { spaceId, folderId })
    },
    onSuccess: document => page.assign(documentPagePath(document.id)),
    onError: (error) => {
      // 只有新建这一步确定被拒绝时才换 requestId：移动那一步失败时文档已经建出来了，换了会多出一份没人要的表格
      if (isDefiniteRejection(error) && !createdRef.current)
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

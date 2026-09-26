import { documentPagePath } from '@nerve-office/contracts'
import { useMutation } from '@tanstack/react-query'
import { FilePlus2 } from 'lucide-react'
import { useRef } from 'react'
import { describeError, isTransientError } from '../../shared/api/index.ts'
import { messages } from '../../shared/i18n/index.ts'
import { usePageLocation } from '../../shared/lib/page-location.ts'
import { Alert, AlertDescription, Button } from '../../shared/ui/index.ts'
import { createDocument } from './documents-api.ts'

/**
 * 新建表格（US-M1-04，P4 设计 §3.7.4）：建好之后整页打开编辑器页（另一个入口）。
 * 一次点击生成一个 requestId：网络错误或服务端的临时错误之后再点，沿用同一个，服务端只建一份；确定失败（4xx）之后再点，换一个新的。
 */
export function NewSheetButton() {
  const page = usePageLocation()
  const requestIdRef = useRef<string>(undefined)
  const mutation = useMutation({
    mutationFn: createDocument,
    onSuccess: document => page.assign(documentPagePath(document.id)),
    onError: (error) => {
      if (!isTransientError(error))
        requestIdRef.current = undefined
    },
  })
  // 建好之后页面正在离开：按钮保持进行中，不能再建一份
  const busy = mutation.isPending || mutation.isSuccess

  function create(): void {
    if (busy)
      return
    requestIdRef.current ??= crypto.randomUUID()
    mutation.mutate({ type: 'sheet', requestId: requestIdRef.current })
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

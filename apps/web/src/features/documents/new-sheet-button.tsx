import type { ApiError, ErrorDescription } from '../../shared/api/index.ts'
import type { RequestIdLedger } from '../../shared/api/request-ids.ts'
import { documentPagePath } from '@nerve-office/contracts'
import { useMutation } from '@tanstack/react-query'
import { FilePlus2 } from 'lucide-react'
import { describeError, isAccessDenied, isUnknownOutcome } from '../../shared/api/index.ts'
import { messages } from '../../shared/i18n/index.ts'
import { usePageLocation } from '../../shared/lib/page-location.ts'
import { useRequestIdLedger } from '../../shared/lib/request-id-ledger.ts'
import { Alert, AlertDescription, Button, buttonVariants } from '../../shared/ui/index.ts'
import { createDocument } from './documents-api.ts'
import { useOrganizeRefresh } from './organize-refresh.ts'

interface NewSheetButtonProps {
  readonly spaceId: string
  /** 建在哪个文件夹里；null 表示空间的根目录（M2-P4） */
  readonly folderId?: string | null
  /**
   * 新建按访问权限被拒绝（403：不能在这里新建了，例如空间刚被归档；404：空间或文件夹看不到了）：页面上显示的权限已经过时，
   * 由页面重新请求、按新的权限重画，并在一条说明里写明原因——这个按钮可能随之消失，原因不能只写在它下面（M2-P6 复核 S2、S5）。
   * 页头在 features/spaces，这里不反向引用它（会成环），由页面传入
   */
  readonly onDenied?: (error: ApiError) => void
}

/** 失败的说明：上一次可能已经建好（服务端认出了用过的 requestId）、结果未知（再点不会重复新建）、其余按错误码 */
function failureOf(error: unknown, ledger: RequestIdLedger): ErrorDescription {
  if (ledger.earlierAttemptDone(error))
    return { message: messages.documents.createdEarlier }
  const described = describeError(error)
  const message = isUnknownOutcome(error) ? messages.documents.createOutcomeUnknown(described.message) : messages.documents.createFailed(described.message)
  return { message, requestId: described.requestId }
}

/**
 * 新建表格（US-M1-04，P4 设计 §3.7.4，M2-P2 设计 §3.10）：建在当前位置，建好之后整页打开编辑器页（另一个入口）。
 * requestId 按"在这个位置新建"记账（shared/api/request-ids.ts，M2-P6 复核 M1）：结果未知之后再点沿用同一个，服务端只建一份；
 * 之后撞上会话类的拒绝（别的标签页换了令牌）同样沿用；成功、或者与载荷有关的确定拒绝才换新的。在文件夹之间切换时页头不重来，
 * 换了位置就是另一件事、另一个 requestId，结果未知的那个位置回去之后仍沿用它原来的。
 * 结果未知时列表随即刷新：建好了的话就在列表里。
 * 服务端说这次是重放（replayed，M2-P6 复核第二批 S-1）：结果未知的那一次其实已经建好了。这时不打开它——用户可能早已给它改了名、
 * 很久以后才回来想另建一份，打开的却是改过名的那一份——而是刷新列表、说明"上一次其实已经完成，就是「…」"，给出打开它的链接；
 * 这件事随之了结（成功就换新的 requestId），再点就是新建一份。
 *
 * 在文件夹里新建也是一次请求：目标文件夹随请求给出（契约 createDocumentRequestSchema 的 folderId），
 * 服务端在同一个事务里判断它并写进去，不存在"建好了却没能移进来"的中间状态。
 */
export function NewSheetButton({ spaceId, folderId = null, onDenied }: NewSheetButtonProps) {
  const page = usePageLocation()
  const ledger = useRequestIdLedger()
  const refresh = useOrganizeRefresh()
  const mutation = useMutation({
    // 建在空间根目录时不带 folderId：契约里省略就是根目录，请求与 M2-P4 之前一样
    mutationFn: async () => ledger.send(`sheet:${spaceId}/${folderId ?? ''}`, async requestId => createDocument({ type: 'sheet', requestId, spaceId, ...(folderId === null ? {} : { folderId }) })),
    onSuccess: async (document) => {
      if (!document.replayed) {
        page.assign(documentPagePath(document.id))
        return
      }
      // 那一份可能已经改了名、移到了别处：这里与它现在所在的空间都刷新
      await refresh([spaceId, document.spaceId])
    },
    onError: async (error) => {
      if (isAccessDenied(error)) {
        onDenied?.(error)
        return
      }
      // 结果未知、或者上一次已经生效：列表刷新出来，看得到它是不是已经建好了
      if (isUnknownOutcome(error) || ledger.earlierAttemptDone(error))
        await refresh([spaceId])
    },
  })
  // 建好之后页面正在离开：按钮保持进行中，不能再建一份（重放不离开，按钮照常可用）
  const busy = mutation.isPending || (mutation.isSuccess && !mutation.data.replayed)
  const replayed = mutation.isSuccess && mutation.data.replayed ? mutation.data : undefined

  function create(): void {
    if (!busy)
      mutation.mutate()
  }

  // 按访问权限被拒绝的原因由页面说明（按钮可能随新的权限消失）
  const failure = mutation.isError && !isAccessDenied(mutation.error) ? failureOf(mutation.error, ledger) : undefined
  return (
    <div className="flex flex-col items-end gap-2">
      {/* 进行中用 aria-disabled：按钮变成 disabled 时焦点会丢（审查 B13）；重复点击由 create 挡住 */}
      <Button aria-disabled={busy} onClick={create}>
        <FilePlus2 aria-hidden="true" />
        {busy ? messages.documents.creating : messages.documents.create}
      </Button>
      {replayed !== undefined && (
        <Alert>
          <AlertDescription className="flex flex-wrap items-center gap-2">
            <span>{messages.documents.createdReplayed(replayed.title)}</span>
            {/* 编辑器页是另一个入口：普通的链接，整页打开 */}
            <a href={documentPagePath(replayed.id)} className={buttonVariants({ variant: 'outline', size: 'sm' })}>{messages.documents.openReplayed}</a>
          </AlertDescription>
        </Alert>
      )}
      {failure !== undefined && (
        <Alert variant="destructive">
          <AlertDescription>
            <p>{failure.message}</p>
            {failure.requestId !== undefined && <p>{messages.common.requestId(failure.requestId)}</p>}
          </AlertDescription>
        </Alert>
      )}
    </div>
  )
}

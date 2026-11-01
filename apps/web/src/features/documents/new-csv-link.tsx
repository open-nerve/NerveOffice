import type { MouseEvent } from 'react'
import { csvCreatePagePath } from '@nerve-office/contracts'
import { messages } from '../../shared/i18n/index.ts'
import { connectionUnavailable, useConnectionState } from '../../shared/lib/use-connection-state.ts'
import { buttonVariants } from '../../shared/ui/index.ts'

function checkConnection(event: MouseEvent<HTMLAnchorElement>): void {
  if (connectionUnavailable() !== undefined)
    event.preventDefault()
}

/** 普通链接打开独立编辑器入口；平台不装入 CSV 控制器或 SDK。 */
export function NewCsvLink({ spaceId, folderId }: { spaceId: string, folderId: string | null }) {
  const unavailable = connectionUnavailable(useConnectionState())
  return (
    <a
      href={csvCreatePagePath({ spaceId, folderId: folderId ?? undefined })}
      className={buttonVariants({ variant: 'outline' })}
      aria-disabled={unavailable !== undefined}
      title={unavailable}
      onClick={checkConnection}
      onAuxClick={checkConnection}
    >
      {messages.documents.createCsv}
    </a>
  )
}

// 列表里的一份文档与它的行内操作（M2-P4 设计 §3.7）：空间的文档列表与"与我共享"共用（Codex 对抗评审 CX3），不各写一份。
// 只凭单独授权的人进不去源空间的文档列表，原来没有复制与改名的界面入口；US-M2-08 承诺"能读源文档、在目标空间有新建权限即可复制"。
import type { QueryKey } from '@tanstack/react-query'
import type { ReactNode, RefObject } from 'react'
import type { GoneTexts, OrganizeNotice } from './item-actions.tsx'
import type { TargetSpaces } from './target-spaces.ts'
import { documentPagePath, documentTitleSchema } from '@nerve-office/contracts'
import { useQuery } from '@tanstack/react-query'
import { FileSpreadsheet } from 'lucide-react'
import { useId } from 'react'
import { messages } from '../../shared/i18n/index.ts'
import { useRequestIdLedger } from '../../shared/lib/request-id-ledger.ts'
import { problemOf } from '../../shared/lib/validation.ts'
import { Button, buttonVariants } from '../../shared/ui/index.ts'
import { copyDocument, deleteDocument, documentQueryOptions, moveDocument, updateDocument } from './documents-api.ts'
import { ItemActions } from './item-actions.tsx'
import { useOrganizeRefresh, useOrganizeRefreshChecked } from './organize-refresh.ts'
import { ShareEntry } from './share-entry.tsx'

const organize = messages.organize

function titleProblem(value: string): string | undefined {
  return problemOf(documentTitleSchema.safeParse(value))
}

interface DocumentPanelProps {
  readonly documentId: string
  readonly title: string
  /** 文档所在的空间：还没取到元数据时（或者它已经不在了）回收站的入口与"它现在在哪里"按它给出 */
  readonly spaceId: string
  /** 我能新建内容的空间（服务端给的 canCreateDocuments），连同取到了没有：复制与跨空间移动的候选 */
  readonly targetSpaces: TargetSpaces
  readonly onDone: (notice: OrganizeNotice | undefined) => void
  /** 操作按访问权限被拒绝：由页面重新请求，兑现为列表刷新好了没有（M2-P6 复核第五批 G3） */
  readonly onDenied: () => Promise<boolean>
  /**
   * 这份文档还列在空间之外的哪个列表里（"与我共享"）：改名、移动、删除之后连同它一起刷新，结果未知之后也一起刷新、计入"刷新好了没有"。
   * 复制不改动源文档，只刷新副本所在的空间
   */
  readonly listedIn?: QueryKey
  /** 说明里给不给"打开回收站"（默认给）：见 ItemActions 的 trashReachable */
  readonly trashReachable?: boolean
  /** 它已经不在了的说法（默认是空间里的说法）：见 ItemActions 的 goneTexts */
  readonly goneTexts?: GoneTexts
}

/**
 * 展开的操作面板。列表的条目只有摘要（契约里没有权限位），所以展开时才按 id 取一次元数据：能做哪些操作一律以服务端给的 permissions 为准，
 * 顺带也拿到它现在所在的文件夹（移动与复制要用）。只凭单独授权时（accessVia 为 grant）服务端不给移动、删除与分享，
 * 编辑者能改名，能读就能复制（M2-P5 设计 §3.4(1)）；复制的目标是自己能新建的空间，不显示源空间的目录结构（它本来就不在候选里）
 */
function DocumentPanel({ panelId, documentId, title, spaceId, targetSpaces, onDone, onDenied, onClose, listedIn, trashReachable, goneTexts }: DocumentPanelProps & { readonly panelId: string, readonly onClose: () => void }) {
  const refresh = useOrganizeRefresh()
  const refreshAfterUnknown = useOrganizeRefreshChecked()
  const ledger = useRequestIdLedger()
  const detail = useQuery(documentQueryOptions(documentId))
  const sourceSpaceId = detail.data?.spaceId ?? spaceId
  const also = listedIn === undefined ? [] : [listedIn]

  return (
    <ItemActions
      panelId={panelId}
      name={title}
      validateName={titleProblem}
      permissions={detail.data?.permissions}
      request={detail}
      current={{ spaceId: sourceSpaceId, folderId: detail.data?.folderId ?? undefined }}
      targetSpaces={targetSpaces}
      trashReachable={trashReachable}
      goneTexts={goneTexts}
      operations={{
        rename: async (newTitle) => {
          const renamed = await updateDocument(documentId, { title: newTitle })
          return refresh([renamed.spaceId], also)
        },
        move: async (destination) => {
          const moved = await moveDocument(documentId, { spaceId: destination.spaceId, ...(destination.folderId === undefined ? {} : { folderId: destination.folderId }) })
          return refresh([sourceSpaceId, moved.spaceId], also)
        },
        // requestId 按"把这份文档复制到这个位置"记账（shared/api/request-ids.ts，M2-P6 复核 M1）：目标位置是"空间加文件夹"，
        // 换了位置不沿用旧的（沿用会让重试落回旧目标，M2-P4 审查 B1）；某个位置的结果未知之后切去别处、再切回来，
        // 仍然沿用它原来那一个，不会在那里多出一份副本（M2-P4 复验 S1）；做完之后再往同一个位置复制是另一件事，换新的
        // （沿用旧的会被服务端按幂等重放，原样返回第一份副本，第二份根本没建出来）。
        // 记账是页面一份的：离开这一页再回来，结果未知的那个位置仍沿用原来的 requestId。服务端说这次是重放（replayed，
        // M2-P6 复核第二批 S-1）：结果未知的那一次其实已经复制好了，说"上一次其实已经完成"，不说成这一次复制出来的；
        // 这件事随之了结，再点就是再复制一份
        copy: async (destination) => {
          const copy = await ledger.send(`copy:${documentId}->${destination.spaceId}/${destination.folderId ?? ''}`, async requestId => copyDocument(documentId, {
            spaceId: destination.spaceId,
            requestId,
            ...(destination.folderId === undefined ? {} : { folderId: destination.folderId }),
          }))
          const refreshing = await refresh([copy.spaceId])
          return {
            message: copy.replayed ? organize.copyReplayed(copy.title) : organize.copied(copy.title),
            action: <a href={documentPagePath(copy.id)} className={buttonVariants({ variant: 'outline', size: 'sm' })}>{organize.openCopy}</a>,
            refreshing,
          }
        },
        remove: async () => {
          await deleteDocument(documentId)
          return refresh([sourceSpaceId], also)
        },
        refresh: async destination => refreshAfterUnknown([sourceSpaceId, ...(destination === undefined ? [] : [destination.spaceId])], also),
      }}
      onDone={onDone}
      onDenied={onDenied}
      onClose={onClose}
      shareEntry={fallbackFocus => (
        <ShareEntry
          documentId={documentId}
          documentTitle={detail.data?.title ?? title}
          canShare={detail.data?.permissions.canShare === true}
          onDenied={() => void onDenied()}
          fallbackFocus={fallbackFocus}
        />
      )}
    />
  )
}

export interface DocumentRowProps extends DocumentPanelProps {
  /** 标题下面的一行（类型、所属的空间、更新时间等），由列表给出 */
  readonly details: ReactNode
  readonly open: boolean
  /** 记下被点的那个"操作"按钮：面板收起之后页面把焦点还给它（organize-panels.ts） */
  readonly openTriggerRef: RefObject<HTMLButtonElement | null>
  readonly onToggle: () => void
}

/**
 * 列表里的一份文档：标题是打开编辑器页的链接（另一个入口，整页打开，P4 设计 §3.7.4），右边是"操作 <标题>"，展开时在下面显示操作面板
 */
export function DocumentRow({ details, open, openTriggerRef, onToggle, ...panel }: DocumentRowProps) {
  const panelId = useId()
  return (
    <li>
      <div className="flex items-center gap-3 px-4 py-3">
        <a href={documentPagePath(panel.documentId)} className="flex min-w-0 flex-1 items-center gap-3 outline-none hover:bg-muted/50 focus-visible:ring-3 focus-visible:ring-ring/50">
          <FileSpreadsheet className="size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
          <span className="flex min-w-0 flex-col">
            <span className="truncate font-medium">{panel.title}</span>
            <span className="text-xs text-muted-foreground">{details}</span>
          </span>
        </a>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-expanded={open}
          aria-controls={panelId}
          aria-label={organize.actionsOn(panel.title)}
          onClick={(event) => {
            openTriggerRef.current = event.currentTarget
            onToggle()
          }}
        >
          {organize.actions}
        </Button>
      </div>
      {open && <DocumentPanel panelId={panelId} onClose={onToggle} {...panel} />}
    </li>
  )
}

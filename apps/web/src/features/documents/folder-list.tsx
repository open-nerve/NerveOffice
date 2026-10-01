import type { Folder, SpaceView } from '@nerve-office/contracts'
import type { RefObject } from 'react'
import type { OrganizeNotice } from './item-actions.tsx'
import { folderNameSchema } from '@nerve-office/contracts'
import { Folder as FolderIcon } from 'lucide-react'
import { useId } from 'react'
import { Link } from 'react-router'
import { messages } from '../../shared/i18n/index.ts'
import { spaceFolderPath } from '../../shared/lib/space-paths.ts'
import { problemOf } from '../../shared/lib/validation.ts'
import { Button } from '../../shared/ui/index.ts'
import { deleteFolder, moveFolder, updateFolder } from './folders-api.ts'
import { ItemActions } from './item-actions.tsx'
import { useOrganizeRefresh, useOrganizeRefreshAfterUnknown } from './organize-refresh.ts'

const text = messages.organize

function nameProblem(value: string): string | undefined {
  return problemOf(folderNameSchema.safeParse(value))
}

interface FolderRowProps {
  readonly folder: Folder
  /** 当前位置的 id 路径：进入这个文件夹就是在它后面接上自己的 id */
  readonly folderIds: readonly string[]
  readonly targetSpaces: readonly SpaceView[]
  readonly open: boolean
  /** 记下被点的那个"操作"按钮：面板收起之后空间页把焦点还给它 */
  readonly openTriggerRef: RefObject<HTMLButtonElement | null>
  readonly onToggle: () => void
  readonly onDone: (notice: OrganizeNotice | undefined) => void
  readonly onDenied: () => void
}

/**
 * 一个子文件夹：名称是进入它的链接，右边是"操作 <名称>"（改名、移动、删除；文件夹不能复制）。
 * 权限直接用列表里服务端给的 permissions，一个都不能做时连"操作"都不显示。
 */
function FolderRow({ folder, folderIds, targetSpaces, open, openTriggerRef, onToggle, onDone, onDenied }: FolderRowProps) {
  const refresh = useOrganizeRefresh()
  const refreshAfterUnknown = useOrganizeRefreshAfterUnknown()
  const panelId = useId()
  const { canRename, canMoveWithinSpace, canMoveAcrossSpaces, canDelete } = folder.permissions
  const actionable = canRename || canMoveWithinSpace || canMoveAcrossSpaces || canDelete

  return (
    <li>
      <div className="flex items-center gap-3 px-4 py-3">
        <FolderIcon className="size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
        <Link to={spaceFolderPath(folder.spaceId, [...folderIds, folder.id])} className="min-w-0 flex-1 truncate font-medium outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50">
          {folder.name}
        </Link>
        {actionable && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-expanded={open}
            aria-controls={panelId}
            aria-label={text.actionsOn(folder.name)}
            onClick={(event) => {
              openTriggerRef.current = event.currentTarget
              onToggle()
            }}
          >
            {text.actions}
          </Button>
        )}
      </div>
      {/* 刷新之后一个操作都做不了了（例如空间刚被归档）：面板不再显示，和"操作"一起消失 */}
      {open && actionable && (
        <ItemActions
          panelId={panelId}
          name={folder.name}
          validateName={nameProblem}
          // 文件夹不能复制（契约里没有这一位）：面板上不出现"复制"
          permissions={{ ...folder.permissions, canCopy: false }}
          loading={false}
          error={null}
          onRetry={onToggle}
          current={{ spaceId: folder.spaceId, folderId: folder.parentId ?? undefined }}
          // 目标位置里不列出它自己（挪到它所在的那一层时就在眼前）：更深的子孙仍由服务端的 409 拦下（审查建议 6）
          excludeFolderId={folder.id}
          targetSpaces={targetSpaces}
          operations={{
            rename: async (name) => {
              await updateFolder(folder.id, { name })
              await refresh([folder.spaceId])
            },
            move: async (destination) => {
              await moveFolder(folder.id, { spaceId: destination.spaceId, ...(destination.folderId === undefined ? {} : { folderId: destination.folderId }) })
              await refresh([folder.spaceId, destination.spaceId])
            },
            remove: async () => {
              await deleteFolder(folder.id)
              await refresh([folder.spaceId])
            },
            refresh: async destination => refreshAfterUnknown([folder.spaceId, ...(destination === undefined ? [] : [destination.spaceId])]),
          }}
          onDone={onDone}
          onDenied={onDenied}
          onClose={onToggle}
        />
      )}
    </li>
  )
}

interface FolderListProps {
  readonly folders: readonly Folder[]
  readonly folderIds: readonly string[]
  readonly targetSpaces: readonly SpaceView[]
  /** 当前展开操作面板的那一个（整页只有一个），undefined 表示都没展开 */
  readonly openId: string | undefined
  /** 记下被点的那个"操作"按钮：面板收起之后空间页把焦点还给它 */
  readonly openTriggerRef: RefObject<HTMLButtonElement | null>
  readonly onToggle: (id: string) => void
  readonly onDone: (notice: OrganizeNotice | undefined) => void
  readonly onDenied: () => void
}

/** 当前位置下的子文件夹（M2-P4 设计 §3.7）：排在文档前面，空列表时整块不显示（由文档列表说明"这里还没有文档"）。 */
export function FolderList({ folders, folderIds, targetSpaces, openId, openTriggerRef, onToggle, onDone, onDenied }: FolderListProps) {
  if (folders.length === 0)
    return null
  return (
    <ul aria-label={text.folderListLabel} className="divide-y rounded-lg border">
      {folders.map(folder => (
        <FolderRow
          key={folder.id}
          folder={folder}
          folderIds={folderIds}
          targetSpaces={targetSpaces}
          open={openId === folder.id}
          openTriggerRef={openTriggerRef}
          onToggle={() => onToggle(folder.id)}
          onDone={onDone}
          onDenied={onDenied}
        />
      ))}
    </ul>
  )
}

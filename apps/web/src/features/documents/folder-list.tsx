import type { Folder, SpaceView } from '@nerve-office/contracts'
import type { OrganizeNotice } from './item-actions.tsx'
import { folderNameSchema } from '@nerve-office/contracts'
import { Folder as FolderIcon } from 'lucide-react'
import { useId } from 'react'
import { Link } from 'react-router'
import { describeError, isPermissionDeniedError } from '../../shared/api/index.ts'
import { messages } from '../../shared/i18n/index.ts'
import { spaceFolderPath } from '../../shared/lib/space-paths.ts'
import { Button } from '../../shared/ui/index.ts'
import { deleteFolder, moveFolder, updateFolder } from './folders-api.ts'
import { ItemActions } from './item-actions.tsx'
import { useOrganizeRefresh } from './organize-refresh.ts'

const text = messages.organize

function validName(value: string): boolean {
  return folderNameSchema.safeParse(value).success
}

interface FolderRowProps {
  readonly folder: Folder
  /** 当前位置的 id 路径：进入这个文件夹就是在它后面接上自己的 id */
  readonly folderIds: readonly string[]
  readonly targetSpaces: readonly SpaceView[]
  readonly open: boolean
  readonly onToggle: () => void
  readonly onDone: (notice: OrganizeNotice | undefined) => void
  readonly onDenied: () => void
}

/**
 * 一个子文件夹：名称是进入它的链接，右边是"操作 <名称>"（改名、移动、删除；文件夹不能复制）。
 * 权限直接用列表里服务端给的 permissions，一个都不能做时连"操作"都不显示。
 */
function FolderRow({ folder, folderIds, targetSpaces, open, onToggle, onDone, onDenied }: FolderRowProps) {
  const refresh = useOrganizeRefresh()
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
          <Button type="button" variant="ghost" size="sm" aria-expanded={open} aria-controls={panelId} aria-label={text.actionsOn(folder.name)} onClick={onToggle}>{text.actions}</Button>
        )}
      </div>
      {open && (
        <ItemActions
          panelId={panelId}
          name={folder.name}
          validateName={validName}
          // 文件夹不能复制（契约里没有这一位）：面板上不出现"复制"
          permissions={{ ...folder.permissions, canCopy: false }}
          loading={false}
          error={null}
          onRetry={onToggle}
          current={{ spaceId: folder.spaceId, folderId: folder.parentId ?? undefined }}
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
          }}
          // 编辑者删文件夹时服务端还要按子树重新判断一次（P4-S3 spec §2）：403 在这里说清楚为什么，不是笼统的"你没有执行这个操作的权限"
          describeDeleteError={error => (isPermissionDeniedError(error) ? text.folderDeleteDenied : describeError(error).message)}
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
  readonly onToggle: (id: string) => void
  readonly onDone: (notice: OrganizeNotice | undefined) => void
  readonly onDenied: () => void
}

/** 当前位置下的子文件夹（M2-P4 设计 §3.7）：排在文档前面，空列表时整块不显示（由文档列表说明"这里还没有文档"）。 */
export function FolderList({ folders, folderIds, targetSpaces, openId, onToggle, onDone, onDenied }: FolderListProps) {
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
          onToggle={() => onToggle(folder.id)}
          onDone={onDone}
          onDenied={onDenied}
        />
      ))}
    </ul>
  )
}

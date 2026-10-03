import type { SpaceView } from '@nerve-office/contracts'
import { useQuery } from '@tanstack/react-query'
import { useId, useState } from 'react'
import { describeError } from '../../shared/api/index.ts'
import { messages } from '../../shared/i18n/index.ts'
import { Alert, AlertDescription, Button, Label, NativeSelect, Skeleton } from '../../shared/ui/index.ts'
import { RefreshProblem } from '../../shared/ui/refresh-problem.tsx'
import { folderChildrenQueryOptions } from './folders-api.ts'

const text = messages.organize

/** 目标位置：要放进哪个空间的哪个文件夹（选到根目录时 folderId 为 undefined，与契约一致） */
export interface Destination {
  readonly spaceId: string
  readonly folderId: string | undefined
}

interface DestinationFormProps {
  /** 展开的面板的 id：与“操作”按钮的 aria-controls 对应 */
  readonly panelId: string
  readonly action: 'move' | 'copy'
  /** 可以选的目标空间：调用方按服务端给的权限筛好（能不能跨空间、目标空间能不能新建） */
  readonly spaces: readonly SpaceView[]
  /** 对象现在所在的位置：移动时用来说明"它已经在这里了" */
  readonly current: Destination
  /**
   * 不列出这个文件夹：移动文件夹时就是它自己（目录会成环，服务端以 409 拒绝）。
   * 只挡住"看得见的那一层"，更深的子孙仍由服务端拦下：界面为此把整棵子树查一遍不值当（审查建议 6）
   */
  readonly excludeFolderId?: string
  readonly pending: boolean
  /** 上一次提交的失败说明（由操作面板按错误与操作给出） */
  readonly error: string | undefined
  /** label 是目标位置的可读名称，例如"市场部 / 方案"：做完之后在说明里回述 */
  readonly onSubmit: (destination: Destination, label: string) => void
  readonly onCancel: () => void
}

/** 已经点进去的那一串目标文件夹（名称在点进去时就知道，不用再查） */
interface TargetCrumb {
  readonly id: string
  readonly name: string
}

/**
 * 行内选目标位置（M2-P4 设计 §3.7）：先选空间，再一层层点进文件夹，最后"移动到这里"/"复制到这里"。
 *
 * 为什么不是弹窗：移动与复制的入口在空间页上，而空间页是平台的首屏页面，首屏不引入 Radix Dialog（ADR-008）。
 * 一次只有一个对象在选目标，所以这个表单由列表渲染在那一行下面，与行内改名同一个形态。
 */
export function DestinationForm({ panelId, action, spaces, current, excludeFolderId, pending, error, onSubmit, onCancel }: DestinationFormProps) {
  const spaceSelectId = useId()
  const [spaceId, setSpaceId] = useState(spaces.some(space => space.id === current.spaceId) ? current.spaceId : (spaces[0]?.id ?? current.spaceId))
  const [crumbs, setCrumbs] = useState<readonly TargetCrumb[]>([])
  const parentId = crumbs.at(-1)?.id ?? null
  const children = useQuery(folderChildrenQueryOptions(spaceId, parentId))
  const choices = (children.data?.items ?? []).filter(folder => folder.id !== excludeFolderId)
  const target = spaces.find(space => space.id === spaceId)
  const spaceName = target === undefined ? '' : (target.type === 'personal' ? messages.spaces.personal : target.name)
  const label = [spaceName, ...crumbs.map(crumb => crumb.name)].filter(part => part !== '').join(' / ')
  const destination: Destination = { spaceId, folderId: parentId ?? undefined }
  // 移动到它现在待的地方没有意义：说明一句，按钮不可用（服务端照样接受，这里只是别让人白点）
  const unchanged = action === 'move' && destination.spaceId === current.spaceId && destination.folderId === current.folderId

  function enter(folder: TargetCrumb): void {
    setCrumbs([...crumbs, folder])
  }

  function goUp(): void {
    setCrumbs(crumbs.slice(0, -1))
  }

  function changeSpace(value: string): void {
    setSpaceId(value)
    // 换了空间，原来点进去的那串文件夹不属于新空间：回到新空间的根目录
    setCrumbs([])
  }

  return (
    <form
      id={panelId}
      className="flex flex-col gap-3 border-t bg-muted/30 px-4 py-3"
      aria-label={action === 'move' ? text.move : text.copy}
      onSubmit={(event) => {
        event.preventDefault()
        if (!pending && !unchanged)
          onSubmit(destination, label)
      }}
    >
      {spaces.length > 1 && (
        <div className="flex max-w-72 flex-col gap-2">
          <Label htmlFor={spaceSelectId}>{text.targetSpace}</Label>
          <NativeSelect id={spaceSelectId} value={spaceId} onChange={event => changeSpace(event.target.value)}>
            {spaces.map(space => <option key={space.id} value={space.id}>{space.type === 'personal' ? messages.spaces.personal : space.name}</option>)}
          </NativeSelect>
        </div>
      )}
      <p className="text-sm">
        {text.targetLocation}
        ：
        <span className="font-medium">{label}</span>
      </p>
      <div className="flex flex-wrap items-center gap-2">
        {crumbs.length > 0 && <Button type="button" variant="outline" size="sm" onClick={goUp}>{text.upOneLevel}</Button>}
        {children.isPending && (
          <div role="status" aria-label={text.targetLoading}>
            <Skeleton className="h-6 w-32" />
          </div>
        )}
        {!children.isPending && children.data === undefined && (
          <span role="alert" className="text-sm text-destructive">{text.targetLoadFailed(describeError(children.error).message)}</span>
        )}
        {/* 留着之前的子文件夹、刷新却失败了（例如结果未知之后的刷新，Codex 对抗评审 CX5）：明说没能刷新、给出重试 */}
        <RefreshProblem query={children} list={text.targetLocation} className="basis-full" />
        {children.data !== undefined && (choices.length === 0
          ? <span className="text-sm text-muted-foreground">{text.targetEmpty}</span>
          : (
              <ul aria-label={text.targetLocation} className="flex flex-wrap gap-1">
                {choices.map(folder => (
                  <li key={folder.id}>
                    <Button type="button" variant="outline" size="sm" aria-label={text.enterFolder(folder.name)} onClick={() => enter({ id: folder.id, name: folder.name })}>
                      {folder.name}
                    </Button>
                  </li>
                ))}
              </ul>
            ))}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {/* 进行中与不能提交都用 aria-disabled：按钮变成 disabled 时浏览器把焦点丢到 body（M2-P1 审查 B13） */}
        <Button type="submit" size="sm" aria-disabled={pending || unchanged}>
          {pending
            ? (action === 'move' ? text.moving : text.copying)
            : (action === 'move' ? text.moveHere : text.copyHere)}
        </Button>
        <Button type="button" variant="ghost" size="sm" aria-disabled={pending} onClick={() => !pending && onCancel()}>{text.cancel}</Button>
        {unchanged && <span className="text-sm text-muted-foreground">{text.sameLocation}</span>}
      </div>
      {error !== undefined && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
    </form>
  )
}

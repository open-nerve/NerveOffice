import type { SpaceView } from '@nerve-office/contracts'
import type { RefObject } from 'react'
import type { FirstLoadRetry } from '../../shared/lib/use-first-load-retry.ts'
import type { TargetSpaces } from './target-spaces.ts'
import { useQuery } from '@tanstack/react-query'
import { useId, useRef, useState } from 'react'
import { describeError } from '../../shared/api/index.ts'
import { messages } from '../../shared/i18n/index.ts'
import { cn } from '../../shared/lib/cn.ts'
import { useFirstLoadRetry } from '../../shared/lib/use-first-load-retry.ts'
import { Alert, AlertDescription, Button, Label, NativeSelect, RetryButton, Skeleton } from '../../shared/ui/index.ts'
import { RefreshProblem } from '../../shared/ui/refresh-problem.tsx'
import { folderChildrenQueryOptions } from './folders-api.ts'

const text = messages.organize

/** 只能由程序聚焦的元素（tabIndex -1）得到焦点时的样式：键盘操作时看得见焦点在哪里 */
const FOCUS_RING = 'outline-none focus-visible:ring-3 focus-visible:ring-ring/50'

/** 目标位置：要放进哪个空间的哪个文件夹（选到根目录时 folderId 为 undefined，与契约一致） */
export interface Destination {
  readonly spaceId: string
  readonly folderId: string | undefined
}

interface DestinationFormProps {
  /** 展开的面板的 id：与“操作”按钮的 aria-controls 对应 */
  readonly panelId: string
  readonly action: 'move' | 'copy'
  /** 可以选的目标空间，连同取到了没有：调用方按服务端给的权限筛好（能不能跨空间、目标空间能不能新建） */
  readonly targets: TargetSpaces
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

/** 选过的目标空间，连同在它里面点进去的那串文件夹 */
interface TargetChoice {
  readonly spaceId: string
  readonly crumbs: readonly TargetCrumb[]
}

/**
 * 选得到的目标空间：复制只能是候选里的（我能新建的空间）；移动另可以是它现在所在的空间
 * （在同一个空间里移动不依赖候选，候选还没取到时也一样，与原来相同）
 */
function selectable(action: DestinationFormProps['action'], spaces: readonly SpaceView[], current: Destination, spaceId: string): boolean {
  return spaces.some(space => space.id === spaceId) || (action === 'move' && spaceId === current.spaceId)
}

/**
 * 还没选过时的目标空间：它现在所在的空间在候选里就是它，否则是第一个候选。
 * 候选一个也没有（还没取到、取不到、确实没有）时：移动是它现在所在的空间；复制没有目标——只凭单独授权时，
 * 它现在所在的空间是我看不到的源空间，不能去取它的目录，也不能复制到那里（M2 Codex 评审复验的一般 1）。
 * 每次渲染按当时的候选算：候选晚到时随之选上一个有效的默认值
 */
function defaultSpaceOf(action: DestinationFormProps['action'], spaces: readonly SpaceView[], current: Destination): string | undefined {
  if (spaces.some(space => space.id === current.spaceId))
    return current.spaceId
  return spaces[0]?.id ?? (action === 'move' ? current.spaceId : undefined)
}

/**
 * 行内选目标位置（M2-P4 设计 §3.7）：先选空间，再一层层点进文件夹，最后"移动到这里"/"复制到这里"。
 * 目标空间只落在选得到的空间里（selectable）：选过的那个不再选得到时（候选刷新之后没有它了），回到默认的目标空间，
 * 点进去的那串文件夹随之作废（它们属于原来的空间）。复制还没有目标时不取任何目录，按候选的状态说明，"复制到这里"不能提交。
 *
 * 为什么不是弹窗：移动与复制的入口在空间页上，而空间页是平台的首屏页面，首屏不引入 Radix Dialog（ADR-008）。
 * 一次只有一个对象在选目标，所以这个表单由列表渲染在那一行下面，与行内改名同一个形态。
 * 复制的候选没能加载、按了"重试"：重试期间说明与按钮留着（不可用、说正在重试）；取到之后焦点交给"目标位置"这一行（随即选上的默认目标），
 * 一个也没有时交给那句说明，不落到 body（规范 §2.4，shared/lib/use-first-load-retry.ts）
 */
export function DestinationForm({ panelId, action, targets, current, excludeFolderId, pending, error, onSubmit, onCancel }: DestinationFormProps) {
  const spaceSelectId = useId()
  const [choice, setChoice] = useState<TargetChoice>()
  /** 选好的目标位置这一行，或者"没有可以复制到的空间"（同一时刻只有一个，tabIndex -1）：候选没能加载、按"重试"取到之后焦点交给它 */
  const targetRef = useRef<HTMLParagraphElement>(null)
  const candidates = useFirstLoadRetry(targets.request, targetRef)
  const spaces = targets.items ?? []
  const spaceId = choice !== undefined && selectable(action, spaces, current, choice.spaceId) ? choice.spaceId : defaultSpaceOf(action, spaces, current)
  const crumbs = choice !== undefined && choice.spaceId === spaceId ? choice.crumbs : []
  const parentId = crumbs.at(-1)?.id ?? null
  // 没有目标空间（复制的候选还没取到、取不到、一个也没有）时不取目录：键里的空间是占位，不发请求
  const children = useQuery({ ...folderChildrenQueryOptions(spaceId ?? '', parentId), enabled: spaceId !== undefined })
  const choices = (children.data?.items ?? []).filter(folder => folder.id !== excludeFolderId)
  const target = spaces.find(space => space.id === spaceId)
  const spaceName = target === undefined ? '' : (target.type === 'personal' ? messages.spaces.personal : target.name)
  const label = [spaceName, ...crumbs.map(crumb => crumb.name)].filter(part => part !== '').join(' / ')
  const destination: Destination | undefined = spaceId === undefined ? undefined : { spaceId, folderId: parentId ?? undefined }
  // 移动到它现在待的地方没有意义：说明一句，按钮不可用（服务端照样接受，这里只是别让人白点）
  const unchanged = action === 'move' && destination?.spaceId === current.spaceId && destination.folderId === current.folderId
  const blocked = pending || unchanged || destination === undefined

  function enter(folder: TargetCrumb): void {
    if (spaceId !== undefined)
      setChoice({ spaceId, crumbs: [...crumbs, folder] })
  }

  function goUp(): void {
    if (spaceId !== undefined)
      setChoice({ spaceId, crumbs: crumbs.slice(0, -1) })
  }

  function changeSpace(value: string): void {
    // 换了空间，原来点进去的那串文件夹不属于新空间：回到新空间的根目录
    setChoice({ spaceId: value, crumbs: [] })
  }

  return (
    <form
      id={panelId}
      className="flex flex-col gap-3 border-t bg-muted/30 px-4 py-3"
      aria-label={action === 'move' ? text.move : text.copy}
      onSubmit={(event) => {
        event.preventDefault()
        if (!blocked)
          onSubmit(destination, label)
      }}
    >
      {spaces.length > 1 && spaceId !== undefined && (
        <div className="flex max-w-72 flex-col gap-2">
          <Label htmlFor={spaceSelectId}>{text.targetSpace}</Label>
          <NativeSelect id={spaceSelectId} value={spaceId} onChange={event => changeSpace(event.target.value)}>
            {spaces.map(space => <option key={space.id} value={space.id}>{space.type === 'personal' ? messages.spaces.personal : space.name}</option>)}
          </NativeSelect>
        </div>
      )}
      {spaceId === undefined
        ? <TargetSpacesState targets={targets} failure={candidates} noneRef={targetRef} />
        : (
            <>
              <p ref={targetRef} tabIndex={-1} className={cn('text-sm', FOCUS_RING)}>
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
            </>
          )}
      <div className="flex flex-wrap items-center gap-2">
        {/* 进行中与不能提交都用 aria-disabled：按钮变成 disabled 时浏览器把焦点丢到 body（M2-P1 审查 B13） */}
        <Button type="submit" size="sm" aria-disabled={blocked}>
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

/**
 * 复制还没有目标空间时，候选的状态（M2 Codex 评审复验的一般 1）：还没取到——加载中（读屏读得到）；
 * 取不到——说明原因、给出重试（重新请求导航的空间列表，取到之后随即选上默认的目标空间）；取到了却一个也没有——说清楚（noneRef）。
 * 按了"重试"之后说明与按钮留着（failure.retrying），不换成加载中
 */
function TargetSpacesState({ targets, failure, noneRef }: { readonly targets: TargetSpaces, readonly failure: FirstLoadRetry, readonly noneRef: RefObject<HTMLParagraphElement | null> }) {
  if (failure.failed) {
    return (
      <div role="alert" className="flex flex-wrap items-center gap-2" onFocus={failure.focus.onFocus} onBlur={failure.focus.onBlur}>
        <span className="text-sm text-destructive">{text.targetSpacesLoadFailed(failure.retrying ? undefined : describeError(targets.error).message)}</span>
        <RetryButton retrying={failure.retrying} onRetry={targets.retry} />
      </div>
    )
  }
  if (targets.items !== undefined)
    return <p ref={noneRef} tabIndex={-1} className={cn('text-sm text-muted-foreground', FOCUS_RING)}>{text.noTargetSpaces}</p>
  return (
    <div role="status" aria-label={text.targetSpacesLoading}>
      <Skeleton className="h-6 w-32" />
    </div>
  )
}

import type { DocumentGrant, GrantRole, UserSummary } from '@nerve-office/contracts'
import type { ReactNode, RefObject } from 'react'
import type { PendingConfirmation } from '../confirmation/index.ts'
import { GRANT_ROLES } from '@nerve-office/contracts'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useEffectEvent, useId, useMemo, useRef, useState } from 'react'
import { describeError, isAccessDenied, isNotFoundError, isUnknownOutcome } from '../../shared/api/index.ts'
import { SHARED_LIST_QUERY_KEY } from '../../shared/api/shared-list-key.ts'
import { writeFailureText } from '../../shared/api/write-outcome.ts'
import { messages } from '../../shared/i18n/index.ts'
import { sharingMessages } from '../../shared/i18n/zh-cn/sharing.ts'
import { formatDateTime } from '../../shared/lib/format.ts'
import { refreshQueries } from '../../shared/lib/refresh-queries.ts'
import { useOutcomeRefresh } from '../../shared/lib/use-outcome-refresh.ts'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../../shared/ui/dialog.tsx'
import { Alert, AlertDescription, Badge, Button, Label, NativeSelect, PersonName, Phrase, Skeleton } from '../../shared/ui/index.ts'
import { StatusRegion } from '../../shared/ui/status-region.tsx'
import { ColleaguePicker } from '../colleagues/index.ts'
import { ConfirmDialog } from '../confirmation/index.ts'
import { grantsQueryKey, grantsQueryOptions, revokeGrant, setGrant } from './sharing-api.ts'

const text = sharingMessages

/** 角色的选项：从高到低（编辑者、查看者） */
const ROLE_OPTIONS = [...GRANT_ROLES].reverse()

/**
 * 写操作之后的刷新（M2-P5 设计 §3.5）。被拒绝与结果未知之后走共用的做法（shared/api/write-outcome.ts，经 useOutcomeRefresh 在时限之内等它）。
 */
interface ShareRefresh {
  /**
   * 成功之后：授权列表（取消时连同"与我共享"：取消的可能是分享给我自己的那一条）。刷新失败时列表自己显示加载失败，不算这次操作失败
   */
  readonly afterSuccess: (withShared: boolean) => Promise<void>
  /**
   * 结果未知与被拒绝之后：授权列表、文档详情与"与我共享"都刷新——文档详情决定入口还在不在（例如空间刚被归档、自己刚被移出）。
   * 说明里"刷新好了没有"只看授权列表，它没能刷新就拒绝；文档详情与"与我共享"照常刷新，不计入、不等：被拒绝时再取文档详情正是 404
   * 或 403，那是拒绝之后的样子，不是"没能刷新"（与整理的做法相同，M2-P6 复核第五批 S-1）
   */
  readonly afterFailure: () => Promise<void>
}

function useShareRefresh(documentId: string, refreshDocument: () => void): ShareRefresh {
  const queryClient = useQueryClient()
  return useMemo(() => ({
    afterSuccess: async (withShared) => {
      await refreshQueries(queryClient, [grantsQueryKey(documentId), ...(withShared ? [SHARED_LIST_QUERY_KEY] : [])], { throwOnError: false })
    },
    afterFailure: async () => {
      refreshDocument()
      void refreshQueries(queryClient, [SHARED_LIST_QUERY_KEY], { throwOnError: false })
      await refreshQueries(queryClient, [grantsQueryKey(documentId)])
    },
  }), [queryClient, documentId, refreshDocument])
}

/**
 * 写操作失败的说明：看不到这份文档了（404，已经删除或者自己被移出了空间）说文档已经不在了；403 用服务端说的原因
 * （例如"空间已归档，恢复之后才能调整分享"，规范 §2.4）；结果未知按共用的说法（可能已经生效，授权列表刷新好了没有）；其余按错误码
 */
function failureText(error: unknown, refreshed: boolean): string {
  return isNotFoundError(error) ? text.gone : writeFailureText(error, refreshed)
}

interface AddGrantFormProps {
  readonly documentId: string
  /** 不作为候选的人：自己（不能分享给自己）与已经有授权的人 */
  readonly exclude: ReadonlySet<string>
  readonly refresh: ShareRefresh
  readonly onAdded: (grant: DocumentGrant) => void
}

/**
 * 分享给一位同事：按名字选人（同事选择，候选与已选都用人名组件）、选角色。成功之后选择清掉（同事选择整个重新开始）。
 * 结果未知与被拒绝时按共用的做法刷新（授权列表、文档详情与"与我共享"）再说明：结果未知时这个人可能已经在列表里了，
 * 再点也只会得到同样的结果（按状态幂等）
 */
function AddGrantForm({ documentId, exclude, refresh, onAdded }: AddGrantFormProps) {
  const [user, setUser] = useState<UserSummary>()
  const [role, setRole] = useState<GrantRole>('viewer')
  // 分享成功之后换一个 key，同事选择整个重新开始：关键词与上一次的候选都清掉
  const [pickerKey, setPickerKey] = useState(0)
  const { refreshed, refreshAfterFailure } = useOutcomeRefresh()
  const roleId = useId()
  const hintId = useId()
  const mutation = useMutation({
    mutationFn: async (target: { readonly user: UserSummary, readonly role: GrantRole }) => setGrant(documentId, target.user.id, target.role),
    onSuccess: async (grant) => {
      setUser(undefined)
      setPickerKey(key => key + 1)
      onAdded(grant)
      await refresh.afterSuccess(false)
    },
    onError: async (error) => {
      await refreshAfterFailure(error, refresh.afterFailure, { also: isAccessDenied })
    },
  })

  return (
    <form
      className="flex flex-wrap items-end gap-3"
      onSubmit={(event) => {
        event.preventDefault()
        if (user !== undefined && !mutation.isPending)
          mutation.mutate({ user, role })
      }}
    >
      <div className="min-w-48 flex-1">
        <ColleaguePicker key={pickerKey} label={text.colleague} selected={user} onSelect={setUser} exclude={exclude} />
      </div>
      <div className="flex w-28 flex-col gap-2">
        <Label htmlFor={roleId}>{text.role}</Label>
        <NativeSelect id={roleId} value={role} onChange={event => setRole(event.target.value as GrantRole)}>
          {ROLE_OPTIONS.map(value => <option key={value} value={value}>{text.roleName(value)}</option>)}
        </NativeSelect>
      </div>
      {/* 还不能提交时说明原因：aria-disabled 的按钮读屏软件读出"不可用"，却不知道为什么 */}
      <Button type="submit" aria-disabled={user === undefined || mutation.isPending} aria-describedby={user === undefined ? hintId : undefined}>
        {mutation.isPending ? text.adding : text.add}
      </Button>
      {user === undefined && <p id={hintId} className="m-0 basis-full text-sm text-muted-foreground">{text.pickColleague}</p>}
      {mutation.isError && (
        <Alert variant="destructive" className="basis-full">
          <AlertDescription>{failureText(mutation.error, refreshed)}</AlertDescription>
        </Alert>
      )}
    </form>
  )
}

interface GrantRowProps {
  readonly documentId: string
  readonly grant: DocumentGrant
  /** 分享给我自己的那一条（别的空间管理员分享的）：不能调整（PUT 给自己是 400），只能取消 */
  readonly self: boolean
  readonly refresh: ShareRefresh
  readonly onRevoke: () => void
}

/**
 * 授权列表的一行：被授权人（人名组件；停用的标出来）、最后设置它的人与时间、角色、取消。
 * 调整与成员页的角色同一个做法：选择框只是选，点了"保存"才提交（收起的选择框上按方向键会逐个改值）；保存之后立即显示目标角色，
 * 进行中这一行标为忙碌；成功时先用响应替换缓存里的这一行再刷新。失败时恢复原来的角色，原因就在这一行说明：
 * 结果未知与被拒绝时按共用的做法刷新（授权列表、文档详情与"与我共享"）再说明。
 * 角色不能调整、只能取消的两种：分享给我自己的（PUT 给自己是 400）、被授权人已停用的（服务端对停用的人调整一律 409，
 * M2-P5 设计 §3.2；授权保留，取消照样可以，M2-P5 审查 B 的 S3）——不给一个注定失败的操作
 */
function GrantRow({ documentId, grant, self, refresh, onRevoke }: GrantRowProps) {
  const queryClient = useQueryClient()
  const noteId = useId()
  const unsavedId = useId()
  const selectRef = useRef<HTMLSelectElement>(null)
  /** 选了、还没保存的角色 */
  const [chosen, setChosen] = useState<GrantRole>()
  /** 正在保存的角色 */
  const [saving, setSaving] = useState<GrantRole>()
  const { refreshed, refreshAfterFailure } = useOutcomeRefresh()
  const change = useMutation({
    mutationFn: async (role: GrantRole) => setGrant(documentId, grant.user.id, role),
    onSuccess: (saved) => {
      queryClient.setQueryData(grantsQueryOptions(documentId).queryKey, list => list === undefined
        ? undefined
        : { ...list, items: list.items.map(item => (item.user.id === saved.user.id ? saved : item)) })
    },
    onSettled: async (_saved, error) => {
      if (error !== null && (isUnknownOutcome(error) || isAccessDenied(error)))
        await refreshAfterFailure(error, refresh.afterFailure, { also: isAccessDenied })
      else
        await refresh.afterSuccess(false)
      setSaving(undefined)
    },
  })
  // 纯文字里的人名（选择框与按钮的可读名称）：登录名在前、显示名隔离（规范 §2.4）
  const name = messages.people.text(grant.user)
  const disabled = grant.status === 'disabled'
  /** 只能取消、不能调整角色的一行：分享给我自己的、被授权人已停用的 */
  const revokeOnly = self || disabled
  const busy = saving !== undefined
  const pending = chosen !== undefined && chosen !== grant.role ? chosen : undefined
  const unsaved = pending !== undefined && !busy
  const describedBy = [unsaved ? unsavedId : undefined, busy || change.isError ? noteId : undefined].filter(id => id !== undefined).join(' ')

  function choose(role: GrantRole): void {
    if (!busy)
      setChosen(role)
  }

  function save(): void {
    if (busy || pending === undefined)
      return
    // "保存"随之收起：焦点先回到这一行的选择框
    selectRef.current?.focus()
    setChosen(undefined)
    setSaving(pending)
    change.mutate(pending)
  }

  return (
    <li className="flex flex-col gap-1.5 py-3" aria-busy={busy}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">
          <PersonName person={grant.user} />
          {self && text.you}
        </span>
        {disabled && <Badge variant="destructive">{text.disabled}</Badge>}
      </div>
      <p className="m-0 text-xs text-muted-foreground">
        <Phrase parts={text.grantedBy(<PersonName person={grant.grantedBy} />, formatDateTime(grant.grantedAt))} />
      </p>
      <div className="flex flex-wrap items-center gap-2">
        {revokeOnly
          ? <span className="text-sm">{text.roleName(grant.role)}</span>
          : (
              <>
                <NativeSelect ref={selectRef} className="w-28" aria-label={text.roleOf(name)} aria-describedby={describedBy === '' ? undefined : describedBy} value={saving ?? pending ?? grant.role} onChange={event => choose(event.target.value as GrantRole)}>
                  {ROLE_OPTIONS.map(value => <option key={value} value={value}>{text.roleName(value)}</option>)}
                </NativeSelect>
                {unsaved && <Button type="button" variant="outline" size="sm" aria-label={text.saveRoleOf(name)} onClick={save}>{text.saveRole}</Button>}
              </>
            )}
        <Button type="button" variant="ghost" size="sm" aria-label={messages.common.actionOn(text.revoke, name)} onClick={onRevoke}>{text.revoke}</Button>
      </div>
      {self && <span className="text-xs text-muted-foreground">{text.ownGrant}</span>}
      {!self && disabled && <span className="text-xs text-muted-foreground">{text.disabledGrant}</span>}
      {unsaved && <span id={unsavedId} className="text-xs text-muted-foreground">{text.unsaved}</span>}
      {busy && <span id={noteId} className="text-xs text-muted-foreground">{text.saving}</span>}
      {!busy && change.isError && <span id={noteId} role="alert" className="text-xs text-destructive">{failureText(change.error, refreshed)}</span>}
    </li>
  )
}

interface GrantsProps {
  readonly documentId: string
  readonly grants: readonly DocumentGrant[]
  readonly currentUserId: string
  readonly refresh: ShareRefresh
  readonly headingRef: RefObject<HTMLHeadingElement | null>
  readonly onRevoke: (grant: DocumentGrant) => void
}

/** 已分享给的人：没有时说明还没有分享给任何人 */
function Grants({ documentId, grants, currentUserId, refresh, headingRef, onRevoke }: GrantsProps) {
  const headingId = useId()
  return (
    <section className="flex flex-col gap-1" aria-labelledby={headingId}>
      {/* tabIndex -1：只能由程序聚焦（取消分享之后那一行不在了，确认的弹窗关闭时焦点交给它），Tab 键不经过它 */}
      <h3 ref={headingRef} id={headingId} tabIndex={-1} className="m-0 text-sm font-medium outline-none focus-visible:ring-3 focus-visible:ring-ring/50">{text.listHeading}</h3>
      {grants.length === 0
        ? <p className="m-0 text-sm text-muted-foreground">{text.empty}</p>
        : (
            <ul aria-labelledby={headingId} className="m-0 list-none divide-y p-0">
              {grants.map(grant => (
                <GrantRow
                  key={grant.user.id}
                  documentId={documentId}
                  grant={grant}
                  self={grant.user.id === currentUserId}
                  refresh={refresh}
                  onRevoke={() => onRevoke(grant)}
                />
              ))}
            </ul>
          )}
    </section>
  )
}

export interface ShareDialogProps {
  readonly documentId: string
  /** 文档的标题：对话框的标题里用 */
  readonly documentTitle: string
  /** 看这个对话框的人：同事选择里排除自己（不能分享给自己），分享给自己的那一条只能取消 */
  readonly currentUserId: string
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
  /**
   * 重新取文档详情（分享的权限 canShare 等）：写操作结果未知或被拒绝、打开时授权列表就被拒绝，都与授权列表、"与我共享"一起刷新。
   * 平台页面是请求缓存里的文档详情，编辑器页是页面自己载入的那一份；入口随新的权限消失（例如空间刚被归档、自己刚被移出）。
   * 不计入"刷新好了没有"、不等它，自己接住失败
   */
  readonly refreshDocument: () => void
  /**
   * 打开它的入口：关闭之后焦点回到这里。打开之前有焦点的元素不是它时（WebKit 点按钮不移焦点，打开时记不下）同样回到它
   */
  readonly entry: RefObject<HTMLElement | null>
  /** 关闭之后入口已经不在了（随新的权限消失）时焦点交给谁 */
  readonly fallbackFocus: () => void
}

/** 关闭之后焦点回到入口；入口已经不在了交给 fallback */
function focusEntry(entry: RefObject<HTMLElement | null>, fallback: () => void): void {
  if (entry.current?.isConnected === true)
    entry.current.focus()
  else
    fallback()
}

/** 对话框打开时的内容：每次打开都重新开始（授权列表重新请求，选择与说明清掉） */
function ShareDialogContent({ documentId, documentTitle, currentUserId, refreshDocument, entry, fallbackFocus }: Omit<ShareDialogProps, 'open' | 'onOpenChange'>) {
  const grants = useQuery(grantsQueryOptions(documentId))
  const refresh = useShareRefresh(documentId, refreshDocument)
  const [pending, setPending] = useState<PendingConfirmation>()
  /** 做完一件事的说明（已分享给谁、已取消分享给谁）：放在一直在的状态容器里，读屏读得到 */
  const [notice, setNotice] = useState<ReactNode>()
  const headingRef = useRef<HTMLHeadingElement>(null)
  // 先看错误、再看数据：重新请求被拒绝时 TanStack Query 保留上一次的数据，不能还显示能操作的列表（与空间页同一个做法）
  const denied = isAccessDenied(grants.error) ? grants.error : undefined
  // 授权列表被拒绝（打开时就是，或者写操作之后重新请求时）：入口所依据的文档详情已经过时，刷新它，入口随之消失
  const reportDenied = useEffectEvent(() => refreshDocument())
  useEffect(() => {
    if (denied !== undefined)
      reportDenied()
  }, [denied])

  function confirmRevoke(grant: DocumentGrant): void {
    const self = grant.user.id === currentUserId
    setNotice(undefined)
    setPending({
      title: self ? text.confirmRevokeSelf : text.confirmRevoke(messages.people.text(grant.user)),
      description: self ? text.revokeSelfDescription : text.revokeDescription,
      confirmLabel: text.revoke,
      destructive: true,
      run: async () => {
        await revokeGrant(documentId, grant.user.id)
        await refresh.afterSuccess(true)
        // 说明交给确认框，等它关掉、对话框不再被标为 aria-hidden、焦点交还之后才写进状态区：确认框开着时写进去的读屏多半不播报（M2-P5 复验 S1）
        return () => setNotice(<Phrase parts={text.revoked(<PersonName person={grant.user} />)} />)
      },
      // 结果未知与被拒绝之后：授权列表、文档详情与"与我共享"一起刷新（共用的做法），说明按刷新的结果给
      refresh: refresh.afterFailure,
      refreshAfter: isAccessDenied,
      describeFailure: failureText,
      // 取消之后那一行不在了：焦点交给"已分享给"
      returnFocus: () => headingRef.current?.focus(),
    })
  }

  let body: ReactNode
  if (grants.isPending) {
    body = (
      <div role="status" aria-label={text.loading} className="flex flex-col gap-2">
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-8 w-full" />
      </div>
    )
  }
  else if (denied !== undefined) {
    // 看不到这份文档了（404），或者不能分享（403：服务端说明原因，例如空间已归档、已经不是空间管理员）：不给重试
    body = (
      <Alert>
        <AlertDescription>{isNotFoundError(denied) ? text.gone : describeError(denied).message}</AlertDescription>
      </Alert>
    )
  }
  else if (grants.data === undefined) {
    body = (
      <Alert variant="destructive">
        <AlertDescription>
          <p>{text.loadFailed}</p>
          <p>{describeError(grants.error).message}</p>
          <Button type="button" variant="outline" size="sm" className="mt-2" onClick={() => void grants.refetch()}>{messages.common.retry}</Button>
        </AlertDescription>
      </Alert>
    )
  }
  else {
    const exclude = new Set([currentUserId, ...grants.data.map(grant => grant.user.id)])
    body = (
      <>
        <AddGrantForm documentId={documentId} exclude={exclude} refresh={refresh} onAdded={grant => setNotice(<Phrase parts={text.added(<PersonName person={grant.user} />, text.roleName(grant.role))} />)} />
        <Grants documentId={documentId} grants={grants.data} currentUserId={currentUserId} refresh={refresh} headingRef={headingRef} onRevoke={confirmRevoke} />
      </>
    )
  }

  return (
    <DialogContent fallbackFocus={() => focusEntry(entry, fallbackFocus)} className="max-h-[calc(100svh-2rem)] overflow-y-auto sm:max-w-xl">
      <DialogHeader>
        <DialogTitle>{text.title(documentTitle)}</DialogTitle>
        <DialogDescription>{text.description}</DialogDescription>
      </DialogHeader>
      {/* 做完一件事的说明：状态区一直在无障碍树里（空的时候只做视觉隐藏、不占位置），内容变化时往里填，读屏软件才会播报 */}
      <StatusRegion className="m-0 rounded-lg border p-2 text-sm">{notice}</StatusRegion>
      {body}
      <ConfirmDialog pending={pending} onClose={() => setPending(undefined)} />
    </DialogContent>
  )
}

/**
 * 分享对话框（M2-P5 设计 §3.5，US-M2-10）：这份文档的授权列表（人名组件）、按名字选同事加人（排除自己与已有授权的人）、选角色、
 * 调整、取消（确认的弹窗）。只有能分享的人看得到入口（canShare：空间管理员或个人空间的所有者，归档的空间里没有）；
 * 服务端逐请求检查，被拒绝时说明原因、按共用的做法刷新。打开时焦点进对话框，关闭之后回到入口（入口不在了交给 fallbackFocus）。
 * 入口在平台页面文档的行操作（按需加载，不进平台页面的首屏）与编辑器页的页头（静态引用，理由见 features/sheet-editor/share-entry.tsx）：
 * 带着 Radix Dialog、同事选择与确认的弹窗
 */
export function ShareDialog({ open, onOpenChange, ...content }: ShareDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open && <ShareDialogContent {...content} />}
    </Dialog>
  )
}

import type { CreateInvitationRequest, Invitation, InvitationStatus, IssuedInvitation } from '@nerve-office/contracts'
import type { SyntheticEvent } from 'react'
import type { PendingConfirmation } from '../confirmation/index.ts'
import type { IssuedLink } from './issued-link-dialog.tsx'
import type { PagedTableHandle } from './paged-table.tsx'
import { createInvitationRequestSchema, INVITATION_LIFETIME_DAYS, INVITATION_STATUSES } from '@nerve-office/contracts'
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useId, useRef, useState } from 'react'
import { ApiError, describeError, isUnknownOutcome } from '../../shared/api/index.ts'
import { messages } from '../../shared/i18n/index.ts'
import { formatDateTime } from '../../shared/lib/format.ts'
import { Alert, AlertDescription, Badge, Button, Input, Label, NativeSelect, TableCell } from '../../shared/ui/index.ts'
import { SYSTEM_ADMIN_ONLY } from '../auth/index.ts'
import { ConfirmDialog } from '../confirmation/index.ts'
import { ADMIN_QUERY_KEY, createInvitation, invitationsQueryOptions, reissueInvitation, revokeInvitation } from './admin-api.ts'
import { IssuedLinkDialog } from './issued-link-dialog.tsx'
import { PagedTable } from './paged-table.tsx'

const text = messages.admin.invitations

const STATUS_VARIANTS: Record<InvitationStatus, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  pending: 'default',
  accepted: 'secondary',
  expired: 'outline',
  revoked: 'destructive',
}

function linkOf(issued: IssuedInvitation, returnFocus: () => void): IssuedLink {
  return { title: messages.admin.link.invitationTitle, recipient: `${issued.invitation.displayName}（${issued.invitation.username}）`, url: issued.url, expiresAt: issued.invitation.expiresAt, returnFocus }
}

/**
 * 签发失败时的说明（M2-P6 复核 G-2）：结果未知时邀请可能已经建好，链接却丢了（只在签发的响应里出现一次），引导去列表里重新生成；
 * 结果未知之后对同一个登录名再签发得到"已被占用"，多半就是刚才那一次，同样引导去重新生成；其余按错误码。
 */
function issueFailureText(error: unknown, request: CreateInvitationRequest | undefined, unsureFor: string | undefined): string {
  if (isUnknownOutcome(error))
    return text.issueOutcomeUnknown(describeError(error).message)
  if (error instanceof ApiError && error.code === 'USERNAME_TAKEN' && unsureFor !== undefined && request?.username === unsureFor)
    return text.issueRetryTaken
  return describeError(error).message
}

/**
 * 管理界面：邀请（M2-P1 设计 §3.8，US-M2-01）。管理员填好登录名与显示名，生成一次性链接（只显示这一次）；
 * 列表按签发时间从新到旧，可按状态过滤；待接受或已过期的可以作废。同一个登录名只对最新的一条（没有接受、后来也没有再签发过）
 * 给出重新生成，原来的随即作废（审查 B6）。
 * 签发的结果未知时（网络中断、服务端出错）刷新列表、保留输入，引导去列表里重新生成（M2-P6 复核 G-2）。
 */
export function AdminInvitationsPage() {
  const queryClient = useQueryClient()
  const [status, setStatus] = useState<InvitationStatus | ''>('')
  const invitations = useInfiniteQuery(invitationsQueryOptions({ status: status === '' ? undefined : status }))
  const [username, setUsername] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [problem, setProblem] = useState<string>()
  const [pending, setPending] = useState<PendingConfirmation>()
  const [issued, setIssued] = useState<IssuedLink>()
  /** 结果未知的那一次签发的登录名：邀请可能已经建好了。成功签发之后清掉 */
  const [unsureFor, setUnsureFor] = useState<string>()
  const usernameRef = useRef<HTMLInputElement>(null)
  const statusRef = useRef<HTMLSelectElement>(null)
  const tableRef = useRef<PagedTableHandle>(null)
  const usernameId = useId()
  const displayNameId = useId()
  const statusId = useId()

  async function refresh(): Promise<void> {
    await queryClient.invalidateQueries({ queryKey: [...ADMIN_QUERY_KEY, 'invitations'] })
  }

  /** 焦点回到这条邀请的那一行；这一行不在表里（例如按状态过滤掉了）时回到状态的筛选（审查 B9） */
  function focusRow(id: string): void {
    if (!(tableRef.current?.focusRow(id) ?? false))
      statusRef.current?.focus()
  }

  const creation = useMutation({
    mutationFn: createInvitation,
    meta: SYSTEM_ADMIN_ONLY,
    onSuccess: async (result) => {
      setUsername('')
      setDisplayName('')
      setUnsureFor(undefined)
      // 清空之后提交按钮变成 disabled：焦点先进链接的弹窗，关闭之后回到登录名，接着签发下一个（审查 B9）
      setIssued(linkOf(result, () => usernameRef.current?.focus()))
      await refresh()
    },
    // 结果未知：邀请可能已经建好，刷新列表让它出现；输入留着，列表里没有时可以再生成一次
    onError: async (error, request) => {
      if (!isUnknownOutcome(error))
        return
      setUnsureFor(request.username)
      await refresh()
    },
  })

  function submit(event: SyntheticEvent<HTMLFormElement>): void {
    event.preventDefault()
    if (creation.isPending)
      return
    // 与服务端同一套规则（登录名的规范写法、显示名的长度），先在前端说清楚
    const parsed = createInvitationRequestSchema.safeParse({ username, displayName })
    setProblem(parsed.success ? undefined : parsed.error.issues[0]?.message)
    if (parsed.success)
      creation.mutate(parsed.data)
  }

  function actionsOf(invitation: Invitation) {
    const open = invitation.status === 'pending' || invitation.status === 'expired'
    const reissuable = invitation.status !== 'accepted' && !invitation.superseded
    return (
      <div className="flex flex-wrap gap-1">
        {open && (
          <Button
            variant="ghost"
            size="sm"
            aria-label={messages.admin.actionOn(text.revoke, invitation.username)}
            onClick={() => setPending({
              title: text.confirmRevoke(invitation.username),
              description: text.revokeDescription,
              confirmLabel: text.revoke,
              destructive: true,
              run: async () => {
                await revokeInvitation(invitation.id)
                await refresh()
              },
              // 作废之后这一行没有"作废"了
              returnFocus: () => focusRow(invitation.id),
            })}
          >
            {text.revoke}
          </Button>
        )}
        {reissuable && (
          <Button
            variant="ghost"
            size="sm"
            aria-label={messages.admin.actionOn(text.reissue, invitation.username)}
            onClick={() => setPending({
              title: text.confirmReissue(invitation.username),
              description: text.reissueDescription,
              confirmLabel: text.reissue,
              run: async () => {
                const result = await reissueInvitation(invitation.id)
                await refresh()
                // 列表刷新之后，确认的弹窗关掉的同时弹出链接：任何时刻只有一个弹窗（审查 B7）；关闭链接之后焦点到新的那一行
                setPending(undefined)
                setIssued(linkOf(result, () => focusRow(result.invitation.id)))
              },
              returnFocus: () => focusRow(invitation.id),
            })}
          >
            {text.reissue}
          </Button>
        )}
      </div>
    )
  }

  const error = problem ?? (creation.isError ? issueFailureText(creation.error, creation.variables, unsureFor) : undefined)
  return (
    <div className="flex flex-col gap-6">
      <form className="flex flex-col gap-3 rounded-lg border p-4" onSubmit={submit} noValidate aria-label={text.issue}>
        <p className="text-sm text-muted-foreground">{text.description(INVITATION_LIFETIME_DAYS)}</p>
        {error !== undefined && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex min-w-40 flex-1 flex-col gap-2">
            <Label htmlFor={usernameId}>{text.username}</Label>
            <Input ref={usernameRef} id={usernameId} name="username" autoComplete="off" value={username} onChange={event => setUsername(event.target.value)} />
          </div>
          <div className="flex min-w-40 flex-1 flex-col gap-2">
            <Label htmlFor={displayNameId}>{text.displayName}</Label>
            <Input id={displayNameId} name="display-name" autoComplete="off" value={displayName} onChange={event => setDisplayName(event.target.value)} />
          </div>
          {/* 进行中用 aria-disabled：按钮变成 disabled 时浏览器把焦点丢到 body（M1 审查 B13）；重复提交由 submit 挡住 */}
          <Button type="submit" aria-disabled={creation.isPending} disabled={username.trim() === '' || displayName.trim() === ''}>
            {creation.isPending ? text.issuing : text.issue}
          </Button>
        </div>
      </form>
      <div className="flex w-36 flex-col gap-2">
        <Label htmlFor={statusId}>{text.statusFilter}</Label>
        <NativeSelect ref={statusRef} id={statusId} value={status} onChange={event => setStatus(event.target.value as InvitationStatus | '')}>
          <option value="">{messages.common.all}</option>
          {INVITATION_STATUSES.map(value => <option key={value} value={value}>{text.statusName(value)}</option>)}
        </NativeSelect>
      </div>
      <PagedTable
        ref={tableRef}
        query={invitations}
        label={text.listLabel}
        texts={text}
        columns={[text.columns.username, text.columns.displayName, text.columns.status, text.columns.createdBy, text.columns.createdAt, text.columns.expiresAt, text.columns.actions]}
        rowKey={invitation => invitation.id}
        renderCells={invitation => (
          <>
            <TableCell className="font-medium">{invitation.username}</TableCell>
            <TableCell>{invitation.displayName}</TableCell>
            <TableCell><Badge variant={STATUS_VARIANTS[invitation.status]}>{text.statusName(invitation.status)}</Badge></TableCell>
            <TableCell>{invitation.createdBy.displayName}</TableCell>
            <TableCell className="whitespace-nowrap"><time dateTime={invitation.createdAt}>{formatDateTime(invitation.createdAt)}</time></TableCell>
            <TableCell className="whitespace-nowrap"><time dateTime={invitation.expiresAt}>{formatDateTime(invitation.expiresAt)}</time></TableCell>
            <TableCell>{actionsOf(invitation)}</TableCell>
          </>
        )}
      />
      <ConfirmDialog pending={pending} onClose={() => setPending(undefined)} meta={SYSTEM_ADMIN_ONLY} />
      <IssuedLinkDialog link={issued} onClose={() => setIssued(undefined)} />
    </div>
  )
}

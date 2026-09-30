import type { AdminUser, UserStatus } from '@nerve-office/contracts'
import type { PendingConfirmation } from '../confirmation/index.ts'
import type { IssuedLink } from './issued-link-dialog.tsx'
import type { PagedTableHandle } from './paged-table.tsx'
import { PASSWORD_RESET_LIFETIME_HOURS, USER_STATUSES } from '@nerve-office/contracts'
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query'
import { useId, useRef, useState } from 'react'
import { Link } from 'react-router'
import { messages } from '../../shared/i18n/index.ts'
import { adminUserDocumentsPath } from '../../shared/lib/admin-paths.ts'
import { formatDateTime } from '../../shared/lib/format.ts'
import { useSessionRecheck } from '../../shared/lib/session-recheck.ts'
import { useDebouncedValue } from '../../shared/lib/use-debounced-value.ts'
import { Badge, Button, buttonVariants, Input, Label, NativeSelect, TableCell } from '../../shared/ui/index.ts'
import { sessionQueryOptions, SYSTEM_ADMIN_ONLY } from '../auth/index.ts'
import { ConfirmDialog } from '../confirmation/index.ts'
import { ADMIN_QUERY_KEY, adminUsersQueryOptions, changeSystemRole, disableUser, enableUser, issuePasswordReset, unlockLogin } from './admin-api.ts'
import { IssuedLinkDialog } from './issued-link-dialog.tsx'
import { PagedTable } from './paged-table.tsx'

const text = messages.admin.users

function nameOf(user: AdminUser): string {
  return `${user.displayName}（${user.username}）`
}

/** 登录锁定的说明（M2-P6 复核 A1）：全部来源都锁了，还是只锁了某些来源（本人从别处照常登录） */
function loginLockText(lock: NonNullable<AdminUser['loginLock']>): string {
  const until = formatDateTime(lock.until)
  return lock.allSources ? text.loginLocked(until) : text.loginLockedSomeSources(until)
}

/** 弹出的重置链接；给自己生成的，关闭之后重新确认会话（本人的登录已经退出） */
interface IssuedReset {
  readonly link: IssuedLink
  readonly own: boolean
}

/**
 * 管理界面：账户（M2-P1 设计 §3.8，US-M2-03、04）。搜索与状态过滤；停用与启用、设为或取消系统管理员、生成重置链接，
 * 登录被锁定的账户显示锁到什么时候、可以解除（M2-P6 复核 A1）；
 * 每个操作先确认后果；失败按错误码说明（例如至少要保留一个有效的系统管理员）。
 * 操作的是自己的账户时另给说明，成功之后重新确认会话（审查 B4）：取消了自己的系统管理员就切到无权限，停用了自己就整页离开；
 * 给自己生成的重置链接要先交到本人手里，关闭链接的弹窗之后再确认。
 */
export function AdminUsersPage() {
  const queryClient = useQueryClient()
  const recheckSession = useSessionRecheck()
  const session = useQuery(sessionQueryOptions())
  const [keyword, setKeyword] = useState('')
  const [status, setStatus] = useState<UserStatus | ''>('')
  const query = useDebouncedValue(keyword.trim())
  const users = useInfiniteQuery(adminUsersQueryOptions({ query: query === '' ? undefined : query, status: status === '' ? undefined : status }))
  const [pending, setPending] = useState<PendingConfirmation>()
  const [issued, setIssued] = useState<IssuedReset>()
  const tableRef = useRef<PagedTableHandle>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const searchId = useId()
  const statusId = useId()

  async function refresh(): Promise<void> {
    await queryClient.invalidateQueries({ queryKey: [...ADMIN_QUERY_KEY, 'users'] })
  }

  /** 焦点回到这个账户的那一行；这一行已经不在表里（例如按状态过滤掉了）时回到搜索框（审查 B9） */
  function focusRow(user: AdminUser): void {
    if (!(tableRef.current?.focusRow(user.id) ?? false))
      searchRef.current?.focus()
  }

  function confirmThen(user: AdminUser, confirmation: Omit<PendingConfirmation, 'run' | 'returnFocus'>, action: () => Promise<unknown>): void {
    const own = user.id === session.data?.user.id
    setPending({
      ...confirmation,
      run: async () => {
        await action()
        // 改的是自己的账户：先向服务端确认会话，页面随之切到无权限或者整页离开
        if (own)
          await recheckSession()
        await refresh()
      },
      returnFocus: () => focusRow(user),
    })
  }

  function confirmReset(user: AdminUser): void {
    const own = user.id === session.data?.user.id
    const name = nameOf(user)
    setPending({
      title: own ? text.confirmResetOwn : text.confirmReset(name),
      description: own ? text.resetOwnDescription(PASSWORD_RESET_LIFETIME_HOURS) : text.resetDescription(PASSWORD_RESET_LIFETIME_HOURS),
      confirmLabel: text.resetPassword,
      run: async () => {
        const reset = await issuePasswordReset(user.id)
        // 确认的弹窗关掉的同时弹出链接：任何时刻只有一个弹窗（审查 B7）
        setPending(undefined)
        setIssued({
          link: {
            title: messages.admin.link.resetTitle,
            recipient: name,
            url: reset.url,
            expiresAt: reset.expiresAt,
            ...(own ? { note: messages.admin.link.ownResetNote } : {}),
            returnFocus: () => focusRow(user),
          },
          own,
        })
      },
      returnFocus: () => focusRow(user),
    })
  }

  function closeLink(): void {
    setIssued(undefined)
    // 给自己生成的：本人的登录已经退出（服务端撤销了这个人的全部会话），确认会话之后整页回到登录页（审查 A12）
    if (issued?.own === true)
      void recheckSession()
  }

  function actionsOf(user: AdminUser) {
    const name = nameOf(user)
    const own = user.id === session.data?.user.id
    return (
      <div className="flex flex-wrap gap-1">
        {user.status === 'active'
          ? (
              <Button
                variant="ghost"
                size="sm"
                aria-label={messages.admin.actionOn(text.disable, name)}
                onClick={() => confirmThen(user, own
                  ? { title: text.confirmDisableOwn, description: text.disableOwnDescription, confirmLabel: text.disable, destructive: true }
                  : { title: text.confirmDisable(name), description: text.disableDescription, confirmLabel: text.disable, destructive: true }, async () => disableUser(user.id))}
              >
                {text.disable}
              </Button>
            )
          : (
              <Button variant="ghost" size="sm" aria-label={messages.admin.actionOn(text.enable, name)} onClick={() => confirmThen(user, { title: text.confirmEnable(name), description: text.enableDescription, confirmLabel: text.enable }, async () => enableUser(user.id))}>
                {text.enable}
              </Button>
            )}
        {user.systemRole === 'admin'
          ? (
              <Button
                variant="ghost"
                size="sm"
                aria-label={messages.admin.actionOn(text.revokeAdmin, name)}
                onClick={() => confirmThen(user, own
                  ? { title: text.confirmRevokeOwnAdmin, description: text.revokeOwnAdminDescription, confirmLabel: text.revokeAdmin, destructive: true }
                  : { title: text.confirmRevokeAdmin(name), description: text.revokeAdminDescription, confirmLabel: text.revokeAdmin, destructive: true }, async () => changeSystemRole(user.id, 'member'))}
              >
                {text.revokeAdmin}
              </Button>
            )
          : user.status === 'active' && (
            <Button variant="ghost" size="sm" aria-label={messages.admin.actionOn(text.grantAdmin, name)} onClick={() => confirmThen(user, { title: text.confirmGrantAdmin(name), description: text.grantAdminDescription, confirmLabel: text.grantAdmin }, async () => changeSystemRole(user.id, 'admin'))}>
              {text.grantAdmin}
            </Button>
          )}
        {user.status === 'active' && (
          <Button variant="ghost" size="sm" aria-label={messages.admin.actionOn(text.resetPassword, name)} onClick={() => confirmReset(user)}>
            {text.resetPassword}
          </Button>
        )}
        {/* 登录被锁定（M2-P6 复核 A1）：解除之后这一行不再有这个按钮，焦点回到这一行 */}
        {user.loginLock !== null && (
          <Button variant="ghost" size="sm" aria-label={messages.admin.actionOn(text.unlockLogin, name)} onClick={() => confirmThen(user, { title: text.confirmUnlockLogin(name), description: text.unlockLoginDescription, confirmLabel: text.unlockLogin }, async () => unlockLogin(user.id))}>
            {text.unlockLogin}
          </Button>
        )}
        {/* 停用的账户：把个人空间里的文档转移给别人（M2-P2 设计 §3.8） */}
        {user.status === 'disabled' && (
          <Link to={adminUserDocumentsPath(user.id)} aria-label={messages.admin.actionOn(text.transfer, name)} className={buttonVariants({ variant: 'ghost', size: 'sm' })}>
            {text.transfer}
          </Link>
        )}
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex min-w-48 flex-1 flex-col gap-2">
          <Label htmlFor={searchId}>{text.search}</Label>
          <Input ref={searchRef} id={searchId} type="search" value={keyword} onChange={event => setKeyword(event.target.value)} />
        </div>
        <div className="flex w-36 flex-col gap-2">
          <Label htmlFor={statusId}>{text.statusFilter}</Label>
          <NativeSelect id={statusId} value={status} onChange={event => setStatus(event.target.value as UserStatus | '')}>
            <option value="">{messages.common.all}</option>
            {USER_STATUSES.map(value => <option key={value} value={value}>{messages.admin.statusName(value)}</option>)}
          </NativeSelect>
        </div>
      </div>
      <PagedTable
        ref={tableRef}
        query={users}
        label={text.listLabel}
        texts={text}
        columns={[text.columns.username, text.columns.displayName, text.columns.role, text.columns.status, text.columns.createdAt, text.columns.actions]}
        rowKey={user => user.id}
        renderCells={user => (
          <>
            <TableCell className="font-medium">{user.username}</TableCell>
            <TableCell>{user.displayName}</TableCell>
            <TableCell><Badge variant={user.systemRole === 'admin' ? 'default' : 'outline'}>{messages.admin.roleName(user.systemRole)}</Badge></TableCell>
            <TableCell>
              <div className="flex flex-col items-start gap-1">
                <Badge variant={user.status === 'active' ? 'secondary' : 'destructive'}>{messages.admin.statusName(user.status)}</Badge>
                {user.loginLock !== null && <span className="text-xs text-destructive">{loginLockText(user.loginLock)}</span>}
              </div>
            </TableCell>
            <TableCell className="whitespace-nowrap"><time dateTime={user.createdAt}>{formatDateTime(user.createdAt)}</time></TableCell>
            <TableCell>{actionsOf(user)}</TableCell>
          </>
        )}
      />
      <ConfirmDialog pending={pending} onClose={() => setPending(undefined)} meta={SYSTEM_ADMIN_ONLY} />
      <IssuedLinkDialog link={issued?.link} onClose={closeLink} />
    </div>
  )
}

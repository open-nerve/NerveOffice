import type { AdminUser, UserStatus } from '@nerve-office/contracts'
import type { PendingConfirmation } from './confirm-dialog.tsx'
import type { IssuedLink } from './issued-link-dialog.tsx'
import { USER_STATUSES } from '@nerve-office/contracts'
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query'
import { useId, useState } from 'react'
import { messages } from '../../shared/i18n/index.ts'
import { formatDateTime } from '../../shared/lib/format.ts'
import { useDebouncedValue } from '../../shared/lib/use-debounced-value.ts'
import { Badge, Button, Input, Label, NativeSelect, TableCell } from '../../shared/ui/index.ts'
import { ADMIN_QUERY_KEY, adminUsersQueryOptions, changeSystemRole, disableUser, enableUser, issuePasswordReset } from './admin-api.ts'
import { ConfirmDialog } from './confirm-dialog.tsx'
import { IssuedLinkDialog } from './issued-link-dialog.tsx'
import { PagedTable } from './paged-table.tsx'

const text = messages.admin.users

function nameOf(user: AdminUser): string {
  return `${user.displayName}（${user.username}）`
}

/**
 * 管理界面：账户（M2-P1 设计 §3.8，US-M2-03、04）。搜索与状态过滤；停用与启用、设为或取消系统管理员、生成重置链接，
 * 每个操作先确认后果；失败按错误码说明（例如至少要保留一个有效的系统管理员）。
 */
export function AdminUsersPage() {
  const queryClient = useQueryClient()
  const [keyword, setKeyword] = useState('')
  const [status, setStatus] = useState<UserStatus | ''>('')
  const query = useDebouncedValue(keyword.trim())
  const users = useInfiniteQuery(adminUsersQueryOptions({ query: query === '' ? undefined : query, status: status === '' ? undefined : status }))
  const [pending, setPending] = useState<PendingConfirmation>()
  const [issued, setIssued] = useState<IssuedLink>()
  const searchId = useId()
  const statusId = useId()

  async function refresh(): Promise<void> {
    await queryClient.invalidateQueries({ queryKey: [...ADMIN_QUERY_KEY, 'users'] })
  }

  function confirmThen(confirmation: Omit<PendingConfirmation, 'run'>, action: () => Promise<unknown>): void {
    setPending({
      ...confirmation,
      run: async () => {
        await action()
        await refresh()
      },
    })
  }

  function actionsOf(user: AdminUser) {
    const name = nameOf(user)
    return (
      <div className="flex flex-wrap gap-1">
        {user.status === 'active'
          ? <Button variant="ghost" size="sm" onClick={() => confirmThen({ title: text.confirmDisable(name), description: text.disableDescription, confirmLabel: text.disable, destructive: true }, async () => disableUser(user.id))}>{text.disable}</Button>
          : <Button variant="ghost" size="sm" onClick={() => confirmThen({ title: text.confirmEnable(name), description: text.enableDescription, confirmLabel: text.enable }, async () => enableUser(user.id))}>{text.enable}</Button>}
        {user.systemRole === 'admin'
          ? <Button variant="ghost" size="sm" onClick={() => confirmThen({ title: text.confirmRevokeAdmin(name), description: text.revokeAdminDescription, confirmLabel: text.revokeAdmin, destructive: true }, async () => changeSystemRole(user.id, 'member'))}>{text.revokeAdmin}</Button>
          : user.status === 'active' && <Button variant="ghost" size="sm" onClick={() => confirmThen({ title: text.confirmGrantAdmin(name), description: text.grantAdminDescription, confirmLabel: text.grantAdmin }, async () => changeSystemRole(user.id, 'admin'))}>{text.grantAdmin}</Button>}
        {user.status === 'active' && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setPending({
              title: text.confirmReset(name),
              description: text.resetDescription,
              confirmLabel: text.resetPassword,
              run: async () => {
                const reset = await issuePasswordReset(user.id)
                setIssued({ title: messages.admin.link.resetTitle, recipient: name, url: reset.url, expiresAt: reset.expiresAt })
              },
            })}
          >
            {text.resetPassword}
          </Button>
        )}
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex min-w-48 flex-1 flex-col gap-2">
          <Label htmlFor={searchId}>{text.search}</Label>
          <Input id={searchId} type="search" value={keyword} onChange={event => setKeyword(event.target.value)} />
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
            <TableCell><Badge variant={user.status === 'active' ? 'secondary' : 'destructive'}>{messages.admin.statusName(user.status)}</Badge></TableCell>
            <TableCell className="whitespace-nowrap"><time dateTime={user.createdAt}>{formatDateTime(user.createdAt)}</time></TableCell>
            <TableCell>{actionsOf(user)}</TableCell>
          </>
        )}
      />
      <ConfirmDialog pending={pending} onClose={() => setPending(undefined)} />
      <IssuedLinkDialog link={issued} onClose={() => setIssued(undefined)} />
    </div>
  )
}

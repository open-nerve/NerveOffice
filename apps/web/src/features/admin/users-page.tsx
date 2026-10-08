import type { AdminUser, UserStatus } from '@nerve-office/contracts'
import type { BackgroundRefresh } from '../../shared/api/write-outcome.ts'
import type { PendingConfirmation } from '../confirmation/index.ts'
import type { IssuedLink } from './issued-link-dialog.tsx'
import type { PagedTableHandle } from './paged-table.tsx'
import { PASSWORD_RESET_LIFETIME_HOURS, USER_STATUSES } from '@nerve-office/contracts'
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query'
import { useId, useRef, useState } from 'react'
import { Link } from 'react-router'
import { describeError, isUnknownOutcome } from '../../shared/api/index.ts'
import { refreshAfterSuccess } from '../../shared/api/write-outcome.ts'
import { messages } from '../../shared/i18n/index.ts'
import { adminMessages } from '../../shared/i18n/zh-cn/admin.ts'
import { adminUserDocumentsPath } from '../../shared/lib/admin-paths.ts'
import { formatDateTime } from '../../shared/lib/format.ts'
import { updatePagedItems } from '../../shared/lib/paged-cache.ts'
import { refreshQueries } from '../../shared/lib/refresh-queries.ts'
import { useSessionRecheck } from '../../shared/lib/session-recheck.ts'
import { useDebouncedValue } from '../../shared/lib/use-debounced-value.ts'
import { useDocumentTitle } from '../../shared/lib/use-document-title.ts'
import { Badge, Button, buttonVariants, Input, Label, NativeSelect, TableCell } from '../../shared/ui/index.ts'
import { StatusRegion } from '../../shared/ui/status-region.tsx'
import { OWN_DISABLE_AFTER_UNKNOWN, OWN_RESET_AFTER_UNKNOWN, sessionQueryOptions, SYSTEM_ADMIN_ONLY } from '../auth/index.ts'
import { ConfirmDialog } from '../confirmation/index.ts'
import { ADMIN_QUERY_KEY, adminUsersQueryOptions, changeSystemRole, disableUser, enableUser, issuePasswordReset, revokeLocalKey, unlockLogin } from './admin-api.ts'
import { IssuedLinkDialog } from './issued-link-dialog.tsx'
import { PagedTable, StillRefreshingLine } from './paged-table.tsx'

const text = adminMessages.users

/** 账户列表（各种搜索与过滤条件下的各页） */
const USERS_QUERY_KEY = [...ADMIN_QUERY_KEY, 'users'] as const

/** 拼进纯文字（按钮的可读名称、确认框的标题）的名字：显示名隔离、登录名另外标出（M2-P6 复核 M2） */
function nameOf(user: AdminUser): string {
  return messages.people.text(user)
}

/** 登录锁定的说明（M2-P6 复核 A1）：全部来源都锁了，还是只锁了某些来源（本人从别处照常登录） */
function loginLockText(lock: NonNullable<AdminUser['loginLock']>): string {
  const until = formatDateTime(lock.until)
  return lock.allSources ? text.loginLocked(until) : text.loginLockedSomeSources(until)
}

/**
 * 吊销本机密钥的确认框里的说明（M3-P6 设计 §3.8）：自己的、停用的、别人的三版（审查 B1）。停用的账户登录都已退出，也生成不了重置链接，
 * 不能照别人的那一版引导"同时生成重置链接"；要提醒的是重新启用之后旧密码照旧可用（ADR-013）。自己的账户总是有效的（停用的登录不了）
 */
function revokeLocalKeyDescription(user: AdminUser, own: boolean): string {
  if (own)
    return text.revokeOwnLocalKeyDescription
  return user.status === 'disabled' ? text.revokeDisabledLocalKeyDescription : text.revokeLocalKeyDescription
}

/**
 * 对自己的操作结果未知之后，确认的弹窗换上的元数据：再试得到"登录已过期"时，登录页说明对应的原因——
 * 为自己生成重置链接（M2-P6 复核 S1）、停用自己（第五批 G1）
 */
const OWN_AFTER_UNKNOWN = { password_reset: OWN_RESET_AFTER_UNKNOWN, account_disabled: OWN_DISABLE_AFTER_UNKNOWN } as const

/** 弹出的重置链接；给自己生成的，关闭之后重新确认会话（本人的登录已经退出） */
interface IssuedReset {
  readonly link: IssuedLink
  readonly own: boolean
}

/**
 * 管理界面：账户（M2-P1 设计 §3.8，US-M2-03、04）。搜索与状态过滤；停用与启用、设为或取消系统管理员、生成重置链接，
 * 登录被锁定的账户显示锁到什么时候、可以解除（M2-P6 复核 A1）；吊销本机密钥（M3-P6 设计 §3.8，US-M3-17），"状态"列显示本机密钥的版本（审查 B2），
 * 吊销的结果另写进页面顶部的状态区；
 * 每个操作先确认后果；失败按错误码说明（例如至少要保留一个有效的系统管理员）。
 * 操作的是自己的账户时另给说明，成功之后重新确认会话（审查 B4）：取消了自己的系统管理员就切到无权限，停用了自己就整页离开；
 * 给自己生成的重置链接要先交到本人手里，关闭链接的弹窗之后再确认。为自己生成重置链接、停用自己的结果未知时，带着原因确认会话
 * （第三批 R-1、第五批 G1）。
 */
export function AdminUsersPage() {
  useDocumentTitle(adminMessages.pageTitle(adminMessages.nav.users))
  const queryClient = useQueryClient()
  const recheckSession = useSessionRecheck()
  const session = useQuery(sessionQueryOptions())
  const [keyword, setKeyword] = useState('')
  const [status, setStatus] = useState<UserStatus | ''>('')
  const query = useDebouncedValue(keyword.trim())
  const users = useInfiniteQuery(adminUsersQueryOptions({ query: query === '' ? undefined : query, status: status === '' ? undefined : status }))
  const [pending, setPending] = useState<PendingConfirmation>()
  const [issued, setIssued] = useState<IssuedReset>()
  /**
   * 为自己生成重置链接（M2-P6 复核 S1）、停用自己（第五批 G1）的结果未知：密码可能已经失效（账户可能已经停用）、会话已经撤销。
   * 确认的弹窗随之换上带原因的元数据（OWN_AFTER_UNKNOWN）：再试得到"登录已过期"时，登录页说明"你的密码可能已经失效"
   * （"你的账户可能已经被停用"），而不是只说登录已过期。弹窗关掉时清掉。
   * 结果未知的那一刻就先按同一个原因确认一次会话（确认的弹窗的 refresh，第三批 R-1）：会话已经撤销的话，不必等再试就回到登录页
   */
  const [ownUnsure, setOwnUnsure] = useState<keyof typeof OWN_AFTER_UNKNOWN>()
  /** 写操作成功之后、到了时限还在后台的刷新（Codex 对抗评审 CX4）：表格上方说列表还在刷新 */
  const [background, setBackground] = useState<BackgroundRefresh>()
  /**
   * 页面顶部状态区里的说明（M3-P6 设计 §3.8）：吊销本机密钥的结果。这一行的本机密钥随之换成新的一版（审查 B2：在列表靠下的一行吊销时，
   * 状态区不在可视区域里，明眼人在这一行看得见；写进说明时这一行不被挤出可视区域，见状态区的 keepFocusInView），这一行的变化读屏不会播报，读屏靠这里的说明。
   * 确认的弹窗关掉之后才写（AfterConfirmed）；打开下一个确认的弹窗时清掉——说明只对刚做完的那一次，同样的说法再出现时照样是一次变化，读屏照样播报
   */
  const [done, setDone] = useState<string>()
  const tableRef = useRef<PagedTableHandle>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const searchId = useId()
  const statusId = useId()

  /**
   * 成功之后刷新账户列表，最多等到时限（Codex 对抗评审 CX4）：一直不回来时操作照常结束，表格上方说列表还在刷新。
   * 刷新失败不算这个操作失败，表格自己说明没能刷新（CX5）
   */
  async function refresh(): Promise<void> {
    setBackground(await refreshAfterSuccess(async () => refreshQueries(queryClient, [USERS_QUERY_KEY])))
  }

  /** 按确定的写入结果先换上这个账户的那一行（CX4）：刷新一直不回来时，这一行也已经是操作之后的样子（打开确认框的按钮随之换掉） */
  function replaceRow(updated: AdminUser): void {
    updatePagedItems<AdminUser>(queryClient, USERS_QUERY_KEY, item => (item.id === updated.id ? updated : item))
  }

  /** 确认的弹窗在结果未知之后的刷新：刷新失败时拒绝，弹窗据此说明页面没能刷新（M2-P6 复核第三批 G-a） */
  async function refreshAfterUnknown(): Promise<void> {
    await refreshQueries(queryClient, [USERS_QUERY_KEY])
  }

  /** 打开确认的弹窗：先清掉状态区里上一次的说明（见 done） */
  function askToConfirm(confirmation: PendingConfirmation): void {
    setDone(undefined)
    setPending(confirmation)
  }

  /** 焦点回到这个账户的那一行；这一行已经不在表里（例如按状态过滤掉了）时回到搜索框（审查 B9） */
  function focusRow(user: AdminUser): void {
    if (!(tableRef.current?.focusRow(user.id) ?? false))
      searchRef.current?.focus()
  }

  /**
   * 停用与启用、改系统角色、解除锁定：先确认，再执行。结果未知时（M2-P6 复核第二批 G-2）确认的弹窗刷新账户列表、说明可能已经生效
   * （这些操作按状态幂等，再试安全）；刷新失败时说明页面没能刷新（第三批 G-a）
   */
  function confirmThen(user: AdminUser, confirmation: Omit<PendingConfirmation, 'run' | 'refresh' | 'returnFocus'>, action: () => Promise<AdminUser>): void {
    const own = user.id === session.data?.user.id
    askToConfirm({
      ...confirmation,
      run: async () => {
        replaceRow(await action())
        // 改的是自己的账户：先向服务端确认会话，页面随之切到无权限或者整页离开
        if (own)
          await recheckSession()
        await refresh()
      },
      refresh: refreshAfterUnknown,
      returnFocus: () => focusRow(user),
    })
  }

  /**
   * 停用（US-M2-04）。停用别人与其他按状态幂等的操作一样（confirmThen）。
   * 停用自己（M2-P6 复核第五批 G1）：生效时服务端随即撤销本人的全部会话。结果未知时不去刷新需要登录的账户列表——已经停用的话
   * 只会得到"登录已过期"、按普通的原因回到登录页，登录页就不说"你的账户可能已经被停用"了——改为带着 account_disabled 的原因
   * 确认会话（与为自己生成重置链接的 R-1 一样）：已经没有会话，按这个原因回到登录页；还在（这一次没有生效），弹窗留着说明，可以再试，
   * 再试得到"登录已过期"时同样按这个原因
   */
  function confirmDisable(user: AdminUser): void {
    const name = nameOf(user)
    if (user.id !== session.data?.user.id) {
      confirmThen(user, { title: text.confirmDisable(name), description: text.disableDescription, confirmLabel: text.disable, destructive: true }, async () => disableUser(user.id))
      return
    }
    askToConfirm({
      title: text.confirmDisableOwn,
      description: text.disableOwnDescription,
      confirmLabel: text.disable,
      destructive: true,
      describeFailure: (error) => {
        const reason = describeError(error).message
        return isUnknownOutcome(error) ? text.disableOwnOutcomeUnknown(reason) : reason
      },
      run: async () => {
        try {
          await disableUser(user.id)
        }
        catch (error) {
          if (isUnknownOutcome(error))
            setOwnUnsure('account_disabled')
          throw error
        }
        // 停用了自己：先向服务端确认会话（已经退出），整页离开（审查 B4）
        await recheckSession()
        await refresh()
      },
      refresh: async () => recheckSession('account_disabled'),
      returnFocus: () => focusRow(user),
    })
  }

  /**
   * 生成重置链接（M2-P6 复核 S1）：结果未知时服务端可能已经让密码失效、撤销了会话，链接却只在响应里出现一次——
   * 弹窗里说明这一点（给自己生成的另说"你的密码可能已经失效"）；再生成一次没有冲突，之前那一条随即作废。
   * 结果未知之后确认的弹窗按 refresh 确认（第二批 G-2）。生成重置链接不改变账户列表显示的任何一项（状态、角色、锁定都不变），
   * 给别人生成时没有要重新请求的。给自己生成时，变了的是本人的会话（M2-P6 复核第三批 R-1）：服务端可能已经撤销了它，这时重新请求
   * 账户列表（或任何需要登录的请求）只会得到"登录已过期"、按普通的原因回到登录页，登录页就不说"你的密码可能已经失效"了。
   * 所以改为带着 password_reset 的原因确认会话：已经没有会话，就按这个原因回到登录页；还在（这一次没有生效），弹窗留着说明，可以再试
   */
  function confirmReset(user: AdminUser): void {
    const own = user.id === session.data?.user.id
    const name = nameOf(user)
    askToConfirm({
      title: own ? text.confirmResetOwn : text.confirmReset(name),
      description: own ? text.resetOwnDescription(PASSWORD_RESET_LIFETIME_HOURS) : text.resetDescription(PASSWORD_RESET_LIFETIME_HOURS),
      confirmLabel: text.resetPassword,
      describeFailure: (error) => {
        const reason = describeError(error).message
        if (!isUnknownOutcome(error))
          return reason
        return own ? text.resetOwnOutcomeUnknown(reason) : text.resetOutcomeUnknown(reason)
      },
      run: async () => {
        let reset: Awaited<ReturnType<typeof issuePasswordReset>>
        try {
          reset = await issuePasswordReset(user.id)
        }
        catch (error) {
          if (own && isUnknownOutcome(error))
            setOwnUnsure('password_reset')
          throw error
        }
        // 确认的弹窗关掉的同时弹出链接：任何时刻只有一个弹窗（审查 B7）
        setPending(undefined)
        setIssued({
          link: {
            title: adminMessages.link.resetTitle,
            recipient: user,
            url: reset.url,
            expiresAt: reset.expiresAt,
            ...(own ? { note: adminMessages.link.ownResetNote } : {}),
            returnFocus: () => focusRow(user),
          },
          own,
        })
      },
      refresh: own ? async () => recheckSession('password_reset') : async () => {},
      returnFocus: () => focusRow(user),
    })
  }

  /**
   * 吊销本机密钥（M3-P6 设计 §3.8，US-M3-17）：所有状态的账户都能吊销，自己的也一样（说明分自己、停用的、别人的三版，见 revokeLocalKeyDescription）。
   * 成功时与别的操作（confirmThen）一样：先按响应（吊销之后的账户）换上这一行（审查 B2：这一行"状态"列里的本机密钥随之是新的一版），
   * 再刷新账户列表（refresh：时限与"列表还在刷新"的说明都是共用的）。刷新经 refreshQueries 先取消在路上的列表请求——它们在吊销之前读的库
   * （"加载更多"的下一页、上一个操作到了时限还在后台的刷新、结果未知之后还没回来的刷新），不取消的话回来时把这一行换回吊销之前的版本，
   * 与状态区的说明矛盾（复验 C1）。成功的说明交回给确认的弹窗，关掉之后写进页面顶部的状态区（读屏靠它）。
   * 这个人从没取过本机密钥时服务端原样返回，说明没有要吊销的。
   * 吊销不动会话：自己的账户也不重新确认会话。结果未知时刷新账户列表（刷新之后这一行显示的就是现在的状态），用专门的说法——
   * 吊销每次都换一把新的（不按状态幂等），再吊销一次没有坏处。焦点回到这一行的"吊销本机密钥"（按钮一直在，打开之前有焦点的就交还给它；
   * 点按钮不给焦点的浏览器回到这一行）
   */
  function confirmRevokeLocalKey(user: AdminUser): void {
    const own = user.id === session.data?.user.id
    const name = nameOf(user)
    askToConfirm({
      title: own ? text.confirmRevokeOwnLocalKey : text.confirmRevokeLocalKey(name),
      description: revokeLocalKeyDescription(user, own),
      confirmLabel: text.revokeLocalKey,
      destructive: true,
      describeFailure: (error, refreshed) => {
        const reason = describeError(error).message
        return isUnknownOutcome(error) ? text.revokeLocalKeyOutcomeUnknown(reason, refreshed) : reason
      },
      run: async () => {
        const revoked = await revokeLocalKey(user.id)
        replaceRow(revoked)
        await refresh()
        const { localKey } = revoked
        return () => setDone(localKey === null ? text.noLocalKeyToRevoke(name) : text.localKeyRevoked(name, localKey.version))
      },
      refresh: refreshAfterUnknown,
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
              <Button variant="ghost" size="sm" aria-label={messages.common.actionOn(text.disable, name)} onClick={() => confirmDisable(user)}>
                {text.disable}
              </Button>
            )
          : (
              <Button variant="ghost" size="sm" aria-label={messages.common.actionOn(text.enable, name)} onClick={() => confirmThen(user, { title: text.confirmEnable(name), description: text.enableDescription, confirmLabel: text.enable }, async () => enableUser(user.id))}>
                {text.enable}
              </Button>
            )}
        {user.systemRole === 'admin'
          ? (
              <Button
                variant="ghost"
                size="sm"
                aria-label={messages.common.actionOn(text.revokeAdmin, name)}
                onClick={() => confirmThen(user, own
                  ? { title: text.confirmRevokeOwnAdmin, description: text.revokeOwnAdminDescription, confirmLabel: text.revokeAdmin, destructive: true }
                  : { title: text.confirmRevokeAdmin(name), description: text.revokeAdminDescription, confirmLabel: text.revokeAdmin, destructive: true }, async () => changeSystemRole(user.id, 'member'))}
              >
                {text.revokeAdmin}
              </Button>
            )
          : user.status === 'active' && (
            <Button variant="ghost" size="sm" aria-label={messages.common.actionOn(text.grantAdmin, name)} onClick={() => confirmThen(user, { title: text.confirmGrantAdmin(name), description: text.grantAdminDescription, confirmLabel: text.grantAdmin }, async () => changeSystemRole(user.id, 'admin'))}>
              {text.grantAdmin}
            </Button>
          )}
        {user.status === 'active' && (
          <Button variant="ghost" size="sm" aria-label={messages.common.actionOn(text.resetPassword, name)} onClick={() => confirmReset(user)}>
            {text.resetPassword}
          </Button>
        )}
        {/* 吊销本机密钥（M3-P6 设计 §3.8）：所有状态的账户都给（设备丢了又停用、之后再启用时，旧设备上的草稿同样不该再解得开） */}
        <Button variant="ghost" size="sm" aria-label={messages.common.actionOn(text.revokeLocalKey, name)} onClick={() => confirmRevokeLocalKey(user)}>
          {text.revokeLocalKey}
        </Button>
        {/* 登录被锁定（M2-P6 复核 A1）：解除之后这一行不再有这个按钮，焦点回到这一行 */}
        {user.loginLock !== null && (
          <Button variant="ghost" size="sm" aria-label={messages.common.actionOn(text.unlockLogin, name)} onClick={() => confirmThen(user, { title: text.confirmUnlockLogin(name), description: text.unlockLoginDescription, confirmLabel: text.unlockLogin }, async () => unlockLogin(user.id))}>
            {text.unlockLogin}
          </Button>
        )}
        {/* 停用的账户：把个人空间里的文档转移给别人（M2-P2 设计 §3.8） */}
        {user.status === 'disabled' && (
          <Link to={adminUserDocumentsPath(user.id)} aria-label={messages.common.actionOn(text.transfer, name)} className={buttonVariants({ variant: 'ghost', size: 'sm' })}>
            {text.transfer}
          </Link>
        )}
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      {/* 操作结果的说明：共用的状态区，一直在无障碍树里（空的时候只做视觉隐藏、不占位置），结果出来时往里填文字，读屏软件才会播报。
          它在长列表上方：写进说明时下面的内容整体下移，keepFocusInView 把焦点所在的元素（交还焦点的那一行的按钮）滚回可视区域（复验 C7 时发现） */}
      <StatusRegion className="rounded-lg border p-3 text-sm" keepFocusInView>{done}</StatusRegion>
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex min-w-48 flex-1 flex-col gap-2">
          <Label htmlFor={searchId}>{text.search}</Label>
          <Input ref={searchRef} id={searchId} type="search" value={keyword} onChange={event => setKeyword(event.target.value)} />
        </div>
        <div className="flex w-36 flex-col gap-2">
          <Label htmlFor={statusId}>{text.statusFilter}</Label>
          <NativeSelect id={statusId} value={status} onChange={event => setStatus(event.target.value as UserStatus | '')}>
            <option value="">{messages.common.all}</option>
            {USER_STATUSES.map(value => <option key={value} value={value}>{messages.people.statusName(value)}</option>)}
          </NativeSelect>
        </div>
      </div>
      <StillRefreshingLine background={background} />
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
            {/* 显示名单独一列，用 <bdi> 隔离：从右到左的显示名不打乱旁边的格子（M2-P6 复核 M2） */}
            <TableCell><bdi>{user.displayName}</bdi></TableCell>
            <TableCell><Badge variant={user.systemRole === 'admin' ? 'default' : 'outline'}>{adminMessages.roleName(user.systemRole)}</Badge></TableCell>
            <TableCell>
              <div className="flex flex-col items-start gap-1">
                <Badge variant={user.status === 'active' ? 'secondary' : 'destructive'}>{messages.people.statusName(user.status)}</Badge>
                {user.loginLock !== null && <span className="text-xs text-destructive">{loginLockText(user.loginLock)}</span>}
                {/* 本机密钥的版本（审查 B2）：从没取过的不显示；吊销之后这一行换成新的一版。不折行（与"创建时间"一格一样）：这一格很窄，
                    原来 400 宽时折成三行、把"第 1 版"拆开，1280 宽时也折成两行（复验 C7）；表格在自己的容器里横向滚动 */}
                {user.localKey !== null && <span className="text-xs whitespace-nowrap text-muted-foreground">{text.localKeyVersion(user.localKey.version)}</span>}
              </div>
            </TableCell>
            <TableCell className="whitespace-nowrap"><time dateTime={user.createdAt}>{formatDateTime(user.createdAt)}</time></TableCell>
            <TableCell>{actionsOf(user)}</TableCell>
          </>
        )}
      />
      <ConfirmDialog
        pending={pending}
        onClose={() => {
          setPending(undefined)
          setOwnUnsure(undefined)
        }}
        meta={ownUnsure === undefined ? SYSTEM_ADMIN_ONLY : OWN_AFTER_UNKNOWN[ownUnsure]}
      />
      <IssuedLinkDialog link={issued?.link} onClose={closeLink} />
    </div>
  )
}

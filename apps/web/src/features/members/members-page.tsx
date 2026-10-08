import type { SpaceMember, SpaceMemberListResponse, SpaceRole, UserSummary } from '@nerve-office/contracts'
import type { QueryClient } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import type { BackgroundRefresh } from '../../shared/api/write-outcome.ts'
import type { PendingConfirmation } from '../confirmation/index.ts'
import { SPACE_ROLES } from '@nerve-office/contracts'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useId, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { ApiError, describeError, isMissingResource, isPermissionDeniedError, isUnknownOutcome } from '../../shared/api/index.ts'
import { refreshAfterSuccess, writeFailureText } from '../../shared/api/write-outcome.ts'
import { messages } from '../../shared/i18n/index.ts'
import { membersMessages } from '../../shared/i18n/zh-cn/members.ts'
import { ADMIN_PATHS } from '../../shared/lib/admin-paths.ts'
import { refreshQueries } from '../../shared/lib/refresh-queries.ts'
import { HOME_PATH, spacePath } from '../../shared/lib/space-paths.ts'
import { useDocumentTitle } from '../../shared/lib/use-document-title.ts'
import { useFirstLoadRetry } from '../../shared/lib/use-first-load-retry.ts'
import { useFocusRescue } from '../../shared/lib/use-focus-rescue.ts'
import { useOutcomeRefresh } from '../../shared/lib/use-outcome-refresh.ts'
import { Alert, AlertDescription, Badge, Button, buttonVariants, Label, NativeSelect, PersonName, Phrase, RetryButton, Skeleton, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../shared/ui/index.ts'
import { DetailRefreshProblem } from '../../shared/ui/refresh-problem.tsx'
import { StatusRegion } from '../../shared/ui/status-region.tsx'
import { StillRefreshing } from '../../shared/ui/still-refreshing.tsx'
import { sessionQueryOptions } from '../auth/index.ts'
import { ColleaguePicker } from '../colleagues/index.ts'
import { ConfirmDialog } from '../confirmation/index.ts'
import { addMember, changeMemberRole, forgetSpace, membersQueryOptions, removeMember, SpaceNotFound, SPACES_QUERY_KEY, spacesQueryOptions, useForgetMissingSpace } from '../spaces/index.ts'

const text = membersMessages

/** 角色的选项：从高到低 */
const ROLE_OPTIONS = [...SPACE_ROLES].reverse()

/**
 * 写操作成功之后：成员列表、导航与空间页（都在空间的查询下面）一起刷新，最多等到时限（Codex 对抗评审 CX4）。兑现为到了时限还在后台的刷新
 * （说明里说成员列表还在刷新），刷新已经有了结果时为 undefined；刷新失败不算这个操作失败，成员表自己说明没能刷新（CX5）
 */
async function refreshAfterChange(queryClient: QueryClient): Promise<BackgroundRefresh | undefined> {
  return refreshAfterSuccess(async () => refreshQueries(queryClient, [SPACES_QUERY_KEY]))
}

/**
 * 按确定的写入结果直接改成员表的缓存（Codex 对抗评审 CX4）：刷新一直不回来时，成员表也已经是写入之后的样子；刷新回来之后以服务端为准。
 * change 处理成员的数组
 */
function updateMembers(queryClient: QueryClient, spaceId: string, change: (items: readonly SpaceMember[]) => SpaceMember[]): void {
  queryClient.setQueryData(membersQueryOptions(spaceId).queryKey, list => list === undefined ? undefined : { ...list, items: change(list.items) })
}

/** 换上这个人的那一行（添加时还没有就加在最后） */
function putMember(queryClient: QueryClient, spaceId: string, member: SpaceMember): void {
  updateMembers(queryClient, spaceId, items => items.some(item => item.user.id === member.user.id)
    ? items.map(item => (item.user.id === member.user.id ? member : item))
    : [...items, member])
}

/** 要添加的人已经是成员了 */
function isAlreadyMember(error: unknown): boolean {
  return error instanceof ApiError && error.code === 'ALREADY_MEMBER'
}

/**
 * 添加失败时的说明（M2-P6 复核 S1）：结果未知时这个人可能已经加好了；已经是成员时说清楚——之前添加这个人有过结果未知（unsure），
 * 才说"可能就是刚才没能确认的那一次"，否则只说已经是成员（第五批 G5：多半是别人刚加的，并没有"刚才那一次"）；其余按错误码。
 * 前两种情形成员列表都随即刷新，refreshed 是刷新好了没有（第四批）
 */
function addFailureText(error: unknown, refreshed: boolean, unsure: boolean): string {
  if (isAlreadyMember(error))
    return unsure ? text.addedEarlier(refreshed) : text.alreadyMember(refreshed)
  if (isUnknownOutcome(error))
    return text.addOutcomeUnknown(describeError(error).message, refreshed)
  return describeError(error).message
}

/**
 * 添加成员：按名字选一个同事、选角色；已经是成员的人不作为候选。
 * 结果未知或者得到"已经是成员"时成员列表随即刷新（M2-P6 复核 S1）：加好了的人就出现在表里；
 * 已经是成员时选择随之清掉（这个人不再是候选），再点也只会得到同样的结果。
 * 这时的刷新经共用的做法（shared/api/write-outcome.ts，第四批）：最多等 10 秒，刷新失败或者到了时限还没回来，说明里说
 * "成员列表没能刷新"，按钮也不一直停在"正在添加…"；超时之后刷新才回来的，说明随后改过来（第五批 G4）
 */
function AddMemberForm({ spaceId, members }: { readonly spaceId: string, readonly members: readonly SpaceMember[] }) {
  const queryClient = useQueryClient()
  const [user, setUser] = useState<UserSummary>()
  const [role, setRole] = useState<SpaceRole>('viewer')
  // 添加成功之后换一个 key，同事选择整个重新开始：关键词与上一次的候选都清掉（审查 B11）
  const [pickerKey, setPickerKey] = useState(0)
  /** 上一次失败之后成员列表刷新好了没有：说明据此说"已刷新"还是"没能刷新"（第四批）。每次失败都重新记下 */
  const { refreshed, refreshAfterFailure } = useOutcomeRefresh()
  /**
   * 结果未知的那一次添加的是谁（第五批 G5，与创建团队空间记下那一次的名称一样）：之后添加这个人得到"已经是成员"，
   * 才说多半就是那一次。添加这个人成功时清掉
   */
  const [unsureUserId, setUnsureUserId] = useState<string>()
  const roleId = useId()
  const hintId = useId()

  function startOver(): void {
    setUser(undefined)
    setPickerKey(key => key + 1)
  }

  const mutation = useMutation({
    mutationFn: async (userId: string) => addMember(spaceId, { userId, role }),
    onSuccess: async (member, userId) => {
      startOver()
      setUnsureUserId(current => (current === userId ? undefined : current))
      // 按确定的写入结果先把这个人放进成员表，再刷新（最多等到时限，Codex 对抗评审 CX4）：刷新一直不回来时按钮照常结束"正在添加…"，
      // 表里已经有他
      putMember(queryClient, spaceId, member)
      await refreshAfterChange(queryClient)
    },
    onError: async (error, userId) => {
      if (isUnknownOutcome(error))
        setUnsureUserId(userId)
      if (isAlreadyMember(error))
        startOver()
      await refreshAfterFailure(error, async () => refreshQueries(queryClient, [SPACES_QUERY_KEY]), { also: isAlreadyMember })
    },
  })

  return (
    <form
      className="flex flex-wrap items-end gap-3 rounded-lg border p-4"
      onSubmit={(event) => {
        event.preventDefault()
        if (user !== undefined && !mutation.isPending)
          mutation.mutate(user.id)
      }}
    >
      <div className="min-w-56 flex-1">
        <ColleaguePicker key={pickerKey} label={text.colleague} selected={user} onSelect={setUser} exclude={new Set(members.map(member => member.user.id))} />
      </div>
      <div className="flex w-36 flex-col gap-2">
        <Label htmlFor={roleId}>{text.role}</Label>
        <NativeSelect id={roleId} value={role} onChange={event => setRole(event.target.value as SpaceRole)}>
          {ROLE_OPTIONS.map(value => <option key={value} value={value}>{messages.spaces.roleName(value)}</option>)}
        </NativeSelect>
      </div>
      {/* 还不能提交时说明原因（审查 B5）：aria-disabled 的按钮读屏软件读出"不可用"，却不知道为什么 */}
      <Button type="submit" aria-disabled={user === undefined || mutation.isPending} aria-describedby={user === undefined ? hintId : undefined}>
        {mutation.isPending ? text.adding : text.add}
      </Button>
      {user === undefined && <p id={hintId} className="basis-full text-sm text-muted-foreground">{text.pickColleague}</p>}
      {mutation.isError && (
        <Alert variant="destructive" className="basis-full">
          <AlertDescription>{addFailureText(mutation.error, refreshed, mutation.variables === unsureUserId)}</AlertDescription>
        </Alert>
      )}
    </form>
  )
}

interface MemberRowProps {
  readonly spaceId: string
  readonly member: SpaceMember
  /** 这一行是不是本人 */
  readonly self: boolean
  readonly canManage: boolean
  /** 空间管理员降低自己：由表格先确认 */
  readonly onDemoteSelf: (role: SpaceRole) => void
  readonly onRemove: () => void
}

/**
 * 成员表的一行（审查 B3）。能管理时，角色由这一行各自提交，不同的行可以同时调整：
 * - 选择框只是选（记在这一行的状态里），点了"保存"才提交（M2-P6 复核的疑点）：Windows、Linux 上的 Chrome 与 Edge
 *   在收起的选择框上按方向键直接改值、逐个触发 change，选一下就保存的话会把经过的每个角色都保存一遍；
 *   选回原来的角色，"保存"随之收起；
 * - 保存之后立即显示目标角色（与点击同一次渲染，不等请求的状态）；进行中这一行标为忙碌、说明"正在保存…"，
 *   这期间这一行不再提交，选择框仍显示正在保存的角色；
 * - 保存成功时先用响应替换缓存里的这一行，再刷新成员列表：刷新失败时 TanStack Query 保留上一次的数据，
 *   这一行也已经是保存之后的角色，不显示旧的（复验），成员表上方说明没能刷新（Codex 对抗评审 CX5）；
 * - 成员列表刷新完成之后才结束，选择框不先弹回旧的角色；刷新最多等到时限（CX4），一直不回来时这一行照样结束忙碌；
 * - 失败时恢复原来的角色（失败之后也刷新，显示服务端的实际状态），原因就在这一行说明。结果未知时说明可能已经生效（第二批 G-2）：
 *   这时的刷新最多等 10 秒（第三批 S-a），这一行不一直停在"正在保存…"；刷新失败或者超时，说明页面没能刷新（第三批 G-a），
 *   超时之后刷新才回来的，说明随后改过来（第五批 G4）。
 */
function MemberRow({ spaceId, member, self, canManage, onDemoteSelf, onRemove }: MemberRowProps) {
  const queryClient = useQueryClient()
  const noteId = useId()
  const unsavedId = useId()
  const selectRef = useRef<HTMLSelectElement>(null)
  /** 选了、还没保存的角色 */
  const [chosen, setChosen] = useState<SpaceRole>()
  /** 正在保存的角色 */
  const [saving, setSaving] = useState<SpaceRole>()
  /** 上一次失败之后成员列表刷新好了没有：结果未知的说明据此说"已刷新"还是"没能刷新"（第三批 G-a） */
  const { refreshed, refreshAfterFailure } = useOutcomeRefresh()
  const change = useMutation({
    mutationFn: async (role: SpaceRole) => changeMemberRole(spaceId, member.user.id, role),
    onSuccess: saved => putMember(queryClient, spaceId, saved),
    onSettled: async (_saved, error) => {
      if (error !== null && isUnknownOutcome(error))
        await refreshAfterFailure(error, async () => refreshQueries(queryClient, [SPACES_QUERY_KEY]))
      else
        await refreshAfterChange(queryClient)
      setSaving(undefined)
    },
  })
  // 纯文字里的人名（选择框与按钮的可读名称）：显示名隔离、登录名另外标出（M2-P6 复核 M2）
  const name = messages.people.text(member.user)
  const busy = saving !== undefined
  // 选回了原来的角色（或者角色已经被别处改成了选的那个）：没有要保存的
  const pending = chosen !== undefined && chosen !== member.role ? chosen : undefined
  // 选了、还没保存：选择框显示的是选的角色，却还没有生效——看得见"保存"按钮，读屏用户要靠关联的说明才知道（M2-P6 复核第二批 S-3）
  const unsaved = pending !== undefined && !busy
  const describedBy = [unsaved ? unsavedId : undefined, busy || change.isError ? noteId : undefined].filter(id => id !== undefined).join(' ')

  function choose(role: SpaceRole): void {
    if (!busy)
      setChosen(role)
  }

  function save(): void {
    if (busy || pending === undefined)
      return
    // "保存"随之收起：焦点先回到这一行的选择框
    selectRef.current?.focus()
    setChosen(undefined)
    // 空间管理员降低自己：改完立即失去管理的权限，先确认；失败的原因显示在确认的弹窗里
    if (self && member.role === 'admin') {
      onDemoteSelf(pending)
      return
    }
    setSaving(pending)
    change.mutate(pending)
  }

  return (
    <TableRow aria-busy={busy}>
      <TableCell className="font-medium">
        <PersonName person={member.user} />
        {self && text.you}
      </TableCell>
      <TableCell>
        {canManage
          ? (
              <div className="flex flex-col gap-1">
                <div className="flex items-center gap-2">
                  <NativeSelect ref={selectRef} aria-label={text.roleOf(name)} aria-describedby={describedBy === '' ? undefined : describedBy} value={saving ?? pending ?? member.role} onChange={event => choose(event.target.value as SpaceRole)}>
                    {ROLE_OPTIONS.map(value => <option key={value} value={value}>{messages.spaces.roleName(value)}</option>)}
                  </NativeSelect>
                  {unsaved && <Button variant="outline" size="sm" aria-label={text.saveRoleOf(name)} onClick={save}>{text.saveRole}</Button>}
                </div>
                {unsaved && <span id={unsavedId} className="text-xs text-muted-foreground">{text.unsaved}</span>}
                {busy && <span id={noteId} className="text-xs text-muted-foreground">{text.saving}</span>}
                {/* 结果未知时成员列表已经刷新（onSettled），说明可能已经生效（M2-P6 复核第二批 G-2）；没能刷新时另说（第三批 G-a） */}
                {!busy && change.isError && <span id={noteId} role="alert" className="text-xs text-destructive">{writeFailureText(change.error, refreshed)}</span>}
              </div>
            )
          : messages.spaces.roleName(member.role)}
      </TableCell>
      <TableCell>
        {member.status === 'disabled' ? <Badge variant="destructive">{text.disabled}</Badge> : <Badge variant="secondary">{messages.people.statusName(member.status)}</Badge>}
      </TableCell>
      {canManage && (
        <TableCell>
          <Button variant="ghost" size="sm" aria-label={messages.common.actionOn(text.remove, name)} onClick={onRemove}>{text.remove}</Button>
        </TableCell>
      )}
    </TableRow>
  )
}

interface MembersTableProps {
  readonly spaceId: string
  readonly list: SpaceMemberListResponse
  readonly selfId: string | undefined
  /** 确认的弹窗关闭之后，打开它的元素随操作消失了（移出之后这一行没了、降低自己之后选择框换成了文字）：焦点交给页面的标题（审查 B2） */
  readonly focusTitle: () => void
}

/** 成员表：能管理时角色可以改、可以移出；降低或移出自己先确认 */
function MembersTable({ spaceId, list, selfId, focusTitle }: MembersTableProps) {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const [pending, setPending] = useState<PendingConfirmation>()
  /** 表格上方的说明（要移出的人已经不在成员里了）；下一次打开确认的弹窗时清掉 */
  const [notice, setNotice] = useState<ReactNode>()

  /** 确认的弹窗在结果未知之后的刷新：刷新失败时拒绝，弹窗据此说明页面没能刷新（M2-P6 复核第三批 G-a） */
  async function refreshAfterUnknown(): Promise<void> {
    await refreshQueries(queryClient, [SPACES_QUERY_KEY])
  }

  /**
   * 成功之后交回的说明（等确认的弹窗关掉之后才写，M2-P5 复验 S1）：刷新已经有了结果时不另外说明（成员表看得见）；
   * 到了时限还在后台时说明做完了什么，接着说成员列表还在刷新（Codex 对抗评审 CX4）
   */
  function afterChange(done: ReactNode, refreshing: BackgroundRefresh | undefined): (() => void) | undefined {
    if (refreshing === undefined)
      return undefined
    return () => setNotice(
      <>
        {done}
        <StillRefreshing refresh={refreshing} list={text.listLabel} />
      </>,
    )
  }

  function confirm(confirmation: PendingConfirmation): void {
    setNotice(undefined)
    setPending(confirmation)
  }

  function confirmDemoteSelf(member: SpaceMember, role: SpaceRole): void {
    confirm({
      title: text.confirmDemoteSelf(role),
      description: text.demoteSelfDescription,
      confirmLabel: text.change,
      destructive: true,
      run: async () => {
        // 按确定的写入结果先改好这一行，再刷新（最多等到时限，CX4）；能不能管理由服务端在刷新之后的列表里给出
        putMember(queryClient, spaceId, await changeMemberRole(spaceId, member.user.id, role))
        return afterChange(text.demotedSelf(role), await refreshAfterChange(queryClient))
      },
      refresh: refreshAfterUnknown,
      returnFocus: focusTitle,
    })
  }

  function confirmRemove(member: SpaceMember): void {
    const self = member.user.id === selfId
    const name = messages.people.text(member.user)
    confirm({
      title: self ? text.confirmRemoveSelf : text.confirmRemove(name),
      description: self ? text.removeSelfDescription : text.removeDescription,
      confirmLabel: text.remove,
      destructive: true,
      run: async () => {
        try {
          await removeMember(spaceId, member.user.id)
        }
        catch (error) {
          if (!isMissingResource(error))
            throw error
          // 已经不是成员了（可能被别人移出，404）：先刷新成员列表，这一行随之消失（审查 B12）。列表取到了就关闭弹窗，在表格上方说明：
          // 弹窗留着的话，再点确认只会原样重发（复验）。列表取不到时照旧在弹窗里说明原因：空间本身看不到了，成员页随之显示
          // "空间不存在"（B1），不另外说明；刷新失败、或者到了时限还没回来（Codex 对抗评审 CX4）时列表还是旧的，这一行也还在。
          // 说明交给确认的弹窗，等它关掉、页面不再被标为 aria-hidden、焦点交还之后才写进状态区（M2-P5 复验 S1）
          const refreshing = await refreshAfterChange(queryClient)
          if (refreshing !== undefined || queryClient.getQueryState(membersQueryOptions(spaceId).queryKey)?.status !== 'success')
            throw error
          return () => setNotice(self ? text.alreadyRemovedSelf : <Phrase parts={text.alreadyRemoved(<PersonName person={member.user} />)} />)
        }
        if (!self) {
          // 按确定的写入结果先去掉这一行，再刷新（最多等到时限，CX4）：刷新一直不回来时弹窗照常关掉，那一行已经不在，焦点交给标题
          updateMembers(queryClient, spaceId, items => items.filter(item => item.user.id !== member.user.id))
          return afterChange(<Phrase parts={text.removed(<PersonName person={member.user} />)} />, await refreshAfterChange(queryClient))
        }
        // 移出了自己：这个空间可能已经看不到了，回到首页。离开之前先去掉它的缓存（包括正在显示的成员表）：
        // 回来时从加载开始，不先显示还能管理的旧页面
        forgetSpace(queryClient, spaceId, { leaving: true })
        await navigate(HOME_PATH)
        await refreshAfterChange(queryClient)
      },
      // 结果未知时确认的弹窗刷新成员列表、说明可能已经移出（M2-P6 复核第二批 G-2）；再试得到 404 时照上面说明"已经不在成员里了"
      refresh: refreshAfterUnknown,
      returnFocus: focusTitle,
    })
  }

  return (
    <div>
      {/* 表格上方的说明：共用的状态区，一直在无障碍树里（空的时候只做视觉隐藏、不占位置），内容变化时往里填文字，读屏软件才会播报。
          它在成员表上方：写进说明时下面的内容整体下移，keepFocusInView 把焦点所在的元素滚回可视区域（与账户页、转移页相同，M3-P6 复验） */}
      <StatusRegion className="mb-4 rounded-lg border p-3 text-sm" keepFocusInView>{notice}</StatusRegion>
      {list.items.length === 0
        ? <p className="rounded-lg border border-dashed p-8 text-center text-muted-foreground">{text.empty}</p>
        : (
            <Table aria-label={text.listLabel}>
              <TableHeader>
                <TableRow>
                  <TableHead>{text.columns.name}</TableHead>
                  <TableHead>{text.columns.role}</TableHead>
                  <TableHead>{text.columns.status}</TableHead>
                  {list.canManage && <TableHead>{text.columns.actions}</TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {list.items.map(member => (
                  <MemberRow
                    key={member.user.id}
                    spaceId={spaceId}
                    member={member}
                    self={member.user.id === selfId}
                    canManage={list.canManage}
                    onDemoteSelf={role => confirmDemoteSelf(member, role)}
                    onRemove={() => confirmRemove(member)}
                  />
                ))}
              </TableBody>
            </Table>
          )}
      <ConfirmDialog pending={pending} onClose={() => setPending(undefined)} />
    </div>
  )
}

/**
 * 返回的去处：看得到这个空间就回空间页；没有加入的系统管理员回到管理界面的团队空间。
 * 导航列表与会话还在加载时先不显示，免得闪一下不对的链接（审查 B5）
 */
function BackLink({ spaceId }: { readonly spaceId: string }) {
  const spaces = useQuery(spacesQueryOptions())
  const session = useQuery(sessionQueryOptions())
  if (spaces.isPending || session.isPending)
    return null
  if (spaces.data?.items.some(space => space.id === spaceId) === true)
    return <Link to={spacePath(spaceId)} className={buttonVariants({ variant: 'outline' })}>{text.backToSpace}</Link>
  if (session.data?.user.systemRole === 'admin')
    return <Link to={ADMIN_PATHS.spaces} className={buttonVariants({ variant: 'outline' })}>{text.backToAdmin}</Link>
  return null
}

/** 只能查看时说明为什么；能管理而空间已归档（系统管理员）时说明调整成员不改变只读（审查 B5） */
function ManageNotice({ list }: { readonly list: SpaceMemberListResponse }) {
  const archived = list.space.status === 'archived'
  if (list.canManage && !archived)
    return null
  let notice: string = text.readOnly
  if (list.canManage)
    notice = text.archivedManaged
  else if (archived)
    notice = text.archivedReadOnly
  return (
    <Alert>
      <AlertDescription>{notice}</AlertDescription>
    </Alert>
  )
}

/** 看不到（404，与不存在一致）、看得到却不能查看成员（403，服务端说明原因）：页面另有说明，重试也不会好 */
function notRetryable(error: unknown): boolean {
  return !isMissingResource(error) && !isPermissionDeniedError(error)
}

/**
 * 成员页的内容：加载中；看不到（与不存在一致）；看得到却不能查看成员（服务端说明原因）；加载失败（可以重试）；成员表。
 * 先看错误、再看数据：重新请求失败时 TanStack Query 保留上一次的数据。已打开的页面里被移出了空间，缓存里还是能管理的成员表，
 * 重新请求得到 404 就按看不到显示，管理的控件不再出现（审查 B1）；导航与这个空间的缓存随之更新。
 * 别的失败（网络、5xx）留着之前的成员表与空间信息，标题下面说明它们没能刷新、可以重试（CX5、DEF-040）。
 * 第一次就没取到时按"重试"：重试期间说明与按钮留着（不可用、说正在重试）；取到之后焦点交给页面的标题（得到不能查看成员的说明时交给那一页的标题，
 * 得到 404 时由"空间不存在"接住），不落到 body（规范 §2.4，shared/lib/use-first-load-retry.ts）
 */
function MembersContent({ spaceId }: { readonly spaceId: string }) {
  const list = useQuery(membersQueryOptions(spaceId))
  const session = useQuery(sessionQueryOptions())
  const titleRef = useRef<HTMLHeadingElement>(null)
  // 有焦点的按钮、行随刷新消失时（被移出的人、改成别的角色之后），焦点交给页面的标题（M2-P6 复核 S3）
  const rescueFocus = useFocusRescue(titleRef)
  const firstLoad = useFirstLoadRetry(list, titleRef, { retryable: notRetryable })
  const missing = isMissingResource(list.error)
  useForgetMissingSpace(spaceId, missing)
  // 浏览器标签页的标题（M2-P6 复核 S4）：看不到时由"空间不存在"给出；重试期间照旧
  let title: string | undefined
  if (list.data !== undefined && list.error === null)
    title = text.title(list.data.space.name)
  else if ((!list.isPending || firstLoad.retrying) && !missing)
    title = text.pageTitle
  useDocumentTitle(title)
  if (missing)
    return <SpaceNotFound />
  // 看得到这个空间却不能查看成员（现在只有个人空间的所有者会这样）：显示服务端在这次拒绝里给出的说明（例如"个人空间没有成员"），
  // 原因由服务端判断，前端不按错误码猜（复验；ADR-006：说明面向用户）。重试也一样，不给重试
  if (isPermissionDeniedError(list.error)) {
    return (
      <section className="flex flex-col gap-4" aria-labelledby="members-title">
        <h1 ref={titleRef} id="members-title" tabIndex={-1} className="text-xl font-semibold outline-none focus-visible:ring-3 focus-visible:ring-ring/50">{text.pageTitle}</h1>
        <Alert>
          <AlertDescription>{describeError(list.error).message}</AlertDescription>
        </Alert>
      </section>
    )
  }
  if (firstLoad.failed) {
    // 重试期间说明与按钮留着（不可用、说正在重试），上一次的原因不再给（请求缓存已经清掉了它）
    return (
      <section className="flex flex-col gap-4" aria-labelledby="members-title">
        <h1 id="members-title" className="text-xl font-semibold">{text.loadFailed}</h1>
        <Alert variant="destructive" onFocus={firstLoad.focus.onFocus} onBlur={firstLoad.focus.onBlur}>
          <AlertDescription>
            {!firstLoad.retrying && <p>{describeError(list.error).message}</p>}
            <RetryButton retrying={firstLoad.retrying} onRetry={() => void list.refetch()} className={firstLoad.retrying ? undefined : 'mt-2'} />
          </AlertDescription>
        </Alert>
      </section>
    )
  }
  if (list.data === undefined) {
    return (
      <div role="status" aria-label={text.loading} className="flex flex-col gap-3">
        {['first', 'second', 'third'].map(row => <Skeleton key={row} className="h-10 w-full" />)}
      </div>
    )
  }
  const { space } = list.data
  return (
    <section ref={rescueFocus} className="flex flex-col gap-4" aria-labelledby="members-title">
      <div className="flex flex-wrap items-start justify-between gap-3">
        {/* tabIndex -1：只能由程序聚焦（确认的弹窗关闭之后），Tab 键不经过它 */}
        <h1 ref={titleRef} id="members-title" tabIndex={-1} className="text-xl font-semibold outline-none focus-visible:ring-3 focus-visible:ring-ring/50">{text.title(space.name)}</h1>
        <BackLink spaceId={spaceId} />
      </div>
      {/* 留着之前的成员表、刷新却失败了（Codex 对抗评审 CX5）：明说没能刷新、给出重试，之前的照常显示。页头的空间信息（名称、归档、
          能不能管理）与成员表是同一个请求，说明放在标题下面、一起说（DEF-040）；重试成功之后焦点交给标题 */}
      <DetailRefreshProblem query={list} detail={text.detailName} fallbackFocus={titleRef} />
      <ManageNotice list={list.data} />
      {list.data.canManage && <AddMemberForm spaceId={spaceId} members={list.data.items} />}
      <MembersTable spaceId={spaceId} list={list.data} selfId={session.data?.user.id} focusTitle={() => titleRef.current?.focus()} />
    </section>
  )
}

/**
 * 成员页（M2-P2 设计 §3.10，US-M2-06）：团队空间里有空间角色的人与系统管理员能看；空间管理员（空间没有归档）与系统管理员能添加、
 * 调整角色、移出。服务端逐请求检查，界面只显示能做的操作。按需加载：带着确认的弹窗与同事选择，不进首屏。
 */
export function MembersPage() {
  const { spaceId = '' } = useParams()
  return <MembersContent key={spaceId} spaceId={spaceId} />
}

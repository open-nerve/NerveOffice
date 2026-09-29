import type { SpaceMember, SpaceMemberListResponse, SpaceRole, UserSummary } from '@nerve-office/contracts'
import type { PendingConfirmation } from '../confirmation/index.ts'
import { SPACE_ROLES } from '@nerve-office/contracts'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useId, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { describeError, isMissingResource, isPermissionDeniedError } from '../../shared/api/index.ts'
import { messages } from '../../shared/i18n/index.ts'
import { ADMIN_PATHS } from '../../shared/lib/admin-paths.ts'
import { HOME_PATH, spacePath } from '../../shared/lib/space-paths.ts'
import { Alert, AlertDescription, Badge, Button, buttonVariants, Label, NativeSelect, Skeleton, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../shared/ui/index.ts'
import { sessionQueryOptions } from '../auth/index.ts'
import { ColleaguePicker } from '../colleagues/index.ts'
import { ConfirmDialog } from '../confirmation/index.ts'
import { addMember, changeMemberRole, forgetSpace, membersQueryOptions, removeMember, SPACES_QUERY_KEY, spacesQueryOptions, useForgetMissingSpace } from '../spaces/index.ts'

const text = messages.members

/** 角色的选项：从高到低 */
const ROLE_OPTIONS = [...SPACE_ROLES].reverse()

/** 添加成员：按名字选一个同事、选角色；已经是成员的人不作为候选 */
function AddMemberForm({ spaceId, members }: { readonly spaceId: string, readonly members: readonly SpaceMember[] }) {
  const queryClient = useQueryClient()
  const [user, setUser] = useState<UserSummary>()
  const [role, setRole] = useState<SpaceRole>('viewer')
  // 添加成功之后换一个 key，同事选择整个重新开始：关键词与上一次的候选都清掉（审查 B11）
  const [pickerKey, setPickerKey] = useState(0)
  const roleId = useId()
  const hintId = useId()
  const mutation = useMutation({
    mutationFn: async (userId: string) => addMember(spaceId, { userId, role }),
    onSuccess: async () => {
      setUser(undefined)
      setPickerKey(key => key + 1)
      await queryClient.invalidateQueries({ queryKey: SPACES_QUERY_KEY })
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
          <AlertDescription>{describeError(mutation.error).message}</AlertDescription>
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
 * - 选择之后立即显示目标角色（记在这一行的状态里，与选择同一次渲染，不等请求的状态）；进行中这一行标为忙碌、说明"正在保存…"，
 *   这期间再改这一行不提交，选择框仍显示正在保存的角色；
 * - 成员列表刷新完成之后才结束，选择框不先弹回旧的角色；
 * - 失败时恢复原来的角色（失败之后也刷新，显示服务端的实际状态），原因就在这一行说明。
 */
function MemberRow({ spaceId, member, self, canManage, onDemoteSelf, onRemove }: MemberRowProps) {
  const queryClient = useQueryClient()
  const noteId = useId()
  /** 正在保存的角色 */
  const [saving, setSaving] = useState<SpaceRole>()
  const change = useMutation({
    mutationFn: async (role: SpaceRole) => changeMemberRole(spaceId, member.user.id, role),
    onSettled: async () => {
      await queryClient.invalidateQueries({ queryKey: SPACES_QUERY_KEY })
      setSaving(undefined)
    },
  })
  const name = messages.colleagues.name(member.user)
  const busy = saving !== undefined

  function choose(role: SpaceRole): void {
    if (busy || role === member.role)
      return
    // 空间管理员降低自己：改完立即失去管理的权限，先确认；失败的原因显示在确认的弹窗里
    if (self && member.role === 'admin') {
      onDemoteSelf(role)
      return
    }
    setSaving(role)
    change.mutate(role)
  }

  return (
    <TableRow aria-busy={busy}>
      <TableCell className="font-medium">
        {name}
        {self && text.you}
      </TableCell>
      <TableCell>
        {canManage
          ? (
              <div className="flex flex-col gap-1">
                <NativeSelect aria-label={text.roleOf(name)} aria-describedby={busy || change.isError ? noteId : undefined} value={saving ?? member.role} onChange={event => choose(event.target.value as SpaceRole)}>
                  {ROLE_OPTIONS.map(value => <option key={value} value={value}>{messages.spaces.roleName(value)}</option>)}
                </NativeSelect>
                {busy && <span id={noteId} className="text-xs text-muted-foreground">{text.saving}</span>}
                {!busy && change.isError && <span id={noteId} role="alert" className="text-xs text-destructive">{describeError(change.error).message}</span>}
              </div>
            )
          : messages.spaces.roleName(member.role)}
      </TableCell>
      <TableCell>
        {member.status === 'disabled' ? <Badge variant="destructive">{text.disabled}</Badge> : <Badge variant="secondary">{messages.admin.statusName(member.status)}</Badge>}
      </TableCell>
      {canManage && (
        <TableCell>
          <Button variant="ghost" size="sm" aria-label={messages.admin.actionOn(text.remove, name)} onClick={onRemove}>{text.remove}</Button>
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

  async function refresh(): Promise<void> {
    await queryClient.invalidateQueries({ queryKey: SPACES_QUERY_KEY })
  }

  function confirmDemoteSelf(member: SpaceMember, role: SpaceRole): void {
    setPending({
      title: text.confirmDemoteSelf(role),
      description: text.demoteSelfDescription,
      confirmLabel: text.change,
      destructive: true,
      run: async () => {
        await changeMemberRole(spaceId, member.user.id, role)
        await refresh()
      },
      returnFocus: focusTitle,
    })
  }

  function confirmRemove(member: SpaceMember): void {
    const self = member.user.id === selfId
    setPending({
      title: self ? text.confirmRemoveSelf : text.confirmRemove(messages.colleagues.name(member.user)),
      description: self ? text.removeSelfDescription : text.removeDescription,
      confirmLabel: text.remove,
      destructive: true,
      run: async () => {
        try {
          await removeMember(spaceId, member.user.id)
        }
        catch (error) {
          // 已经被别人移出（404）：先刷新成员列表（这一行随之消失），再在弹窗里说明原因（审查 B12）
          if (isMissingResource(error))
            await refresh()
          throw error
        }
        if (!self) {
          await refresh()
          return
        }
        // 移出了自己：这个空间可能已经看不到了，回到首页。离开之前先去掉它的缓存（包括正在显示的成员表）：
        // 回来时从加载开始，不先显示还能管理的旧页面
        forgetSpace(queryClient, spaceId, { leaving: true })
        await navigate(HOME_PATH)
        await refresh()
      },
      returnFocus: focusTitle,
    })
  }

  if (list.items.length === 0)
    return <p className="rounded-lg border border-dashed p-8 text-center text-muted-foreground">{text.empty}</p>
  return (
    <>
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
      <ConfirmDialog pending={pending} onClose={() => setPending(undefined)} />
    </>
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

/**
 * 成员页的内容：加载中；看不到（与不存在一致）；个人空间（没有成员）；加载失败（可以重试）；成员表。
 * 先看错误、再看数据：重新请求失败时 TanStack Query 保留上一次的数据。已打开的页面里被移出了空间，缓存里还是能管理的成员表，
 * 重新请求得到 404 就按看不到显示，管理的控件不再出现（审查 B1）；导航与这个空间的缓存随之更新。
 */
function MembersContent({ spaceId }: { readonly spaceId: string }) {
  const list = useQuery(membersQueryOptions(spaceId))
  const session = useQuery(sessionQueryOptions())
  const titleRef = useRef<HTMLHeadingElement>(null)
  const missing = isMissingResource(list.error)
  useForgetMissingSpace(spaceId, missing)
  if (list.isPending) {
    return (
      <div role="status" aria-label={text.loading} className="flex flex-col gap-3">
        {['first', 'second', 'third'].map(row => <Skeleton key={row} className="h-10 w-full" />)}
      </div>
    )
  }
  if (missing) {
    return (
      <Alert variant="destructive">
        <AlertDescription>{messages.spaces.notFound}</AlertDescription>
      </Alert>
    )
  }
  // 看得到这个空间却不能查看成员：只有个人空间的所有者会这样，重试也一样，不给重试
  if (isPermissionDeniedError(list.error)) {
    return (
      <Alert>
        <AlertDescription>{text.personalSpace}</AlertDescription>
      </Alert>
    )
  }
  if (list.data === undefined) {
    return (
      <Alert variant="destructive">
        <AlertDescription>
          <p>{text.loadFailed}</p>
          <p>{describeError(list.error).message}</p>
          <Button variant="outline" size="sm" className="mt-2" onClick={() => void list.refetch()}>{messages.common.retry}</Button>
        </AlertDescription>
      </Alert>
    )
  }
  const { space } = list.data
  return (
    <section className="flex flex-col gap-4" aria-labelledby="members-title">
      <div className="flex flex-wrap items-start justify-between gap-3">
        {/* tabIndex -1：只能由程序聚焦（确认的弹窗关闭之后），Tab 键不经过它 */}
        <h1 ref={titleRef} id="members-title" tabIndex={-1} className="text-xl font-semibold outline-none focus-visible:ring-3 focus-visible:ring-ring/50">{text.title(space.name)}</h1>
        <BackLink spaceId={spaceId} />
      </div>
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

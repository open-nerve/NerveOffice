import type { SpaceMember, SpaceMemberListResponse, SpaceRole, UserSummary } from '@nerve-office/contracts'
import type { PendingConfirmation } from '../confirmation/index.ts'
import { SPACE_ROLES } from '@nerve-office/contracts'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useId, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { ApiError, describeError } from '../../shared/api/index.ts'
import { messages } from '../../shared/i18n/index.ts'
import { ADMIN_PATHS } from '../../shared/lib/admin-paths.ts'
import { HOME_PATH, spacePath } from '../../shared/lib/space-paths.ts'
import { Alert, AlertDescription, Badge, Button, buttonVariants, Label, NativeSelect, Skeleton, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../shared/ui/index.ts'
import { sessionQueryOptions } from '../auth/index.ts'
import { ColleaguePicker } from '../colleagues/index.ts'
import { ConfirmDialog } from '../confirmation/index.ts'
import { SPACES_QUERY_KEY, spacesQueryOptions } from '../spaces/index.ts'
import { addMember, changeMemberRole, membersQueryOptions, removeMember } from './members-api.ts'

const text = messages.members

/** 看不到与不存在的空间（404；地址里的 id 不合法时 400）：同一句说明 */
function isMissing(error: unknown): boolean {
  return error instanceof ApiError && (error.code === 'NOT_FOUND' || error.code === 'REQUEST_INVALID')
}

/** 添加成员：按名字选一个同事、选角色；已经是成员的人不作为候选 */
function AddMemberForm({ spaceId, members }: { readonly spaceId: string, readonly members: readonly SpaceMember[] }) {
  const queryClient = useQueryClient()
  const [user, setUser] = useState<UserSummary>()
  const [role, setRole] = useState<SpaceRole>('viewer')
  const roleId = useId()
  const mutation = useMutation({
    mutationFn: async (userId: string) => addMember(spaceId, { userId, role }),
    onSuccess: async () => {
      setUser(undefined)
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
        <ColleaguePicker label={text.add} selected={user} onSelect={setUser} exclude={new Set(members.map(member => member.user.id))} />
      </div>
      <div className="flex w-36 flex-col gap-2">
        <Label htmlFor={roleId}>{text.role}</Label>
        <NativeSelect id={roleId} value={role} onChange={event => setRole(event.target.value as SpaceRole)}>
          {[...SPACE_ROLES].reverse().map(value => <option key={value} value={value}>{messages.spaces.roleName(value)}</option>)}
        </NativeSelect>
      </div>
      <Button type="submit" aria-disabled={user === undefined || mutation.isPending}>{mutation.isPending ? text.adding : text.add}</Button>
      {mutation.isError && (
        <Alert variant="destructive" className="basis-full">
          <AlertDescription>{describeError(mutation.error).message}</AlertDescription>
        </Alert>
      )}
    </form>
  )
}

/** 成员表：能管理时角色可以改、可以移出；降低或移出自己先确认 */
function MembersTable({ spaceId, list, selfId }: { readonly spaceId: string, readonly list: SpaceMemberListResponse, readonly selfId: string | undefined }) {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const [pending, setPending] = useState<PendingConfirmation>()
  const change = useMutation({
    mutationFn: async ({ userId, role }: { readonly userId: string, readonly role: SpaceRole }) => changeMemberRole(spaceId, userId, role),
    onSettled: async () => queryClient.invalidateQueries({ queryKey: SPACES_QUERY_KEY }),
  })

  async function refresh(): Promise<void> {
    await queryClient.invalidateQueries({ queryKey: SPACES_QUERY_KEY })
  }

  function chooseRole(member: SpaceMember, role: SpaceRole): void {
    if (change.isPending || role === member.role)
      return
    // 空间管理员降低自己：改完立即失去管理的权限，先确认；失败的原因显示在确认的弹窗里
    if (member.user.id === selfId && member.role === 'admin') {
      setPending({
        title: text.confirmDemoteSelf(role),
        description: text.demoteSelfDescription,
        confirmLabel: text.change,
        destructive: true,
        run: async () => {
          await changeMemberRole(spaceId, member.user.id, role)
          await refresh()
        },
      })
      return
    }
    change.mutate({ userId: member.user.id, role })
  }

  function confirmRemove(member: SpaceMember): void {
    const self = member.user.id === selfId
    setPending({
      title: self ? text.confirmRemoveSelf : text.confirmRemove(messages.colleagues.name(member.user)),
      description: self ? text.removeSelfDescription : text.removeDescription,
      confirmLabel: text.remove,
      destructive: true,
      run: async () => {
        await removeMember(spaceId, member.user.id)
        // 移出了自己：这个空间可能已经看不到了，回到首页
        if (self)
          await navigate(HOME_PATH)
        await refresh()
      },
    })
  }

  if (list.items.length === 0)
    return <p className="rounded-lg border border-dashed p-8 text-center text-muted-foreground">{text.empty}</p>
  return (
    <>
      {change.isError && (
        <Alert variant="destructive">
          <AlertDescription>{describeError(change.error).message}</AlertDescription>
        </Alert>
      )}
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
          {list.items.map((member) => {
            const name = messages.colleagues.name(member.user)
            return (
              <TableRow key={member.user.id}>
                <TableCell className="font-medium">
                  {name}
                  {member.user.id === selfId && text.you}
                </TableCell>
                <TableCell>
                  {list.canManage
                    ? (
                        <NativeSelect aria-label={text.roleOf(name)} value={member.role} onChange={event => chooseRole(member, event.target.value as SpaceRole)}>
                          {[...SPACE_ROLES].reverse().map(value => <option key={value} value={value}>{messages.spaces.roleName(value)}</option>)}
                        </NativeSelect>
                      )
                    : messages.spaces.roleName(member.role)}
                </TableCell>
                <TableCell>
                  {member.status === 'disabled' ? <Badge variant="destructive">{text.disabled}</Badge> : <Badge variant="secondary">{messages.admin.statusName(member.status)}</Badge>}
                </TableCell>
                {list.canManage && (
                  <TableCell>
                    <Button variant="ghost" size="sm" aria-label={messages.admin.actionOn(text.remove, name)} onClick={() => confirmRemove(member)}>{text.remove}</Button>
                  </TableCell>
                )}
              </TableRow>
            )
          })}
        </TableBody>
      </Table>
      <ConfirmDialog pending={pending} onClose={() => setPending(undefined)} />
    </>
  )
}

/** 返回的去处：看得到这个空间就回空间页；没有加入的系统管理员回到管理界面的团队空间 */
function BackLink({ spaceId }: { readonly spaceId: string }) {
  const spaces = useQuery(spacesQueryOptions())
  const session = useQuery(sessionQueryOptions())
  if (spaces.data?.items.some(space => space.id === spaceId) === true)
    return <Link to={spacePath(spaceId)} className={buttonVariants({ variant: 'outline' })}>{text.backToSpace}</Link>
  if (session.data?.user.systemRole === 'admin')
    return <Link to={ADMIN_PATHS.spaces} className={buttonVariants({ variant: 'outline' })}>{text.backToAdmin}</Link>
  return null
}

function MembersContent({ spaceId }: { readonly spaceId: string }) {
  const list = useQuery(membersQueryOptions(spaceId))
  const session = useQuery(sessionQueryOptions())
  if (list.isPending) {
    return (
      <div role="status" aria-label={text.loading} className="flex flex-col gap-3">
        {['first', 'second', 'third'].map(row => <Skeleton key={row} className="h-10 w-full" />)}
      </div>
    )
  }
  if (list.data === undefined) {
    const missing = isMissing(list.error)
    return (
      <Alert variant="destructive">
        <AlertDescription>
          {missing ? messages.spaces.notFound : <p>{text.loadFailed}</p>}
          {!missing && <p>{describeError(list.error).message}</p>}
          {!missing && <Button variant="outline" size="sm" className="mt-2" onClick={() => void list.refetch()}>{messages.common.retry}</Button>}
        </AlertDescription>
      </Alert>
    )
  }
  const { space } = list.data
  return (
    <section className="flex flex-col gap-4" aria-labelledby="members-title">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <h1 id="members-title" className="text-xl font-semibold">{text.title(space.name)}</h1>
        <BackLink spaceId={spaceId} />
      </div>
      {!list.data.canManage && (
        <Alert>
          <AlertDescription>{space.status === 'archived' ? text.archivedReadOnly : text.readOnly}</AlertDescription>
        </Alert>
      )}
      {list.data.canManage && <AddMemberForm spaceId={spaceId} members={list.data.items} />}
      <MembersTable spaceId={spaceId} list={list.data} selfId={session.data?.user.id} />
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

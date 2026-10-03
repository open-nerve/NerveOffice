import type { AdminSpace, SpaceStatus, UserSummary } from '@nerve-office/contracts'
import type { BackgroundRefresh } from '../../shared/api/write-outcome.ts'
import type { PendingConfirmation } from '../confirmation/index.ts'
import type { PagedTableHandle } from './paged-table.tsx'
import { SPACE_STATUSES, spaceNameSchema } from '@nerve-office/contracts'
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useId, useRef, useState } from 'react'
import { Link } from 'react-router'
import { ApiError, describeError, isUnknownOutcome } from '../../shared/api/index.ts'
import { refreshAfterSuccess } from '../../shared/api/write-outcome.ts'
import { messages } from '../../shared/i18n/index.ts'
import { adminMessages } from '../../shared/i18n/zh-cn/admin.ts'
import { formatDateTime } from '../../shared/lib/format.ts'
import { updatePagedItems } from '../../shared/lib/paged-cache.ts'
import { refreshQueries } from '../../shared/lib/refresh-queries.ts'
import { spaceMembersPath } from '../../shared/lib/space-paths.ts'
import { useDebouncedValue } from '../../shared/lib/use-debounced-value.ts'
import { useDocumentTitle } from '../../shared/lib/use-document-title.ts'
import { useOutcomeRefresh } from '../../shared/lib/use-outcome-refresh.ts'
import { Alert, AlertDescription, Badge, Button, buttonVariants, Input, Label, NativeSelect, TableCell } from '../../shared/ui/index.ts'
import { SYSTEM_ADMIN_ONLY } from '../auth/index.ts'
import { ColleaguePicker } from '../colleagues/index.ts'
import { ConfirmDialog } from '../confirmation/index.ts'
import { SPACES_QUERY_KEY } from '../spaces/index.ts'
import { ADMIN_QUERY_KEY, adminSpacesQueryOptions, archiveSpace, createTeamSpace, restoreSpace, setSpaceVisibility } from './admin-api.ts'
import { PagedTable, StillRefreshingLine } from './paged-table.tsx'
import { JoinSpaceDialog, RenameSpaceDialog } from './space-dialogs.tsx'

const text = adminMessages.spaces

/** 管理界面的团队空间列表（各种搜索与过滤条件下的各页） */
const ADMIN_SPACES_QUERY_KEY = [...ADMIN_QUERY_KEY, 'spaces'] as const

/** 管理界面的团队空间列表与左侧导航（"我能看到的空间"等）：加入、改名、全员可见、归档会改变谁看得到什么 */
const LIST_QUERY_KEYS = [ADMIN_SPACES_QUERY_KEY, SPACES_QUERY_KEY] as const

/** 已有同名的团队空间 */
function isNameTaken(error: unknown): boolean {
  return error instanceof ApiError && error.code === 'SPACE_NAME_TAKEN'
}

interface CreateSpaceFormProps {
  /**
   * 创建成功之后刷新列表与导航：最多等到时限（Codex 对抗评审 CX4），一直不回来时表格上方说列表还在刷新；刷新失败时列表自己说明没能刷新
   */
  readonly onCreated: () => Promise<void>
  /** 结果未知之后刷新同样的列表与导航：刷新失败时拒绝，说明据此说"没能刷新"（M2-P6 复核第四批） */
  readonly refreshAfterUnknown: () => Promise<void>
}

/**
 * 创建团队空间：名称、首个空间管理员（按名字选同事）、是否全员可见。
 * 结果未知时空间可能已经建好（M2-P6 复核 S1）：列表随即刷新，说明下面的列表里有它就是建好了；结果未知之后用同一个名称再创建
 * 得到"已有同名"，多半就是刚才那一次，同样刷新并说明。比较的两边都是经契约解析过的名称（规范写法）。
 * 这两种情形的刷新经共用的做法（shared/api/write-outcome.ts，第四批）：最多等 10 秒，刷新失败或者到了时限还没回来，说明里说
 * "列表没能刷新"，按钮也不一直停在"正在创建…"；超时之后刷新才回来的，说明随后改过来（第五批 G4）
 */
function CreateSpaceForm({ onCreated, refreshAfterUnknown }: CreateSpaceFormProps) {
  const [name, setName] = useState('')
  const [admin, setAdmin] = useState<UserSummary>()
  const [visibleToAll, setVisibleToAll] = useState(false)
  // 创建成功之后换一个 key，同事选择整个重新开始：关键词与上一次的候选都清掉（与成员页的添加一样，审查 B11）
  const [pickerKey, setPickerKey] = useState(0)
  /** 结果未知的那一次创建用的名称：空间可能已经建好了。成功创建之后清掉 */
  const [unsureName, setUnsureName] = useState<string>()
  /** 上一次失败之后列表刷新好了没有：说明据此说"已刷新"还是"没能刷新"（第四批）。每次失败都重新记下 */
  const { refreshed, refreshAfterFailure } = useOutcomeRefresh()
  const nameId = useId()
  const visibleId = useId()
  const hintId = useId()
  const mutation = useMutation({
    mutationFn: createTeamSpace,
    meta: SYSTEM_ADMIN_ONLY,
    onSuccess: async () => {
      setName('')
      setAdmin(undefined)
      setPickerKey(key => key + 1)
      setVisibleToAll(false)
      setUnsureName(undefined)
      await onCreated()
    },
    onError: async (error, request) => {
      if (isUnknownOutcome(error))
        setUnsureName(request.name)
      await refreshAfterFailure(error, refreshAfterUnknown, { also: failure => isNameTaken(failure) && request.name === unsureName })
    },
  })
  const parsed = spaceNameSchema.safeParse(name)
  // 还不能创建的原因：没有选首个空间管理员，或者名称不合规（审查 B5）
  let blocked: string | undefined
  if (admin === undefined)
    blocked = text.pickAdmin
  else if (!parsed.success)
    blocked = parsed.error.issues.map(issue => issue.message).join('；')

  return (
    <form
      className="flex flex-col gap-3 rounded-lg border p-4"
      aria-label={text.create}
      onSubmit={(event) => {
        event.preventDefault()
        if (parsed.success && admin !== undefined && !mutation.isPending)
          mutation.mutate({ name: parsed.data, adminUserId: admin.id, visibleToAll })
      }}
    >
      <div className="flex flex-wrap items-start gap-3">
        <div className="flex min-w-48 flex-1 flex-col gap-2">
          <Label htmlFor={nameId}>{text.name}</Label>
          <Input id={nameId} value={name} onChange={event => setName(event.target.value)} />
        </div>
        <div className="min-w-56 flex-1">
          <ColleaguePicker key={pickerKey} label={text.admin} selected={admin} onSelect={setAdmin} />
        </div>
      </div>
      <div className="flex items-center gap-2">
        <input id={visibleId} type="checkbox" className="size-4" checked={visibleToAll} onChange={event => setVisibleToAll(event.target.checked)} />
        <Label htmlFor={visibleId}>{text.visibleToAll}</Label>
      </div>
      {mutation.isError && (
        <Alert variant="destructive">
          <AlertDescription>{createFailureText(mutation.error, mutation.variables?.name, unsureName, refreshed)}</AlertDescription>
        </Alert>
      )}
      {/* aria-disabled 的按钮读屏软件读出"不可用"，却不知道为什么：原因写在按钮下方，按钮经 aria-describedby 指向它 */}
      <Button type="submit" className="self-start" aria-disabled={blocked !== undefined || mutation.isPending} aria-describedby={blocked === undefined ? undefined : hintId}>
        {mutation.isPending ? text.creating : text.create}
      </Button>
      {blocked !== undefined && <p id={hintId} className="text-sm text-muted-foreground">{blocked}</p>}
    </form>
  )
}

/**
 * 创建失败时的说明：结果未知、结果未知之后同一个名称"已有同名"（多半就是那一次），其余按错误码。
 * refreshed：前两种情形之后列表刷新好了没有（第四批）
 */
function createFailureText(error: unknown, name: string | undefined, unsureName: string | undefined, refreshed: boolean): string {
  if (isUnknownOutcome(error))
    return text.createOutcomeUnknown(describeError(error).message, refreshed)
  if (isNameTaken(error) && name !== undefined && name === unsureName)
    return text.createRetryTaken(refreshed)
  return describeError(error).message
}

/**
 * 管理界面：团队空间（M2-P2 设计 §3.10，US-M2-05）。创建（连同首个空间管理员）；按名称搜索、按状态过滤；
 * 改名、全员可见的开关、归档与恢复（先确认）；"成员"进入成员页；没有加入的空间可以"加入空间"（选角色，记审计）。
 */
export function AdminSpacesPage() {
  useDocumentTitle(adminMessages.pageTitle(adminMessages.nav.spaces))
  const queryClient = useQueryClient()
  const [keyword, setKeyword] = useState('')
  const [status, setStatus] = useState<SpaceStatus | ''>('')
  const query = useDebouncedValue(keyword.trim())
  const spaces = useInfiniteQuery(adminSpacesQueryOptions({ query: query === '' ? undefined : query, status: status === '' ? undefined : status }))
  const [pending, setPending] = useState<PendingConfirmation>()
  const [renaming, setRenaming] = useState<AdminSpace>()
  const [joining, setJoining] = useState<AdminSpace>()
  /** 写操作成功之后、到了时限还在后台的刷新（Codex 对抗评审 CX4）：表格上方说列表还在刷新 */
  const [background, setBackground] = useState<BackgroundRefresh>()
  const tableRef = useRef<PagedTableHandle>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const searchId = useId()
  const statusId = useId()

  /**
   * 成功之后管理界面的列表与导航（加入、改名、全员可见会改变谁看得到什么）一起刷新，最多等到时限（Codex 对抗评审 CX4）：
   * 一直不回来时操作照常结束（弹窗关掉、表单清空），表格上方说列表还在刷新；刷新失败时列表自己说明没能刷新（CX5）。
   * 换了过滤条件、过滤的请求还在路上时创建成功，那个请求也重来（第五批 G6，shared/lib/refresh-queries.ts）
   */
  async function refresh(): Promise<void> {
    setBackground(await refreshAfterSuccess(async () => refreshQueries(queryClient, LIST_QUERY_KEYS)))
  }

  /**
   * 结果未知之后的刷新（弹窗与创建的表单）：同样的列表与导航，刷新失败时拒绝，据此说明页面没能刷新（M2-P6 复核第三批 G-a、第四批）
   */
  async function refreshAfterUnknown(): Promise<void> {
    await refreshQueries(queryClient, LIST_QUERY_KEYS)
  }

  function focusRow(space: AdminSpace): void {
    if (!(tableRef.current?.focusRow(space.id) ?? false))
      searchRef.current?.focus()
  }

  function focusRowOf(space: AdminSpace | undefined): void {
    if (space !== undefined)
      focusRow(space)
  }

  /**
   * 全员可见、归档与恢复：先确认，再执行。成功之后先按响应换上这一行（打开确认框的按钮随之换掉，CX4），再刷新。
   * 结果未知时确认的弹窗刷新列表与导航、说明可能已经生效（M2-P6 复核第二批 G-2）
   */
  function confirmThen(space: AdminSpace, confirmation: Omit<PendingConfirmation, 'run' | 'refresh' | 'returnFocus'>, action: () => Promise<AdminSpace>): void {
    setPending({
      ...confirmation,
      run: async () => {
        const updated = await action()
        updatePagedItems<AdminSpace>(queryClient, ADMIN_SPACES_QUERY_KEY, item => (item.id === updated.id ? updated : item))
        await refresh()
      },
      refresh: refreshAfterUnknown,
      returnFocus: () => focusRow(space),
    })
  }

  function actionsOf(space: AdminSpace) {
    const on = (action: string) => messages.common.actionOn(action, space.name)
    return (
      <div className="flex flex-wrap gap-1">
        <Link to={spaceMembersPath(space.id)} aria-label={on(text.members)} className={buttonVariants({ variant: 'ghost', size: 'sm' })}>{text.members}</Link>
        <Button variant="ghost" size="sm" aria-label={on(text.rename)} onClick={() => setRenaming(space)}>{text.rename}</Button>
        {space.visibleToAll
          ? <Button variant="ghost" size="sm" aria-label={on(text.hideFromAll)} onClick={() => confirmThen(space, { title: text.confirmHide(space.name), description: text.hideDescription, confirmLabel: text.hideFromAll }, async () => setSpaceVisibility(space.id, false))}>{text.hideFromAll}</Button>
          : <Button variant="ghost" size="sm" aria-label={on(text.showToAll)} onClick={() => confirmThen(space, { title: text.confirmShow(space.name), description: text.showDescription, confirmLabel: text.showToAll }, async () => setSpaceVisibility(space.id, true))}>{text.showToAll}</Button>}
        {space.status === 'active'
          ? <Button variant="ghost" size="sm" aria-label={on(text.archive)} onClick={() => confirmThen(space, { title: text.confirmArchive(space.name), description: text.archiveDescription, confirmLabel: text.archive, destructive: true }, async () => archiveSpace(space.id))}>{text.archive}</Button>
          : <Button variant="ghost" size="sm" aria-label={on(text.restore)} onClick={() => confirmThen(space, { title: text.confirmRestore(space.name), description: text.restoreDescription, confirmLabel: text.restore }, async () => restoreSpace(space.id))}>{text.restore}</Button>}
        {space.myRole === null && <Button variant="ghost" size="sm" aria-label={on(text.join)} onClick={() => setJoining(space)}>{text.join}</Button>}
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      <CreateSpaceForm onCreated={refresh} refreshAfterUnknown={refreshAfterUnknown} />
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex min-w-48 flex-1 flex-col gap-2">
          <Label htmlFor={searchId}>{text.search}</Label>
          <Input ref={searchRef} id={searchId} type="search" value={keyword} onChange={event => setKeyword(event.target.value)} />
        </div>
        <div className="flex w-36 flex-col gap-2">
          <Label htmlFor={statusId}>{text.statusFilter}</Label>
          <NativeSelect id={statusId} value={status} onChange={event => setStatus(event.target.value as SpaceStatus | '')}>
            <option value="">{messages.common.all}</option>
            {SPACE_STATUSES.map(value => <option key={value} value={value}>{text.statusName(value)}</option>)}
          </NativeSelect>
        </div>
      </div>
      <StillRefreshingLine background={background} />
      <PagedTable
        ref={tableRef}
        query={spaces}
        label={text.listLabel}
        texts={text}
        columns={[text.columns.name, text.columns.status, text.columns.visibility, text.columns.members, text.columns.myRole, text.columns.createdAt, text.columns.actions]}
        rowKey={space => space.id}
        renderCells={space => (
          <>
            <TableCell className="font-medium">{space.name}</TableCell>
            <TableCell><Badge variant={space.status === 'active' ? 'secondary' : 'outline'}>{text.statusName(space.status)}</Badge></TableCell>
            <TableCell>{space.visibleToAll ? text.visibleYes : text.visibleNo}</TableCell>
            <TableCell>{space.memberCount}</TableCell>
            <TableCell>{space.myRole === null ? text.notJoined : messages.spaces.roleName(space.myRole)}</TableCell>
            <TableCell className="whitespace-nowrap"><time dateTime={space.createdAt}>{formatDateTime(space.createdAt)}</time></TableCell>
            <TableCell>{actionsOf(space)}</TableCell>
          </>
        )}
      />
      <ConfirmDialog pending={pending} onClose={() => setPending(undefined)} meta={SYSTEM_ADMIN_ONLY} />
      <RenameSpaceDialog space={renaming} onDone={refresh} refresh={refreshAfterUnknown} onClose={() => setRenaming(undefined)} returnFocus={() => focusRowOf(renaming)} />
      <JoinSpaceDialog space={joining} onDone={refresh} refresh={refreshAfterUnknown} onClose={() => setJoining(undefined)} returnFocus={() => focusRowOf(joining)} />
    </div>
  )
}

import type { AdminSpace, AdminUser, TransferTarget, UserSummary } from '@nerve-office/contracts'
import type { KeywordPickerTexts } from '../colleagues/index.ts'
import type { PendingConfirmation } from '../confirmation/index.ts'
import { TRANSFER_MAX_DOCUMENTS } from '@nerve-office/contracts'
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query'
import { useId, useRef, useState } from 'react'
import { Link, useParams } from 'react-router'
import { describeError, isMissingResource } from '../../shared/api/index.ts'
import { messages } from '../../shared/i18n/index.ts'
import { ADMIN_PATHS } from '../../shared/lib/admin-paths.ts'
import { cn } from '../../shared/lib/cn.ts'
import { formatDateTime } from '../../shared/lib/format.ts'
import { Alert, AlertDescription, Button, buttonVariants, Label, Skeleton, TableCell } from '../../shared/ui/index.ts'
import { sessionQueryOptions, SYSTEM_ADMIN_ONLY } from '../auth/index.ts'
import { ColleaguePicker, KeywordPicker } from '../colleagues/index.ts'
import { ConfirmDialog } from '../confirmation/index.ts'
import { adminUserQueryOptions, transferDocuments, transferTargetsQueryOptions, userDocumentsQueryOptions } from './admin-api.ts'
import { PagedTable } from './paged-table.tsx'

const text = messages.admin.transfer

/** 找目标团队空间：按名称找没有归档的团队空间（与按名字选同事同一个组件，审查 B13） */
const TEAM_TEXTS: KeywordPickerTexts = { placeholder: text.searchTeam, candidates: text.teamCandidates, searching: text.searchingTeam, none: text.noTeam, failed: text.teamSearchFailed }

function spaceId(space: AdminSpace): string {
  return space.id
}

function spaceName(space: AdminSpace): string {
  return space.name
}

/** 转移的表单：选文档（最多 100 份）、选目标、确认之后整批转移 */
function TransferForm({ account }: { readonly account: AdminUser }) {
  const queryClient = useQueryClient()
  const session = useQuery(sessionQueryOptions())
  const documentsQuery = userDocumentsQueryOptions(account.id)
  const documents = useInfiniteQuery(documentsQuery)
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set())
  const [targetType, setTargetType] = useState<TransferTarget['type']>('team')
  const [person, setPerson] = useState<UserSummary>()
  const [team, setTeam] = useState<AdminSpace>()
  const [pending, setPending] = useState<PendingConfirmation>()
  const [done, setDone] = useState<string>()
  const submitRef = useRef<HTMLButtonElement>(null)
  const groupId = useId()
  const hintId = useId()
  const loaded = documents.data?.pages.flatMap(page => page.items) ?? []
  const allSelected = loaded.length > 0 && loaded.every(document => selected.has(document.id))
  // 目标不能是这个停用的人自己，也不能是操作者本人的个人空间（服务端同样拒绝，M2-P2 审查 A7）
  const selfId = session.data?.user.id
  const excludedPeople = new Set(selfId === undefined ? [account.id] : [account.id, selfId])

  function toggle(id: string, checked: boolean): void {
    const next = new Set(selected)
    if (checked)
      next.add(id)
    else
      next.delete(id)
    setSelected(next)
  }

  /**
   * 转移失败（例如有文档已经被别人转走了）之后，刷新标题列表，清掉已经不在列表里的选中项，列表与选择都是服务端的实际状态（审查 B12）。
   * 刷新本身失败时列表不变，选择也不动
   */
  async function refreshAfterFailure(): Promise<void> {
    await queryClient.invalidateQueries({ queryKey: documentsQuery.queryKey })
    const pages = queryClient.getQueryData(documentsQuery.queryKey)?.pages ?? []
    const present = new Set(pages.flatMap(page => page.items.map(document => document.id)))
    setSelected(previous => new Set([...previous].filter(id => present.has(id))))
  }

  const target: { readonly request: TransferTarget, readonly label: string } | undefined = targetType === 'personal'
    ? person === undefined ? undefined : { request: { type: 'personal', userId: person.id }, label: text.personalTarget(messages.colleagues.name(person)) }
    : team === undefined ? undefined : { request: { type: 'team', spaceId: team.id }, label: team.name }
  const tooMany = selected.size > TRANSFER_MAX_DOCUMENTS
  let blocked: string | undefined
  if (selected.size === 0)
    blocked = text.pickDocuments
  else if (tooMany)
    blocked = text.tooMany(TRANSFER_MAX_DOCUMENTS)
  else if (target === undefined)
    blocked = text.pickTarget

  function submit(): void {
    if (blocked !== undefined || target === undefined)
      return
    const documentIds = [...selected]
    setPending({
      title: text.confirm(documentIds.length, target.label),
      description: text.confirmDescription,
      confirmLabel: text.submit,
      run: async () => {
        try {
          const result = await transferDocuments(account.id, { documentIds, target: target.request })
          setSelected(new Set())
          setDone(text.done(result.transferred, target.label))
          await queryClient.invalidateQueries({ queryKey: documentsQuery.queryKey })
        }
        catch (error) {
          // 失败的原因由确认的弹窗显示
          await refreshAfterFailure()
          throw error
        }
      },
      // WebKit 点按钮时不聚焦按钮，打开之前的焦点记不下来：关闭之后焦点回到"转移"（它一直在，审查 B2）
      returnFocus: () => submitRef.current?.focus(),
    })
  }

  return (
    <div className="flex flex-col gap-4">
      {/* 结果的说明：容器一直在（空的时候没有内容），结果出来时往里填文字，读屏软件才会播报（审查 B10） */}
      <p role="status" className={cn('text-sm', done !== undefined && 'rounded-lg border p-3')}>{done}</p>
      {loaded.length > 0 && (
        <div className="flex items-center gap-2">
          <input
            id={`${groupId}-all`}
            type="checkbox"
            className="size-4"
            checked={allSelected}
            onChange={event => setSelected(event.target.checked ? new Set(loaded.map(document => document.id)) : new Set())}
          />
          <Label htmlFor={`${groupId}-all`}>{text.selectAll}</Label>
        </div>
      )}
      <PagedTable
        query={documents}
        label={text.listLabel}
        texts={text}
        columns={[text.columns.select, text.columns.title, text.columns.type, text.columns.updatedAt]}
        rowKey={document => document.id}
        renderCells={document => (
          <>
            <TableCell className="w-8">
              <input type="checkbox" className="size-4" aria-label={text.select(document.title)} checked={selected.has(document.id)} onChange={event => toggle(document.id, event.target.checked)} />
            </TableCell>
            <TableCell className="font-medium">{document.title}</TableCell>
            <TableCell>{messages.documents.typeName(document.type)}</TableCell>
            <TableCell className="whitespace-nowrap"><time dateTime={document.updatedAt}>{formatDateTime(document.updatedAt)}</time></TableCell>
          </>
        )}
      />
      <p className="text-sm text-muted-foreground" aria-live="polite">{text.selected(selected.size, TRANSFER_MAX_DOCUMENTS)}</p>
      <fieldset className="flex flex-col gap-3 rounded-lg border p-4">
        <legend className="px-1 text-sm font-medium">{text.targetLegend}</legend>
        <div className="flex flex-wrap gap-4">
          {(['team', 'personal'] as const).map(type => (
            <label key={type} className="flex items-center gap-2 text-sm">
              <input type="radio" name={groupId} value={type} checked={targetType === type} onChange={() => setTargetType(type)} />
              {type === 'team' ? text.toTeam : text.toPersonal}
            </label>
          ))}
        </div>
        {targetType === 'team'
          ? <KeywordPicker label={text.pickTeam} selected={team} onSelect={setTeam} search={transferTargetsQueryOptions} itemKey={spaceId} itemName={spaceName} texts={TEAM_TEXTS} />
          : <ColleaguePicker label={text.pickPerson} selected={person} onSelect={setPerson} exclude={excludedPeople} />}
      </fieldset>
      {/* 还不能转移时说明原因，按钮经 aria-describedby 指向它（审查 B5） */}
      {blocked !== undefined && <p id={hintId} className="text-sm text-muted-foreground">{blocked}</p>}
      <Button ref={submitRef} className="self-start" aria-disabled={blocked !== undefined} aria-describedby={blocked === undefined ? undefined : hintId} onClick={submit}>{text.submit}</Button>
      <ConfirmDialog pending={pending} onClose={() => setPending(undefined)} meta={SYSTEM_ADMIN_ONLY} />
    </div>
  )
}

/**
 * 管理界面：转移停用者的文档（M2-P2 设计 §3.8、§3.10，US-M2-04）。只看得到标题，打不开内容；
 * 选文档（分页、全选已加载的，一次最多 100 份）、选目标（某人的个人空间或没有归档的团队空间），确认之后整批转移。
 */
export function AdminTransferPage() {
  const { userId = '' } = useParams()
  const account = useQuery(adminUserQueryOptions(userId))
  const back = <Link to={ADMIN_PATHS.users} className={buttonVariants({ variant: 'outline' })}>{text.back}</Link>
  if (account.isPending) {
    return (
      <div role="status" aria-label={text.loadingAccount} className="flex flex-col gap-3">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-10 w-full" />
      </div>
    )
  }
  if (isMissingResource(account.error)) {
    return (
      <div className="flex flex-col items-start gap-3">
        <Alert variant="destructive">
          <AlertDescription>{messages.errors.byCode('NOT_FOUND', '')}</AlertDescription>
        </Alert>
        {back}
      </div>
    )
  }
  if (account.data === undefined) {
    // 网络与服务端的临时错误：可以重试（审查 B5）
    return (
      <div className="flex flex-col items-start gap-3">
        <Alert variant="destructive">
          <AlertDescription>
            <p>{text.loadAccountFailed}</p>
            <p>{describeError(account.error).message}</p>
            <Button variant="outline" size="sm" className="mt-2" onClick={() => void account.refetch()}>{messages.common.retry}</Button>
          </AlertDescription>
        </Alert>
        {back}
      </div>
    )
  }
  const name = messages.colleagues.name(account.data)
  return (
    <section className="flex flex-col gap-4" aria-labelledby="transfer-title">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <h2 id="transfer-title" className="text-lg font-semibold">{text.title(name)}</h2>
        {back}
      </div>
      {account.data.status === 'active'
        ? (
            <Alert>
              <AlertDescription>{messages.errors.byCode('ACCOUNT_NOT_DISABLED', '')}</AlertDescription>
            </Alert>
          )
        : (
            <>
              <p className="text-sm text-muted-foreground">{text.description}</p>
              <TransferForm key={account.data.id} account={account.data} />
            </>
          )}
    </section>
  )
}

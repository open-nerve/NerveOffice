import type { AdminSpace, AdminUser, TransferTarget, UserSummary } from '@nerve-office/contracts'
import type { UseQueryResult } from '@tanstack/react-query'
import type { PendingConfirmation } from '../confirmation/index.ts'
import { TRANSFER_MAX_DOCUMENTS } from '@nerve-office/contracts'
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query'
import { useId, useRef, useState } from 'react'
import { Link, useParams } from 'react-router'
import { ApiError, describeError } from '../../shared/api/index.ts'
import { messages } from '../../shared/i18n/index.ts'
import { ADMIN_PATHS } from '../../shared/lib/admin-paths.ts'
import { formatDateTime } from '../../shared/lib/format.ts'
import { useDebouncedValue } from '../../shared/lib/use-debounced-value.ts'
import { useFocusAfterRender } from '../../shared/lib/use-focus-after-render.ts'
import { Alert, AlertDescription, Badge, Button, buttonVariants, Input, Label, Skeleton, TableCell } from '../../shared/ui/index.ts'
import { SYSTEM_ADMIN_ONLY } from '../auth/index.ts'
import { ColleaguePicker } from '../colleagues/index.ts'
import { ConfirmDialog } from '../confirmation/index.ts'
import { ADMIN_QUERY_KEY, adminUserQueryOptions, transferDocuments, transferTargetsQueryOptions, userDocumentsQueryOptions } from './admin-api.ts'
import { PagedTable } from './paged-table.tsx'

const text = messages.admin.transfer

/** 找团队空间的候选：查找中、失败（可以重试）、没有找到、找到的几个 */
function TeamCandidates({ candidates, onPick }: { readonly candidates: UseQueryResult<AdminSpace[]>, readonly onPick: (space: AdminSpace) => void }) {
  if (candidates.isPending)
    return <p role="status" className="text-sm text-muted-foreground">{text.searchingTeam}</p>
  if (candidates.isError) {
    return (
      <div role="alert" className="flex items-center gap-2 text-sm text-destructive">
        <span>{text.teamSearchFailed(describeError(candidates.error).message)}</span>
        <Button variant="outline" size="sm" onClick={() => void candidates.refetch()}>{messages.common.retry}</Button>
      </div>
    )
  }
  if (candidates.data.length === 0)
    return <p role="status" className="text-sm text-muted-foreground">{text.noTeam}</p>
  return (
    <ul aria-label={text.toTeam} className="flex flex-wrap gap-1">
      {candidates.data.map(space => (
        <li key={space.id}>
          <Button type="button" variant="outline" size="sm" onClick={() => onPick(space)}>{space.name}</Button>
        </li>
      ))}
    </ul>
  )
}

/** 选一个没有归档的团队空间（按名称找）；选中之后显示成标签，可以重新选择 */
function TeamSpacePicker({ selected, onSelect }: { readonly selected: AdminSpace | undefined, readonly onSelect: (space: AdminSpace | undefined) => void }) {
  const [keyword, setKeyword] = useState('')
  const query = useDebouncedValue(keyword.trim())
  const candidates = useQuery({ ...transferTargetsQueryOptions(query), enabled: query !== '' && selected === undefined })
  const inputRef = useRef<HTMLInputElement>(null)
  const changeRef = useRef<HTMLButtonElement>(null)
  const focusAfterRender = useFocusAfterRender()
  const inputId = useId()
  if (selected !== undefined) {
    return (
      <span className="inline-flex flex-wrap items-center gap-2">
        <Badge variant="secondary">{messages.colleagues.selected(selected.name)}</Badge>
        <Button
          ref={changeRef}
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => {
            onSelect(undefined)
            setKeyword('')
            focusAfterRender(inputRef)
          }}
        >
          {messages.colleagues.change}
        </Button>
      </span>
    )
  }
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={inputId}>{text.searchTeam}</Label>
      <Input ref={inputRef} id={inputId} type="search" value={keyword} onChange={event => setKeyword(event.target.value)} />
      {query !== '' && (
        <TeamCandidates
          candidates={candidates}
          onPick={(space) => {
            onSelect(space)
            focusAfterRender(changeRef)
          }}
        />
      )}
    </div>
  )
}

/** 转移的表单：选文档（最多 100 份）、选目标、确认之后整批转移 */
function TransferForm({ account }: { readonly account: AdminUser }) {
  const queryClient = useQueryClient()
  const documents = useInfiniteQuery(userDocumentsQueryOptions(account.id))
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set())
  const [targetType, setTargetType] = useState<TransferTarget['type']>('team')
  const [person, setPerson] = useState<UserSummary>()
  const [team, setTeam] = useState<AdminSpace>()
  const [pending, setPending] = useState<PendingConfirmation>()
  const [done, setDone] = useState<string>()
  const groupId = useId()
  const loaded = documents.data?.pages.flatMap(page => page.items) ?? []
  const allSelected = loaded.length > 0 && loaded.every(document => selected.has(document.id))

  function toggle(id: string, checked: boolean): void {
    const next = new Set(selected)
    if (checked)
      next.add(id)
    else
      next.delete(id)
    setSelected(next)
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
        const result = await transferDocuments(account.id, { documentIds, target: target.request })
        setSelected(new Set())
        setDone(text.done(result.transferred, target.label))
        await queryClient.invalidateQueries({ queryKey: [...ADMIN_QUERY_KEY, 'user-documents', account.id] })
      },
    })
  }

  return (
    <div className="flex flex-col gap-4">
      {done !== undefined && <p role="status" className="rounded-lg border p-3 text-sm">{done}</p>}
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
          ? <TeamSpacePicker selected={team} onSelect={setTeam} />
          : <ColleaguePicker label={text.pickPerson} selected={person} onSelect={setPerson} exclude={new Set([account.id])} />}
      </fieldset>
      {blocked !== undefined && selected.size > 0 && <p className="text-sm text-muted-foreground">{blocked}</p>}
      <Button className="self-start" aria-disabled={blocked !== undefined} onClick={submit}>{text.submit}</Button>
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
  if (account.data === undefined) {
    const missing = account.error instanceof ApiError && (account.error.code === 'NOT_FOUND' || account.error.code === 'REQUEST_INVALID')
    return (
      <div className="flex flex-col items-start gap-3">
        <Alert variant="destructive">
          <AlertDescription>{missing ? messages.errors.byCode('NOT_FOUND', '') : describeError(account.error).message}</AlertDescription>
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

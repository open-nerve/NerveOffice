import type { AdminSpace, AdminUser, TransferTarget, UserSummary } from '@nerve-office/contracts'
import type { ReactNode } from 'react'
import type { Phrase as PhraseParts } from '../../shared/i18n/index.ts'
import type { KeywordPickerTexts } from '../colleagues/index.ts'
import type { PendingConfirmation } from '../confirmation/index.ts'
import { TRANSFER_MAX_DOCUMENTS } from '@nerve-office/contracts'
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query'
import { useId, useRef, useState } from 'react'
import { Link, useParams } from 'react-router'
import { ApiError, describeError, isMissingResource, isUnknownOutcome } from '../../shared/api/index.ts'
import { refreshWithin } from '../../shared/api/write-outcome.ts'
import { messages, phraseText } from '../../shared/i18n/index.ts'
import { adminMessages } from '../../shared/i18n/zh-cn/admin.ts'
import { ADMIN_PATHS } from '../../shared/lib/admin-paths.ts'
import { formatDateTime } from '../../shared/lib/format.ts'
import { refreshQueries } from '../../shared/lib/refresh-queries.ts'
import { useDocumentTitle } from '../../shared/lib/use-document-title.ts'
import { Alert, AlertDescription, Button, buttonVariants, Label, PersonName, Phrase, Skeleton, TableCell } from '../../shared/ui/index.ts'
import { StatusRegion } from '../../shared/ui/status-region.tsx'
import { sessionQueryOptions, SYSTEM_ADMIN_ONLY } from '../auth/index.ts'
import { ColleaguePicker, KeywordPicker } from '../colleagues/index.ts'
import { ConfirmDialog } from '../confirmation/index.ts'
import { adminUserQueryOptions, transferDocuments, transferTargetsQueryOptions, userDocumentsQueryOptions } from './admin-api.ts'
import { PagedTable } from './paged-table.tsx'

const text = adminMessages.transfer

/** 找目标团队空间：按名称找没有归档的团队空间（与按名字选同事同一个组件，审查 B13） */
const TEAM_TEXTS: KeywordPickerTexts = { placeholder: text.searchTeam, candidates: text.teamCandidates, searching: text.searchingTeam, none: text.noTeam, failed: text.teamSearchFailed }

function spaceId(space: AdminSpace): string {
  return space.id
}

/** 候选与已选的团队空间：名称用 <bdi> 隔离，从右到左的名称不打乱旁边的字 */
function spaceName(space: AdminSpace): ReactNode {
  return <bdi>{space.name}</bdi>
}

/** 转移的目标：请求、纯文字的叫法（确认框的标题）与界面上的叫法（结果的说明，人名用 PersonName，M2-P6 复核 M2） */
interface Target {
  readonly request: TransferTarget
  readonly text: PhraseParts<string>
  readonly shown: PhraseParts<ReactNode>
}

function targetOf(type: TransferTarget['type'], person: UserSummary | undefined, team: AdminSpace | undefined): Target | undefined {
  if (type === 'personal') {
    return person === undefined
      ? undefined
      : { request: { type: 'personal', userId: person.id }, text: text.personalTarget(messages.people.text(person)), shown: text.personalTarget(<PersonName person={person} />) }
  }
  return team === undefined ? undefined : { request: { type: 'team', spaceId: team.id }, text: [team.name], shown: [<bdi key="team">{team.name}</bdi>] }
}

/** 有文档已经不在这个人的个人空间里了（可能被别人转走了）：整批没有转移 */
function isTransferConflict(error: unknown): boolean {
  return error instanceof ApiError && error.code === 'TRANSFER_CONFLICT'
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
  const [done, setDone] = useState<ReactNode>()
  /** 上一次转移时有文档已经不在了：在转移按钮旁说明，下一次打开确认的弹窗时清掉（转移成功之前一定先打开它） */
  const [conflict, setConflict] = useState(false)
  /**
   * 有过结果未知的转移、之后还没有成功过（M2-P6 复核第二批 G-3）：那一次可能已经完成。之后得到 TRANSFER_CONFLICT 时，
   * 说明多半就是那一次已经转走了，而不是"可能被别人转走了"
   */
  const [unsure, setUnsure] = useState(false)
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
   * 转移失败（例如有文档已经被别人转走了）或者结果未知之后，刷新标题列表，清掉已经不在列表里的选中项，列表与选择都是服务端的实际状态
   * （审查 B12，第二批 G-3）。刷新本身失败时拒绝，列表不变，选择也不动：结果未知之后确认的弹窗据此说明列表没能刷新（第三批 G-a）
   */
  async function refreshDocuments(): Promise<void> {
    await refreshQueries(queryClient, [documentsQuery.queryKey])
    const pages = queryClient.getQueryData(documentsQuery.queryKey)?.pages ?? []
    const present = new Set(pages.flatMap(page => page.items.map(document => document.id)))
    setSelected(previous => new Set([...previous].filter(id => present.has(id))))
  }

  /**
   * 同上，返回刷新是否成功（确定的失败之后，按它决定是关掉弹窗在按钮旁说明，还是弹窗留着说明原因）。与结果未知之后一样最多等 10 秒
   * （shared/api/write-outcome.ts 的 refreshWithin，M2-P6 复核第四批）：一直不回来时按没能刷新处理，弹窗不一直停在"正在处理…"
   */
  async function refreshAfterFailure(): Promise<boolean> {
    return refreshWithin(refreshDocuments)
  }

  const target = targetOf(targetType, person, team)
  const tooMany = selected.size > TRANSFER_MAX_DOCUMENTS
  let blocked: string | undefined
  if (selected.size === 0)
    blocked = text.pickDocuments
  else if (tooMany)
    blocked = text.tooMany(TRANSFER_MAX_DOCUMENTS)
  else if (target === undefined)
    blocked = text.pickTarget

  /**
   * 确认之后整批转移。结果未知时（M2-P6 复核第二批 G-3）可能已经转移了：确认的弹窗按 refresh 刷新列表、清掉已经不在的选择，
   * 说明"可能已经转移"——列表没能刷新（失败，或者到了时限还没回来）时说明列表还是之前的（第三批 G-a）；
   * 之后得到 TRANSFER_CONFLICT 时说明多半就是那一次已经完成。
   * 结果的说明与"有文档已经不在了"的说明都交给确认的弹窗，等它关掉、页面不再被标为 aria-hidden、焦点交还之后才写（M2-P5 复验 S1）；
   * 打开确认的弹窗时清掉上一次的：同样的说法（例如又转移了 1 份到同一个空间）照样是一次变化，读屏照样播报
   */
  function submit(): void {
    if (blocked !== undefined || target === undefined)
      return
    const documentIds = [...selected]
    setConflict(false)
    setDone(undefined)
    setPending({
      title: phraseText(text.confirm(documentIds.length, target.text)),
      description: text.confirmDescription,
      confirmLabel: text.submit,
      run: async () => {
        try {
          const result = await transferDocuments(account.id, { documentIds, target: target.request })
          setSelected(new Set())
          setUnsure(false)
          await refreshQueries(queryClient, [documentsQuery.queryKey], { throwOnError: false })
          return () => setDone(<Phrase parts={text.done(result.transferred, target.shown)} />)
        }
        catch (error) {
          // 结果未知：确认的弹窗随即按 refresh 刷新、说明可能已经转移
          if (isUnknownOutcome(error)) {
            setUnsure(true)
            throw error
          }
          const refreshed = await refreshAfterFailure()
          // 有文档已经不在了：列表刷新之后关闭弹窗，在转移按钮旁说明，按新的列表重新选择。弹窗留着的话，再点确认只会拿着
          // 同样的文档原样重发（复验）。其他失败（目标已归档等）与刷新本身失败时，弹窗留着说明原因
          if (refreshed && isTransferConflict(error))
            return () => setConflict(true)
          throw error
        }
      },
      refresh: refreshDocuments,
      describeFailure: (error, refreshed) => {
        const reason = describeError(error).message
        if (!isUnknownOutcome(error))
          return reason
        return refreshed ? text.outcomeUnknown(reason) : text.outcomeUnknownNotRefreshed(reason)
      },
      // WebKit 点按钮时不聚焦按钮，打开之前的焦点记不下来：关闭之后焦点回到"转移"（它一直在，审查 B2）
      returnFocus: () => submitRef.current?.focus(),
    })
  }

  return (
    <div className="flex flex-col gap-4">
      {/* 结果的说明：共用的状态区，一直在无障碍树里（空的时候只做视觉隐藏、不占位置），结果出来时往里填文字，读屏软件才会播报（审查 B10） */}
      <StatusRegion className="rounded-lg border p-3 text-sm">{done}</StatusRegion>
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
          ? <KeywordPicker label={text.pickTeam} selected={team} onSelect={setTeam} search={transferTargetsQueryOptions} itemKey={spaceId} renderItem={spaceName} texts={TEAM_TEXTS} />
          : <ColleaguePicker label={text.pickPerson} selected={person} onSelect={setPerson} exclude={excludedPeople} />}
      </fieldset>
      {conflict && (
        <Alert variant="destructive">
          <AlertDescription>{unsure ? text.conflictAfterUnknown : text.conflict}</AlertDescription>
        </Alert>
      )}
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
  // 浏览器标签页的标题（M2-P6 复核 S4）：账户还没取到或取不到时是账户页的
  useDocumentTitle(adminMessages.pageTitle(account.data === undefined ? adminMessages.nav.users : phraseText(text.title(messages.people.text(account.data)))))
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
  return (
    <section className="flex flex-col gap-4" aria-labelledby="transfer-title">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <h2 id="transfer-title" className="text-lg font-semibold"><Phrase parts={text.title(<PersonName person={account.data} />)} /></h2>
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

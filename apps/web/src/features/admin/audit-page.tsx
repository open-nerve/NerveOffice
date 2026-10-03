import type { AdminUser, AuditAction, AuditEventItem, AuditEventQuery } from '@nerve-office/contracts'
import type { UseQueryResult } from '@tanstack/react-query'
import type { ReactNode, Ref } from 'react'
import { AUDIT_ACTIONS, AUDIT_TARGET_TYPES } from '@nerve-office/contracts'
import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { useId, useRef, useState } from 'react'
import { describeError } from '../../shared/api/index.ts'
import { messages } from '../../shared/i18n/index.ts'
import { adminMessages } from '../../shared/i18n/zh-cn/admin.ts'
import { formatDateTime } from '../../shared/lib/format.ts'
import { useDebouncedValue } from '../../shared/lib/use-debounced-value.ts'
import { useDocumentTitle } from '../../shared/lib/use-document-title.ts'
import { useFocusAfterRender } from '../../shared/lib/use-focus-after-render.ts'
import { Badge, Button, Input, Label, NativeSelect, PersonName, Phrase, TableCell } from '../../shared/ui/index.ts'
import { StatusRegion } from '../../shared/ui/status-region.tsx'
import { actorCandidatesQueryOptions, auditEventsQueryOptions } from './admin-api.ts'
import { auditTimeFrom, auditTimeTo } from './audit-time.ts'
import { PagedTable } from './paged-table.tsx'

const text = adminMessages.audit

type AuditTargetType = NonNullable<AuditEventQuery['targetType']>

/** 筛选里选中的操作者或对象：id 与显示的名字；对象另有类型（前端不认识的类型只按 id 筛选） */
interface Picked {
  readonly id: string
  readonly label: ReactNode
  readonly type?: AuditTargetType
}

function isTargetType(type: string): type is AuditTargetType {
  return (AUDIT_TARGET_TYPES as readonly string[]).includes(type)
}

/** 操作者：账户用 PersonName（显示名与登录名分开呈现，M2-P6 复核 M2），账户已经不在时是它的 id；系统与未登录的访问者按类型 */
function actorOf(event: AuditEventItem): ReactNode {
  const { actor } = event
  if (actor.type !== 'user')
    return text.actorKind(actor.type)
  if (actor.displayName === null || actor.username === null)
    return actor.id ?? ''
  return <PersonName person={{ displayName: actor.displayName, username: actor.username }} />
}

/**
 * 对象：类型与它的名字。账户用服务端分开给出的登录名与显示名（target.user），由 PersonName 呈现：
 * 拼好的"显示名（登录名）"冒充得了登录名（M2-P6 复核 M2）；邀请是登录名，空间是名称（target.name，<bdi> 隔离），别的只有 id
 */
function targetOf(target: NonNullable<AuditEventItem['target']>): ReactNode {
  let name: ReactNode = target.id
  if (target.user !== null)
    name = <PersonName person={target.user} />
  else if (target.name !== null)
    name = <bdi>{target.name}</bdi>
  return <Phrase parts={text.target(text.targetKind(target.type), name)} />
}

/** 选中的筛选：显示成一个可以清除的标签；清除按钮的可读名称说明清除的是哪一个（审查 B14） */
function Chip({ label, clearLabel, onClear, ref }: { readonly label: ReactNode, readonly clearLabel: string, readonly onClear: () => void, readonly ref: Ref<HTMLButtonElement> }) {
  return (
    <span className="inline-flex items-center gap-1">
      <Badge variant="secondary">{label}</Badge>
      <Button ref={ref} variant="ghost" size="sm" aria-label={clearLabel} onClick={onClear}>{text.clear}</Button>
    </span>
  )
}

interface ActorCandidatesProps {
  readonly candidates: UseQueryResult<AdminUser[]>
  /** 输入框里的关键词（去掉首尾空白） */
  readonly typed: string
  /** 防抖之后的关键词与输入框一致：查找针对的就是现在输入的 */
  readonly settled: boolean
  readonly onPick: (user: AdminUser) => void
}

/**
 * 找操作者的候选：查找中、失败（可以重试）、没有找到与找到的几个人，都有提示（审查 B8）。
 * 状态容器一直在无障碍树里，内容变化时往里填文字：与内容一起插入的 role="status" 部分读屏不播报（M2-P2 复验，与同事选择相同）。
 * 空的时候原来用 empty:hidden（display: none），同样不在无障碍树里，改用共用的状态区（M2-P5 审查 B 的 M1）。
 * 只显示与输入框里的关键词一致的候选：输入还没停下、或者刚清空时，防抖之后的查询还是上一个关键词的（M2-P2 审查 B11 的同类问题）
 */
function ActorCandidates({ candidates, typed, settled, onPick }: ActorCandidatesProps) {
  const searching = typed !== '' && (!settled || candidates.isPending || (candidates.isError && candidates.isFetching))
  const current = typed !== '' && settled && !searching
  let status = ''
  if (searching)
    status = text.searchingActor
  else if (current && candidates.isSuccess && candidates.data.length === 0)
    status = text.noActor
  return (
    <>
      <StatusRegion className="text-sm text-muted-foreground">{status}</StatusRegion>
      {current && candidates.isError && (
        <div role="alert" className="flex items-center gap-2 text-sm text-destructive">
          <span>{text.actorSearchFailed(describeError(candidates.error).message)}</span>
          <Button variant="outline" size="sm" onClick={() => void candidates.refetch()}>{messages.common.retry}</Button>
        </div>
      )}
      {current && candidates.isSuccess && candidates.data.length > 0 && (
        <ul aria-label={text.actor} className="flex flex-wrap gap-1">
          {candidates.data.map(user => (
            <li key={user.id}>
              <Button variant="outline" size="sm" onClick={() => onPick(user)}><PersonName person={user} /></Button>
            </li>
          ))}
        </ul>
      )}
    </>
  )
}

/**
 * 时间条件的输入框。换算不出接口接受的时刻（例如年份超出 1–9999）时，这个条件不发出去：
 * 标 aria-invalid，并用说明文字告诉用户它没有生效（复验 N8）
 */
function TimeFilter({ id, label, value, invalid, onChange }: { readonly id: string, readonly label: string, readonly value: string, readonly invalid: boolean, readonly onChange: (value: string) => void }) {
  const hintId = `${id}-hint`
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} type="datetime-local" value={value} aria-invalid={invalid} aria-describedby={invalid ? hintId : undefined} onChange={event => onChange(event.target.value)} />
      {invalid && <p id={hintId} className="text-xs text-destructive">{adminMessages.audit.invalidTime}</p>}
    </div>
  )
}

/**
 * 管理界面：审计查询（M2-P1 设计 §3.7、§3.8，US-M2-13）。按动作、时间范围、操作者筛选，点表格里的对象可以只看这个对象；
 * 按时间倒序，"加载更多"翻页。审计里没有文档正文与标题。来源一格里有客户端地址与请求标识。
 * 选中或清除筛选时被点的元素随之消失，焦点移到稳定的元素上（审查 B9）：选中之后到它的清除按钮，清除操作者之后回到找操作者的输入框，
 * 清除对象之后回到动作的筛选。
 */
export function AdminAuditPage() {
  useDocumentTitle(adminMessages.pageTitle(adminMessages.nav.audit))
  const [action, setAction] = useState<AuditAction | ''>('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [actor, setActor] = useState<Picked>()
  const [target, setTarget] = useState<Picked>()
  const [actorKeyword, setActorKeyword] = useState('')
  const typedKeyword = actorKeyword.trim()
  const keyword = useDebouncedValue(typedKeyword)
  const keywordSettled = keyword === typedKeyword
  const actionRef = useRef<HTMLSelectElement>(null)
  const actorInputRef = useRef<HTMLInputElement>(null)
  const actorClearRef = useRef<HTMLButtonElement>(null)
  const targetClearRef = useRef<HTMLButtonElement>(null)
  const focusAfterRender = useFocusAfterRender()
  const actionId = useId()
  const fromId = useId()
  const toId = useId()
  const actorId = useId()

  // 时间按本地时间输入，换算成 UTC；结束时间含所选的这一分钟。换算不出接口接受的时刻（例如 0 年）时不作为条件，输入框标成无效
  const fromInstant = auditTimeFrom(from)
  const toInstant = auditTimeTo(to)
  const filter: Omit<AuditEventQuery, 'cursor'> = {
    ...(action === '' ? {} : { action }),
    ...(fromInstant === undefined ? {} : { from: fromInstant }),
    ...(toInstant === undefined ? {} : { to: toInstant }),
    ...(actor === undefined ? {} : { actorId: actor.id }),
    ...(target === undefined ? {} : { targetId: target.id, ...(target.type === undefined ? {} : { targetType: target.type }) }),
  }
  const events = useInfiniteQuery(auditEventsQueryOptions(filter))
  const candidates = useQuery({ ...actorCandidatesQueryOptions(keyword), enabled: keyword !== '' && keywordSettled && actor === undefined })

  function pickActor(user: AdminUser): void {
    setActor({ id: user.id, label: <PersonName person={user} /> })
    focusAfterRender(actorClearRef)
  }

  function clearActor(): void {
    setActor(undefined)
    setActorKeyword('')
    focusAfterRender(actorInputRef)
  }

  function pickTarget(event: AuditEventItem): void {
    if (event.target === null)
      return
    setTarget({ id: event.target.id, label: targetOf(event.target), ...(isTargetType(event.target.type) ? { type: event.target.type } : {}) })
    focusAfterRender(targetClearRef)
  }

  function clearTarget(): void {
    setTarget(undefined)
    focusAfterRender(actionRef)
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex w-44 flex-col gap-2">
          <Label htmlFor={actionId}>{text.action}</Label>
          <NativeSelect ref={actionRef} id={actionId} value={action} onChange={event => setAction(event.target.value as AuditAction | '')}>
            <option value="">{messages.common.all}</option>
            {AUDIT_ACTIONS.map(value => <option key={value} value={value}>{text.actionName(value)}</option>)}
          </NativeSelect>
        </div>
        <TimeFilter id={fromId} label={text.from} value={from} invalid={from !== '' && fromInstant === undefined} onChange={setFrom} />
        <TimeFilter id={toId} label={text.to} value={to} invalid={to !== '' && toInstant === undefined} onChange={setTo} />
        {actor === undefined && (
          <div className="flex min-w-48 flex-1 flex-col gap-2">
            <Label htmlFor={actorId}>{text.searchActor}</Label>
            <Input ref={actorInputRef} id={actorId} type="search" value={actorKeyword} onChange={event => setActorKeyword(event.target.value)} />
          </div>
        )}
      </div>
      {actor === undefined && <ActorCandidates candidates={candidates} typed={typedKeyword} settled={keywordSettled} onPick={pickActor} />}
      {(actor !== undefined || target !== undefined) && (
        <div className="flex flex-wrap gap-3">
          {actor !== undefined && <Chip ref={actorClearRef} label={<Phrase parts={text.chipActor(actor.label)} />} clearLabel={text.clearActor} onClear={clearActor} />}
          {target !== undefined && <Chip ref={targetClearRef} label={<Phrase parts={text.chipTarget(target.label)} />} clearLabel={text.clearTarget} onClear={clearTarget} />}
        </div>
      )}
      <PagedTable
        query={events}
        label={text.listLabel}
        texts={text}
        columns={[text.columns.occurredAt, text.columns.actor, text.columns.action, text.columns.target, text.columns.origin, text.columns.details]}
        rowKey={event => event.id}
        renderCells={event => (
          <>
            <TableCell className="whitespace-nowrap"><time dateTime={event.occurredAt}>{formatDateTime(event.occurredAt)}</time></TableCell>
            <TableCell>{actorOf(event)}</TableCell>
            <TableCell>{text.actionName(event.action)}</TableCell>
            <TableCell>
              {event.target === null
                ? '—'
                : (
                    <Button variant="link" size="sm" className="h-auto p-0" title={text.onlyTarget} onClick={() => pickTarget(event)}>
                      {targetOf(event.target)}
                    </Button>
                  )}
            </TableCell>
            <TableCell className="text-xs text-muted-foreground">
              <span className="block whitespace-nowrap">{[text.source(event.source), event.clientIp].filter(Boolean).join(' · ')}</span>
              {event.requestId !== null && <span className="block font-mono" title={messages.common.requestId(event.requestId)}>{event.requestId}</span>}
            </TableCell>
            <TableCell className="max-w-64 truncate font-mono text-xs" title={JSON.stringify(event.details)}>{Object.keys(event.details).length === 0 ? '—' : JSON.stringify(event.details)}</TableCell>
          </>
        )}
      />
    </div>
  )
}

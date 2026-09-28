import type { AuditAction, AuditEventItem, AuditEventQuery } from '@nerve-office/contracts'
import { AUDIT_ACTIONS } from '@nerve-office/contracts'
import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { useId, useState } from 'react'
import { messages } from '../../shared/i18n/index.ts'
import { formatDateTime } from '../../shared/lib/format.ts'
import { useDebouncedValue } from '../../shared/lib/use-debounced-value.ts'
import { Badge, Button, Input, Label, NativeSelect, TableCell } from '../../shared/ui/index.ts'
import { ADMIN_QUERY_KEY, auditEventsQueryOptions, fetchAdminUsers } from './admin-api.ts'
import { PagedTable } from './paged-table.tsx'

const text = messages.admin.audit

/** 筛选里选中的操作者或对象：id 与显示的名字 */
interface Picked {
  readonly id: string
  readonly label: string
  readonly type?: string
}

/** datetime-local 的值（本地时间）→ ISO 8601 的 UTC；没填时 undefined */
function isoOf(local: string): string | undefined {
  if (local === '')
    return undefined
  const instant = new Date(local)
  return Number.isNaN(instant.getTime()) ? undefined : instant.toISOString()
}

function actorOf(event: AuditEventItem): string {
  if (event.actor.type === 'user')
    return event.actor.displayName === null ? (event.actor.id ?? '') : `${event.actor.displayName}（${event.actor.username ?? ''}）`
  return text.actorKind(event.actor.type)
}

function targetOf(event: AuditEventItem): string {
  if (event.target === null)
    return '—'
  return `${text.targetKind(event.target.type)}：${event.target.label ?? event.target.id}`
}

/** 选中的筛选：显示成一个可以清除的标签 */
function Chip({ label, onClear }: { readonly label: string, readonly onClear: () => void }) {
  return (
    <span className="inline-flex items-center gap-1">
      <Badge variant="secondary">{label}</Badge>
      <Button variant="ghost" size="sm" onClick={onClear}>{text.clear}</Button>
    </span>
  )
}

/**
 * 管理界面：审计查询（M2-P1 设计 §3.7、§3.8，US-M2-13）。按动作、时间范围、操作者筛选，点表格里的对象可以只看这个对象；
 * 按时间倒序，"加载更多"翻页。审计里没有文档正文与标题。
 */
export function AdminAuditPage() {
  const [action, setAction] = useState<AuditAction | ''>('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [actor, setActor] = useState<Picked>()
  const [target, setTarget] = useState<Picked>()
  const [actorKeyword, setActorKeyword] = useState('')
  const keyword = useDebouncedValue(actorKeyword.trim())
  const actionId = useId()
  const fromId = useId()
  const toId = useId()
  const actorId = useId()

  const filter: Omit<AuditEventQuery, 'cursor'> = {
    ...(action === '' ? {} : { action }),
    ...(isoOf(from) === undefined ? {} : { from: isoOf(from) }),
    ...(isoOf(to) === undefined ? {} : { to: isoOf(to) }),
    ...(actor === undefined ? {} : { actorId: actor.id }),
    ...(target === undefined ? {} : { targetId: target.id, ...(target.type === undefined ? {} : { targetType: target.type as AuditEventQuery['targetType'] }) }),
  }
  const events = useInfiniteQuery(auditEventsQueryOptions(filter))
  // 找操作者：按名字搜索账户（含停用的），只取第一页的前几条
  const candidates = useQuery({
    queryKey: [...ADMIN_QUERY_KEY, 'actor-candidates', keyword],
    queryFn: async ({ signal }) => fetchAdminUsers({ query: keyword }, signal),
    enabled: keyword !== '' && actor === undefined,
    select: page => page.items.slice(0, 5),
  })

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex w-44 flex-col gap-2">
          <Label htmlFor={actionId}>{text.action}</Label>
          <NativeSelect id={actionId} value={action} onChange={event => setAction(event.target.value as AuditAction | '')}>
            <option value="">{messages.common.all}</option>
            {AUDIT_ACTIONS.map(value => <option key={value} value={value}>{text.actionName(value)}</option>)}
          </NativeSelect>
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor={fromId}>{text.from}</Label>
          <Input id={fromId} type="datetime-local" value={from} onChange={event => setFrom(event.target.value)} />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor={toId}>{text.to}</Label>
          <Input id={toId} type="datetime-local" value={to} onChange={event => setTo(event.target.value)} />
        </div>
        {actor === undefined && (
          <div className="flex min-w-48 flex-1 flex-col gap-2">
            <Label htmlFor={actorId}>{text.searchActor}</Label>
            <Input id={actorId} type="search" value={actorKeyword} onChange={event => setActorKeyword(event.target.value)} />
          </div>
        )}
      </div>
      {actor === undefined && candidates.data !== undefined && candidates.data.length > 0 && (
        <ul aria-label={text.actor} className="flex flex-wrap gap-1">
          {candidates.data.map(user => (
            <li key={user.id}>
              <Button variant="outline" size="sm" onClick={() => setActor({ id: user.id, label: `${user.displayName}（${user.username}）` })}>
                {`${user.displayName}（${user.username}）`}
              </Button>
            </li>
          ))}
        </ul>
      )}
      {(actor !== undefined || target !== undefined) && (
        <div className="flex flex-wrap gap-3">
          {actor !== undefined && (
            <Chip
              label={text.chipActor(actor.label)}
              onClear={() => {
                setActor(undefined)
                setActorKeyword('')
              }}
            />
          )}
          {target !== undefined && <Chip label={text.chipTarget(target.label)} onClear={() => setTarget(undefined)} />}
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
                    <Button variant="link" size="sm" className="h-auto p-0" title={text.onlyTarget} onClick={() => setTarget({ id: event.target?.id ?? '', type: event.target?.type, label: targetOf(event) })}>
                      {targetOf(event)}
                    </Button>
                  )}
            </TableCell>
            <TableCell className="text-xs whitespace-nowrap text-muted-foreground">{[text.source(event.source), event.clientIp].filter(Boolean).join(' · ')}</TableCell>
            <TableCell className="max-w-64 truncate font-mono text-xs" title={JSON.stringify(event.details)}>{Object.keys(event.details).length === 0 ? '—' : JSON.stringify(event.details)}</TableCell>
          </>
        )}
      />
    </div>
  )
}

import type { UserSummary } from '@nerve-office/contracts'
import type { UseQueryResult } from '@tanstack/react-query'
import { userDirectoryResponseSchema } from '@nerve-office/contracts'
import { queryOptions, useQuery } from '@tanstack/react-query'
import { useId, useRef, useState } from 'react'
import { apiRequest, describeError } from '../../shared/api/index.ts'
import { messages } from '../../shared/i18n/index.ts'
import { useDebouncedValue } from '../../shared/lib/use-debounced-value.ts'
import { useFocusAfterRender } from '../../shared/lib/use-focus-after-render.ts'
import { Badge, Button, Input, Label } from '../../shared/ui/index.ts'

const text = messages.colleagues

/** 同事目录（M2-P1 的 GET /api/users）：显示名或登录名包含关键词的有效账户 */
function colleaguesQueryOptions(keyword: string) {
  return queryOptions({
    queryKey: ['colleagues', keyword],
    queryFn: async ({ signal }) => apiRequest(`/api/users?${new URLSearchParams({ query: keyword }).toString()}`, { schema: userDirectoryResponseSchema, signal }),
    select: response => response.items,
  })
}

/** 候选：查找中、失败（可以重试）、没有找到、找到的几个人 */
function Candidates({ candidates, exclude, onPick }: {
  readonly candidates: UseQueryResult<UserSummary[]>
  readonly exclude: ReadonlySet<string>
  readonly onPick: (user: UserSummary) => void
}) {
  if (candidates.isPending)
    return <p role="status" className="text-sm text-muted-foreground">{text.searching}</p>
  if (candidates.isError) {
    return (
      <div role="alert" className="flex items-center gap-2 text-sm text-destructive">
        <span>{text.failed(describeError(candidates.error).message)}</span>
        <Button variant="outline" size="sm" onClick={() => void candidates.refetch()}>{messages.common.retry}</Button>
      </div>
    )
  }
  const found = candidates.data.filter(user => !exclude.has(user.id))
  if (found.length === 0)
    return <p role="status" className="text-sm text-muted-foreground">{text.none}</p>
  return (
    <ul aria-label={text.candidates} className="flex flex-wrap gap-1">
      {found.map(user => (
        <li key={user.id}>
          <Button type="button" variant="outline" size="sm" onClick={() => onPick(user)}>{text.name(user)}</Button>
        </li>
      ))}
    </ul>
  )
}

interface ColleaguePickerProps {
  /** 输入框的标签，例如"首个空间管理员" */
  readonly label: string
  readonly selected: UserSummary | undefined
  readonly onSelect: (user: UserSummary | undefined) => void
  /** 不作为候选的人（例如已经是成员的） */
  readonly exclude?: ReadonlySet<string>
}

/**
 * 按名字选一个同事（M2-P2 设计 §3.10）：添加成员、首个空间管理员、转移的目标共用。输入停下之后才查找（同事目录只有有效账户）；
 * 选中之后显示成标签，可以重新选择。选中与重新选择时被点的元素随之消失，焦点移到新出现的元素上（审查 B9 的做法）。
 * 只由按需加载的页面引用，不进首屏。
 */
export function ColleaguePicker({ label, selected, onSelect, exclude = new Set() }: ColleaguePickerProps) {
  const [keyword, setKeyword] = useState('')
  const query = useDebouncedValue(keyword.trim())
  const candidates = useQuery({ ...colleaguesQueryOptions(query), enabled: query !== '' && selected === undefined })
  const inputRef = useRef<HTMLInputElement>(null)
  const changeRef = useRef<HTMLButtonElement>(null)
  const focusAfterRender = useFocusAfterRender()
  const inputId = useId()

  if (selected !== undefined) {
    return (
      <div className="flex flex-col gap-2">
        <span className="text-sm font-medium">{label}</span>
        <span className="inline-flex flex-wrap items-center gap-2">
          <Badge variant="secondary">{text.selected(text.name(selected))}</Badge>
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
            {text.change}
          </Button>
        </span>
      </div>
    )
  }
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={inputId}>{label}</Label>
      <Input ref={inputRef} id={inputId} type="search" placeholder={text.search} value={keyword} onChange={event => setKeyword(event.target.value)} />
      {query !== '' && (
        <Candidates
          candidates={candidates}
          exclude={exclude}
          onPick={(user) => {
            onSelect(user)
            focusAfterRender(changeRef)
          }}
        />
      )}
    </div>
  )
}

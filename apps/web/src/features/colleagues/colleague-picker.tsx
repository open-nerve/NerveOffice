import type { UserSummary } from '@nerve-office/contracts'
import { userDirectoryResponseSchema } from '@nerve-office/contracts'
import { queryOptions } from '@tanstack/react-query'
import { apiRequest } from '../../shared/api/index.ts'
import { colleaguesMessages } from '../../shared/i18n/zh-cn/colleagues.ts'
import { PersonName } from '../../shared/ui/index.ts'
import { KeywordPicker } from './keyword-picker.tsx'

const text = colleaguesMessages

const TEXTS = { placeholder: text.search, candidates: text.candidates, searching: text.searching, none: text.none, failed: text.failed }

/** 同事目录（M2-P1 的 GET /api/users）：显示名或登录名包含关键词的有效账户 */
function colleaguesQueryOptions(keyword: string) {
  return queryOptions({
    queryKey: ['colleagues', keyword],
    queryFn: async ({ signal }) => apiRequest(`/api/users?${new URLSearchParams({ query: keyword }).toString()}`, { schema: userDirectoryResponseSchema, signal }),
    select: response => response.items,
  })
}

function userId(user: UserSummary): string {
  return user.id
}

/** 候选与已选都用 PersonName：同名的两个人、显示名里写了"（登录名）"的人，看登录名就分得清（M2-P6 复核 M2） */
function personOf(user: UserSummary) {
  return <PersonName person={user} />
}

interface ColleaguePickerProps {
  /** 选的是谁，例如"首个空间管理员"：输入框的标签 */
  readonly label: string
  readonly selected: UserSummary | undefined
  readonly onSelect: (user: UserSummary | undefined) => void
  /** 不作为候选的人（例如已经是成员的） */
  readonly exclude?: ReadonlySet<string>
}

/**
 * 按名字选一个同事（M2-P2 设计 §3.10）：添加成员、首个空间管理员、转移的目标共用。同事目录只有有效账户。
 * 只由按需加载的页面引用，不进首屏。
 */
export function ColleaguePicker({ label, selected, onSelect, exclude }: ColleaguePickerProps) {
  return (
    <KeywordPicker
      label={label}
      selected={selected}
      onSelect={onSelect}
      search={colleaguesQueryOptions}
      itemKey={userId}
      renderItem={personOf}
      exclude={exclude === undefined ? undefined : user => exclude.has(user.id)}
      texts={TEXTS}
    />
  )
}

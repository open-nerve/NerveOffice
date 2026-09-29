import type { QueryKey, UseQueryOptions, UseQueryResult } from '@tanstack/react-query'
import { useQuery } from '@tanstack/react-query'
import { useId, useRef, useState } from 'react'
import { describeError } from '../../shared/api/index.ts'
import { messages } from '../../shared/i18n/index.ts'
import { cn } from '../../shared/lib/cn.ts'
import { useDebouncedValue } from '../../shared/lib/use-debounced-value.ts'
import { useFocusAfterRender } from '../../shared/lib/use-focus-after-render.ts'
import { Badge, Button, Input, Label } from '../../shared/ui/index.ts'

/** 按关键词选一项时的界面文字 */
export interface KeywordPickerTexts {
  /** 输入框的提示：怎么找，例如"按名字或登录名搜索同事" */
  readonly placeholder: string
  /** 候选列表的可读名称，例如"找到的同事" */
  readonly candidates: string
  readonly searching: string
  /** 没有找到 */
  readonly none: string
  readonly failed: (reason: string) => string
}

interface KeywordPickerProps<TQueryFnData, TItem, TQueryKey extends QueryKey> {
  /** 选的是什么，例如"首个空间管理员"：输入框的标签；选中之后仍显示在原处，"重新选择"的可读名称也带上它（审查 B10） */
  readonly label: string
  readonly selected: TItem | undefined
  readonly onSelect: (item: TItem | undefined) => void
  /** 按关键词（去掉首尾空白、输入停下之后的）查找候选的查询：结果经 select 取成候选的数组 */
  readonly search: (keyword: string) => UseQueryOptions<TQueryFnData, Error, TItem[], TQueryKey>
  readonly itemKey: (item: TItem) => string
  /** 候选按钮与选中之后的标签上显示的名称 */
  readonly itemName: (item: TItem) => string
  /** 不作为候选的（例如已经是成员的人） */
  readonly exclude?: (item: TItem) => boolean
  readonly texts: KeywordPickerTexts
}

/** 按关键词查找的情形：查找中、失败（可以重试）、找到的候选（可能一个也没有） */
type Lookup<TItem>
  = | { readonly state: 'searching' }
    | { readonly state: 'failed', readonly error: Error, readonly retry: () => void }
    | { readonly state: 'found', readonly items: readonly TItem[] }

/**
 * 输入框里有关键词时，查找到了哪一步。输入还没停下（或者刚改过）时，防抖之后的查询还是上一个关键词的：按查找中算，
 * 不显示它的候选（审查 B11）；失败之后点了重试，重新查找期间同样是查找中
 */
function lookupOf<TItem>(result: UseQueryResult<TItem[]>, settled: boolean, exclude: ((item: TItem) => boolean) | undefined): Lookup<TItem> {
  if (!settled || result.isPending || (result.isError && result.isFetching))
    return { state: 'searching' }
  if (result.isError)
    return { state: 'failed', error: result.error, retry: () => void result.refetch() }
  return { state: 'found', items: exclude === undefined ? result.data : result.data.filter(item => !exclude(item)) }
}

/** 查找的结果：失败（可以重试）或者找到的候选。查找中与没有找到只在状态容器里说明 */
function Candidates<TItem>({ lookup, texts, itemKey, itemName, onPick }: {
  readonly lookup: Lookup<TItem>
  readonly texts: KeywordPickerTexts
  readonly itemKey: (item: TItem) => string
  readonly itemName: (item: TItem) => string
  readonly onPick: (item: TItem) => void
}) {
  if (lookup.state === 'failed') {
    return (
      <div role="alert" className="flex items-center gap-2 text-sm text-destructive">
        <span>{texts.failed(describeError(lookup.error).message)}</span>
        <Button type="button" variant="outline" size="sm" onClick={lookup.retry}>{messages.common.retry}</Button>
      </div>
    )
  }
  if (lookup.state === 'searching' || lookup.items.length === 0)
    return null
  return (
    <ul aria-label={texts.candidates} className="flex flex-wrap gap-1">
      {lookup.items.map(item => (
        <li key={itemKey(item)}>
          <Button type="button" variant="outline" size="sm" onClick={() => onPick(item)}>{itemName(item)}</Button>
        </li>
      ))}
    </ul>
  )
}

/**
 * 按关键词选一项（M2-P2 设计 §3.10）：按名字选同事、转移的目标团队空间共用（审查 B13）。输入停下之后才查找；
 * 选中之后显示成标签，可以重新选择。选中与重新选择时被点的元素随之消失，焦点移到新出现的元素上（M2-P1 审查 B9 的做法）。
 * 只显示与输入框里的关键词一致的候选（审查 B11）：输入还没停下、或者关键词刚清空时，防抖之后的查询还是上一个关键词的，
 * 它的候选不能挂在新的关键词（或者空的输入框）下面。
 * 查找的进展（查找中、没有找到）放在一直在的状态容器里，内容变化时往里填文字：与内容一起插入的 role="status"，
 * 部分读屏软件不播报（M2-P2 复验）。候选列表与失败的提示（role="alert"）随结果出现。
 * 只由按需加载的页面引用，不进首屏。
 */
export function KeywordPicker<TQueryFnData, TItem, TQueryKey extends QueryKey>({ label, selected, onSelect, search, itemKey, itemName, exclude, texts }: KeywordPickerProps<TQueryFnData, TItem, TQueryKey>) {
  const [keyword, setKeyword] = useState('')
  const typed = keyword.trim()
  const query = useDebouncedValue(typed)
  // 输入还没停下（或者刚清空）时，防抖之后的还是上一个关键词：不为它查找
  const settled = query === typed
  const candidates = useQuery({ ...search(query), enabled: query !== '' && settled && selected === undefined })
  const inputRef = useRef<HTMLInputElement>(null)
  const changeRef = useRef<HTMLButtonElement>(null)
  const focusAfterRender = useFocusAfterRender()
  const inputId = useId()

  if (selected !== undefined) {
    return (
      <div className="flex flex-col gap-2">
        <span className="text-sm font-medium">{label}</span>
        <span className="inline-flex flex-wrap items-center gap-2">
          <Badge variant="secondary">{messages.colleagues.selected(itemName(selected))}</Badge>
          <Button
            ref={changeRef}
            type="button"
            variant="ghost"
            size="sm"
            aria-label={messages.colleagues.changeOf(label)}
            onClick={() => {
              onSelect(undefined)
              setKeyword('')
              focusAfterRender(inputRef)
            }}
          >
            {messages.colleagues.change}
          </Button>
        </span>
      </div>
    )
  }
  const lookup = typed === '' ? undefined : lookupOf(candidates, settled, exclude)
  let progress: string | undefined
  if (lookup?.state === 'searching')
    progress = texts.searching
  else if (lookup?.state === 'found' && lookup.items.length === 0)
    progress = texts.none
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={inputId}>{label}</Label>
      {/* 状态容器与输入框放在一起：空的时候不占位置（有文字时才加上间距），输入框仍与表单里旁边的控件底边对齐 */}
      <div className="flex flex-col">
        <Input ref={inputRef} id={inputId} type="search" placeholder={texts.placeholder} value={keyword} onChange={event => setKeyword(event.target.value)} />
        <p role="status" className={cn('text-sm text-muted-foreground', progress !== undefined && 'mt-2')}>{progress}</p>
      </div>
      {lookup !== undefined && (
        <Candidates
          lookup={lookup}
          texts={texts}
          itemKey={itemKey}
          itemName={itemName}
          onPick={(item) => {
            onSelect(item)
            focusAfterRender(changeRef)
          }}
        />
      )}
    </div>
  )
}

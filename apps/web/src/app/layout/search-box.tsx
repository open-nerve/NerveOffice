import { searchKeywordSchema } from '@nerve-office/contracts'
import { useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router'
import { messages } from '../../shared/i18n/index.ts'
import { SEARCH_QUERY_PARAM, searchPath } from '../../shared/lib/space-paths.ts'
import { Button, Input } from '../../shared/ui/index.ts'

const text = messages.searchBox

/**
 * 页头里的搜索框（M2-P4 设计 §3.7，US-M2-12）：只负责带着关键词跳到搜索结果页。
 * 结果页按需加载（features/search），所以首屏里只有这个框；关键词放在地址的查询参数里，
 * 刷新、前进后退与分享地址都拿得到同一批结果。
 */
export function SearchBox() {
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const query = params.get(SEARCH_QUERY_PARAM) ?? ''
  const [keyword, setKeyword] = useState(query)
  // 地址里的关键词变了（例如点了浏览器的后退、从结果页离开）：框里跟着变。在渲染中同步，不用 effect 多渲染一轮
  const shownRef = useRef(query)
  if (shownRef.current !== query) {
    shownRef.current = query
    setKeyword(query)
  }
  const parsed = searchKeywordSchema.safeParse(keyword)

  return (
    <form
      role="search"
      // 占住页头中间的空当，窄屏时跟着收窄：页头不换行、不溢出（M2-P1 审查 B11）
      className="flex min-w-0 max-w-xs flex-1 items-center gap-1"
      onSubmit={(event) => {
        event.preventDefault()
        if (parsed.success)
          void navigate(searchPath(parsed.data))
      }}
    >
      <Input
        type="search"
        aria-label={text.label}
        placeholder={text.placeholder}
        className="h-8 w-full min-w-0"
        value={keyword}
        onChange={event => setKeyword(event.target.value)}
      />
      {/* 关键词还不能提交时用 aria-disabled：按钮变成 disabled 时浏览器把焦点丢到 body（M2-P1 审查 B13） */}
      <Button type="submit" variant="ghost" size="sm" className="shrink-0" aria-disabled={!parsed.success}>{text.submit}</Button>
    </form>
  )
}

import { useEffect, useState } from 'react'

/** 输入停下 delayMs 之后才更新的值：按名字搜索时，不必每按一个键就发一次请求 */
export function useDebouncedValue<T>(value: T, delayMs = 300): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const timer = setTimeout(setDebounced, delayMs, value)
    return () => clearTimeout(timer)
  }, [value, delayMs])
  return debounced
}

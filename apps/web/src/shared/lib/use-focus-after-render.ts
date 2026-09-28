import type { RefObject } from 'react'
import { useCallback, useEffect, useRef } from 'react'

/**
 * 状态更新之后把焦点移到某个元素上（A14，M1 审查 B13）：被点的元素常常随之消失或变成 disabled（例如选中的筛选换成了标签、
 * 提交之后清空的表单），焦点不能留给 body；要去的元素又往往等这次渲染之后才出现（例如成功的提示）。
 * 返回的函数在事件处理里、与状态更新一起调用：记下目标，下一次渲染之后聚焦它。
 */
export function useFocusAfterRender(): (target: RefObject<HTMLElement | null>) => void {
  const targetRef = useRef<RefObject<HTMLElement | null>>(undefined)
  useEffect(() => {
    const target = targetRef.current
    if (target === undefined)
      return
    targetRef.current = undefined
    target.current?.focus()
  })
  return useCallback((target: RefObject<HTMLElement | null>) => {
    targetRef.current = target
  }, [])
}

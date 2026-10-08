// 焦点不落到 body（规范 §2.4）的两件共用的小东西：判断焦点是不是已经落到了 body；一块说明连同里面的按钮消失时把焦点交给一直在的元素。
// 用到的地方：列表与详情的"没能刷新"（shared/ui/refresh-problem.tsx，DEF-040）、第一次就没取到时的"重试"（use-first-load-retry.ts）、
// 页面级的焦点接住（use-focus-rescue.ts）、编辑器页头与登录页（初始焦点与为什么来到这里的说明，DEF-047）、
// 选目标位置的表单（表单出现时按下的"移动""复制"随之卸载，DEF-049）。
import type { FocusEvent, RefObject } from 'react'
import { useLayoutEffect, useRef } from 'react'

/** 焦点不在任何元素上（落到了 body） */
export function focusIsLost(): boolean {
  return document.activeElement === null || document.activeElement === document.body
}

/** 挂在说明上：记下焦点在不在它里面 */
export interface FocusHandOffHandlers {
  readonly onFocus: () => void
  readonly onBlur: (event: FocusEvent<HTMLElement>) => void
}

/**
 * 说明连同按钮一起消失时，焦点不落到 body（DEF-040）：记下焦点在不在说明里（focusin 记下；移到说明之外的元素时忘掉，
 * 落到 body、或者按钮被移走时不忘，与 use-focus-rescue.ts 同一个做法），说明消失（shown 由真变假）的那一次提交里交给 fallbackFocus。
 * 用布局效果：DOM 刚改完、页面的 useFocusRescue（MutationObserver，之后的微任务）之前，焦点留在说明附近，不先跳到页面的标题。
 * 只在焦点已经落到 body 时交：别处在这之前已经接过焦点，就不抢。返回的处理函数挂在说明的外层上
 */
export function useFocusHandOff(shown: boolean, fallbackFocus: RefObject<HTMLElement | null> | undefined): FocusHandOffHandlers {
  const insideRef = useRef(false)
  useLayoutEffect(() => {
    if (shown || !insideRef.current)
      return
    insideRef.current = false
    if (focusIsLost())
      fallbackFocus?.current?.focus()
  }, [shown, fallbackFocus])
  return {
    onFocus: () => {
      insideRef.current = true
    },
    onBlur: (event) => {
      if (event.relatedTarget instanceof Element && !event.currentTarget.contains(event.relatedTarget))
        insideRef.current = false
    },
  }
}

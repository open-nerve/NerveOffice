import type { RefCallback, RefObject } from 'react'
import { useCallback } from 'react'

/** 焦点不在任何元素上（落到了 body） */
function focusIsLost(): boolean {
  return document.activeElement === null || document.activeElement === document.body
}

/**
 * 区域里有焦点的元素随着页面变化消失时，焦点不落到 body（A14，M2-P6 复核 S3）：交给 fallback（页面的标题，tabIndex -1）。
 * 消失的原因各种各样，逐处处理总有漏掉的：行因为刷新而不在了（别人删了、刚才那次结果未知的删除其实生效了），
 * 按钮、表单随新的权限不再显示（空间刚被归档），"加载更多"在最后一页之后不再出现……
 *
 * 做法：记下区域里最后一个得到焦点的元素（focusin）；区域里的节点被移走时（MutationObserver），它在被移走的节点里、
 * 而且焦点已经落到了 body，就把焦点交给 fallback。有意的焦点移动照常生效：说明条、新的那一行在自己的 effect 里接过焦点，
 * 不论在这之前还是之后，最后的焦点都是它们的；焦点已经在别处时这里什么也不做。
 * 焦点主动移到区域外的别的元素上时忘掉记下的元素；移到 body（点了空白处）时不忘：那个元素随后消失，交给标题也无妨。
 * 用原生的 focusin 而不是 React 的 onFocus：React 的事件沿组件树冒泡，弹窗（Portal）里的元素也会被记下来。
 *
 * 返回的是区域的回调 ref（区域常常是有条件地渲染的，例如加载完才出现的 section）：挂上时开始看，卸下时停止。
 */
export function useFocusRescue(fallback: RefObject<HTMLElement | null>): RefCallback<HTMLElement> {
  return useCallback((root: HTMLElement) => {
    let focused: Element | undefined
    const remember = (event: FocusEvent): void => {
      focused = event.target instanceof Element ? event.target : undefined
    }
    const forget = (event: FocusEvent): void => {
      if (event.relatedTarget instanceof Element && !root.contains(event.relatedTarget))
        focused = undefined
    }
    const observer = new MutationObserver((records) => {
      const last = focused
      if (last === undefined || last.isConnected || !focusIsLost())
        return
      if (!records.some(record => [...record.removedNodes].some(node => node === last || node.contains(last))))
        return
      focused = undefined
      fallback.current?.focus()
    })
    root.addEventListener('focusin', remember)
    root.addEventListener('focusout', forget)
    observer.observe(root, { childList: true, subtree: true })
    return () => {
      root.removeEventListener('focusin', remember)
      root.removeEventListener('focusout', forget)
      observer.disconnect()
    }
  }, [fallback])
}

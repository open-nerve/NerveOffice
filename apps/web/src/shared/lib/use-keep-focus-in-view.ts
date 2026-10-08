// 有焦点的元素上方的内容变高之后，把它按最小距离滚回可视区域（M3-P6 复验 N1、再复核 D1、D5）。
// 上方的内容变高（写进说明、插进一条提示）会把排在它后面的内容整体往下挤，三个浏览器都不补偿滚动：在可视区域底部附近做完操作时，
// 焦点交还的按钮（那一行）被挤出可视区域。说明要等确认的弹窗关掉、焦点交还之后才写（读屏才播报），只能挤完之后再滚。
// 读屏的状态区（StatusRegion 的 keepFocusInView）与转移页"有文档已经不在了"的说明共用这一个做法。
import type { RefCallback } from 'react'
import { useCallback } from 'react'

/**
 * 有焦点的元素排在容器后面（会被它变高往下挤）时，按最小距离滚回可视区域（本来就看得见的不动）。
 * 焦点在 body 上、在容器里面、在容器前面（它变高挤不动）、或者那个元素已经不在文档里时什么也不做
 */
function keepFocusBelowInView(container: Element): void {
  const active = document.activeElement
  if (active === null || active === document.body || !active.isConnected || container.contains(active))
    return
  if ((container.compareDocumentPosition(active) & Node.DOCUMENT_POSITION_FOLLOWING) === 0)
    return
  active.scrollIntoView({ block: 'nearest' })
}

/**
 * 盯着一个一直在的容器（读屏的状态区；插提示的位置，空的时候可以不显示）的高度：它变高了，把排在它后面、有焦点的元素滚回可视区域。
 * 用 ResizeObserver：回调在布局之后、画到屏幕上之前送达，看不到跳动；容器里的子组件自己重新渲染引起的变高（例如之后才出现的
 * "列表还在刷新"）也接得住，与谁重新渲染无关。只在变高时滚：变矮、等高（"列表还在刷新"一句消失、打开确认框时清空、换成一样长的说明）
 * 时下面的内容往上走或者不动，不会被挤出去——这时用户若已经滚离了焦点所在的元素，也不把页面拉回去。窗口变窄引起的折行变高同样算变高。
 * 挂上时的高度只记下、不滚。容器要一直在：随内容一起插入的元素第一次量到的就是有内容的高度，看不出"变高"。
 * 返回容器的回调 ref：挂上时开始盯，卸下时停止；enabled 为 false 时什么也不做
 */
export function useKeepFocusInView(enabled = true): RefCallback<Element> {
  return useCallback((container: Element | null) => {
    if (!enabled || container === null)
      return
    let height = container.getBoundingClientRect().height
    const observer = new ResizeObserver(() => {
      const next = container.getBoundingClientRect().height
      const grew = next > height
      height = next
      if (grew)
        keepFocusBelowInView(container)
    })
    observer.observe(container, { box: 'border-box' })
    return () => {
      observer.disconnect()
    }
  }, [enabled])
}

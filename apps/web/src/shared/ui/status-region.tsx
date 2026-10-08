// 读屏用的状态区（role="status"）：做完一件事的说明、查找的进展这一类，内容变化时读屏软件播报（M2-P5 审查 B 的 M1）。
// 分享对话框、成员页、转移页、审计页与按关键词选一项共用；只由按需加载的功能引用，按路径引用（不经 shared/ui 的桶文件），不进首屏。
import type { ReactNode } from 'react'
import { useLayoutEffect, useRef } from 'react'

interface StatusRegionProps {
  /** 要说的话；没有时（undefined、null、false、空串）容器照样在，只是看不见 */
  readonly children?: ReactNode
  /** 有内容时的样式（边框、间距、字号等）；空的时候不用 */
  readonly className?: string
  /**
   * 放在长列表上方的状态区（账户页、成员页、转移页）：内容从无到有、换了、清空之后，把有焦点的元素按最小距离滚回可视区域
   * （`scrollIntoView({ block: 'nearest' })`，本来就看得见的不动）。状态区空的时候不占位置，写进说明时下面的内容整体下移，
   * 三个浏览器都不补偿滚动：在可视区域底部附近做完操作时，那一行与焦点交还的按钮被挤出可视区域（M3-P6 复验 C7 时在账户页发现）。
   * 说明要等确认的弹窗关掉、焦点交还之后才写（读屏才播报，ConfirmDialog 的 AfterConfirmed），所以只能写进去之后再滚。
   * 默认关：编辑器页里有焦点的可能是 Univer 的隐藏输入元素，滚它有风险；对话框里的状态区是固定定位的，不挤动页面；
   * 审计页、按关键词选一项的进展不在长列表上方
   */
  readonly keepFocusInView?: boolean
}

/** 没有要说的：React 不渲染的 undefined、null、false，另加空串（查找的进展等用空串表示没有） */
function isEmpty(children: ReactNode): boolean {
  return children === undefined || children === null || children === false || children === ''
}

/** 把有焦点的元素按最小距离滚回可视区域。焦点在 body 上、在状态区自己里面、或者那个元素已经不在文档里时什么也不做 */
function keepActiveInView(region: HTMLElement): void {
  const active = document.activeElement
  if (active === null || active === document.body || !active.isConnected || region.contains(active))
    return
  active.scrollIntoView({ block: 'nearest' })
}

/**
 * 状态区一直在无障碍树里，内容变化时往同一个元素里填：与内容一起插入的 role="status"，部分读屏软件不播报（M2-P2 复验）。
 * 空的时候同样不能 display: none（Tailwind 的 hidden、empty:hidden）——那样它不在无障碍树里，内容出现时等于与内容一起插入，
 * 原来分享对话框与审计页就是这样（M2-P5 审查 B 的 M1）。空的时候只做视觉隐藏（sr-only：不占位置，也不撑开 flex、grid 的间距），
 * 有内容时按 className 照常显示。role="status" 带 hidden 一类的写法由 lint 近似地拦下（eslint.config.ts 的 LIVE_STATUS_HIDDEN）。
 * keepFocusInView 开着时，画出来的文字变了的那一刻（布局已经变了、还没画到屏幕上：layout effect）把有焦点的元素滚回可视区域；
 * 按画出来的文字判断变没变：父组件重新渲染而文字没变时不滚，第一次画出来时只记下、不滚
 */
export function StatusRegion({ children, className, keepFocusInView = false }: StatusRegionProps) {
  const empty = isEmpty(children)
  const regionRef = useRef<HTMLParagraphElement>(null)
  /** 上一次画出来的文字；还没画过时为 undefined */
  const shownRef = useRef<string>(undefined)
  useLayoutEffect(() => {
    const region = regionRef.current
    if (region === null)
      return
    const shown = region.textContent
    const previous = shownRef.current
    shownRef.current = shown
    if (keepFocusInView && previous !== undefined && previous !== shown)
      keepActiveInView(region)
  })
  return <p ref={regionRef} role="status" data-slot="status-region" className={empty ? 'sr-only' : className}>{empty ? null : children}</p>
}

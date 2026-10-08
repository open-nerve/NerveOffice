// 读屏用的状态区（role="status"）：做完一件事的说明、查找的进展这一类，内容变化时读屏软件播报（M2-P5 审查 B 的 M1）。
// 账户页、成员页、转移页、审计页、分享对话框、按关键词选一项与编辑器页的页头共用；只由按需加载的功能与编辑器页引用，
// 按路径引用（不经 shared/ui 的桶文件），不进首屏。
import type { ReactNode } from 'react'
import { useKeepFocusInView } from '../lib/use-keep-focus-in-view.ts'

interface StatusRegionProps {
  /** 要说的话；没有时（undefined、null、false、空串）容器照样在，只是看不见 */
  readonly children?: ReactNode
  /** 有内容时的样式（边框、间距、字号等）；空的时候不用 */
  readonly className?: string
  /**
   * 放在长列表上方的状态区（账户页、成员页、转移页）：状态区变高之后，把排在它后面、有焦点的元素按最小距离滚回可视区域
   * （shared/lib/use-keep-focus-in-view.ts）。状态区空的时候不占位置，写进说明（从无到有、换成更长的）时下面的内容整体下移，
   * 三个浏览器都不补偿滚动：在可视区域底部附近做完操作时，那一行与焦点交还的按钮被挤出可视区域（M3-P6 复验 C7 时在账户页发现）。
   * 只在变高时滚：变矮、等高（"列表还在刷新"一句消失、打开确认框时清空）时下面的内容往上走或不动，用户这期间滚走了也不拉回去（再复核 D1）。
   * 默认关，不接的几处：编辑器页里有焦点的可能是 Univer 的隐藏输入元素，滚它有风险；分享对话框里添加成功时焦点在紧挨着状态区下面的
   * 表单里，取消分享之后焦点交给"已分享给"（focus() 已把它滚到看得见的地方），说明插在它上方只会把它往下推、不会推出去；
   * 审计页、按关键词选一项的进展在输入框下面，挤不动焦点所在的输入框
   */
  readonly keepFocusInView?: boolean
}

/** 没有要说的：React 不渲染的 undefined、null、false，另加空串（查找的进展等用空串表示没有） */
function isEmpty(children: ReactNode): boolean {
  return children === undefined || children === null || children === false || children === ''
}

/**
 * 状态区一直在无障碍树里，内容变化时往同一个元素里填：与内容一起插入的 role="status"，部分读屏软件不播报（M2-P2 复验）。
 * 空的时候同样不能 display: none（Tailwind 的 hidden、empty:hidden）——那样它不在无障碍树里，内容出现时等于与内容一起插入，
 * 原来分享对话框与审计页就是这样（M2-P5 审查 B 的 M1）。空的时候只做视觉隐藏（sr-only：不占位置，也不撑开 flex、grid 的间距），
 * 有内容时按 className 照常显示。role="status" 带 hidden 一类的写法由 lint 近似地拦下（eslint.config.ts 的 LIVE_STATUS_HIDDEN）。
 * keepFocusInView 开着时盯着状态区的高度（它一直在，空的时候 1 像素），见上
 */
export function StatusRegion({ children, className, keepFocusInView = false }: StatusRegionProps) {
  const empty = isEmpty(children)
  const keepInView = useKeepFocusInView(keepFocusInView)
  return <p ref={keepInView} role="status" data-slot="status-region" className={empty ? 'sr-only' : className}>{empty ? null : children}</p>
}

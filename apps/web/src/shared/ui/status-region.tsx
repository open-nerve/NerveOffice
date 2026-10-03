// 读屏用的状态区（role="status"）：做完一件事的说明、查找的进展这一类，内容变化时读屏软件播报（M2-P5 审查 B 的 M1）。
// 分享对话框、成员页、转移页、审计页与按关键词选一项共用；只由按需加载的功能引用，按路径引用（不经 shared/ui 的桶文件），不进首屏。
import type { ReactNode } from 'react'

interface StatusRegionProps {
  /** 要说的话；没有时（undefined、null、false、空串）容器照样在，只是看不见 */
  readonly children?: ReactNode
  /** 有内容时的样式（边框、间距、字号等）；空的时候不用 */
  readonly className?: string
}

/** 没有要说的：React 不渲染的 undefined、null、false，另加空串（查找的进展等用空串表示没有） */
function isEmpty(children: ReactNode): boolean {
  return children === undefined || children === null || children === false || children === ''
}

/**
 * 状态区一直在无障碍树里，内容变化时往同一个元素里填：与内容一起插入的 role="status"，部分读屏软件不播报（M2-P2 复验）。
 * 空的时候同样不能 display: none（Tailwind 的 hidden、empty:hidden）——那样它不在无障碍树里，内容出现时等于与内容一起插入，
 * 原来分享对话框与审计页就是这样（M2-P5 审查 B 的 M1）。空的时候只做视觉隐藏（sr-only：不占位置，也不撑开 flex、grid 的间距），
 * 有内容时按 className 照常显示。role="status" 带 hidden 一类的写法由 lint 近似地拦下（eslint.config.ts 的 LIVE_STATUS_HIDDEN）
 */
export function StatusRegion({ children, className }: StatusRegionProps) {
  const empty = isEmpty(children)
  return <p role="status" data-slot="status-region" className={empty ? 'sr-only' : className}>{empty ? null : children}</p>
}

// 列表上的行内操作面板（M2-P4 设计 §3.7）：哪一行展开了面板（整页只有一个）、列表上方的说明、焦点的去处。
// 空间页的内容区与"与我共享"共用（Codex 对抗评审 CX3：只凭单独授权的人在"与我共享"里复制与改名），不各写一份。
// 说明条本身在 organize-notice-bar.tsx
import type { RefObject } from 'react'
import type { OrganizeNotice } from './item-actions.tsx'
import { useRef, useState } from 'react'
import { useFocusAfterRender } from '../../shared/lib/use-focus-after-render.ts'

/** 展开了操作面板的那一个对象（整页只有一个：同时开几个面板既分散注意，也会白白多取几次元数据） */
export interface OpenItem {
  readonly kind: 'folder' | 'document'
  readonly id: string
}

export interface OrganizePanels {
  readonly open: OpenItem | undefined
  /**
   * 最后一次被点开的那一行的"操作"按钮：面板收起、说明关掉之后焦点回到它身上，不落到 body（M2-P4 审查建议 1）。
   * 由行在点击时记下这个元素，不用 React 的 ref：面板一收起，绑在"展开的那一行"上的 ref 就被置空了，那时已经晚了
   */
  readonly openTriggerRef: RefObject<HTMLButtonElement | null>
  /** 列表上方的说明：每次一条新的对象（它本身就是这条说明的标识，换了一条就再接一次焦点） */
  readonly notice: OrganizeNotice | undefined
  /** 展开或收起这一行的面板；收起时面板里的按钮随之消失，焦点还给这一行的"操作" */
  readonly toggle: (kind: OpenItem['kind'], id: string) => void
  /** 面板里做完了（或者没能完成）：收起面板；有说明时由说明条接住焦点，没有时焦点还给这一行的"操作" */
  readonly finish: (notice: OrganizeNotice | undefined) => void
  /** 面板之外的说明（新建文件夹的重放、被拒绝）：说明条接住焦点 */
  readonly showNotice: (notice: OrganizeNotice) => void
  /** 关掉说明：焦点还给那一行的"操作" */
  readonly closeNotice: () => void
}

/**
 * titleRef 是页面的标题（h1，tabIndex -1）：那一行已经不在了（删掉了、移走了、随新的权限不再有"操作"）时焦点交给它（M2-P6 复核 S3）
 */
export function useOrganizePanels(titleRef: RefObject<HTMLElement | null>): OrganizePanels {
  const [open, setOpen] = useState<OpenItem>()
  const [notice, setNotice] = useState<OrganizeNotice>()
  const openTriggerRef = useRef<HTMLButtonElement>(null)
  const focusAfterRender = useFocusAfterRender()

  /** 焦点还给那一行的"操作"；那一行已经不在了时交给页面的标题 */
  function focusTrigger(): void {
    focusAfterRender(openTriggerRef.current?.isConnected === true ? openTriggerRef : titleRef)
  }

  return {
    open,
    openTriggerRef,
    notice,
    toggle: (kind, id) => {
      const same = open?.kind === kind && open.id === id
      setOpen(same ? undefined : { kind, id })
      if (same)
        focusTrigger()
    },
    finish: (done) => {
      setOpen(undefined)
      setNotice(done)
      // 没有说明条时（例如改名成功）焦点还给这一行的"操作"；有说明条时由它接住（那一行常常随之消失）
      if (done === undefined)
        focusTrigger()
    },
    showNotice: setNotice,
    closeNotice: () => {
      setNotice(undefined)
      focusTrigger()
    },
  }
}

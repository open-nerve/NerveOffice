// 编辑器槽位（M3-P2 设计 §3.1；审查 A1）：编辑器页里"现在是哪一个编辑器"的唯一持有者——当前接上的编辑器、它的进展（surface）
// 与在途的那一次创建都在这里，阅读与编辑的状态机（edit-mode.ts）的每一次重建都经它。
//
// 不变量：同一个容器里至多一个编辑器、至多一次创建在途。Univer 按容器共用一个 React root（@univerjs/design 的 helper/react-dom.ts
// 的 rootMap）：两个实例同时建在同一个容器里时，后建的接管了这个 root，先建的那个销毁时把它的界面一起卸掉（审查 A1：刷新重建期间
// 点"编辑"，页面停在没有表格的编辑）。所以 replace 单飞：上一次创建还在途时先等它结束、销毁它的结果（那次 replace 交回 undefined），
// 再取出视图状态、销毁当前的编辑器，等销毁完，然后才新建。
// 销毁可能要等一会儿（M3-P4 设计 §3.14）：主线程公式模式下有一轮公式正在算时，编辑器先停下它、等它结束再销毁（SheetEditor.dispose
// 交回的 Promise）。槽位把每个销毁记下，新建之前等它们都销毁完——旧的实例还在销毁时不新建，同一个容器里不会同时有两个实例。
// 等的期间 surface 已经是 creating（页面的交互屏障挡着旧的界面）。
//
// 新建的编辑器先交回调用方（还没接上：surface 仍是 creating，页面的交互屏障挂着）：可编辑时调用方先建好保存的状态机，再 attach
// （之后 surface 随编辑器的生命周期，就绪时页面撤掉屏障，Codex 评审 CX1）。交回之后、接上之前被新的 replace 或 clear 取代的，
// 由这里销毁。
import type { EditorAccess, SheetEditor, SheetEditorLifecycle, SheetViewState } from '../../editor/index.ts'

/** 当前编辑器的进展：creating 是正在新建（含等旧的销毁完、建好还没接上；页面的交互屏障挡着），之后随编辑器的生命周期；没有编辑器时为 none */
export type EditorSurface = 'none' | 'creating' | SheetEditorLifecycle

/**
 * 新建编辑器的工厂：容器由页面绑定。recalculate：打开时强制全量重算（带"公式待更新"的文档进入编辑，M3-P4 设计 §3.5；适配层的
 * createSheetEditor 的同名参数）
 */
export type CreateModeEditor = (options: { readonly snapshot: string, readonly access: EditorAccess, readonly viewState?: SheetViewState | undefined, readonly recalculate?: boolean }) => Promise<SheetEditor>

/** 这一次新建的选项 */
export interface ReplaceOptions {
  /** 打开时强制全量重算（M3-P4 设计 §3.5：带"公式待更新"的文档进入编辑）；默认不 */
  readonly recalculate?: boolean
}

export interface EditorSlotOptions {
  readonly createEditor: CreateModeEditor
  /** surface 变了 */
  readonly onChange: () => void
  /** 新建失败：上报（浏览器的 reportError） */
  readonly reportError: (error: unknown) => void
}

export interface EditorSlot {
  /** 接上了的编辑器：新建期间（含建好、还没接上）与没有编辑器时为 undefined */
  readonly editor: () => SheetEditor | undefined
  readonly surface: () => EditorSurface
  /**
   * 换编辑器（§3.1）：先等在途的那一次创建结束、销毁它的结果，再取出视图状态、销毁现在的编辑器，等销毁完（主线程模式下可能要等
   * 正在算的一轮公式停下），以 access 与 snapshot 新建，就绪之后恢复视图状态。交回新建的编辑器（还没接上，由调用方 attach）。
   * 新建失败时上报、surface 为 none、交回 undefined；被之后的 replace 或 clear 取代时也交回 undefined（结果由这里销毁，失败不上报）
   */
  readonly replace: (access: EditorAccess, snapshot: string, options?: ReplaceOptions) => Promise<SheetEditor | undefined>
  /** 接上 replace 交回的编辑器：之后 surface 随它的生命周期。不是最近一次交回、还没接上的那一个（已被取代、已销毁）时什么也不做 */
  readonly attach: (created: SheetEditor) => void
  /**
   * 销毁现在的编辑器，在途的创建作废（建好之后销毁）；surface 为 none（读不到了、页面卸载）。销毁本身可能还要等一会儿：
   * 之后的 replace 照样等它销毁完再新建
   */
  readonly clear: () => void
}

export function createEditorSlot(options: EditorSlotOptions): EditorSlot {
  /** 接上了的编辑器与对它生命周期的订阅 */
  let attached: { readonly editor: SheetEditor, readonly unwatch: () => void } | undefined
  /** 建好、交回了调用方、还没接上的编辑器 */
  let handedOut: SheetEditor | undefined
  /** 在途的那一次创建：结束（成功、失败或被取代）时兑现 */
  let creating: Promise<void> | undefined
  /** replace、clear 的次数：更早的那次 replace 发现自己被取代，就不再接着做 */
  let ticket = 0
  /**
   * 最近一次取出的视图状态：新建的编辑器还没接上就被取代、或者新建失败时，下一个照样恢复它（例如以可编辑重建失败、
   * 回退以只读重建时，用户的视图不丢）
   */
  let carried: SheetViewState | undefined
  let surface: EditorSurface = 'none'
  /** 已经开始销毁、还没销毁完的编辑器都销毁完时兑现（SheetEditor.dispose 交回的 Promise 合在一起；从不失败） */
  let retiring: Promise<void> = Promise.resolve()

  function setSurface(next: EditorSurface): void {
    if (surface === next)
      return
    surface = next
    options.onChange()
  }

  /** 销毁一个编辑器：记下它销毁完的那一刻，新建之前等 */
  function retire(editor: SheetEditor): void {
    retiring = Promise.all([retiring, editor.dispose()]).then(() => undefined)
  }

  /** 销毁现在的编辑器与交回了还没接上的那一个；交回现在的视图状态（没有接上的编辑器时是上一次取出的） */
  function takeDown(): SheetViewState | undefined {
    if (attached !== undefined) {
      carried = attached.editor.viewState()
      attached.unwatch()
      retire(attached.editor)
      attached = undefined
    }
    if (handedOut !== undefined)
      retire(handedOut)
    handedOut = undefined
    return carried
  }

  return {
    editor: () => attached?.editor,
    surface: () => surface,

    replace: async (access, snapshot, replaceOptions = {}) => {
      const mine = ++ticket
      // 上一次创建还在途：等它结束（它在自己那边发现被取代，销毁结果）。等的不止一个时只有最后一个接着做：别的 replace、clear
      // 都会让 ticket 前进，所以等完之后还是自己的，就没有别的创建开始过
      if (creating !== undefined) {
        await creating
        if (mine !== ticket)
          return undefined
      }
      const viewState = takeDown()
      setSurface('creating')
      let finish: () => void = () => {}
      creating = new Promise<void>((resolve) => {
        finish = resolve
      })
      try {
        // 旧的编辑器销毁完才新建（主线程模式下可能要等正在算的一轮公式停下）：同一个容器里不同时有两个实例。等的期间被取代就不建了。
        // 等的期间不会再有新的销毁：同一时刻至多一次创建在途（别的 replace 先等这一次结束），清空时这里已经没有编辑器了
        await retiring
        if (mine !== ticket)
          return undefined
        const created = await options.createEditor(replaceOptions.recalculate === true ? { snapshot, access, viewState, recalculate: true } : { snapshot, access, viewState })
        if (mine !== ticket) {
          retire(created)
          return undefined
        }
        handedOut = created
        return created
      }
      catch (error) {
        // 已被取代（页面卸载、又换了一次）时这次的失败不再有人关心
        if (mine === ticket) {
          options.reportError(error)
          setSurface('none')
        }
        return undefined
      }
      finally {
        creating = undefined
        finish()
      }
    },

    attach: (created) => {
      if (created !== handedOut)
        return
      handedOut = undefined
      attached = { editor: created, unwatch: created.onLifecycle(setSurface) }
      setSurface(created.lifecycle())
    },

    clear: () => {
      ticket += 1
      takeDown()
      setSurface('none')
    },
  }
}

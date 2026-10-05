// E2E 的探针（M2-P3 设计 §3.7）：只在测试构建里（vite build --mode e2e），由 createSheetEditor 在就绪之后动态引入并装上。
// 生产构建里那个分支与这个分块都被去掉，门禁 artifacts 核对：生产产物里没有探针的分块（TEST_ONLY_ARTIFACTS），也没有 __nerveEditorProbe；
// 静态引入它（或 probe-facades.ts）会把补上的 Facade 带进生产构建、门禁认不出，所以 lint 规定非测试代码只能动态引入（M2-P6 复核 F5）。
// 为什么要它：画布上的内容读不出来，"改动被拦住"要比较内存里的快照；M0 的 28 个表格编辑入口里 21 个是直接调 Facade 的，
// 只读时界面上没有它们的入口，但防火墙必须拦住它们（SDK 升级可能带来新的入口），E2E 经这里逐项调用。
// 探针只读取与调用 Facade、读取两项内部服务（快捷键的清单、编辑栏的内容，经 internal-api 登记），不改变编辑器的行为；E2E 的其他用例不用它。
// 放在 editor/ 下：只有编辑器适配层能引用 Univer；文件名不带 test-support，生产代码（sheet-editor.ts）才能引用它。
// 另外两样（M2-P3 S3）：
// - 命令日志：订阅 Facade 的执行前与执行后的事件，记下每条命令。探针在就绪之后才装上，排在入口守卫与只读守卫之后，
//   读得到它们给出的 cancel（Facade 按订阅的顺序逐个调用，core 的 f-event-registry.ts 的 fireEvent）。
//   前提（P3 审查 B12）：探针只看得到在它之前订阅的监听者设下的取消；在它之后订阅的取消了命令，日志里的 canceled 仍是假，
//   而且随后没有 executed，看起来像是被 SDK 的权限检查拦下。现在没有这样的订阅者：守卫都在创建编辑器时装上，阅读与编辑之间的切换
//   一律重建编辑器、探针随新的编辑器重新装上（M3-P2 设计 §3.1）。将来有守卫在就绪之后才订阅时，要么重新装上探针（先撤掉再装，
//   排到最后），要么让守卫在探针之前订阅；
//   E2E 据此等到"这次操作已经处理完"（某条命令已被尝试、已被取消或已执行完），不用固定时长的等待；
// - M0 的 Facade 入口用到的插件 Facade（./probe-facades.ts）：编辑器只引用它自己用到的 Facade（sheet-editor.ts，包体积），
//   筛选、排序、图片、条件格式、数据验证、超链接、批注、查找替换的方法在各插件的 Facade 里。
// 再两样（M2-P6 复核 F1、F2 之后，只读的快捷键回归用）：SDK 当前注册的全部快捷键（Facade 的 FShortcut 只能派发，列不出来），
// 与编辑栏现在显示的文字（画在画布上，页面上读不出来）。
// 还有页面里打包的链接地址判定（M3-P3 S2）：链接的改写器用的就是它（经 contracts 的 normalizeCellLinks），E2E 拿跨引擎的同一组用例
// （contracts 的 link-address.test-support.ts）在三个浏览器里核对它的结果与 Node 相同。
// 捕获时机的复核（M3-P4 设计 §3.15，DEF-003）：命令日志每条带时刻（performance.now()）；露出编辑器的变更检测（本地修改序号）、
// 公式收齐与进度（与保存、自动保存读的是同一个跟踪器）与公式在哪里计算（测试构建可以选主线程模式，./formula-mode.ts）
import type { CanonicalLink } from '@nerve-office/contracts'
import type { Univer } from '@univerjs/core'
import type { FUniver } from '@univerjs/core/facade'
import type { ChangeTracker } from '../change-tracking/change-tracker.ts'
import type { CommandEvent } from '../change-tracking/command-event.ts'
import type { CommandKind } from '../change-tracking/command-record.ts'
import type { FormulaProgress } from '../change-tracking/formula-settle-tracker.ts'
import type { FormulaMode } from '../profile/sheet-profile.ts'
import { canonicalLink } from '@nerve-office/contracts'
import { toCommandRecord } from '../change-tracking/command-event.ts'
import { stringParam } from '../change-tracking/command-record.ts'
import { DOCS_FORMULA_BAR_EDITOR_UNIT_ID_KEY, injectorOf } from '../internal-api/index.ts'
import { IEditorService, IShortcutService } from '../internal-api/ui.ts'
import './probe-facades.ts'

type Workbook = ReturnType<FUniver['createWorkbook']>

/**
 * 命令日志里的一条：
 * - before：执行前（BeforeCommandExecute；撤销与重做是 BeforeUndo、BeforeRedo）。canceled 是排在探针之前的订阅者
 *   （入口守卫、只读守卫）给出的结果；SDK 自己的权限检查排在 Facade 的订阅之后，被它拦下的命令只有 before、没有 executed；
 * - executed：执行完（CommandExecuted；撤销与重做是 Undo、Redo）。命令返回 false 时同样送出
 */
export interface ProbeCommand {
  /** 从 1 开始的序号，按发生的顺序 */
  readonly seq: number
  /** 记下的时刻（performance.now()，页面的导航开始是 0）：Worker 同步回来的 mutation 是它在主线程上执行的时刻 */
  readonly at: number
  /**
   * 记下时编辑器的本地修改序号：变更检测在探针之前订阅（创建工作簿之前），所以执行完的那一条记下时，这条命令若被认作修改，序号已经加过了。
   * 前后两条的差就是这条命令算了几次修改——捕获的时机按它（编辑器自己的判定）算，不按命令日志另做的判定
   */
  readonly changeSeq: number
  readonly phase: 'before' | 'executed'
  readonly id: string
  readonly kind: CommandKind
  readonly canceled: boolean
  /** 参数里的 unitId；没有时为 undefined */
  readonly unitId: string | undefined
  /** 执行选项里为真的标记（onlyLocal、fromFormula 等） */
  readonly flags: readonly string[]
}

type ShortcutItem = ReturnType<IShortcutService['getAllShortcuts']>[number]

/**
 * SDK 注册的一个快捷键（快捷键服务 getAllShortcuts 的一项，只取 E2E 用到的字段）。绑定是 KeyCode 与修饰键（MetaKeys）的组合；
 * SDK 按页面的平台取其一：苹果的平台先看 mac，Windows 先看 win，Linux 先看 linux，都没有时用 binding（ui 的 shortcut.service.ts 的
 * _getBindingFromItem）。E2E 按同样的规则算出这个页面上要按的组合（tests/e2e/support/keyboard.ts）
 */
export interface ProbeShortcut {
  /** 按下时执行的命令 */
  readonly id: string
  readonly binding: number | undefined
  readonly mac: number | undefined
  readonly win: number | undefined
  readonly linux: number | undefined
  /** 同一个组合有几项时，先看优先级高的 */
  readonly priority: number
  /** 有没有前提条件：有的话只在满足时派发（例如单元格编辑器开着） */
  readonly conditional: boolean
}

export interface EditorProbe {
  /** 编辑器的 Facade：E2E 经它调用各个编辑入口 */
  readonly univerAPI: FUniver
  /** 内存里的快照，与编辑器的捕获相同（JSON.stringify(save())） */
  readonly snapshot: () => string
  /** 装上探针之后的命令日志：序号大于 after 的各条（默认全部） */
  readonly commands: (after?: number) => readonly ProbeCommand[]
  /** SDK 当前注册的全部快捷键（每次调用时重新读取） */
  readonly shortcuts: () => readonly ProbeShortcut[]
  /**
   * 编辑栏现在显示的文字：它的内部文档的正文，去掉结尾的段落与节的标记。取不到编辑栏的编辑器、或者它的文档没有正文时抛错
   * （M2-P6 复验 N3）：返回空串会让"编辑栏与单元格一致"的核对在两边都读出空串时照样通过
   */
  readonly formulaBarText: () => string
  /**
   * 页面里打包的链接地址判定（contracts 的 canonicalLink，M3-P3 设计 §3.2）：与链接的改写器（profile/link-policy.ts）用的是同一份代码。
   * 规范写法依赖各引擎的 WHATWG URL，E2E 经它在三个浏览器里跑跨引擎的同一组用例
   */
  readonly canonicalLink: (url: string) => CanonicalLink
  /** 编辑器的本地修改序号（变更检测，与保存读的是同一个） */
  readonly changeSeq: () => number
  /** 公式收齐了没有（formula-settle-tracker.ts 的三个条件，与保存等的是同一个判断） */
  readonly formulasSettled: () => boolean
  /** 公式计算的进度（轮数、开始、被停、完成、带结果与已写回的表、有没有排队） */
  readonly formulaProgress: () => FormulaProgress
  /** 公式在哪里计算：worker 或 main-thread（测试构建经地址参数选，./formula-mode.ts） */
  readonly formulaMode: FormulaMode
}

declare global {
  interface Window {
    /** 只在测试构建里有 */
    __nerveEditorProbe?: EditorProbe
  }
}

type FacadeEvent = CommandEvent & { readonly cancel?: boolean }

/** 执行选项里为真的标记 */
function flagsOf(options: Readonly<Record<string, unknown>> | undefined): string[] {
  return Object.entries(options ?? {}).filter(([, value]) => Boolean(value)).map(([key]) => key)
}

function toProbeShortcut(item: ShortcutItem): ProbeShortcut {
  return {
    id: item.id,
    binding: item.binding,
    mac: item.mac,
    win: item.win,
    linux: item.linux,
    priority: item.priority ?? 0,
    conditional: item.preconditions !== undefined || item.eventPreconditions !== undefined,
  }
}

/** 文档正文的结尾：段落标记 \r 与节的标记 \n（空的编辑栏就是这两个字符） */
const BODY_END = /\r\n$/

/** 编辑栏显示的文字：按编辑栏的单元 id 取它的编辑器、读它的文档；读不出来时抛错 */
function readFormulaBar(editors: IEditorService): string {
  const editor = editors.getEditor(DOCS_FORMULA_BAR_EDITOR_UNIT_ID_KEY)
  if (editor == null)
    throw new Error(`取不到编辑栏的编辑器（${DOCS_FORMULA_BAR_EDITOR_UNIT_ID_KEY}）：SDK 改了编辑栏的单元 id 或注册方式，回头核对 internal-api 的登记`)
  const dataStream = editor.getDocumentData().body?.dataStream
  if (dataStream === undefined)
    throw new Error('编辑栏的文档没有正文：SDK 改了编辑栏的文档，回头核对 internal-api 的登记')
  return dataStream.replace(BODY_END, '')
}

/**
 * 装上探针的编辑器：Univer 实例（取快捷键与编辑器管理的服务）、它的 Facade 与工作簿，变更检测与公式收齐的跟踪器，公式在哪里计算
 */
export interface ProbeTarget {
  readonly univer: Univer
  readonly univerAPI: FUniver
  readonly workbook: Workbook
  readonly changes: Pick<ChangeTracker, 'changeSeq' | 'formulasSettled' | 'formulaProgress'>
  readonly formulaMode: FormulaMode
}

/** 装上探针，返回移除它的函数（编辑器销毁时调用：退订命令事件；已经换成别的探针时不动 window 上的那个） */
export function installEditorProbe({ univer, univerAPI, workbook, changes, formulaMode }: ProbeTarget): () => void {
  const log: ProbeCommand[] = []
  const record = (phase: ProbeCommand['phase'], event: FacadeEvent): void => {
    const command = toCommandRecord(event)
    log.push({
      seq: log.length + 1,
      at: performance.now(),
      changeSeq: changes.changeSeq(),
      phase,
      id: command.id,
      kind: command.kind,
      canceled: phase === 'before' && event.cancel === true,
      unitId: stringParam(command, 'unitId'),
      flags: flagsOf(command.options),
    })
  }
  const { Event } = univerAPI
  const subscriptions = [
    univerAPI.addEvent(Event.BeforeCommandExecute, event => record('before', event)),
    univerAPI.addEvent(Event.CommandExecuted, event => record('executed', event)),
    // Facade 的 BeforeCommandExecute 与 CommandExecuted 不送出撤销与重做（core 的 f-univer.ts:202-213、255-268），另有专门的事件
    univerAPI.addEvent(Event.BeforeUndo, event => record('before', event)),
    univerAPI.addEvent(Event.BeforeRedo, event => record('before', event)),
    univerAPI.addEvent(Event.Undo, event => record('executed', event)),
    univerAPI.addEvent(Event.Redo, event => record('executed', event)),
  ]
  const injector = injectorOf(univer)
  const probe: EditorProbe = {
    univerAPI,
    snapshot: () => JSON.stringify(workbook.save()),
    commands: (after = 0) => log.filter(command => command.seq > after),
    shortcuts: () => injector.get(IShortcutService).getAllShortcuts().map(toProbeShortcut),
    formulaBarText: () => readFormulaBar(injector.get(IEditorService)),
    canonicalLink,
    changeSeq: changes.changeSeq,
    formulasSettled: changes.formulasSettled,
    formulaProgress: changes.formulaProgress,
    formulaMode,
  }
  window.__nerveEditorProbe = probe
  return () => {
    for (const subscription of subscriptions.splice(0))
      subscription.dispose()
    if (window.__nerveEditorProbe === probe)
      delete window.__nerveEditorProbe
  }
}

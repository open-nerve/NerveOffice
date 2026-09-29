// E2E 的探针（M2-P3 设计 §3.7）：只在测试构建里（vite build --mode e2e），由 createSheetEditor 在就绪之后动态引入并装上。
// 生产构建里那个分支与这个分块都被去掉，门禁 artifacts 核对：生产产物里没有探针的分块（TEST_ONLY_ARTIFACTS），也没有 __nerveEditorProbe。
// 为什么要它：画布上的内容读不出来，"改动被拦住"要比较内存里的快照；M0 的 28 个表格编辑入口里 21 个是直接调 Facade 的，
// 只读时界面上没有它们的入口，但防火墙必须拦住它们（SDK 升级可能带来新的入口），E2E 经这里逐项调用。
// 探针只读取与调用 Facade，不改变编辑器的行为；E2E 的其他用例不用它。
// 放在 editor/ 下：只有编辑器适配层能引用 Univer；文件名不带 test-support，生产代码（sheet-editor.ts）才能引用它。
// 另外两样（M2-P3 S3）：
// - 命令日志：订阅 Facade 的执行前与执行后的事件，记下每条命令。探针在就绪之后才装上，排在入口守卫与只读守卫之后，
//   读得到它们给出的 cancel（Facade 按订阅的顺序逐个调用，core 的 f-event-registry.ts 的 fireEvent）。
//   E2E 据此等到"这次操作已经处理完"（某条命令已被尝试、已被取消或已执行完），不用固定时长的等待；
// - M0 的 Facade 入口用到的插件 Facade（./probe-facades.ts）：编辑器只引用它自己用到的 Facade（sheet-editor.ts，包体积），
//   筛选、排序、图片、条件格式、数据验证、超链接、批注、查找替换的方法在各插件的 Facade 里
import type { FUniver } from '@univerjs/core/facade'
import type { CommandEvent } from '../change-tracking/command-event.ts'
import type { CommandKind } from '../change-tracking/command-record.ts'
import { toCommandRecord } from '../change-tracking/command-event.ts'
import { stringParam } from '../change-tracking/command-record.ts'
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
  readonly phase: 'before' | 'executed'
  readonly id: string
  readonly kind: CommandKind
  readonly canceled: boolean
  /** 参数里的 unitId；没有时为 undefined */
  readonly unitId: string | undefined
  /** 执行选项里为真的标记（onlyLocal、fromFormula 等） */
  readonly flags: readonly string[]
}

export interface EditorProbe {
  /** 编辑器的 Facade：E2E 经它调用各个编辑入口 */
  readonly univerAPI: FUniver
  /** 内存里的快照，与编辑器的捕获相同（JSON.stringify(save())） */
  readonly snapshot: () => string
  /** 装上探针之后的命令日志：序号大于 after 的各条（默认全部） */
  readonly commands: (after?: number) => readonly ProbeCommand[]
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

/** 装上探针，返回移除它的函数（编辑器销毁时调用：退订命令事件；已经换成别的探针时不动 window 上的那个） */
export function installEditorProbe(univerAPI: FUniver, workbook: Workbook): () => void {
  const log: ProbeCommand[] = []
  const record = (phase: ProbeCommand['phase'], event: FacadeEvent): void => {
    const command = toCommandRecord(event)
    log.push({
      seq: log.length + 1,
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
  const probe: EditorProbe = {
    univerAPI,
    snapshot: () => JSON.stringify(workbook.save()),
    commands: (after = 0) => log.filter(command => command.seq > after),
  }
  window.__nerveEditorProbe = probe
  return () => {
    for (const subscription of subscriptions.splice(0))
      subscription.dispose()
    if (window.__nerveEditorProbe === probe)
      delete window.__nerveEditorProbe
  }
}

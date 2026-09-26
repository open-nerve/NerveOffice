// 变更检测的判定（计划书 §7.3，插件档案 v1 §5.3，P4 设计 §3.6.5）：一条命令是不是"本文档的一次修改"。
// - 只看 MUTATION：命令与操作本身不改模型，它们执行的 mutation 会各自送出；
// - 排除带 onlyLocal、fromCollab、fromChangeset、fromFormula 标记的：不是用户修改，或内容来自别处
//   （公式结果写回、易变函数打开时的重算、Worker 同步回来的 mutation 都带 onlyLocal）；
//   syncOnly 的 mutation 本来就不送给普通监听者（core 的 command.service.ts:449-455）；
// - 排除作用于其他单元的：单元格编辑器内部文档的 doc.mutation.rich-text-editing 就是这一类，
//   所以正在编辑、还没提交的单元格不算修改；
// - 排除名单里的 mutation（档案的 CHANGE_DETECTION_EXCLUDED_MUTATIONS）；不排除自动行高。
// M0 实测：23 个样本的 37 种打开组合都不被判定为修改，48 种改内容的动作都被检测到，8 种只改视图的动作都不被检测（计划书 §7.3）
import type { CommandRecord } from './command-record.ts'
import { stringParam } from './command-record.ts'

export const EXCLUDED_EXECUTION_OPTIONS = ['onlyLocal', 'fromCollab', 'fromChangeset', 'fromFormula'] as const

export type ExcludedExecutionOption = (typeof EXCLUDED_EXECUTION_OPTIONS)[number]

export type ChangeVerdict
  = | 'change'
    | 'not-mutation'
    | `option:${ExcludedExecutionOption}`
    | 'other-unit'
    | 'excluded'

export interface ChangeClassifierConfig {
  /** 本文档的 unitId */
  readonly unitId: string
  /** 排除名单（插件档案 v1 §5.3） */
  readonly excludedMutationIds: readonly string[]
}

export function classifyCommand(record: CommandRecord, config: ChangeClassifierConfig): ChangeVerdict {
  if (record.kind !== 'mutation')
    return 'not-mutation'
  // 与 SDK 自己的判断一样按真值取（network 的 f-univer.ts:69-73）
  const option = EXCLUDED_EXECUTION_OPTIONS.find(key => Boolean(record.options?.[key]))
  if (option !== undefined)
    return `option:${option}`
  // 参数里没有 unitId 的 mutation 不知道作用于哪个单元，按本文档算：宁可多保存一次，不能漏掉修改
  const unitId = stringParam(record, 'unitId')
  if (unitId !== undefined && unitId !== config.unitId)
    return 'other-unit'
  if (config.excludedMutationIds.includes(record.id))
    return 'excluded'
  return 'change'
}

export function isDocumentChange(record: CommandRecord, config: ChangeClassifierConfig): boolean {
  return classifyCommand(record, config) === 'change'
}

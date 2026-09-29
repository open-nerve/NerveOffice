import type { CommandEvent } from './command-event.ts'
import { CommandType } from '@univerjs/core'
import { describe, expect, it } from 'vitest'
import { toCommandRecord } from './command-event.ts'

function event(type: CommandType, options?: CommandEvent['options']): CommandEvent {
  return { id: 'sheet.mutation.set-range-values', type, params: { unitId: 'unit-1' }, ...(options === undefined ? {} : { options }) }
}

describe('Facade 的命令事件转成命令记录', () => {
  it('类型换成字面量：命令、操作、mutation', () => {
    expect(toCommandRecord(event(CommandType.COMMAND)).kind).toBe('command')
    expect(toCommandRecord(event(CommandType.OPERATION)).kind).toBe('operation')
    expect(toCommandRecord(event(CommandType.MUTATION)).kind).toBe('mutation')
  })

  it('不认识的类型按命令算：变更检测与防火墙只看 mutation', () => {
    expect(toCommandRecord(event(99 as CommandType)).kind).toBe('command')
  })

  it('id、参数与执行选项原样带上；没有执行选项时为 undefined', () => {
    expect(toCommandRecord(event(CommandType.MUTATION, { onlyLocal: true }))).toEqual({
      id: 'sheet.mutation.set-range-values',
      kind: 'mutation',
      params: { unitId: 'unit-1' },
      options: { onlyLocal: true },
    })
    expect(toCommandRecord(event(CommandType.MUTATION)).options).toBeUndefined()
  })
})

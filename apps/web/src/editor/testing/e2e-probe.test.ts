import type { FUniver } from '@univerjs/core/facade'
import { afterEach, describe, expect, it } from 'vitest'
import { installEditorProbe } from './e2e-probe.ts'

type Workbook = ReturnType<FUniver['createWorkbook']>

function fakeWorkbook(content: () => unknown): Workbook {
  return { save: content } as unknown as Workbook
}

const univerAPI = { marker: 'facade' } as unknown as FUniver

afterEach(() => {
  delete window.__nerveEditorProbe
})

describe('E2E 的探针（M2-P3 设计 §3.7）', () => {
  it('装上之后 window.__nerveEditorProbe 给出 Facade 与内存里的快照（每次读取时重新保存）', () => {
    let cell = 'A'
    installEditorProbe(univerAPI, fakeWorkbook(() => ({ id: 'unit-1', cell })))
    const probe = window.__nerveEditorProbe
    expect(probe?.univerAPI).toBe(univerAPI)
    expect(probe?.snapshot()).toBe('{"id":"unit-1","cell":"A"}')
    cell = 'B'
    expect(probe?.snapshot()).toBe('{"id":"unit-1","cell":"B"}')
  })

  it('移除：删掉 window 上的探针；已经换成别的探针时不动', () => {
    const remove = installEditorProbe(univerAPI, fakeWorkbook(() => ({})))
    remove()
    expect('__nerveEditorProbe' in window).toBe(false)

    const removeFirst = installEditorProbe(univerAPI, fakeWorkbook(() => ({ n: 1 })))
    installEditorProbe(univerAPI, fakeWorkbook(() => ({ n: 2 })))
    removeFirst()
    expect(window.__nerveEditorProbe?.snapshot()).toBe('{"n":2}')
  })
})

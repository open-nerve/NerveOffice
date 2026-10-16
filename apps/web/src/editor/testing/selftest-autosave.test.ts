import type { AutosaveLogEntry } from './autosave-control.ts'
import { describe, expect, it } from 'vitest'
import { hiddenSavePreludeProblem } from './selftest-autosave.ts'

const first: AutosaveLogEntry = { kind: 'capture', trigger: 'control', at: 10, seq: 1, formulasPending: false, bytes: 20, durationMs: 1 }
const second: AutosaveLogEntry = { ...first, trigger: 'hidden', at: 30, seq: 2 }
const firstSaved: AutosaveLogEntry = { kind: 'upload', trigger: 'control', startedAt: 10, at: 40, seq: 1, outcome: { kind: 'saved', requestId: 'first' } }
const secondSaved: AutosaveLogEntry = { ...firstSaved, trigger: 'hidden', startedAt: 30, at: 50, seq: 2, outcome: { kind: 'saved', requestId: 'second' } }
const visible = { firstSeq: 1, secondSeq: 2, hiddenAt: undefined, save: 'dirty' }
const hidden = { ...visible, hiddenAt: 30, save: 'saving' }

describe('自检的首笔确认与隐藏交错', () => {
  it('先收到首笔确认、还没隐藏：第二格仍 dirty，只有第一格的控制捕获与上传', () => {
    expect(hiddenSavePreludeProblem([first, firstSaved], visible)).toBeUndefined()
  })

  it('先隐藏、才收到首笔确认：第二格确由隐藏捕获并正在保存', () => {
    expect(hiddenSavePreludeProblem([first, second, firstSaved], hidden)).toBeUndefined()
  })

  it('判定时隐藏上传也已经确认：两笔序号、原因与 clean 对应', () => {
    expect(hiddenSavePreludeProblem([first, second, firstSaved, secondSaved], { ...hidden, save: 'clean' })).toBeUndefined()
  })

  it.each(['saving', 'clean', undefined])('没隐藏时 %s 不能冒充第二格仍未保存', (save) => {
    expect(hiddenSavePreludeProblem([first, firstSaved], { ...visible, save })).toContain('应当是 dirty')
  })

  it('没有观察到隐藏时，额外捕获不能被接受', () => {
    expect(hiddenSavePreludeProblem([first, second, firstSaved], visible)).toContain('隐藏之前应当只有')
  })

  it('第二格未被检测到时失败', () => {
    expect(hiddenSavePreludeProblem([first, firstSaved], { ...visible, secondSeq: 1 })).toContain('没有被检测为修改')
  })

  it('第一笔确认的序号必须对应第一格', () => {
    expect(hiddenSavePreludeProblem([first, { ...firstSaved, seq: 2 }], visible)).toContain('第一格必须')
  })

  it.each([
    { trigger: 'quiet' },
    { seq: 1 },
    { at: 29 },
  ])('隐藏捕获的原因、序号和时间都必须匹配：%j', (change) => {
    expect(hiddenSavePreludeProblem([first, { ...second, ...change }, firstSaved], hidden)).toContain('隐藏的那一刻必须只捕获第二格')
  })

  it('已经隐藏却没捕获第二格，不能仅凭 saving 放过', () => {
    expect(hiddenSavePreludeProblem([first, firstSaved], hidden)).toContain('隐藏的那一刻必须只捕获第二格')
  })

  it('重复捕获不能被当作原来的两格', () => {
    expect(hiddenSavePreludeProblem([first, second, second, firstSaved], hidden)).toContain('不能有额外捕获')
  })

  it.each([
    { trigger: 'control' },
    { seq: 1 },
    { startedAt: 29 },
  ])('已确认的第二笔也须来自该次隐藏：%j', (change) => {
    expect(hiddenSavePreludeProblem([first, second, firstSaved, { ...secondSaved, ...change }], { ...hidden, save: 'clean' })).toContain('只能是隐藏触发的第二格上传')
  })

  it('隐藏上传失败照常失败，不能因为第一笔成功而放过', () => {
    expect(hiddenSavePreludeProblem([first, second, firstSaved, { ...secondSaved, outcome: { kind: 'failed' } }], { ...hidden, save: 'failed' })).toContain('自动保存出了问题')
  })

  it('还没确认隐藏保存时不能提前 clean，已确认后也不能仍 saving', () => {
    expect(hiddenSavePreludeProblem([first, second, firstSaved], { ...hidden, save: 'clean' })).toContain('应当是 saving')
    expect(hiddenSavePreludeProblem([first, second, firstSaved, secondSaved], hidden)).toContain('应当是 clean')
  })
})

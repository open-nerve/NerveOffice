import type { AutosaveView } from './autosave.ts'
import type { SaveView } from './save-coordinator.ts'
import type { SaveIndicator } from './save-indicator.ts'
import { describe, expect, it } from 'vitest'
import { NetworkError } from '../../shared/api/index.ts'
import { saveIndicator } from './save-indicator.ts'

const CLEAN: SaveView = { status: 'clean', formulasPending: false, problem: undefined, conflict: undefined, canSave: true, unsaved: false, unsavedEdits: false, checking: false, snapshotBytes: undefined }
const DIRTY: SaveView = { ...CLEAN, status: 'dirty', unsaved: true, unsavedEdits: true }
/** 修改都已存上、只差公式 */
const FORMULAS: SaveView = { ...CLEAN, status: 'dirty', formulasPending: true, unsaved: true }
const FAILED: SaveView = { ...DIRTY, status: 'failed', problem: { kind: 'request', error: new NetworkError('断网') } }
const ONLINE: AutosaveView = { offline: false, paused: false, retrying: false, held: false }

describe('编辑时的保存状态（设计 §3.9 的全集）', () => {
  it.each<[string, SaveView, AutosaveView | undefined, SaveIndicator]>([
    ['已保存到云端', CLEAN, ONLINE, 'saved'],
    ['有未保存的修改', DIRTY, ONLINE, 'unsaved'],
    ['单元格里有没提交的输入（修改没确认完）', { ...CLEAN, status: 'dirty', unsaved: true, unsavedEdits: true }, ONLINE, 'unsaved'],
    ['保存中（在途或排着）', { ...DIRTY, status: 'saving' }, ONLINE, 'saving'],
    ['重试在途时照样说保存中（失败的说明另外留着）', { ...FAILED, status: 'saving' }, { ...ONLINE, retrying: true }, 'saving'],
    ['只差公式的结果', FORMULAS, ONLINE, 'formulas-pending'],
    ['修改与公式都没存上：说有未保存的修改', { ...DIRTY, formulasPending: true }, ONLINE, 'unsaved'],
    ['保存失败、会自动重试', FAILED, { ...ONLINE, retrying: true }, 'retrying'],
    ['保存失败、要等新内容（不会自动重试）', FAILED, ONLINE, 'failed'],
    ['要等新内容时又离线了：仍说失败的原因（恢复网络也存不上）', FAILED, { ...ONLINE, offline: true }, 'failed'],
    ['离线、有没存上的修改', DIRTY, { ...ONLINE, offline: true }, 'offline'],
    ['离线、只差公式', FORMULAS, { ...ONLINE, offline: true }, 'offline'],
    ['离线而重试中：说离线（恢复之后立即重试）', FAILED, { ...ONLINE, offline: true, retrying: true }, 'offline'],
    ['离线、都已保存：说已保存到云端', CLEAN, { ...ONLINE, offline: true }, 'saved'],
    ['会话暂停、有没存上的修改', DIRTY, { ...ONLINE, paused: true }, 'paused'],
    ['会话类的失败、页面在确认会话', FAILED, { ...ONLINE, paused: true, retrying: true }, 'paused'],
    ['离线与暂停同时：先说离线', DIRTY, { ...ONLINE, offline: true, paused: true }, 'offline'],
    ['会话暂停、都已保存：说已保存到云端', CLEAN, { ...ONLINE, paused: true }, 'saved'],
    ['版本冲突（终态）', { ...DIRTY, status: 'conflict' }, { ...ONLINE, offline: true }, 'conflict'],
    ['需要刷新（终态）', { ...DIRTY, status: 'outdated' }, ONLINE, 'outdated'],
    ['不能保存（终态）', { ...DIRTY, status: 'too-new' }, ONLINE, 'too-new'],
    ['自动保存没接上：失败一律按失败说', FAILED, undefined, 'failed'],
    ['自动保存没接上：有未保存的修改', DIRTY, undefined, 'unsaved'],
  ])('%s', (_case, save, autosave, expected) => {
    expect(saveIndicator(save, autosave)).toBe(expected)
  })
})

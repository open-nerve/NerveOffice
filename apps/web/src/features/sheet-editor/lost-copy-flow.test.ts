import type { ConflictCopyQuery, CreatedDocument } from '@nerve-office/contracts'
import type { CaptureEditor } from './snapshot-capture.ts'
import { describe, expect, it, vi } from 'vitest'
import { ApiError, NetworkError } from '../../shared/api/index.ts'
import { captureLostContent, createLostCopyFlow } from './lost-copy-flow.ts'

const DOCUMENT = '0199a2c4-1f2e-7a3b-8c4d-5e6f7a8b9c0d'
const SNAPSHOT = '{"v":"本页的修改"}'
const CREATED: CreatedDocument = {
  id: '0199a2c4-1f2e-7a3b-8c4d-0000000000c1',
  title: '周报（冲突副本 2026-10-10 12:30）',
  type: 'sheet',
  createdAt: '2026-10-10T04:30:00.000Z',
  updatedAt: '2026-10-10T04:30:00.000Z',
  spaceId: '0199a2c4-1f2e-7a3b-8c4d-000000000001',
  space: { id: '0199a2c4-1f2e-7a3b-8c4d-000000000001', type: 'personal' },
  folderId: null,
  accessVia: 'space',
  revision: 1,
  profile: 'sheet@1',
  formatVersion: 1,
  sdkVersion: '0.24.0',
  formulasPending: false,
  permissions: { canEdit: true, canRename: true, canMoveWithinSpace: true, canMoveAcrossSpaces: true, canCopy: true, canDelete: true, canShare: true, canTakeOver: true },
  replayed: false,
}

function editorFixture() {
  const calls: string[] = []
  const editor = {
    changeSeq: () => 1,
    isCellEditing: (): boolean => true,
    settlePanels: vi.fn(async () => { calls.push('panels') }),
    commitCellEditing: vi.fn(async () => {
      calls.push('commit')
      return true
    }),
    settleFormulas: vi.fn(async (_timeoutMs: number): Promise<'settled' | 'timeout'> => {
      calls.push('formulas')
      return 'settled'
    }),
    capture: vi.fn(() => {
      calls.push('capture')
      return SNAPSHOT
    }),
  } satisfies CaptureEditor
  const reportError = vi.fn()
  return { editor, reportError, calls }
}

function copyFixture() {
  let request = 0
  const conflictCopy = vi.fn(async (_documentId: string, _query: ConflictCopyQuery, _body: Uint8Array<ArrayBuffer>): Promise<CreatedDocument> => CREATED)
  const compress = vi.fn(async (snapshot: string) => new TextEncoder().encode(snapshot))
  const onSessionProblem = vi.fn()
  const copy = createLostCopyFlow({
    documentId: DOCUMENT,
    snapshot: SNAPSHOT,
    lostAt: new Date(2026, 9, 10, 12, 30),
    formulasPending: true,
    title: () => '周报',
    newId: () => `copy-${++request}`,
    compress,
    conflictCopy,
    onSessionProblem,
  })
  return { copy, conflictCopy, compress, onSessionProblem }
}

describe('失去编辑权时捕获本页内容', () => {
  it('先落面板再提交单元格，按当前公式状态捕获', async () => {
    const { editor, reportError, calls } = editorFixture()
    expect(await captureLostContent(editor, reportError)).toEqual({ snapshot: SNAPSHOT, formulasPending: false, inputLeft: false })
    expect(calls).toEqual(['panels', 'commit', 'formulas', 'capture'])
    expect(editor.settleFormulas).toHaveBeenCalledExactlyOnceWith(0)
    expect(reportError).not.toHaveBeenCalled()
  })

  it('单元格提交不了仍保留模型里的修改，并说明最后输入没有进入快照', async () => {
    const { editor, reportError } = editorFixture()
    editor.commitCellEditing.mockResolvedValue(false)
    expect(await captureLostContent(editor, reportError)).toEqual({ snapshot: SNAPSHOT, formulasPending: false, inputLeft: true })
    expect(editor.capture).toHaveBeenCalledTimes(1)
    expect(reportError).not.toHaveBeenCalled()
  })

  it('没有正在编辑的单元格时不调用提交', async () => {
    const { editor, reportError } = editorFixture()
    editor.isCellEditing = () => false
    expect(await captureLostContent(editor, reportError)).toEqual({ snapshot: SNAPSHOT, formulasPending: false, inputLeft: false })
    expect(editor.commitCellEditing).not.toHaveBeenCalled()
  })

  it('公式没收齐时保留待更新标记', async () => {
    const { editor, reportError } = editorFixture()
    editor.settleFormulas.mockResolvedValue('timeout')
    expect(await captureLostContent(editor, reportError)).toEqual({ snapshot: SNAPSHOT, formulasPending: true, inputLeft: false })
  })

  it('没有编辑器时不编造快照，也不声称公式已经收齐', async () => {
    const reportError = vi.fn()
    expect(await captureLostContent(undefined, reportError)).toEqual({ snapshot: undefined, formulasPending: true, inputLeft: false })
    expect(reportError).not.toHaveBeenCalled()
  })

  it.each(['settlePanels', 'commitCellEditing', 'settleFormulas', 'capture'] as const)('%s 出错时不返回不完整快照，只上报一次', async (stage) => {
    const { editor, reportError } = editorFixture()
    const failure = new Error('SDK 失败')
    editor[stage].mockImplementationOnce(() => {
      throw failure
    })
    expect(await captureLostContent(editor, reportError)).toEqual({ snapshot: undefined, formulasPending: stage !== 'capture', inputLeft: false })
    expect(reportError).toHaveBeenCalledExactlyOnceWith(failure)
    if (stage !== 'capture')
      expect(editor.capture).not.toHaveBeenCalled()
  })
})

describe('失效副本的保存结果', () => {
  it('成功返回完整文档，捕获内容与失效时的公式标记进入副本请求', async () => {
    const { copy, conflictCopy, compress, onSessionProblem } = copyFixture()
    const result = await copy.save()
    expect(result).toEqual({ kind: 'done', document: CREATED })
    if (result.kind !== 'done')
      throw new Error('未返回副本文档')
    expect(result.document).toBe(CREATED)
    expect(compress).toHaveBeenCalledExactlyOnceWith(SNAPSHOT)
    expect(conflictCopy).toHaveBeenCalledExactlyOnceWith(DOCUMENT, { requestId: 'copy-1', title: CREATED.title, formulasPending: true }, new TextEncoder().encode(SNAPSHOT))
    expect(onSessionProblem).not.toHaveBeenCalled()
  })

  it('未知结果返回可重试，重试沿用请求标识并保留服务端的重放事实', async () => {
    const { copy, conflictCopy, onSessionProblem } = copyFixture()
    const failure = new NetworkError('断网')
    conflictCopy.mockRejectedValueOnce(failure)
    conflictCopy.mockResolvedValueOnce({ ...CREATED, replayed: true })
    expect(await copy.save()).toEqual({ kind: 'failed', error: failure })
    expect(await copy.save()).toEqual({ kind: 'done', document: { ...CREATED, replayed: true } })
    expect(conflictCopy.mock.calls.map(call => call[1].requestId)).toEqual(['copy-1', 'copy-1'])
    expect(onSessionProblem).not.toHaveBeenCalled()
  })

  it.each([
    { code: 'CLIENT_OUTDATED', status: 409, refusal: 'outdated' },
    { code: 'SNAPSHOT_INVALID', status: 422, refusal: 'content' },
    { code: 'PAYLOAD_TOO_LARGE', status: 413, refusal: 'content' },
  ] as const)('$code 保留明确拒绝及原始详情', async ({ code, status, refusal }) => {
    const { copy, conflictCopy, onSessionProblem } = copyFixture()
    const failure = new ApiError(status, code, '不能保存这份内容', { details: { reason: '验证详情' } })
    conflictCopy.mockRejectedValueOnce(failure)
    expect(await copy.save()).toEqual({ kind: 'refused', refusal, error: failure })
    expect(onSessionProblem).not.toHaveBeenCalled()
  })

  it.each(['UNAUTHENTICATED', 'SESSION_EXPIRED', 'CSRF_TOKEN_INVALID'] as const)('%s 通知会话问题一次，内容仍可重试', async (code) => {
    const { copy, conflictCopy, onSessionProblem } = copyFixture()
    const failure = new ApiError(code === 'CSRF_TOKEN_INVALID' ? 403 : 401, code, '会话需重新确认')
    conflictCopy.mockRejectedValueOnce(failure)
    expect(await copy.save()).toEqual({ kind: 'failed', error: failure })
    expect(onSessionProblem).toHaveBeenCalledExactlyOnceWith(failure)
    expect(await copy.save()).toEqual({ kind: 'done', document: CREATED })
    expect(onSessionProblem).toHaveBeenCalledTimes(1)
    expect(conflictCopy.mock.calls.map(call => call[1].requestId)).toEqual(['copy-1', 'copy-2'])
  })

  it.each([
    new ApiError(404, 'NOT_FOUND', '暂时读不到'),
    new ApiError(403, 'PERMISSION_DENIED', '暂时没有权限'),
    new ApiError(500, 'INTERNAL_ERROR', '服务端失败'),
    new Error('意外错误'),
  ])('其他失败可重试，不误判为内容拒绝或会话失效：%s', async (failure) => {
    const { copy, conflictCopy, onSessionProblem } = copyFixture()
    conflictCopy.mockRejectedValueOnce(failure)
    expect(await copy.save()).toEqual({ kind: 'failed', error: failure })
    expect(onSessionProblem).not.toHaveBeenCalled()
  })

  it('压缩失败可重试，不向服务端提交半份内容', async () => {
    const { copy, conflictCopy, compress, onSessionProblem } = copyFixture()
    const failure = new Error('压缩失败')
    compress.mockRejectedValueOnce(failure)
    expect(await copy.save()).toEqual({ kind: 'failed', error: failure })
    expect(conflictCopy).not.toHaveBeenCalled()
    expect(onSessionProblem).not.toHaveBeenCalled()
  })
})

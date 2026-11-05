import type { CreatedDocument, SessionResponse } from '@nerve-office/contracts'
import { describe, expect, it, vi } from 'vitest'
import { ApiError, NetworkError } from '../../shared/api/index.ts'
import { csvFile, pending } from './csv-controller.test-support.ts'
import { CSV_CREATED, CSV_CREATOR, csvCreationFixture } from './csv-create-controller.test-support.ts'

vi.hoisted(() => {
  globalThis.Path2D ??= class {} as unknown as typeof Path2D
})

async function preview(text = '001,=1+1\n甲,-12.5') {
  const h = csvCreationFixture()
  await h.controller.load()
  await h.controller.chooseFile(csvFile(text))
  expect(h.controller.view().stage).toBe('preview')
  return h
}

describe('CSV 创建前验证与单轮内存', () => {
  it('先确认位置和会话，预览仅保留 8×8/80 字符，不创建文档', async () => {
    const text = Array.from({ length: 10 }, () => Array.from<string>({ length: 10 }).fill('长'.repeat(100)).join(',')).join('\n')
    const h = await preview(text)
    expect(h.api.adopt).toHaveBeenCalledWith(CSV_CREATOR)
    expect(h.api.access).toHaveBeenCalledTimes(1)
    expect(h.api.create).not.toHaveBeenCalled()
    expect(h.controller.view().preview).toMatchObject({ rowCount: 10, columnCount: 10 })
    expect(h.controller.view().preview?.rows).toHaveLength(8)
    expect(h.controller.view().preview?.rows[0]).toHaveLength(8)
    expect(h.controller.view().preview?.rows[0]?.[0]?.length).toBeLessThanOrEqual(80)
    expect(JSON.stringify(h.controller.view())).not.toContain('长'.repeat(100))
    expect(h.controller.hasPendingWork()).toBe(true)
    h.controller.cancel()
    expect(h.controller.view()).toMatchObject({ stage: 'selecting', creation: 'none', preview: undefined })
    expect(h.controller.hasPendingWork()).toBe(false)
  })

  it('超过 5 MiB 读取前拒绝，错误不包含文件正文', async () => {
    const h = csvCreationFixture()
    await h.controller.load()
    const arrayBuffer = vi.fn(async () => new ArrayBuffer(0))
    await h.controller.chooseFile({ name: 'large.csv', size: 5 * 1024 * 1024 + 1, arrayBuffer })
    expect(arrayBuffer).not.toHaveBeenCalled()
    expect(h.controller.view()).toMatchObject({ stage: 'selecting', problem: 'bytes' })
    expect(h.api.create).not.toHaveBeenCalled()
  })

  it.each(['"未关闭', 'a\u0000b'])('格式失败不能创建：%s', async (text) => {
    const h = csvCreationFixture()
    await h.controller.load()
    await h.controller.chooseFile(csvFile(text))
    await h.controller.confirm()
    expect(h.controller.view().preview).toBeUndefined()
    expect(h.api.create).not.toHaveBeenCalled()
  })

  it('文件本身小于 1 MiB，候选 JSON 超限仍在创建前拒绝', async () => {
    const h = csvCreationFixture()
    await h.controller.load()
    await h.controller.chooseFile(csvFile(Array.from({ length: 30 }, () => '\u0001'.repeat(32_767)).join('\n')))
    expect(h.controller.view()).toMatchObject({ stage: 'selecting', problem: 'capacity' })
    await h.controller.confirm()
    expect(h.api.create).not.toHaveBeenCalled()
  })

  it('取消未结束的 File 读取，晚到数据不能恢复旧预览', async () => {
    const h = csvCreationFixture()
    await h.controller.load()
    const bytes = pending<ArrayBuffer>()
    const reading = h.controller.chooseFile({ name: 'late.csv', size: 1, arrayBuffer: async () => bytes.promise })
    h.controller.cancel()
    bytes.resolve(new TextEncoder().encode('x').buffer)
    await reading
    expect(h.controller.view()).toMatchObject({ stage: 'selecting', preview: undefined })
    expect(h.controller.hasPendingWork()).toBe(false)
    expect(h.api.create).not.toHaveBeenCalled()
  })

  it.each([
    { ...CSV_CREATOR, csrfToken: 'changed' },
    { ...CSV_CREATOR, user: { ...CSV_CREATOR.user, id: '0199a2c4-0000-7000-8000-000000000099' } },
  ])('确认时原会话变化，清空旧 CSV 并拒绝创建', async (session) => {
    const h = await preview()
    h.api.session.mockResolvedValue(session)
    await h.controller.confirm()
    expect(h.controller.view()).toMatchObject({ stage: 'invalid', preview: undefined, problem: 'identity' })
    expect(h.api.create).not.toHaveBeenCalled()
    expect(h.api.adopt).toHaveBeenCalledTimes(1)
  })

  it('离线禁创建，恢复后仍确认原会话与位置资格', async () => {
    const h = await preview()
    h.state.online = false
    await h.controller.confirm()
    expect(h.controller.view().problem).toBe('offline')
    expect(h.api.create).not.toHaveBeenCalled()
    h.state.online = true
    h.api.access.mockRejectedValueOnce(new ApiError(403, 'PERMISSION_DENIED', '已归档'))
    await h.controller.retry()
    expect(h.controller.view().problem).toBe('access-denied')
    expect(h.api.create).not.toHaveBeenCalled()
  })
})

describe('幂等创建、重放与创建后重试', () => {
  it('确认后只创建并导入一次，成功清掉本轮 CSV 内存', async () => {
    const h = await preview()
    await h.controller.confirm()
    expect(h.api.create).toHaveBeenCalledTimes(1)
    expect(h.api.create).toHaveBeenCalledWith({ type: 'sheet', spaceId: CSV_CREATOR.personalSpace.id, requestId: expect.any(String) as unknown })
    expect(h.api.openCreated).toHaveBeenCalledWith(CSV_CREATED, { userId: CSV_CREATOR.user.id, csrfToken: CSV_CREATOR.csrfToken })
    expect(h.applied).toEqual([{ rows: [['001', '=1+1'], ['甲', '-12.5']], rowCount: 2, columnCount: 2 }])
    expect(h.controller.view()).toMatchObject({ stage: 'done', creation: 'created', preview: undefined, document: { id: CSV_CREATED.id } })
    expect(h.controller.hasPendingWork()).toBe(false)
    await h.controller.confirm()
    await h.controller.retry()
    expect(h.api.create).toHaveBeenCalledTimes(1)
    expect(h.applied).toHaveLength(1)
  })

  it('POST 已发出时冻结文件与确认，取消不能假装撤销服务端事务', async () => {
    const h = await preview()
    const result = pending<CreatedDocument>()
    h.api.create.mockReturnValueOnce(result.promise)
    const creating = h.controller.confirm()
    await vi.waitFor(() => expect(h.api.create).toHaveBeenCalledTimes(1))
    await h.controller.confirm()
    await h.controller.chooseFile(csvFile('replacement'))
    h.controller.cancel()
    expect(h.controller.view()).toMatchObject({ stage: 'creating', creation: 'unknown' })
    expect(h.controller.hasPendingWork()).toBe(true)
    result.resolve(CSV_CREATED)
    await creating
    expect(h.applied[0]?.rows[0]).toEqual(['001', '=1+1'])
    expect(h.api.create).toHaveBeenCalledTimes(1)
  })

  it('创建响应丢失原请求重试，replayed 只给文档入口、不加载或导入旧正文', async () => {
    const h = await preview()
    h.api.create.mockRejectedValueOnce(new NetworkError('lost'))
    await h.controller.confirm()
    expect(h.controller.view()).toMatchObject({ stage: 'failed', creation: 'unknown', problem: 'result-unknown' })
    await h.controller.chooseFile(csvFile('replacement'))
    h.api.create.mockResolvedValueOnce({ ...CSV_CREATED, title: '已经改名', revision: 3, replayed: true })
    await h.controller.retry()
    expect(h.api.create.mock.calls[1]).toEqual(h.api.create.mock.calls[0])
    expect(h.controller.view()).toMatchObject({ stage: 'replayed', creation: 'created', document: { title: '已经改名' }, preview: undefined })
    expect(h.api.openCreated).not.toHaveBeenCalled()
    expect(h.applied).toEqual([])
    expect(h.controller.hasPendingWork()).toBe(false)
  })

  it('未知结果之后遇到 requestId 冲突，不能换新 id 悄悄再创建', async () => {
    const h = await preview()
    h.api.create.mockRejectedValueOnce(new NetworkError('lost'))
    await h.controller.confirm()
    h.api.create.mockRejectedValueOnce(new ApiError(409, 'REQUEST_ID_CONFLICT', '已经用过'))
    await h.controller.retry()
    expect(h.controller.view()).toMatchObject({ stage: 'invalid', creation: 'unknown' })
    await h.controller.retry()
    expect(h.api.create).toHaveBeenCalledTimes(2)
    expect(h.api.openCreated).not.toHaveBeenCalled()
  })

  it('未知结果之后失去新建权限，仍以原请求核对只读重放，零挂载和导入', async () => {
    const h = await preview()
    h.api.create.mockRejectedValueOnce(new NetworkError('lost'))
    await h.controller.confirm()
    const checks = h.api.access.mock.calls.length
    h.api.access.mockRejectedValue(new ApiError(403, 'PERMISSION_DENIED', '只能查看'))
    h.api.create.mockResolvedValueOnce({ ...CSV_CREATED, permissions: { ...CSV_CREATED.permissions, canEdit: false }, replayed: true })
    await h.controller.retry()
    expect(h.api.access).toHaveBeenCalledTimes(checks)
    expect(h.api.create).toHaveBeenCalledTimes(2)
    expect(h.api.create.mock.calls[1]).toEqual(h.api.create.mock.calls[0])
    expect(h.controller.view()).toMatchObject({ stage: 'replayed', creation: 'created', document: { id: CSV_CREATED.id }, preview: undefined })
    expect(h.api.openCreated).not.toHaveBeenCalled()
    expect(h.applied).toEqual([])
    expect(h.controller.hasPendingWork()).toBe(false)
  })

  it('未知结果核对被服务端拒绝，不能换 requestId 或凭旧位置预检补建', async () => {
    const h = await preview()
    h.api.create.mockRejectedValueOnce(new NetworkError('lost'))
    await h.controller.confirm()
    h.api.access.mockRejectedValue(new ApiError(403, 'PERMISSION_DENIED', '失去新建权限'))
    h.api.create.mockRejectedValueOnce(new ApiError(403, 'PERMISSION_DENIED', '服务端拒绝'))
    await h.controller.retry()
    expect(h.api.create).toHaveBeenCalledTimes(2)
    expect(h.api.create.mock.calls[1]).toEqual(h.api.create.mock.calls[0])
    expect(h.controller.view()).toMatchObject({ stage: 'invalid', creation: 'unknown', problem: 'already-created' })
    await h.controller.retry()
    expect(h.api.create).toHaveBeenCalledTimes(2)
    expect(h.applied).toEqual([])
  })

  it('此前没有未知结果的业务拒绝，明确未创建，可用新 requestId 重试', async () => {
    const h = await preview()
    h.api.create.mockRejectedValueOnce(new ApiError(403, 'PERMISSION_DENIED', '禁止'))
    await h.controller.confirm()
    expect(h.controller.view()).toMatchObject({ stage: 'failed', creation: 'none' })
    await h.controller.retry()
    expect(h.api.create.mock.calls[1]).not.toEqual(h.api.create.mock.calls[0])
    expect(h.applied).toHaveLength(1)
  })

  it('未知创建后收到会话类拒绝，保持可能已创建的事实、停止旧 CSV 意图', async () => {
    const h = await preview()
    h.api.create.mockRejectedValueOnce(new NetworkError('lost'))
    await h.controller.confirm()
    h.api.create.mockRejectedValueOnce(new ApiError(403, 'CSRF_TOKEN_INVALID', '失效'))
    await h.controller.retry()
    expect(h.api.create.mock.calls[1]).toEqual(h.api.create.mock.calls[0])
    expect(h.controller.view()).toMatchObject({ stage: 'invalid', creation: 'unknown', preview: undefined })
    await h.controller.retry()
    expect(h.api.create).toHaveBeenCalledTimes(2)
  })

  it('M5R-M-14 未知结果后流程作废：不再算未完成的工作（离开不拦），提示可能已创建、请回空间核对', async () => {
    const h = await preview()
    h.api.create.mockRejectedValueOnce(new NetworkError('lost'))
    await h.controller.confirm()
    expect(h.controller.hasPendingWork()).toBe(true)
    h.api.create.mockRejectedValueOnce(new ApiError(403, 'CSRF_TOKEN_INVALID', '失效'))
    await h.controller.retry()
    expect(h.controller.view()).toMatchObject({ stage: 'invalid', creation: 'unknown', problem: 'identity-unknown' })
    expect(h.controller.hasPendingWork()).toBe(false)
  })

  it('M5R-M-14 未知结果后的业务拒绝作废流程：同样不再拦离开', async () => {
    const h = await preview()
    h.api.create.mockRejectedValueOnce(new NetworkError('lost'))
    await h.controller.confirm()
    h.api.create.mockRejectedValueOnce(new ApiError(409, 'REQUEST_ID_CONFLICT', '已经用过'))
    await h.controller.retry()
    expect(h.controller.view()).toMatchObject({ stage: 'invalid', creation: 'unknown', problem: 'already-created' })
    expect(h.controller.hasPendingWork()).toBe(false)
  })

  it('M5R-M-14 首次创建收到服务端明确未生效的 503：按未创建处理，不再显示“结果尚未确认”，可取消、换文件或重试', async () => {
    const h = await preview()
    h.api.create.mockRejectedValueOnce(new ApiError(503, 'SERVICE_UNAVAILABLE', '繁忙'))
    await h.controller.confirm()
    expect(h.controller.view()).toMatchObject({ stage: 'failed', creation: 'none', problem: 'create-failed' })
    expect(h.controller.hasPendingWork()).toBe(true)
    // 503 不是载荷相关的结论，请求标识沿平台约定保留（request-ids.ts）；服务端确定未生效，重发同一请求同样只建一份
    await h.controller.retry()
    expect(h.api.create).toHaveBeenCalledTimes(2)
    expect(h.applied).toHaveLength(1)
  })

  it('M5R-M-14 首次创建收到其他 5xx 仍是结果未知，保持原请求核对', async () => {
    const h = await preview()
    h.api.create.mockRejectedValueOnce(new ApiError(500, 'INTERNAL_ERROR', '出错'))
    await h.controller.confirm()
    expect(h.controller.view()).toMatchObject({ stage: 'failed', creation: 'unknown', problem: 'result-unknown' })
  })

  it('创建后的宿主加载失败有文档链接，保留 CSV 重试且不再创建', async () => {
    const h = await preview()
    h.api.openCreated.mockRejectedValueOnce(new Error('load failed'))
    await h.controller.confirm()
    expect(h.controller.view()).toMatchObject({ stage: 'failed', creation: 'created', problem: 'open-failed', document: { id: CSV_CREATED.id } })
    expect(h.controller.hasPendingWork()).toBe(true)
    await h.controller.retry()
    expect(h.api.create).toHaveBeenCalledTimes(1)
    expect(h.api.openCreated).toHaveBeenCalledTimes(2)
    expect(h.applied).toHaveLength(1)
  })

  it('已创建文档的重试不再要求原位置可新建，仍由正式宿主核对编辑资格', async () => {
    const h = await preview()
    h.api.openCreated.mockRejectedValueOnce(new Error('load failed'))
    await h.controller.confirm()
    const checks = h.api.access.mock.calls.length
    h.api.access.mockRejectedValue(new ApiError(404, 'NOT_FOUND', '原文件夹已移动'))
    h.host.apply.mockResolvedValueOnce(false)
    await h.controller.retry()
    expect(h.api.access).toHaveBeenCalledTimes(checks)
    expect(h.api.create).toHaveBeenCalledTimes(1)
    expect(h.api.openCreated).toHaveBeenCalledTimes(2)
    expect(h.host.apply).toHaveBeenCalledTimes(1)
    expect(h.controller.view()).toMatchObject({ stage: 'failed', creation: 'created', problem: 'import-failed' })
    expect(h.applied).toEqual([])
  })

  it('应用前拒绝后沿原宿主重试，不能销毁用户可能已输入的正文；不重复创建', async () => {
    const h = await preview()
    h.host.apply.mockResolvedValueOnce(false)
    await h.controller.confirm()
    expect(h.controller.view()).toMatchObject({ stage: 'failed', problem: 'import-failed', creation: 'created' })
    await h.controller.retry()
    expect(h.host.dispose).not.toHaveBeenCalled()
    expect(h.api.openCreated).toHaveBeenCalledTimes(1)
    expect(h.api.create).toHaveBeenCalledTimes(1)
    expect(h.applied).toHaveLength(1)
  })

  it('导入完成后的会话变化由正式宿主处理，创建控制器不销毁其未保存正文', async () => {
    const h = await preview()
    await h.controller.confirm()
    h.controller.invalidate()
    expect(h.host.dispose).not.toHaveBeenCalled()
    expect(h.controller.view().stage).toBe('done')
    h.controller.dispose()
    expect(h.host.dispose).toHaveBeenCalledTimes(1)
  })
})

describe('异步边界的失效和销毁', () => {
  it('创建状态通知同步使来源失效，POST 尚未发出时也不能创建', async () => {
    const h = await preview()
    h.controller.subscribe(() => {
      if (h.controller.view().stage === 'creating')
        h.controller.invalidate()
    })
    await h.controller.confirm()
    expect(h.api.create).not.toHaveBeenCalled()
    expect(h.controller.view()).toMatchObject({ stage: 'invalid', creation: 'none' })
  })

  it('会话确认中失效，晚到确认不能创建', async () => {
    const h = await preview()
    const response = pending<SessionResponse>()
    h.api.session.mockReturnValueOnce(response.promise)
    const creating = h.controller.confirm()
    h.controller.invalidate()
    response.resolve(CSV_CREATOR)
    await creating
    expect(h.api.create).not.toHaveBeenCalled()
    expect(h.controller.view()).toMatchObject({ stage: 'invalid', preview: undefined })
  })

  it('创建在途页面销毁，晚到响应不挂载编辑器，仍知请求可能生效', async () => {
    const h = await preview()
    const response = pending<CreatedDocument>()
    h.api.create.mockReturnValueOnce(response.promise)
    const creating = h.controller.confirm()
    await vi.waitFor(() => expect(h.api.create).toHaveBeenCalledTimes(1))
    h.controller.dispose()
    response.resolve(CSV_CREATED)
    await creating
    expect(h.api.openCreated).not.toHaveBeenCalled()
    expect(h.controller.view()).toMatchObject({ stage: 'invalid', creation: 'unknown', preview: undefined })
  })

  it('宿主创建迟到，旧来源失效后必须立即销毁，不能导入', async () => {
    const h = await preview()
    const opening = pending<typeof h.host>()
    h.api.openCreated.mockReturnValueOnce(opening.promise)
    const creating = h.controller.confirm()
    await vi.waitFor(() => expect(h.api.openCreated).toHaveBeenCalledTimes(1))
    h.controller.invalidate()
    opening.resolve(h.host)
    await creating
    expect(h.host.dispose).toHaveBeenCalledTimes(1)
    expect(h.applied).toEqual([])
  })

  it('宿主应用中的身份见证会立即失效，失败不能再次启动旧写入', async () => {
    const h = await preview()
    const waiting = pending<boolean>()
    h.host.apply.mockImplementationOnce(async (_table, current) => {
      await waiting.promise
      expect(current()).toBe(false)
      return false
    })
    const creating = h.controller.confirm()
    await vi.waitFor(() => expect(h.host.apply).toHaveBeenCalledTimes(1))
    h.controller.invalidate()
    waiting.resolve(true)
    await creating
    expect(h.controller.view()).toMatchObject({ stage: 'invalid', preview: undefined })
    expect(h.applied).toEqual([])
    expect(h.host.dispose).not.toHaveBeenCalled()
  })
})

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { csvFile, pending } from './csv-controller.test-support.ts'
import { CSV_CREATED, csvCreationFixture } from './csv-create-controller.test-support.ts'
import { CsvCreateEntry } from './csv-create-entry.tsx'

vi.hoisted(() => {
  globalThis.Path2D ??= class {} as unknown as typeof Path2D
})

async function entry() {
  const h = csvCreationFixture()
  const ui = render(<CsvCreateEntry controller={h.controller} backHref="/spaces/example" />)
  await act(async () => h.controller.load())
  return { ...h, ui }
}

async function choose(text = '名称,值\n甲,001') {
  fireEvent.change(screen.getByLabelText('CSV 文件'), { target: { files: [csvFile(text)] } })
  await waitFor(() => expect(screen.queryByText('正在读取 CSV…')).not.toBeInTheDocument())
}

describe('从 CSV 新建的页面', () => {
  it('中文选择按钮触发原生文件输入，预览文本且确认前不创建', async () => {
    const h = await entry()
    const input = screen.getByLabelText('CSV 文件')
    const clicked = vi.spyOn(input, 'click')
    screen.getByRole('button', { name: '选择文件' }).focus()
    fireEvent.click(screen.getByRole('button', { name: '选择文件' }))
    expect(clicked).toHaveBeenCalledOnce()
    await choose('<script>bad</script>,001')
    expect(screen.getByRole('cell', { name: '<script>bad</script>' })).toBeInTheDocument()
    expect(h.ui.container.querySelector('script')).toBeNull()
    expect(h.api.create).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: '确认创建并导入' })).toBeEnabled()
  })

  it('取消清空预览并把焦点交回选择文件；保留返回空间链接', async () => {
    const h = await entry()
    await choose()
    fireEvent.click(screen.getByRole('button', { name: '取消选择' }))
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '选择文件' })).toHaveFocus()
    expect(screen.getByRole('link', { name: '返回空间' })).toHaveAttribute('href', '/spaces/example')
    expect(h.api.create).not.toHaveBeenCalled()
  })

  it('格式错误有可见说明且不允许创建', async () => {
    const h = await entry()
    await choose('"未闭合')
    expect(screen.getByRole('alert')).toHaveTextContent('CSV 格式不正确')
    expect(screen.getByRole('button', { name: '确认创建并导入' })).toBeDisabled()
    expect(h.api.create).not.toHaveBeenCalled()
  })

  it('创建在途冻结选择和确认；结果未知只允许核对同一创建', async () => {
    const h = await entry()
    const response = pending<typeof CSV_CREATED>()
    h.api.create.mockImplementationOnce(async () => response.promise)
    await choose()
    fireEvent.click(screen.getByRole('button', { name: '确认创建并导入' }))
    await waitFor(() => expect(h.api.create).toHaveBeenCalledOnce())
    expect(screen.getByRole('button', { name: '更换文件' })).toBeDisabled()
    expect(screen.queryByRole('button', { name: '取消选择' })).not.toBeInTheDocument()
    await act(async () => response.reject(new TypeError('network failed')))
    expect(screen.getByRole('alert')).toHaveTextContent('创建结果尚未确认')
    expect(screen.getByRole('button', { name: '重试' })).toBeEnabled()
    expect(screen.getByRole('button', { name: '更换文件' })).toBeDisabled()
  })

  it('已创建但导入失败保留文档链接；重试成功后让原页头报告保存', async () => {
    const h = await entry()
    h.host.apply.mockResolvedValueOnce(false)
    await choose()
    fireEvent.click(screen.getByRole('button', { name: '确认创建并导入' }))
    await screen.findByRole('button', { name: '重试' })
    expect(screen.getByRole('link', { name: '打开已创建文档' })).toHaveAttribute('href', `/documents/${CSV_CREATED.id}`)
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    await screen.findByText('CSV 已导入，请查看页头保存状态。')
    expect(h.api.create).toHaveBeenCalledOnce()
    expect(h.host.dispose).not.toHaveBeenCalled()
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
  })

  it('重放已有创建只提供链接，不自动导入；失效后不暴露旧预览', async () => {
    const h = await entry()
    h.api.create.mockResolvedValueOnce({ ...CSV_CREATED, replayed: true })
    await choose()
    fireEvent.click(screen.getByRole('button', { name: '确认创建并导入' }))
    await screen.findByText('已找到上一次创建的文档，本轮 CSV 未自动导入。')
    expect(h.host.apply).not.toHaveBeenCalled()
    act(() => h.controller.invalidate())
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent('登录状态已变化')
  })
})

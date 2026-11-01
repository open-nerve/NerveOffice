import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { csvFile, csvFixture, pending } from './csv-controller.test-support.ts'
import { CsvEntry } from './csv-entry.tsx'
import { blockInteractions } from './interaction-barrier.ts'

vi.hoisted(() => {
  globalThis.Path2D ??= class {} as unknown as typeof Path2D
})

function entry() {
  const h = csvFixture()
  const fallback = document.createElement('button')
  fallback.textContent = '返回文档'
  const ui = render(<header><CsvEntry controller={h.controller} fallbackFocus={() => fallback.focus()} /></header>)
  ui.container.append(fallback)
  return { ...h, fallback, ui }
}

async function choose(text: string) {
  fireEvent.change(screen.getByLabelText('CSV 文件'), { target: { files: [csvFile(text)] } })
  await waitFor(() => expect(screen.queryByText('正在读取 CSV…')).not.toBeInTheDocument())
}

describe('CSV 正式弹窗', () => {
  it('文件选择有明确中文按钮，预览期间暂不可写会说明原因', async () => {
    const h = entry()
    fireEvent.click(screen.getByRole('button', { name: '导入 CSV' }))
    expect(screen.getByRole('button', { name: '选择文件' })).toBeEnabled()
    await choose('甲,乙')
    expect(screen.getByRole('button', { name: '更换文件' })).toBeEnabled()
    act(() => {
      h.state.writable = false
      h.controller.environmentChanged()
    })
    expect(screen.getByRole('button', { name: '确认导入' })).toBeDisabled()
    expect(screen.getByRole('status')).toHaveTextContent('当前暂时不能导入，请确认网络连接、登录和编辑状态。')
    expect(screen.getByText('共 1 行、2 列')).toBeInTheDocument()
  })

  it('入口跟随真实能力，读取器尚未就绪时不能打开', () => {
    const h = entry()
    expect(screen.getByRole('button', { name: '导入 CSV' })).toBeEnabled()
    act(() => {
      h.state.writable = false
      h.controller.environmentChanged()
    })
    expect(screen.getByRole('button', { name: '导入 CSV' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '导出 CSV' })).toBeEnabled()
    act(() => {
      h.state.present = false
      h.controller.environmentChanged()
    })
    expect(screen.queryByRole('button', { name: '导出 CSV' })).not.toBeInTheDocument()
  })

  it('文件预览保留首行并仅渲染文本；确认后插表并报告完成', async () => {
    const h = entry()
    h.state.input = 'pending'
    fireEvent.click(screen.getByRole('button', { name: '导入 CSV' }))
    const dialog = screen.getByRole('dialog', { name: '导入 CSV' })
    expect(within(dialog).getByRole('button', { name: '确认导入' })).toBeDisabled()
    await choose('名称,值\n"<img src=x onerror=alert(1)>",001')
    expect(within(dialog).getByText('共 2 行、2 列')).toBeInTheDocument()
    expect(within(dialog).getByRole('cell', { name: '<img src=x onerror=alert(1)>' })).toBeInTheDocument()
    expect(dialog.querySelector('img')).toBeNull()
    expect(h.events).toEqual([])
    fireEvent.click(within(dialog).getByRole('button', { name: '确认导入' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(h.inserted[0]?.rows).toEqual([['名称', '值'], ['<img src=x onerror=alert(1)>', '001']])
    expect(h.state.body).toBe('用户刚输入的文字')
    expect(await screen.findByText('CSV 已导入新工作表，后续沿用自动保存。')).toBeInTheDocument()
  })

  it('解析错误可换文件重试；预览取消不提交原文字', async () => {
    const h = entry()
    h.state.input = 'pending'
    fireEvent.click(screen.getByRole('button', { name: '导入 CSV' }))
    await choose('坏"字段')
    expect(screen.getByRole('alert')).toHaveTextContent('CSV 格式不正确')
    await choose('甲,乙')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(h.state.input).toBe('pending')
    expect(h.inserted).toEqual([])
  })

  it('Esc 取消并恢复打开者焦点，迟到文件不重新打开弹窗', async () => {
    const h = entry()
    const gate = pending<ArrayBuffer>()
    const button = screen.getByRole('button', { name: '导入 CSV' })
    fireEvent.click(button)
    fireEvent.change(screen.getByLabelText('CSV 文件'), { target: { files: [{ name: '慢.csv', size: 1, arrayBuffer: async () => gate.promise }] } })
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    await waitFor(() => expect(button).toHaveFocus())
    await act(async () => {
      gate.resolve(new TextEncoder().encode('1').buffer)
    })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(h.inserted).toEqual([])
  })

  it('处理期间不能重复确认，取消后迟到会话复核不写入', async () => {
    const h = entry()
    const gate = pending<void>()
    h.steps.prepare = async () => gate.promise
    fireEvent.click(screen.getByRole('button', { name: '导入 CSV' }))
    await choose('1')
    fireEvent.click(screen.getByRole('button', { name: '确认导入' }))
    expect(screen.getByRole('button', { name: '正在导入…' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: '正在导入…' }))
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    await act(async () => {
      gate.resolve()
    })
    expect(h.inserted).toEqual([])
    expect(h.events).toEqual(['prepare'])
  })

  it('原实例失效关闭并清除预览，打开者不可用时焦点交给返回入口', async () => {
    const h = entry()
    fireEvent.click(screen.getByRole('button', { name: '导入 CSV' }))
    await choose('秘密内容')
    act(() => {
      h.state.current = false
      h.controller.environmentChanged()
    })
    await waitFor(() => expect(h.fallback).toHaveFocus())
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.queryByText('秘密内容')).not.toBeInTheDocument()
    expect(await screen.findByText('页面状态已变化，请重新打开 CSV 操作。')).toBeInTheDocument()
  })

  it('导出明确选择工作表，下载前可见文本保护说明', async () => {
    const h = entry()
    fireEvent.click(screen.getByRole('button', { name: '导出 CSV' }))
    const dialog = screen.getByRole('dialog', { name: '导出 CSV' })
    expect(within(dialog).getByLabelText('工作表')).toHaveValue('second')
    expect(within(dialog).getByText(/制表符/)).toBeInTheDocument()
    fireEvent.change(within(dialog).getByLabelText('工作表'), { target: { value: 'first' } })
    fireEvent.click(within(dialog).getByRole('button', { name: '下载 CSV' }))
    await waitFor(() => expect(h.downloads).toHaveLength(1))
    expect(h.downloads[0]?.name).toBe('预算-第一页.csv')
    expect(new TextDecoder().decode(h.downloads[0]?.bytes)).toBe('"甲"\r\n')
  })

  it('弹窗处于页头交互范围内，真实页面屏障不会吞掉取消操作', async () => {
    entry()
    fireEvent.click(screen.getByRole('button', { name: '导入 CSV' }))
    const unblock = blockInteractions(screen.getByRole('banner', { hidden: true }))
    try {
      fireEvent.click(screen.getByRole('button', { name: '取消' }))
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    }
    finally {
      unblock()
    }
  })
})

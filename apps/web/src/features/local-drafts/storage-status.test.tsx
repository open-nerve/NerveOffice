import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { deferred } from '../../shared/outbox/outbox-lock.test-support.ts'
import { requestPersistence, storageEstimate, storagePersisted } from '../../shared/outbox/storage-status.ts'
import { StorageStatus } from './storage-status.tsx'

vi.mock('../../shared/outbox/storage-status.ts', () => ({ requestPersistence: vi.fn(), storageEstimate: vi.fn(), storagePersisted: vi.fn() }))
beforeEach(() => {
  vi.mocked(storagePersisted).mockResolvedValue({ kind: 'not-persisted' })
  vi.mocked(storageEstimate).mockResolvedValue({ kind: 'estimated', usage: 0, quota: undefined })
  vi.mocked(requestPersistence).mockResolvedValue({ kind: 'denied' })
})

describe('存储状态的三个独立事实', () => {
  it('真实 0 用量照常显示，未知配额不补 0；说明站点范围和持久授权边界', async () => {
    render(<StorageStatus />)
    const region = await screen.findByRole('region', { name: '本机存储状态' })
    expect(await within(region).findByText('0 B')).toBeInTheDocument()
    expect(within(region).getByText('无法取得')).toBeInTheDocument()
    expect(within(region).getByText(/整个站点/)).toBeInTheDocument()
    expect(within(region).getByText(/不能保证/)).toBeInTheDocument()
    expect(within(region).getByRole('button', { name: '申请持久保存' })).toBeInTheDocument()
  })

  it('持久查询失败不影响可用的容量结果；缺 usage 不冒充配额占用', async () => {
    vi.mocked(storagePersisted).mockResolvedValue({ kind: 'failed', error: { name: 'Error', message: '不能查询' } })
    vi.mocked(storageEstimate).mockResolvedValue({ kind: 'estimated', usage: undefined, quota: 1024 * 1024 })
    render(<StorageStatus />)
    expect(await screen.findByText('1 MiB')).toBeInTheDocument()
    expect(screen.getAllByText('无法取得')).toHaveLength(2)
    expect(screen.queryByText('0 B')).not.toBeInTheDocument()
  })

  it('容量查询未返回时，已经取得的持久授权照常显示', async () => {
    vi.mocked(storageEstimate).mockReturnValueOnce(deferred<Awaited<ReturnType<typeof storageEstimate>>>().promise)
    vi.mocked(storagePersisted).mockResolvedValue({ kind: 'persisted' })
    render(<StorageStatus />)
    expect(await screen.findByText('已获准')).toBeInTheDocument()
  })

  it('持久授权查询未返回时，已经取得的容量照常显示', async () => {
    vi.mocked(storagePersisted).mockReturnValueOnce(deferred<Awaited<ReturnType<typeof storagePersisted>>>().promise)
    render(<StorageStatus />)
    expect(await screen.findByText('0 B')).toBeInTheDocument()
  })

  it('申请期间按钮和焦点保留，重复按不再发送；未获准照实说明', async () => {
    let resolve!: (value: { kind: 'denied' }) => void
    vi.mocked(requestPersistence).mockReturnValue(new Promise((done) => {
      resolve = done
    }))
    render(<StorageStatus />)
    const button = await screen.findByRole('button', { name: '申请持久保存' })
    button.focus()
    fireEvent.click(button)
    fireEvent.click(button)
    expect(requestPersistence).toHaveBeenCalledOnce()
    expect(button).toHaveAttribute('aria-disabled', 'true')
    expect(button).toHaveFocus()
    await act(async () => resolve({ kind: 'denied' }))
    expect(button).toHaveFocus()
    expect(screen.getByRole('status')).toHaveTextContent('浏览器尚未授予持久保存')
  })

  it('初始持久状态查询迟到，不能覆盖随后申请成功的事实', async () => {
    const wait = deferred<{ kind: 'not-persisted' }>()
    vi.mocked(storagePersisted).mockReturnValueOnce(wait.promise)
    vi.mocked(requestPersistence).mockResolvedValue({ kind: 'granted' })
    render(<StorageStatus />)
    fireEvent.click(screen.getByRole('button', { name: '申请持久保存' }))
    expect(await screen.findByText('已获准')).toBeInTheDocument()
    await act(async () => wait.resolve({ kind: 'not-persisted' }))
    expect(screen.getByText('已获准')).toBeInTheDocument()
  })
})

import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { connectionState } from '../../shared/lib/connection-state.ts'
import { NewCsvLink } from './new-csv-link.tsx'

const spaceId = '0199a2c4-0000-7000-8000-000000000001'
const folderId = '0199a2c4-0000-7000-8000-000000000002'
afterEach(() => {
  connectionState.setBrowserOnline(true)
  connectionState.succeeded(connectionState.beginRequest())
})

describe('平台 CSV 新建链接', () => {
  it.each([null, folderId])('CSV 链接只带目标位置，普通整页入口：%s', (folder) => {
    render(<NewCsvLink spaceId={spaceId} folderId={folder} />)
    expect(screen.getByRole('link', { name: '从 CSV 新建' })).toHaveAttribute('href', `/documents/new/csv?spaceId=${spaceId}${folder === null ? '' : `&folderId=${folder}`}`)
  })

  it('CSV 离线时点击和中键不能打开，恢复请求成功后再放行', () => {
    render(<NewCsvLink spaceId={spaceId} folderId={null} />)
    const link = screen.getByRole('link', { name: '从 CSV 新建' })
    act(() => connectionState.setBrowserOnline(false))
    expect(link).toHaveAttribute('aria-disabled', 'true')
    expect(fireEvent.click(link)).toBe(false)
    expect(fireEvent(link, new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 }))).toBe(false)
    act(() => connectionState.setBrowserOnline(true))
    expect(link).toHaveAttribute('aria-disabled', 'true')
    act(() => connectionState.succeeded(connectionState.beginRequest()))
    expect(link).toHaveAttribute('aria-disabled', 'false')
  })
})

// 一次性链接只显示这一次：链接、到期时间与"只显示这一次"的提示；复制成功与失败；关闭之后焦点交给页面（审查 B9）。
import type { IssuedLink } from './issued-link-dialog.tsx'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { IssuedLinkDialog } from './issued-link-dialog.tsx'

const URL_OF_LINK = 'https://docs.example.com/invite#token'

function link(changes: Partial<IssuedLink> = {}): IssuedLink {
  return { title: '邀请链接', recipient: { displayName: '张三', username: 'zhang.san' }, url: URL_OF_LINK, expiresAt: '2026-10-05T02:00:00.000Z', returnFocus: () => {}, ...changes }
}

function Page({ issued, onClose }: { readonly issued: IssuedLink, readonly onClose?: () => void }) {
  const [shown, setShown] = useState<IssuedLink>()
  return (
    <>
      <button type="button" onClick={() => setShown(issued)}>签发</button>
      <input aria-label="登录名" />
      <IssuedLinkDialog
        link={shown}
        onClose={() => {
          setShown(undefined)
          onClose?.()
        }}
      />
    </>
  )
}

async function openLink(issued: IssuedLink, onClose?: () => void): Promise<HTMLElement> {
  render(<Page issued={issued} onClose={onClose} />)
  fireEvent.click(screen.getByRole('button', { name: '签发' }))
  // 弹窗的可读名称来自标题：发给谁用 PersonName 呈现（登录名在前、显示名在后，分开呈现，M2-P6 复核 M2、第二批 M-1）
  return screen.findByRole('dialog', { name: `${issued.title}：@${issued.recipient.username} ${issued.recipient.displayName}` })
}

function stubClipboard(writeText: (text: string) => Promise<void>): void {
  vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
}

describe('IssuedLinkDialog', () => {
  it('链接、到期时间与"只显示这一次"的提示；点输入框选中整条链接', async () => {
    const dialog = await openLink(link({ note: '另外的说明' }))
    const input = within(dialog).getByLabelText('链接')
    expect(input).toHaveValue(URL_OF_LINK)
    expect(input).toHaveAttribute('readonly')
    expect(dialog).toHaveAccessibleDescription(/链接只显示这一次/)
    expect(within(dialog).getByText(/之前有效$/)).toHaveTextContent('2026年10月5日')
    expect(within(dialog).getByText('另外的说明')).toBeInTheDocument()
    fireEvent.focus(input)
    expect((input as HTMLInputElement).selectionStart).toBe(0)
    expect((input as HTMLInputElement).selectionEnd).toBe(URL_OF_LINK.length)
  })

  it('复制成功：说明已复制', async () => {
    const writeText = vi.fn(async () => {})
    stubClipboard(writeText)
    const dialog = await openLink(link())
    fireEvent.click(within(dialog).getByRole('button', { name: '复制链接' }))
    expect(await within(dialog).findByRole('status')).toHaveTextContent('已复制')
    expect(writeText).toHaveBeenCalledWith(URL_OF_LINK)
  })

  it('复制失败（浏览器不给剪贴板）：请手动复制；关闭后再打开，上一次的结果不留下', async () => {
    stubClipboard(async () => {
      throw new Error('denied')
    })
    const dialog = await openLink(link())
    fireEvent.click(within(dialog).getByRole('button', { name: '复制链接' }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('复制失败，请选中链接后手动复制')
    fireEvent.click(within(dialog).getByRole('button', { name: '关闭' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    fireEvent.click(screen.getByRole('button', { name: '签发' }))
    const again = await screen.findByRole('dialog')
    expect(within(again).queryByRole('alert')).toBeNull()
  })

  it('关闭：通知页面；焦点交给页面指定的元素，不落到 body（审查 B9）', async () => {
    const onClose = vi.fn()
    const returnFocus = vi.fn(() => screen.getByLabelText('登录名').focus())
    const dialog = await openLink(link({ returnFocus }), onClose)
    fireEvent.keyDown(dialog, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(onClose).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('登录名')))
    expect(returnFocus).toHaveBeenCalledTimes(1)
  })
})

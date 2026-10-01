// 区域里有焦点的元素消失时焦点不落到 body（M2-P6 复核 S3）：交给页面的标题；有意的焦点移动不受影响。
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useRef, useState } from 'react'
import { describe, expect, it } from 'vitest'
import { useFocusRescue } from './use-focus-rescue.ts'

function Page({ moveFocusTo }: { readonly moveFocusTo?: 'notice' }) {
  const titleRef = useRef<HTMLHeadingElement>(null)
  const rescue = useFocusRescue(titleRef)
  const [shown, setShown] = useState(true)
  return (
    <>
      <button type="button">区域外</button>
      <section ref={rescue}>
        <h1 ref={titleRef} tabIndex={-1}>标题</h1>
        {shown && <button type="button" onClick={() => setShown(false)}>会消失</button>}
        {!shown && moveFocusTo === 'notice' && (
          <div
            ref={element => element?.focus()}
            tabIndex={-1}
          >
            说明
          </div>
        )}
        <button type="button" onClick={() => setShown(false)}>让它消失</button>
      </section>
    </>
  )
}

describe('useFocusRescue', () => {
  it('有焦点的元素随渲染消失：焦点交给标题，不落到 body', async () => {
    render(<Page />)
    const vanishing = screen.getByRole('button', { name: '会消失' })
    vanishing.focus()
    fireEvent.click(vanishing)
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('heading', { name: '标题' })))
  })

  it('焦点已经被有意移到别处（新出现的说明）：不抢', async () => {
    render(<Page moveFocusTo="notice" />)
    const vanishing = screen.getByRole('button', { name: '会消失' })
    vanishing.focus()
    fireEvent.click(vanishing)
    await waitFor(() => expect(document.activeElement).toBe(screen.getByText('说明')))
  })

  it('焦点主动移到区域外的元素之后，区域里之前有焦点的元素再消失：不动焦点', async () => {
    render(<Page />)
    screen.getByRole('button', { name: '会消失' }).focus()
    const outside = screen.getByRole('button', { name: '区域外' })
    outside.focus()
    fireEvent.click(screen.getByRole('button', { name: '让它消失' }))
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(document.activeElement).toBe(outside)
  })

  it('消失的不是有焦点的那个：不动焦点', async () => {
    render(<Page />)
    const stays = screen.getByRole('button', { name: '让它消失' })
    stays.focus()
    fireEvent.click(stays)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(document.activeElement).toBe(stays)
  })
})

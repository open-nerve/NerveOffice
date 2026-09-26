import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { App } from './app.tsx'

describe('App', () => {
  it('显示产品名称作为一级标题', () => {
    render(<App />)
    expect(screen.getByRole('heading', { level: 1, name: 'NerveOffice' })).toBeInTheDocument()
  })
})

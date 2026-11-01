import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { ThinkingSelector } from './model-selector'

describe('ThinkingSelector', () => {
  it('offers only supported strengths and reports a selection', async () => {
    const onSelect = vi.fn()
    render(<ThinkingSelector levels={['low', 'high']} value={undefined} onSelect={onSelect} />)
    await userEvent.click(screen.getByRole('button', { name: /思考强度/ }))
    expect(screen.getByRole('option', { name: '默认' })).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: '中' })).not.toBeInTheDocument()
    await userEvent.keyboard('{End}')
    expect(screen.getByRole('option', { name: '高' })).toHaveFocus()
    await userEvent.keyboard('{Enter}')
    expect(onSelect).toHaveBeenCalledWith('high')
  })

  it('shows a disabled default when the model exposes no strength options', () => {
    render(<ThinkingSelector onSelect={() => {}} />)
    expect(screen.getByRole('button', { name: '思考强度：默认' })).toBeDisabled()
  })
})

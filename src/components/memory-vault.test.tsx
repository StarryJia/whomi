import { useState } from 'react'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import type { AnalysisTask } from '../shared/ai-contract'
import { MemoryLibrary } from './memory-library'

const report: AnalysisTask['report'] = { format: 'memory-v3', dimensions: { EI: null, SN: null, TF: null, JP: null }, eventVotes: { EI: [0,0], SN: [0,0], TF: [0,0], JP: [0,0] }, events: [], relationship: '虚构关系解读' }
const task = (id: string, pending = false): AnalysisTask => ({ id, conversationId: '1', conversationTitle: '虚构会话甲', modelId: 'old-model', modelIdentity: { id: 'old-model', label: '旧模型名称', model: 'actual-model-v1', version: 1 }, createdAtMs: new Date(2026, 2, 14, 10, 24).getTime(), completedAtMs: pending ? null : new Date(2026, 2, 15, 18, 42).getTime(), sourceStartTimeMs: new Date(2025, 11, 31).getTime(), sourceEndTimeMs: new Date(2026, 2, 12).getTime(), state: pending ? 'stopped' : 'completed', analyzedMessages: 8, totalMessages: 24, skippedMessages: 0, usage: {}, valid: true, eventSequence: 1, report: pending ? undefined : report })
function props() { return { entries: [task('6')], unfinished: [task('10', true), task('9', true)], conversations: [{ id: '1', title: '虚构会话甲', messageCount: 24 }], onSelect: vi.fn(), onStart: vi.fn(), onImport: vi.fn(), loading: false, error: '', retry: vi.fn(), hasMore: false, loadMore: vi.fn(), listLoading: false, retryList: vi.fn() } }

it('会话与未完成分组独立收展，保留真实日期、范围、模型和任务编号并打开指定任务', async () => {
  const user = userEvent.setup(), input = props()
  render(<MemoryLibrary {...input} />)
  const group = screen.getByRole('button', { name: '虚构会话甲' })
  expect(group).toHaveTextContent('1 份记忆 · 2 项未完成')
  const finished = screen.getByRole('button', { name: '虚构会话甲 · 我们的记忆 #0006' })
  expect(finished).toHaveTextContent('2025年12月31日 至 2026年3月12日')
  expect(finished).toHaveTextContent('生成于 2026年3月15日 18:42')
  expect(finished).toHaveTextContent('actual-model-v1')
  const pending = screen.getByRole('button', { name: '虚构会话甲 · 未完成的记忆 #0010 · 继续整理' })
  expect(pending).toHaveTextContent('创建于 2026年3月14日 10:24')
  expect(pending).toHaveTextContent('已整理 8 / 24 条')
  await user.click(screen.getByRole('button', { name: '未完成（2）' }))
  expect(pending).not.toBeVisible()
  expect(finished).toBeVisible()
  await user.click(group)
  expect(finished).not.toBeVisible()
  await user.click(group)
  expect(finished).toBeVisible()
  expect(pending).not.toBeVisible()
  await user.click(screen.getByRole('button', { name: '未完成（2）' }))
  await user.click(pending)
  expect(input.onStart).toHaveBeenCalledWith('1', '10')
  await user.click(finished)
  expect(input.onSelect).toHaveBeenCalledWith('6')
})

it('旧记录日期和模型未知时保留未记录，创建新记忆取消后回到列表', async () => {
  const user = userEvent.setup(), input = props()
  render(<MemoryLibrary {...input} entries={[{ ...task('6'), createdAtMs: null, completedAtMs: null, modelIdentity: undefined, sourceStartTimeMs: null }]} />)
  const row = screen.getByRole('button', { name: '虚构会话甲 · 我们的记忆 #0006' })
  expect(row).toHaveTextContent('生成时间未记录')
  expect(row).toHaveTextContent('聊天时间未记录')
  expect(row).toHaveTextContent('模型未记录')
  await user.click(screen.getByRole('button', { name: '生成新记忆' }))
  expect(screen.getByRole('heading', { name: '选择一段会话' })).toHaveFocus()
  await user.click(screen.getByRole('button', { name: '取消选择' }))
  expect(screen.getByRole('button', { name: '虚构会话甲 · 我们的记忆 #0006' })).toBeVisible()
})

it('记忆复用右键菜单，删除确认明确保留原文，失败可重试且取消不删除', async () => {
  const user = userEvent.setup(), input = props(), remove = vi.fn().mockRejectedValueOnce(Error('磁盘忙，请重试。')).mockResolvedValue(undefined)
  const arrange = vi.fn(async () => {})
  render(<MemoryLibrary {...input} arrange={arrange} remove={remove} />)
  const row = screen.getByRole('button', { name: '虚构会话甲 · 我们的记忆 #0006' })
  fireEvent.contextMenu(row)
  await user.click(await screen.findByRole('menuitem', { name: '置顶' }))
  expect(arrange).toHaveBeenCalledWith({ id: '6', pinned: true })
  fireEvent.contextMenu(row)
  await user.click(await screen.findByRole('menuitem', { name: '删除' }))
  let dialog = screen.getByRole('dialog')
  expect(dialog).toHaveTextContent('保留原始聊天和其他记忆')
  await user.click(within(dialog).getByRole('button', { name: '取消' }))
  expect(remove).not.toHaveBeenCalled()
  fireEvent.contextMenu(row)
  await user.click(await screen.findByRole('menuitem', { name: '删除' }))
  dialog = screen.getByRole('dialog')
  await user.click(within(dialog).getByRole('button', { name: '确认删除' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('磁盘忙')
  await user.click(within(dialog).getByRole('button', { name: '确认删除' }))
  expect(remove).toHaveBeenCalledTimes(2)
  expect(remove).toHaveBeenLastCalledWith('6')
})

it('键盘菜单关闭后返回原条目，删除后避开已收起的任务并聚焦可见分组', async () => {
  const user = userEvent.setup(), input = props()
  function Fixture() {
    const [entries, setEntries] = useState([task('6'), { ...task('5'), conversationId: '2', conversationTitle: '虚构会话乙' }])
    return <MemoryLibrary {...input} entries={entries} unfinished={[]} remove={async id => { setEntries(items => items.filter(item => item.id !== id)) }} />
  }
  render(<Fixture />)
  await user.click(screen.getByRole('button', { name: '虚构会话乙' }))
  const row = screen.getByRole('button', { name: '虚构会话甲 · 我们的记忆 #0006' })
  row.focus()
  fireEvent.keyDown(row, { key: 'F10', shiftKey: true })
  expect(await screen.findByRole('menuitem', { name: '删除' })).toBeVisible()
  await user.keyboard('{Escape}')
  await waitFor(() => expect(row).toHaveFocus())
  fireEvent.keyDown(row, { key: 'ContextMenu' })
  await user.click(await screen.findByRole('menuitem', { name: '删除' }))
  await user.click(screen.getByRole('button', { name: '确认删除' }))
  await waitFor(() => expect(screen.getByRole('button', { name: '虚构会话乙' })).toHaveFocus())
  expect(screen.getByRole('button', { name: '虚构会话乙' })).toHaveAttribute('aria-expanded', 'false')
})

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from '../App'
import type { Conversation } from '../components/conversations'

const conversations: Conversation[] = [
  { id: 'example-project', title: '项目讨论 · 示例', messages: [
    { id: '1', sender: '小林', text: '先确认一下这次页面的范围吧。', time: '10:24' },
    { id: '2', sender: '我', text: '先把文件选择和会话阅读的前端做好。', time: '10:25', isSelf: true },
    { id: '3', sender: '小林', text: '好的，收起左边的列表后，还能继续看这一段吗？', time: '10:26' },
    { id: '4', sender: '我', text: '可以，阅读的位置会保留下来。\n聊天记录只用于阅读。', time: '10:27', isSelf: true },
    ...Array.from({ length: 12 }, (_, index) => ({ id: `extra-${index}`, sender: index % 2 ? '我' : '小林', text: `第 ${index + 1} 段虚构示例记录，用于检查滚动和长文本。\n这里保留原文换行。`, isSelf: Boolean(index % 2) })),
  ] },
  { id: 'example-long', title: '很长的会话标题，用于检查窄屏阅读和侧栏省略显示 · 虚构示例', messages: [
    { id: 'long', sender: '一位名字很长的参与者', text: '这是一段虚构示例。\n' + '用于确认长文本能够自然换行。'.repeat(24) },
  ] },
  { id: 'example-empty', title: '空记录 · 示例', messages: [] },
]

if (import.meta.env.DEV) createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App conversations={conversations} />
    <div style={{ position: 'fixed', right: 12, bottom: 8, fontSize: 11, color: '#5c6674', pointerEvents: 'none' }}>虚构示例 · 仅供前端预览</div>
  </StrictMode>,
)

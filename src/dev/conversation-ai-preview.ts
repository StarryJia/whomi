import type { Conversation } from '../components/conversations'
import type { ConversationAiAdapter } from '../components/conversation-ai/types'

export const conversationPreview: readonly Conversation[] = [{
  id: 'preview-ai-conversation', title: '和小林的日常聊天 · 虚构示例', messages: [
    { id: 'ai-1', sender: '小林', time: '周三 20:10', text: '下周二就答辩了，我最近有点慌。' },
    { id: 'ai-2', sender: '我', time: '周三 20:12', text: '饭记得吃。你还在实验室？', isSelf: true },
    { id: 'ai-3', sender: '小林', time: '周三 20:13', text: '嗯，外卖都凉了。刚试着讲了一遍，第二张图就卡住了。' },
    { id: 'ai-4', sender: '我', time: '周三 20:15', text: '先吃两口吧。我记得你上次说第二张也不好讲，是那两根线吗？', isSelf: true },
    { id: 'ai-5', sender: '小林', time: '周三 20:17', text: '对，二三两张。你明晚能听我讲一下吗？不用帮我改图，听懂就行。' },
    { id: 'ai-6', sender: '我', time: '周三 20:18', text: '能，九点？我八点半才到家，得先找一下耳机。', isSelf: true },
    { id: 'ai-7', sender: '小林', time: '周三 20:20', text: '九点行。我今天先改那两张，其他的先不碰。' },
  ],
}, {
  id: 'preview-ai-empty', title: '空会话 · 虚构示例', messages: [],
}]

export type ConversationPreviewMode = 'normal' | 'fail-once' | 'slow' | 'no-usage'

function pause(signal: AbortSignal, ms: number) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) { reject(new DOMException('已停止', 'AbortError')); return }
    const abort = () => { clearTimeout(timer); reject(new DOMException('已停止', 'AbortError')) }
    const timer = window.setTimeout(() => { signal.removeEventListener('abort', abort); resolve() }, ms)
    signal.addEventListener('abort', abort, { once: true })
  })
}

/** 固定样例只供开发预览验证交互，不读取真实画像、不访问模型。 */
export function createConversationAiPreview(mode: ConversationPreviewMode): ConversationAiAdapter {
  let replyFailed = false
  let analysisFailed = false
  return {
    models: [{ id: 'preview-model', label: '示例模型' }],
    skills: [{ id: 'communication-review', label: '沟通复盘' }, { id: 'perspective', label: '换个角度' }],
    async respond(request, { signal, onText }) {
      if (mode === 'fail-once' && !replyFailed) {
        replyFailed = true
        await pause(signal, 350)
        throw new Error('模拟连接失败，请重试。')
      }
      const text = request.references.length
        ? '这是一段固定的预览回答。\n\n在这段示例交流里，你先问朋友有没有吃饭，也记得他之前卡住的图。对方提出需要后，你给出了明确的时间。\n\n这些细节可以理解为一种实际的关心方式。不过，仅凭这段记录，还不能概括你在所有关系里的表现。'
        : '这是一段固定的预览回答。\n\n你可以直接聊聊眼前的感受，也可以选中左侧消息，再结合具体情境一起梳理。正式对话将结合相关用户画像回应；本预览不进行真实分析。'
      for (let index = 0; index < text.length; index += 6) {
        await pause(signal, mode === 'slow' ? 500 : 65)
        onText(text.slice(0, index + 6))
      }
      return { text, ...(mode === 'no-usage' ? {} : { usage: {
        inputTokens: 1248, outputTokens: 386, outputTokensPerSecond: 62.1, firstTokenMs: 800, durationMs: 7000,
      } }) }
    },
    async analyze(_request, { signal, onProgress }) {
      for (let analyzedMessages = 0; analyzedMessages <= 7; analyzedMessages++) {
        await pause(signal, mode === 'slow' ? 1400 : 420)
        if (mode === 'fail-once' && !analysisFailed && analyzedMessages === 3) {
          analysisFailed = true
          throw new Error('模拟分析中断，请重试。')
        }
        onProgress({ analyzedMessages, totalMessages: 7, ...(mode === 'no-usage' ? {} : {
          outputTokensPerSecond: 58.3,
          usage: { inputTokens: analyzedMessages * 240, outputTokens: analyzedMessages * 50 },
        }) })
      }
      return { taskId: `preview-analysis-${_request.conversationId}`, ...(mode === 'no-usage' ? {} : { usage: {
        inputTokens: 1680, outputTokens: 350, outputTokensPerSecond: 58.3, durationMs: 6000,
      } }) }
    },
  }
}

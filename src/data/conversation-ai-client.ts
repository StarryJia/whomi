import type { AiApi, AiEvent, AiTurn, AnalysisTask } from '../shared/ai-contract'
import type { ConversationAiAdapter, ConversationRequest, RestoredConversationTurn } from '../components/conversation-ai/types'

const settled = (state: string) => !['queued', 'running', 'summarizing'].includes(state)
const cancelled = () => new DOMException('已停止。', 'AbortError')
const check = (signal: AbortSignal) => { if (signal.aborted) throw cancelled() }
const requestId = () => crypto.randomUUID()
const restore = (turn: AiTurn): RestoredConversationTurn => ({ ...turn })

/** 正式请求只传稳定编号，原文与历史由后台重新读取。 */
export async function createConversationAiClient(api: AiApi): Promise<ConversationAiAdapter> {
  const [models, skills] = await Promise.all([api.listModels(), api.listSkills()])
  const requestIds = new WeakMap<ConversationRequest, string>()
  const threads = new Map<string, Promise<Awaited<ReturnType<AiApi['openThread']>>>>()
  function open(conversationId: string) {
    let thread = threads.get(conversationId)
    if (!thread) {
      thread = api.openThread(conversationId).catch(error => { threads.delete(conversationId); throw error })
      threads.set(conversationId, thread)
    }
    return thread
  }

  function observe<T extends AiTurn | AnalysisTask>(initial: T, signal: AbortSignal, kind: AiEvent['kind'],
    read: () => Promise<T>, stop: () => Promise<unknown>, update: (snapshot: T) => void): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let current = initial, delivered = -1, closed = false, timer: ReturnType<typeof setTimeout> | undefined
      let unsubscribe: () => void = () => {}
      const finish = (error?: unknown) => {
        if (closed) return
        closed = true
        clearTimeout(timer)
        unsubscribe()
        signal.removeEventListener('abort', abort)
        if (error) reject(error)
        else resolve(current)
      }
      const accept = (value: T) => {
        if (closed || value.id !== initial.id || value.eventSequence < current.eventSequence || value.eventSequence <= delivered) return
        current = value
        delivered = value.eventSequence
        update(value)
        if (settled(value.state)) finish()
      }
      const abort = () => {
        if (signal.reason !== 'detach') void stop().catch(() => {})
        finish(cancelled())
      }
      const poll = async () => {
        try { accept(await read()) } catch (error) { finish(error) }
        if (!closed) timer = setTimeout(() => { void poll() }, 500)
      }
      unsubscribe = api.onEvent(event => { if (event.kind === kind) accept(event.snapshot as T) })
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) { abort(); return }
      // 先订阅再读快照，覆盖提交已完成或事件先于提交回执的情况。
      accept(initial)
      if (!closed) void poll()
      else unsubscribe()
    })
  }
  return {
    models: models.filter(model => model.enabled).map(({ id, label }) => ({ id, label })),
    skills: skills.map(({ id, label }) => ({ id, label })),
    async stopTurn(id) { await api.stopTurn(id) },
    async stopAnalysis(id) { await api.stopAnalysis(id) },
    prepareAnalysis: request => api.prepareAnalysis(request),
    async restoreThread(conversationId) {
      const thread = await open(conversationId)
      return (await api.getThread(thread.id)).turns.map(restore)
    },
    async watchThread(conversationId, onChange, signal) {
      check(signal)
      const thread = await open(conversationId)
      check(signal)
      await new Promise<void>((resolve, reject) => {
        let closed = false, timer: ReturnType<typeof setTimeout> | undefined, reading = false
        const sequences = new Map<string, number>()
        let cached: AiTurn[] = []
        let initialized = false
        const publish = (turns: AiTurn[], full = false) => {
          let changed = false
          for (const turn of turns) {
            if (turn.threadId !== thread.id || turn.eventSequence <= (sequences.get(turn.id) ?? -1)) continue
            changed = true
            sequences.set(turn.id, turn.eventSequence)
            const index = cached.findIndex(item => item.id === turn.id)
            if (index < 0) cached.push(turn)
            else cached[index] = turn
          }
          if (full) {
            const byId = new Map(cached.map(turn => [turn.id, turn]))
            const ids = new Set(turns.filter(turn => turn.threadId === thread.id).map(turn => turn.id))
            const ordered = [...ids].flatMap(id => byId.get(id) ? [byId.get(id)!] : [])
            ordered.push(...cached.filter(turn => !ids.has(turn.id)))
            changed ||= ordered.some((turn, index) => cached[index]?.id !== turn.id)
            cached = ordered
          }
          if (changed || !initialized) onChange(cached.map(restore))
          initialized = true
        }
        const clean = (error?: unknown) => { closed = true; clearTimeout(timer); unsubscribe(); signal.removeEventListener('abort', abort); if (error) reject(error); else resolve() }
        const abort = () => clean()
        const unsubscribe = api.onEvent(event => { if (!closed && event.kind === 'turn' && event.snapshot.threadId === thread.id) publish([event.snapshot]) })
        const poll = async () => {
          if (closed || reading) return
          reading = true
          try { const value = await api.getThread(thread.id); if (!closed) publish(value.turns, true) }
          catch (error) { if (!closed) clean(error) }
          finally { reading = false; if (!closed) timer = setTimeout(() => { void poll() }, 700) }
        }
        signal.addEventListener('abort', abort, { once: true })
        if (signal.aborted) clean()
        else void poll()
      })
    },
    async watchAnalysis(conversationId, onChange, signal) {
      check(signal)
      const tasks = await api.listAnalyses(conversationId)
      check(signal)
      const latest = tasks[0]
      if (!latest) return
      await observe(latest, signal, 'analysis', () => api.getAnalysis(latest.id), () => api.stopAnalysis(latest.id), onChange)
    },
    async respond(request, { signal, onText }) {
      check(signal)
      const thread = await open(request.conversationId)
      check(signal)
      let id = request.requestId ?? requestIds.get(request)
      if (!id) { id = requestId(); requestIds.set(request, id) }
      const referenceIds = [...new Set([...request.referenceIds ?? [], ...request.references.flatMap(reference => reference.messages.map(message => message.id))])]
      const initial = request.turnId ? await api.retryTurn(request.turnId) : await api.sendTurn({ threadId: thread.id, requestId: id, prompt: request.prompt, referenceIds,
        modelId: request.modelId, ...(referenceIds.length && request.skillId ? { skillId: request.skillId } : {}) })
      const result = await observe(initial, signal, 'turn', async () => {
        const value = (await api.getThread(thread.id)).turns.find(turn => turn.id === initial.id)
        if (!value) throw new Error('未找到这轮对话，请重新打开会话。')
        return value
      }, () => api.stopTurn(initial.id), value => onText(value.text))
      if (result.state !== 'completed') throw new Error(result.error ?? (result.state === 'stopped' ? '已停止回答。' : '回答中断，请重试。'))
      return { text: result.text, usage: result.usage }
    },
    async analyze(request, { signal, onProgress }) {
      check(signal)
      if (!request.preparationToken) throw new Error('请重新确认分析范围。')
      const initial = await api.confirmAnalysis({ token: request.preparationToken, requestId: request.requestId ?? requestId() })
      const result = await observe(initial, signal, 'analysis', () => api.getAnalysis(initial.id), () => api.stopAnalysis(initial.id), value => {
        onProgress({ analyzedMessages: value.analyzedMessages, totalMessages: value.totalMessages, usage: value.usage,
          outputTokensPerSecond: value.usage.outputTokensPerSecond })
      })
      if (result.state !== 'completed') throw new Error(result.error ?? (result.state === 'stopped' ? '已停止分析。' : '分析中断，请重试。'))
      return { taskId: result.id, usage: result.usage }
    },
  }
}

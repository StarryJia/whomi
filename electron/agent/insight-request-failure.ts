import type { ModelProtocol } from '../../src/shared/model-protocol'
import { BoundaryError } from '../../src/shared/desktop-validation'
import { isPiTimeout } from './model-timeout'

const resumeActions: Readonly<Record<string, string>> = {
  MODEL_CHANGED: '模型配置已更新，请从会话重新开始洞察。',
  INVALID_MODEL: '原任务的模型不可用，请从会话选择可用的模型重新开始洞察。',
  PROMPT_CHANGED: '洞察指令已更新，请从会话重新开始洞察。',
  IDENTITY_CHANGED: '本人身份已更新，请确认本人后重新开始洞察。',
  PROCESSING_CHANGED: '消息处理设置已更新，请从会话重新开始洞察。',
  INSIGHT_SNAPSHOT_UNAVAILABLE: '原任务的分析范围不可用，请从会话重新开始洞察。',
  INVALID_TASK: '找不到原任务，请刷新洞察列表。',
  INVALID_STATE: '任务状态已变化，请刷新洞察进度。',
  ANALYSIS_BUSY: '请等待当前洞察完成，或暂停后再继续。',
  DATA_PROCESS_GONE: '无法读取任务，请重新打开应用后继续洞察。',
}
export function insightResumeFailureAction(code: string) {
  return Object.hasOwn(resumeActions, code) ? resumeActions[code] : '请打开本次操作日志，核对后重试。'
}

const actions = {
  INSIGHT_TOOL_REASONING_CONFLICT: '当前接口拒绝同时使用读取工具和思考参数。请改用支持这组设置的接口，再从会话重新开始洞察。',
  INSIGHT_REASONING_UNSUPPORTED: '服务拒绝了当前思考强度。请从会话重新开始洞察，选择模型支持的思考强度。',
  INSIGHT_REQUEST_INCOMPATIBLE: '服务拒绝了请求参数。请调整模型接口或参数设置，再从会话重新开始洞察。',
  INSIGHT_AUTH_FAILED: '服务拒绝访问。请重新授权原账号后重试。使用密钥时，请核对权限并更新密钥，再从会话重新开始洞察。',
  INSIGHT_CONNECTION_FAILED: '未连到模型服务。请在网络恢复后重试。如需修改服务地址，请保存后从会话重新开始洞察。',
  INSIGHT_PROVIDER_OVERLOADED: '模型服务暂时繁忙，请稍后继续洞察。',
  INSIGHT_SERVICE_UNAVAILABLE: '模型服务暂不可用，请在服务恢复后重试。',
  INSIGHT_SUMMARY_FAILED: '阅读摘要未保存，原因未知。请查看本次操作记录后重试。',
  MODEL_OUTPUT_LIMIT: '达到模型的输出上限。请从会话重新开始洞察，缩小范围或选择输出容量更大的模型。',
  MODEL_TIMEOUT: '模型请求超时，请稍后继续。',
  MODEL_CONTEXT_LIMIT: '洞察请求超出模型容量。请从会话重新开始洞察，缩小范围或选择容量更大的模型。',
  MODEL_REQUEST_FAILED: '模型请求失败，原因未知。请查看本次操作记录，核对服务状态后重试。',
} as const

export type InsightFailureCode = keyof typeof actions
export const insightFailureAction = (code: string): string | undefined => Object.hasOwn(actions, code) ? actions[code as InsightFailureCode] : undefined
export const insightRequestError = (code: InsightFailureCode) => new BoundaryError(code, actions[code])

function providerDetail(message: string) {
  const detail = message.replace(/^(?:\S+ API error \(\d{3}\):\s*)?(?:[45]\d\d[:\s]+)?/i, '').trim()
  if (detail.startsWith('{')) {
    try {
      const body = JSON.parse(detail)
      const error = body?.error ?? body
      return { codes: [error?.code, error?.type, error?.status].filter((v): v is string => typeof v === 'string'),
        text: typeof error?.message === 'string' ? error.message : '', param: typeof error?.param === 'string' ? error.param : '',
        structured: typeof error?.message === 'string' && body?.error != null }
    } catch { /* 服务可能只返回非结构化说明。 */ }
  }
  const prefix = /^(?:error code\s+)?(server_error|unknown|server_overloaded|overloaded_error|server_busy|service_unavailable)\s*:\s*/i.exec(detail)
  return { codes: prefix ? [prefix[1].toLowerCase()] : [], text: prefix ? detail.slice(prefix[0].length) : detail, param: '', structured: false }
}

function classify(api: ModelProtocol, message: string, detail: ReturnType<typeof providerDetail>, responseReceived?: boolean, status?: number): InsightFailureCode {
  const { codes, text, param } = detail
  if (status === 401 || status === 403 || codes.includes('UNAUTHENTICATED') || codes.includes('PERMISSION_DENIED')) return 'INSIGHT_AUTH_FAILED'
  if (status === 408 || status === 504 || isPiTimeout(api, message)) return 'MODEL_TIMEOUT'
  if (responseReceived === false) return 'INSIGHT_CONNECTION_FAILED'
  if (status === 400 || status === 422 || codes.includes('INVALID_ARGUMENT')) {
    if (/\b(?:tools?|function[ _-]?call(?:ing|s)?)\b/i.test(text) && /\b(?:reasoning(?:[ _-]effort)?|thinking)\b/i.test(text)
      && /\b(?:not supported|unsupported|incompatible|cannot|only supported|require[sd]?|not compatible|not allowed)\b/i.test(text)) return 'INSIGHT_TOOL_REASONING_CONFLICT'
    if (/\breasoning[ _-]effort\b/i.test(param + ' ' + text) && /\b(?:invalid|unsupported|not supported|allowed|supported values)\b/i.test(text)) return 'INSIGHT_REASONING_UNSUPPORTED'
    if (codes.includes('unsupported_parameter') || /\b(?:unsupported[_ ](?:parameter|value|tool)|invalid[_ ]parameter|unrecognized request argument)\b/i.test(text)) return 'INSIGHT_REQUEST_INCOMPATIBLE'
    return 'MODEL_REQUEST_FAILED'
  }
  if (codes.some(value => value === 'invalid_request_error' || value === 'insufficient_quota')) return 'MODEL_REQUEST_FAILED'
  if (codes.some(value => /^(?:overloaded_error|server_overloaded|server_busy)$/i.test(value))
    || /^(?:(?:the )?(?:server|service|model) (?:is )?(?:currently |temporarily )?)?overloaded(?:[.!:,\s]|$)/i.test(text)) return 'INSIGHT_PROVIDER_OVERLOADED'
  if (codes.includes('service_unavailable') || codes.includes('UNAVAILABLE')
    || /^(?:the )?(?:server|service|model) (?:is )?(?:currently |temporarily )?unavailable(?:[.!:,\s]|$)/i.test(text)) return 'INSIGHT_SERVICE_UNAVAILABLE'
  return 'MODEL_REQUEST_FAILED'
}

export function diagnoseInsightFailure(api: ModelProtocol, message: string, responseReceived?: boolean, httpStatus?: number) {
  const detail = providerDetail(message)
  if (api === 'google-generative-ai' && responseReceived === undefined) {
    // Google 适配器只交付错误正文。正文中的 code 不能作为传输层状态码。
    if (detail.structured) responseReceived = true
    else if (message === 'fetch failed') responseReceived = false
  }
  return { failureCode: classify(api, message, detail, responseReceived, httpStatus), responseReceived }
}

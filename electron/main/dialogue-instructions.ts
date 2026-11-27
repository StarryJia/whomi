import type { InsightReport } from '../../src/shared/conversation-insights'
import { estimateFrozenInstructionTokens } from '../agent/instruction-budget'
import { assembleDialoguePrompt, type MethodologySnapshot } from '../data/ai/methodology'

function readerObservations(report: InsightReport) {
  const paragraphs = (section: InsightReport['aboutYou']) => section.map(paragraph => paragraph.content.map(part => part.text).join(''))
  return {
    aboutYou: paragraphs(report.aboutYou),
    relationship: paragraphs(report.relationship),
    limitations: report.limitations,
    ...(report.safetyLead && { safetyLead: true }),
  }
}

export function fitDialogueInstructions(snapshot: MethodologySnapshot, editable: string, profile: InsightReport | null, skill: string | undefined, budget: number) {
  const frozen = [snapshot.methodology.body, snapshot.hostAdapter.instructions]
  const frozenDiscount = frozen.reduce((total, text) => total + Buffer.byteLength(text) - estimateFrozenInstructionTokens(text), 0)
  function withReport(report: unknown) {
    const text = assembleDialoguePrompt(snapshot, editable, report, skill)
    // 只在已生成报告中按常见汉字和中文标点估算，用户提问、引用和数字串保留字节上界。
    const chineseCharacters = JSON.stringify(report).match(/[\u4e00-\u9fff，。；：！？、「」『』（）]/g)?.length ?? 0
    const tokens = Buffer.byteLength(text) - frozenDiscount - Math.floor(chineseCharacters * 1.5)
    return { text, tokens }
  }
  const full = withReport(profile)
  if (!profile || full.tokens <= budget) return full
  // 阅读页定位引文用的修订标识无需参与对话，仍一并保留报告的解释和局限。
  const sections = readerObservations(profile)
  const judgments = profile.judgments?.map(({ dimension, direction, text, alternativeExplanations, limitations }) =>
    ({ dimension, direction, text, alternativeExplanations, limitations }))
  const observations = withReport({ ...sections, judgments })
  if (observations.tokens <= budget) return observations
  const narrative = withReport({ ...sections, partial: true })
  return narrative.tokens <= budget ? narrative : withReport(null)
}

import { dimensionKeys, isMemoryReport, type SavedReport } from '../shared/memory'
import { personalityDimensions, predictionText } from './personality-dimensions'
import './memory-article.css'

export { predictionText } from './personality-dimensions'

export function MemoryArticle({ report }: { report: SavedReport }) {
  if (!isMemoryReport(report)) return <article className="memory-prose">
    <h3>摘要</h3><p>{report.summary}</p>
    {!!report.observations.length && <section><h3>观察</h3>{report.observations.map((item, index) => <div key={index}><p>{item.text}</p>{item.limitations && <p>{item.limitations}</p>}</div>)}</section>}
    {report.limitations && <section><h3>解读范围</h3><p>{report.limitations}</p></section>}
  </article>
  return <article className="memory-prose">
    <p className="memory-scope">根据聊天记录写成的娱乐解读，仅供参考。</p>
    <section><h3><abbr title="迈尔斯–布里格斯性格类型指标">MBTI</abbr> 预测</h3>
      <p>你在这段关系中的人格倾向</p>
      <p className="memory-prediction">{predictionText(report.dimensions)}</p>
      <dl className="memory-dimension-explanations">{dimensionKeys.map(axis => {
        const dimension = personalityDimensions[axis]
        const letter = report.dimensions[axis]
        const explanation = letter && report.format === 'memory-v4' && report.dimensionExplanations[axis]?.text
        return <div key={axis}>
          <dt>{dimension.name}</dt>
          <dd className={letter ? 'memory-dimension-result' : 'memory-dimension-unknown'}>
            {letter ? `偏向${letter === axis[0] ? dimension.left : dimension.right}` : '暂难判断'}
          </dd>
          {explanation && <dd className="memory-dimension-reason">{explanation}</dd>}
        </div>
      })}</dl>
    </section>
    <section><h3>我们的记忆</h3>{report.events.length ? report.events.map((event, index) => <div key={index}><h4>{event.title}</h4><p>{event.text}</p></div>) : <p>暂未找到可整理的共同经历。</p>}</section>
    <section><h3>我们的关系</h3><p>{report.relationship}</p></section>
  </article>
}

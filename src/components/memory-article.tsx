import { dimensionKeys, isMemoryReport, type MemoryDimensions, type SavedReport } from '../shared/memory'
import './memory-article.css'

const dimensionNames = { EI: '精力来源', SN: '理解信息', TF: '做决定', JP: '安排方式' }

export function predictionText(dimensions: MemoryDimensions) {
  return dimensionKeys.map(axis => dimensions[axis] ?? '?').join('')
}

export function MemoryArticle({ report }: { report: SavedReport }) {
  if (!isMemoryReport(report)) return <article className="memory-prose">
    <h3>摘要</h3><p>{report.summary}</p>
    {!!report.observations.length && <section><h3>观察</h3>{report.observations.map((item, index) => <div key={index}><p>{item.text}</p>{item.limitations && <p>{item.limitations}</p>}</div>)}</section>}
    {report.limitations && <section><h3>解读范围</h3><p>{report.limitations}</p></section>}
  </article>
  return <article className="memory-prose">
    <p className="memory-scope">这是一份根据你们的聊天写成的娱乐解读。性格预测和关系印象，供你轻松回看这段经历时参考。</p>
    <section><h3><abbr title="迈尔斯–布里格斯性格类型指标">MBTI</abbr> 预测</h3>
      <p className="memory-prediction">{predictionText(report.dimensions)}</p>
      {report.format === 'memory-v4' && <dl className="memory-dimension-explanations">{dimensionKeys.map(axis => <div key={axis}>
        <dt>{dimensionNames[axis]}<span>{axis[0]} / {axis[1]}</span></dt><dd className={report.dimensionExplanations[axis] ? undefined : 'memory-dimension-unknown'}>{report.dimensionExplanations[axis]?.text ?? '暂难判断'}</dd>
      </div>)}</dl>}
    </section>
    <section><h3>我们的记忆</h3>{report.events.length ? report.events.map((event, index) => <div key={index}><h4>{event.title}</h4><p>{event.text}</p></div>) : <p>暂未找到可整理的共同经历。</p>}</section>
    <section><h3>我们的关系</h3><p>{report.relationship}</p></section>
  </article>
}

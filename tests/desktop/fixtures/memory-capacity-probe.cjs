module.exports = (writer, reader) => method => {
  if (method === 'probe.seed') {
    const fixtures = require('./fixtures.json')
    writer.transaction(() => {
      for (const { id, offset, count, title } of fixtures) {
        const mine = id * 2 - 1, friend = id * 2
        writer.prepare("INSERT INTO conversations(id,title,kind,created_at_ms) VALUES(?,?,'direct',0)").run(id, title)
        writer.prepare("INSERT INTO source_conversations(id,conversation_id,platform,namespace) VALUES(?,?,'example',?)").run(id, id, 'fixture-' + id)
        const member = writer.prepare('INSERT INTO memberships(id,conversation_id,source_conversation_id,source_key,display_name) VALUES(?,?,?,?,?)')
        member.run(mine, id, id, 'me', '示例甲')
        member.run(friend, id, id, 'other', '示例乙')
        writer.prepare("INSERT INTO self_confirmations(conversation_id,member_id,status,source) VALUES(?,?,'confirmed','user')").run(id, mine)
        const insert = writer.prepare("INSERT INTO messages(id,conversation_id,member_id,sender_kind,sender_name,kind,text,ordinal,sent_at_ms) VALUES(?,?,?,'member',?,'text',?,?,?)")
        for (let n = 1; n <= count; n++) {
          const own = n % 2 === 1
          const text = '例' + String(offset + n).padStart(5, '0') + (own ? ' 周六一起整理书箱。' : ' 好，在东门见。')
          insert.run(offset + n, id, own ? mine : friend, own ? '示例甲' : '示例乙', text, n - 1, 1761700000000 + 60000 * n)
        }
        writer.prepare("INSERT INTO conversation_summaries(conversation_id,message_count,member_count,status) VALUES(?,?,2,'ready')").run(id, count)
      }
    })()
    return true
  }
  if (method === 'probe.tasks') {
    return reader.prepare(`SELECT CAST(id AS TEXT) AS id, CAST(conversation_id AS TEXT) AS conversation,
      state, error, CAST(model_version AS INTEGER) AS modelVersion, prompt_version AS promptVersion,
      total_messages AS total,
      (SELECT COUNT(*) FROM ai_analysis_coverage WHERE task_id=t.id) AS covered,
      (SELECT COUNT(*) FROM ai_reports WHERE task_id=t.id) AS reports
      FROM ai_analysis_tasks t ORDER BY id`).all().map(row => ({
      ...row, modelVersion: Number(row.modelVersion), total: Number(row.total),
      covered: Number(row.covered), reports: Number(row.reports)
    }))
  }
  throw new Error('未知的验收操作')
}

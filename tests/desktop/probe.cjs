module.exports = (writer, reader) => {
  writer.exec('CREATE TABLE IF NOT EXISTS runtime_probe (id INTEGER PRIMARY KEY, value TEXT NOT NULL)')
  return (method) => {
    if (method === 'probe.write') {
      writer.prepare('INSERT OR REPLACE INTO runtime_probe VALUES (1, ?)').run('saved')
      return null
    }
    if (method === 'probe.read') return reader.prepare('SELECT value FROM runtime_probe WHERE id = 1').get()?.value ?? null
    if (method === 'probe.pending') return new Promise(() => {})
    throw new Error('Unsupported probe')
  }
}

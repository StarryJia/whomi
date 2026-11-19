module.exports = writer => method => {
  if (method === 'probe.fail-statistics') {
    writer.exec(`CREATE TEMP TRIGGER synthetic_statistics_failure
      BEFORE UPDATE OF status ON conversation_summaries
      WHEN NEW.status = 'ready' AND EXISTS (SELECT 1 FROM conversations WHERE id = NEW.conversation_id AND title = 'New synthetic conversation')
      BEGIN SELECT RAISE(ABORT, 'Synthetic statistics failure'); END;`)
    return
  }
  if (method === 'probe.fail-confirm') {
    // Simulate corrupt storage metadata only in the isolated test database.
    writer.pragma('ignore_check_constraints = ON')
    writer.exec(`CREATE TEMP TRIGGER synthetic_receipt_failure
      AFTER UPDATE OF committed_at_ms ON import_results
      WHEN NEW.committed_at_ms IS NOT NULL AND EXISTS (SELECT 1 FROM conversations WHERE id = NEW.conversation_id AND title = 'New synthetic conversation')
      BEGIN UPDATE import_results SET committed_at_ms = NULL WHERE id = NEW.id; END;`)
    return
  }
  throw new Error('Unsupported probe')
}

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Store } from '../../electron/data/db/open'
import { ANALYSIS_PROMPT_VERSION, LEGACY_ANALYSIS_VERSION, LEGACY_MEMORY_VERSION, LEGACY_SCORED_MEMORY_VERSION } from '../../electron/data/ai/prompt-version'

type LegacyAnalysisVersion = typeof ANALYSIS_PROMPT_VERSION | typeof LEGACY_ANALYSIS_VERSION | typeof LEGACY_MEMORY_VERSION | typeof LEGACY_SCORED_MEMORY_VERSION

export function useLegacyAnalysisFixture(store: Store, version: LegacyAnalysisVersion = ANALYSIS_PROMPT_VERSION) {
  store.writer.exec(`CREATE TEMP TRIGGER fixture_legacy_preparation AFTER INSERT ON ai_preparations
    BEGIN UPDATE ai_preparations SET prompt_version='${ANALYSIS_PROMPT_VERSION}',insight_snapshot=NULL WHERE token=NEW.token; END`)
  if (version !== ANALYSIS_PROMPT_VERSION) {
    store.writer.exec(`CREATE TEMP TRIGGER fixture_legacy_analysis AFTER INSERT ON ai_analysis_tasks
      BEGIN UPDATE ai_analysis_tasks SET prompt_version='${version}' WHERE id=NEW.id; END`)
  }
}

export function removeInsightSchemaForMigrationTest(store: Store) {
  store.writer.exec(`DROP TABLE ai_insight_snapshots;
    ALTER TABLE ai_analysis_tasks DROP COLUMN title;
    ALTER TABLE ai_analysis_tasks DROP COLUMN elapsed_ms;
    ALTER TABLE ai_preparations DROP COLUMN insight_snapshot;
    ALTER TABLE ai_reports DROP COLUMN content_revision;
    PRAGMA user_version=8;`)
}

export function temporaryStore() {
  const directory = mkdtempSync(join(tmpdir(), 'whomi-store-'))
  return { path: join(directory, 'test.db'), cleanup: () => rmSync(directory, { recursive: true, force: true }) }
}
export function message(overrides: Record<string, unknown> = {}) {
  return { modelVersion: 1, conversationKey: 'chat', ordinal: 0, originalId: null, idNamespace: null,
    senderKey: null, senderKind: 'unknown', senderName: '未知发送者', sentAtMs: null, timeRaw: null,
    timePrecision: 'unknown', timezone: null, kind: 'text', text: '', sourceType: null, reply: null,
    attachments: [], extra: {}, ...overrides }
}

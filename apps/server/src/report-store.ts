/**
 * WP438（决策 1336 甲）：报表的本机存放处——一个品牌一个 `reports.sqlite`（放在品牌目录下）。
 *
 * | 表 | 一行是什么 |
 * |---|---|
 * | `saved_reports` | 一份固定下来的 AI 报表：**存规格不存图**（活的，按频率重算），谁固定的、固定到哪、第几版 |
 * | `report_snapshots` | 某一次重算的整份结果（往回翻用；同一份报表同一档时间窗一个点一张） |
 *
 * 草稿（对话里刚出、还没点「固定」的）只在内存里——没固定的不落盘。
 * 没有品牌目录（内存档 / 测试）时整个在内存里。迁移用 `PRAGMA user_version`，只加不删。
 */
import type { ReportSnapshotMeta, ReportStorePort, SavedReport } from '@agentsws/api'
import type { ReportData, ReportSpec } from '@agentsws/deck'
import Database from 'better-sqlite3'

const MIGRATIONS: readonly string[] = [
  `
CREATE TABLE IF NOT EXISTS saved_reports (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  person_id TEXT NOT NULL,
  json TEXT NOT NULL,
  pinned_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS saved_reports_person ON saved_reports (workspace_id, person_id);
CREATE TABLE IF NOT EXISTS report_snapshots (
  report_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  at TEXT NOT NULL,
  range TEXT NOT NULL,
  json TEXT NOT NULL,
  PRIMARY KEY (report_id, at, range)
);
`,
]

/** 一份报表最多留几张快照（每天一张约一年；多了删最老的）。 */
export const SNAPSHOT_KEEP = 400

export interface ReportStore extends ReportStorePort {
  close(): void
}

export function createReportStore(path?: string): ReportStore {
  const drafts = new Map<string, ReportSpec>()
  const draftKey = (ws: string, id: string): string => `${ws}\u0000${id}`
  const putDraft = (workspace_id: string, spec: ReportSpec): void => {
    drafts.set(draftKey(workspace_id, spec.id), spec)
    // 草稿只留最近 200 份（一次会话里来回改几次就够了）
    while (drafts.size > 200) {
      const first = drafts.keys().next().value
      if (first === undefined) break
      drafts.delete(first)
    }
  }
  const draft = (workspace_id: string, id: string): ReportSpec | undefined =>
    drafts.get(draftKey(workspace_id, id))

  if (path === undefined) {
    const saved = new Map<string, SavedReport>()
    const snaps = new Map<string, ReportData[]>()
    return {
      list: (ws, person) =>
        [...saved.values()].filter((r) => r.workspace_id === ws && r.person_id === person),
      get: (ws, id) => {
        const r = saved.get(id)
        return r?.workspace_id === ws ? r : undefined
      },
      save: (r) => {
        saved.set(r.spec.id, r)
      },
      remove: (_ws, id) => {
        saved.delete(id)
        snaps.delete(id)
      },
      putDraft,
      draft,
      snapshots: (_ws, id): ReportSnapshotMeta[] =>
        (snaps.get(id) ?? []).map((d) => ({ at: d.computed_at, range: d.range })),
      snapshot: (_ws, id, at) => (snaps.get(id) ?? []).find((d) => d.computed_at === at),
      addSnapshot: (_ws, data) => {
        const list = snaps.get(data.id) ?? []
        list.push(data)
        snaps.set(data.id, list.slice(-SNAPSHOT_KEEP))
      },
      close: () => undefined,
    }
  }

  const db = new Database(path)
  db.pragma('journal_mode = WAL')
  const version = Number(db.pragma('user_version', { simple: true }))
  for (let v = version; v < MIGRATIONS.length; v += 1) {
    db.exec(MIGRATIONS[v] as string)
    db.pragma(`user_version = ${v + 1}`)
  }
  const parse = (json: string): SavedReport => JSON.parse(json) as SavedReport
  return {
    list: (ws, person) =>
      (
        db
          .prepare('SELECT json FROM saved_reports WHERE workspace_id = ? AND person_id = ?')
          .all(ws, person) as { json: string }[]
      ).map((r) => parse(r.json)),
    get: (ws, id) => {
      const row = db
        .prepare('SELECT json FROM saved_reports WHERE workspace_id = ? AND id = ?')
        .get(ws, id) as { json: string } | undefined
      return row === undefined ? undefined : parse(row.json)
    },
    save: (r) => {
      db.prepare(
        'INSERT INTO saved_reports (id, workspace_id, person_id, json, pinned_at) VALUES (?, ?, ?, ?, ?) ' +
          'ON CONFLICT(id) DO UPDATE SET json = excluded.json',
      ).run(r.spec.id, r.workspace_id, r.person_id, JSON.stringify(r), r.pinned_at)
    },
    remove: (ws, id) => {
      db.prepare('DELETE FROM saved_reports WHERE workspace_id = ? AND id = ?').run(ws, id)
      db.prepare('DELETE FROM report_snapshots WHERE workspace_id = ? AND report_id = ?').run(
        ws,
        id,
      )
    },
    putDraft,
    draft,
    snapshots: (ws, id) =>
      db
        .prepare(
          'SELECT at, range FROM report_snapshots WHERE workspace_id = ? AND report_id = ? ORDER BY at DESC',
        )
        .all(ws, id) as ReportSnapshotMeta[],
    snapshot: (ws, id, at) => {
      const row = db
        .prepare(
          'SELECT json FROM report_snapshots WHERE workspace_id = ? AND report_id = ? AND at = ?',
        )
        .get(ws, id, at) as { json: string } | undefined
      return row === undefined ? undefined : (JSON.parse(row.json) as ReportData)
    },
    addSnapshot: (ws, data) => {
      db.prepare(
        'INSERT OR REPLACE INTO report_snapshots (report_id, workspace_id, at, range, json) VALUES (?, ?, ?, ?, ?)',
      ).run(data.id, ws, data.computed_at, data.range, JSON.stringify(data))
      db.prepare(
        'DELETE FROM report_snapshots WHERE workspace_id = ? AND report_id = ? AND at NOT IN ' +
          '(SELECT at FROM report_snapshots WHERE workspace_id = ? AND report_id = ? ORDER BY at DESC LIMIT ?)',
      ).run(ws, data.id, ws, data.id, SNAPSHOT_KEEP)
    },
    close: () => {
      db.close()
    },
  }
}

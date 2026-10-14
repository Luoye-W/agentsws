/**
 * WP330：Reddit 周报的本机存储——一台机器一个 `reddit-weekly.sqlite`，每行钉着 `workspace_id`。
 *
 * 两张表：分节与措辞（一个品牌一行；没有 = 用默认）、出过的周报（一个品牌一周一份，同一周再出覆盖）。
 * 周报留着是为了导出 / 复制「上一份」——卡归档了文档还在。
 */
import {
  DEFAULT_REDDIT_WEEKLY_FORMAT,
  type RedditWeeklyFormat,
  type RedditWeeklyPayload,
  type WorkspaceId,
} from '@agentsws/contracts'
import Database from 'better-sqlite3'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS reddit_weekly_format (
  workspace_id TEXT PRIMARY KEY,
  json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS reddit_weekly_reports (
  workspace_id TEXT NOT NULL,
  week_of TEXT NOT NULL,
  generated_at TEXT NOT NULL,
  json TEXT NOT NULL,
  PRIMARY KEY (workspace_id, week_of)
);
`

export interface RedditWeeklyStore {
  /** 这个品牌的分节与措辞（没改过 = 默认）。 */
  format(workspace_id: WorkspaceId): RedditWeeklyFormat
  setFormat(workspace_id: WorkspaceId, format: RedditWeeklyFormat): void
  /** 回到默认。 */
  resetFormat(workspace_id: WorkspaceId): void
  putReport(workspace_id: WorkspaceId, payload: RedditWeeklyPayload): void
  /** 某一周的（不给 = 最近一份）。 */
  report(workspace_id: WorkspaceId, week_of?: string): RedditWeeklyPayload | undefined
  /** 最近几份（新的在前，只回周与标题）。 */
  reports(
    workspace_id: WorkspaceId,
    limit?: number,
  ): { week_of: string; title: string; generated_at: string }[]
  close(): void
}

/** `dbPath` 不给就是内存档（测试与没有数据目录的档）。 */
export function createRedditWeeklyStore(dbPath?: string): RedditWeeklyStore {
  const db = new Database(dbPath ?? ':memory:')
  if (dbPath !== undefined) db.pragma('journal_mode = WAL')
  db.exec(SCHEMA)
  const parseFormat = (json: string): RedditWeeklyFormat => {
    // 老的一份缺了后来加的项：用默认补齐（只加不删）
    const f = JSON.parse(json) as Partial<RedditWeeklyFormat>
    return {
      ...DEFAULT_REDDIT_WEEKLY_FORMAT,
      ...f,
      assessment_labels: {
        ...DEFAULT_REDDIT_WEEKLY_FORMAT.assessment_labels,
        ...(f.assessment_labels ?? {}),
      },
    }
  }
  return {
    format(ws) {
      const row = db
        .prepare('SELECT json FROM reddit_weekly_format WHERE workspace_id = ?')
        .get(ws) as { json: string } | undefined
      return row === undefined ? DEFAULT_REDDIT_WEEKLY_FORMAT : parseFormat(row.json)
    },
    setFormat(ws, format) {
      db.prepare(
        'INSERT INTO reddit_weekly_format (workspace_id, json) VALUES (?, ?) ON CONFLICT(workspace_id) DO UPDATE SET json = excluded.json',
      ).run(ws, JSON.stringify(format))
    },
    resetFormat(ws) {
      db.prepare('DELETE FROM reddit_weekly_format WHERE workspace_id = ?').run(ws)
    },
    putReport(ws, payload) {
      db.prepare(
        'INSERT INTO reddit_weekly_reports (workspace_id, week_of, generated_at, json) VALUES (?, ?, ?, ?) ON CONFLICT(workspace_id, week_of) DO UPDATE SET generated_at = excluded.generated_at, json = excluded.json',
      ).run(ws, payload.week_of, payload.generated_at, JSON.stringify(payload))
    },
    report(ws, week_of) {
      const row = (
        week_of === undefined
          ? db
              .prepare(
                'SELECT json FROM reddit_weekly_reports WHERE workspace_id = ? ORDER BY week_of DESC, generated_at DESC LIMIT 1',
              )
              .get(ws)
          : db
              .prepare(
                'SELECT json FROM reddit_weekly_reports WHERE workspace_id = ? AND week_of = ?',
              )
              .get(ws, week_of)
      ) as { json: string } | undefined
      return row === undefined ? undefined : (JSON.parse(row.json) as RedditWeeklyPayload)
    },
    reports(ws, limit = 20) {
      const rows = db
        .prepare(
          'SELECT week_of, generated_at, json FROM reddit_weekly_reports WHERE workspace_id = ? ORDER BY week_of DESC LIMIT ?',
        )
        .all(ws, limit) as { week_of: string; generated_at: string; json: string }[]
      return rows.map((r) => ({
        week_of: r.week_of,
        generated_at: r.generated_at,
        title: (JSON.parse(r.json) as RedditWeeklyPayload).title,
      }))
    },
    close() {
      db.close()
    },
  }
}

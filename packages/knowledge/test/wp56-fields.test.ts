/**
 * WP56 第 1 件：契约与存储只加不删。
 *
 * 这一组只管「新的那几格存得进、取得回、老库补得上」——溯源链的行为在
 * `provenance.test.ts` 与 `recheck.test.ts` 里。
 */
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { createKnowledge, type Knowledge, migrate } from '../src/index.js'
import { cardInput, testClock, WS } from './fixtures.js'

const open: Knowledge[] = []
afterEach(() => {
  for (const k of open.splice(0)) k.close()
})
const make = () => {
  const k = createKnowledge({ clock: testClock(), workspace_id: WS })
  open.push(k)
  return k
}

describe('WP56 新增字段', () => {
  it('stage / 指纹 / 时效三件套 / 外部链接 一路存取不掉字段', async () => {
    const k = make()
    const card = await k.store.propose(
      cardInput({
        stage: 'postsales',
        fact_fingerprint: { 'duration:day:30': '30 天' },
        verification_state: 'fresh',
        source_content_hash: 'abc123',
        source_changed_at: '2026-09-10T00:00:00.000Z',
        media: ['https://example.com/help/returns'],
        last_verified_at: '2026-09-01T00:00:00.000Z',
      }),
    )
    const back = await k.store.get(card.id, {
      person_id: 'per_owner',
      assignment_id: 'asg_owner',
      role_id: 'common.owner',
      workspace_id: WS,
      grants: [
        { domain: 'knowledge', ops: ['read'], range: 'workspace', max_sensitivity: 'internal' },
      ],
    })
    expect(back?.stage).toBe('postsales')
    expect(back?.fact_fingerprint).toEqual({ 'duration:day:30': '30 天' })
    expect(back?.verification_state).toBe('fresh')
    expect(back?.source_content_hash).toBe('abc123')
    expect(back?.source_changed_at).toBe('2026-09-10T00:00:00.000Z')
    expect(back?.media).toEqual(['https://example.com/help/returns'])
    expect(back?.last_verified_at).toBe('2026-09-01T00:00:00.000Z')
  })

  it('不给这几格的卡取回来时它们压根不在（exactOptionalPropertyTypes）', async () => {
    const k = make()
    const card = await k.store.propose(cardInput())
    expect('stage' in card).toBe(false)
    expect('verification_state' in card).toBe(false)
    expect('last_verified_at' in card).toBe(false)
  })

  it('老库（没有这几列）跑一次 migrate 就补上，数据不动', () => {
    const db = new Database(':memory:')
    // WP56 之前的最小形态：只有 47 J2 那两格
    db.exec(`CREATE TABLE fact_cards (
      id TEXT PRIMARY KEY, workspace_id TEXT, status TEXT, subject_key TEXT,
      as_of TEXT, downgraded_from TEXT
    );
    CREATE TABLE knowledge_sources (
      id TEXT PRIMARY KEY, workspace_id TEXT, kind TEXT, ref TEXT, last_synced_at TEXT
    );`)
    db.prepare('INSERT INTO fact_cards (id, as_of) VALUES (?, ?)').run('fact_old', '2026-01-01')

    migrate(db)

    const cols = (db.prepare('PRAGMA table_info(fact_cards)').all() as { name: string }[]).map(
      (c) => c.name,
    )
    expect(cols).toContain('stage')
    expect(cols).toContain('fact_fingerprint_json')
    expect(cols).toContain('verification_state')
    expect(cols).toContain('source_content_hash')
    expect(cols).toContain('source_changed_at')
    expect(cols).toContain('media_json')
    expect(cols).toContain('last_verified_at')
    const srcCols = (
      db.prepare('PRAGMA table_info(knowledge_sources)').all() as { name: string }[]
    ).map((c) => c.name)
    expect(srcCols).toContain('last_content_hash')
    expect(
      (db.prepare('SELECT as_of FROM fact_cards WHERE id = ?').get('fact_old') as { as_of: string })
        .as_of,
    ).toBe('2026-01-01')
    db.close()
  })

  it('导入源记得住上一次的内容 hash', () => {
    const k = make()
    const src = k.intake.addSource({
      workspace_id: WS,
      kind: 'website',
      ref: 'https://example.com/returns',
      parser: 'html',
    })
    expect('last_content_hash' in src).toBe(false)
    const synced = k.intake.markSynced(src.id, 3, 'hash_v1')
    expect(synced.last_content_hash).toBe('hash_v1')
  })
})

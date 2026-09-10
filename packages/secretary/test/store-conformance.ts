/** 两档存储（内存 / SQLite）跑同一份用例：接口逐字一致，行为也得一致。 */
import { describe, expect, it } from 'vitest'
import type { AskedRecord, MeetProposal, ProfileRecord, SecretaryStore } from '../src/index.js'
import { defaultProfile } from '../src/index.js'
import { T0, WS } from './helpers.js'

const asked = (over: Partial<AskedRecord> = {}): AskedRecord => ({
  id: 'asked_1',
  schema_version: 1,
  workspace_id: WS,
  person_id: 'p_li',
  asked_by: 'p_chen',
  at: T0,
  run_id: 'run_1',
  kind: 'doing',
  question: '在忙什么',
  answer: '两件',
  question_hash: 'qh',
  answer_hash: 'ah',
  fields: ['in_progress'],
  refused: false,
  ...over,
})

const meet = (over: Partial<MeetProposal> = {}): MeetProposal => ({
  id: 'meet_1',
  schema_version: 1,
  workspace_id: WS,
  from: 'p_wang',
  to: 'p_li',
  title: '聊定价',
  duration_minutes: 30,
  candidates: [{ start: T0, end: '2026-09-07T01:30:00.000Z' }],
  state: 'proposed',
  alternatives: [],
  created_at: T0,
  ...over,
})

export function runStoreConformance(name: string, make: () => SecretaryStore): void {
  describe(`SecretaryStore（${name}）`, () => {
    it('profile 读回来与写进去的一样，同一个人写两次是覆盖', () => {
      const store = make()
      const p: ProfileRecord = defaultProfile({ workspace_id: WS, person_id: 'p_li', at: T0 })
      store.putProfile(p)
      expect(store.getProfile(WS, 'p_li')).toEqual(p)
      const next: ProfileRecord = { ...p, disclosure: { ...p.disclosure, availability: 'self' } }
      store.putProfile(next)
      expect(store.getProfile(WS, 'p_li')?.disclosure.availability).toBe('self')
      expect(store.listProfiles(WS)).toHaveLength(1)
      // 别的工作区看不到
      expect(store.getProfile('ws_2', 'p_li')).toBeUndefined()
      store.close?.()
    })

    it('「谁问过我」按时间倒序，可按问方过滤', () => {
      const store = make()
      store.appendAsked(asked({ id: 'a1', at: '2026-09-07T01:00:00.000Z' }))
      store.appendAsked(asked({ id: 'a2', at: '2026-09-07T02:00:00.000Z', asked_by: 'p_wang' }))
      store.appendAsked(asked({ id: 'a3', person_id: 'p_chen' }))
      const mine = store.listAsked(WS, 'p_li')
      expect(mine.map((r) => r.id)).toEqual(['a2', 'a1'])
      expect(store.listAsked(WS, 'p_li', { asked_by: 'p_wang' }).map((r) => r.id)).toEqual(['a2'])
      expect(store.listAsked(WS, 'p_li', { limit: 1 }).map((r) => r.id)).toEqual(['a2'])
      store.close?.()
    })

    it('约时间卡：按 id 读、按收件人筛、状态可改', () => {
      const store = make()
      store.putMeet(meet())
      store.putMeet(meet({ id: 'meet_2', to: 'p_chen' }))
      expect(store.getMeet('meet_1')?.title).toBe('聊定价')
      expect(store.listMeets(WS, { to: 'p_li' }).map((m) => m.id)).toEqual(['meet_1'])
      store.putMeet(meet({ state: 'accepted', accepted: { start: T0, end: T0 } }))
      expect(store.getMeet('meet_1')?.state).toBe('accepted')
      expect(store.listMeets(WS, { state: ['proposed'] }).map((m) => m.id)).toEqual(['meet_2'])
      store.close?.()
    })

    it('删这个人：profile、问答记录、约时间卡一起走（21 §4）', () => {
      const store = make()
      store.putProfile(defaultProfile({ workspace_id: WS, person_id: 'p_li', at: T0 }))
      store.appendAsked(asked())
      store.putMeet(meet())
      const removed = store.erasePerson(WS, 'p_li')
      expect(removed).toBeGreaterThanOrEqual(3)
      expect(store.getProfile(WS, 'p_li')).toBeUndefined()
      expect(store.listAsked(WS, 'p_li')).toEqual([])
      expect(store.getMeet('meet_1')).toBeUndefined()
      store.close?.()
    })

    it('拿出来的是副本，改它改不动库里那份', () => {
      const store = make()
      store.putProfile(defaultProfile({ workspace_id: WS, person_id: 'p_li', at: T0 }))
      const got = store.getProfile(WS, 'p_li')
      if (got !== undefined) got.disclosure.positions = 'self'
      expect(store.getProfile(WS, 'p_li')?.disclosure.positions).toBe('colleagues')
      store.close?.()
    })
  })
}

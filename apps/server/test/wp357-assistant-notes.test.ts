/**
 * WP357（决策 902）：助理记进知识库的口径——写进去就生效（以点「就这样」的人的名义），
 * 只有让助理记的那个人能改 / 删，别的知识不认；撤销只撤助理记的、还没退役的。
 * 知识库用一个内存替身（只实现这几步用到的方法）。
 */
import type { FactCard } from '@agentsws/contracts'
import type { Knowledge } from '@agentsws/knowledge'
import { describe, expect, it } from 'vitest'
import { AssistantNoteError, createAssistantNotes } from '../src/assistant-notes.js'

const T = '2026-10-16T08:00:00.000Z'
const me = { workspace_id: 'ws_1', person_id: 'p_me', assignment_id: 'asg_1' }

function fakeKnowledge() {
  const cards = new Map<string, FactCard>()
  const activatedBy: string[] = []
  let seq = 0
  const store = {
    async propose(input: Omit<FactCard, 'id' | 'status' | 'usage' | 'created_at' | 'updated_at'>) {
      seq += 1
      const card = {
        ...input,
        id: `fc_${seq}`,
        status: 'proposed',
        usage: { recalled: 0, cited: 0, drafts_edited_after_cite: 0 },
        created_at: T,
        updated_at: T,
      } as FactCard
      cards.set(card.id, card)
      return card
    },
    async activate(id: string, by: string) {
      activatedBy.push(by)
      const next = { ...(cards.get(id) as FactCard), status: 'active' as const }
      cards.set(id, next)
      return next
    },
    async retire(id: string) {
      const next = { ...(cards.get(id) as FactCard), status: 'retired' as const }
      cards.set(id, next)
      return next
    },
    async patch(id: string, patch: Partial<FactCard>) {
      const next = { ...(cards.get(id) as FactCard), ...patch, id }
      cards.set(id, next)
      return next
    },
    getUnchecked: (id: string) => cards.get(id),
  }
  return { knowledge: { store } as unknown as Knowledge, cards, activatedBy }
}

const note = (statement: string, subjectType = 'assistant_note') =>
  ({
    schema_version: 1,
    workspace_id: 'ws_1',
    layer: 'fact',
    domain: 'company',
    scope: [],
    sensitivity: 'internal',
    subject: { type: subjectType, id: 'customer-care', key: `k:${statement}` },
    statement,
    structured: { batch_id: 'fan_1' },
    provenance: [{ source: 'meeting', ref: 'assistant:fan_1', locator: '周会', quote: statement }],
    confidence: { value: 0.6, state: 'unverified' },
    valid: { from: T },
    owner: 'p_me',
    created_by: { kind: 'agent', id: 'assistant' },
  }) as never

function make() {
  const k = fakeKnowledge()
  const notes = createAssistantNotes({
    clock: { now: () => T as never },
    knowledge: k.knowledge,
    approvals: {} as never,
    roleOf: () => undefined,
  })
  return { ...k, notes }
}

describe('WP357 助理记进知识库的口径（决策 902）', () => {
  it('写进去就生效，以点「就这样」的人的名义激活；不出确认卡', async () => {
    const { notes, cards, activatedBy } = make()
    const out = await notes.write(me, {
      batch_id: 'fan_1',
      title: '周会',
      source: { name: '周会.md', kind: 'meeting' },
      cards: [note('退货期统一 30 天'), note('品牌语气偏轻松')],
      groups: [],
    })
    expect(out).toEqual({ card_ids: ['fc_1', 'fc_2'] })
    expect([...cards.values()].map((c) => c.status)).toEqual(['active', 'active'])
    expect(activatedBy).toEqual(['p_me', 'p_me'])
  })

  it('改：就地改正文、旧句留痕；别人改不了；不是助理记的当不存在；空的不行', async () => {
    const { notes, cards } = make()
    await notes.write(me, {
      batch_id: 'fan_1',
      title: '周会',
      source: { name: '周会.md', kind: 'meeting' },
      cards: [note('退货期统一 30 天')],
      groups: [],
    })
    const next = await notes.edit(me, 'fc_1', '退货期统一 45 天')
    expect(next.id).toBe('fc_1')
    expect(next.statement).toBe('退货期统一 45 天')
    expect(next.provenance[0]?.quote).toBe('退货期统一 30 天')
    expect(next.structured?.previous).toEqual([
      { statement: '退货期统一 30 天', at: T, by: 'p_me' },
    ])
    const other = { ...me, person_id: 'p_other' }
    await expect(notes.edit(other, 'fc_1', 'x')).rejects.toMatchObject({ code: 'forbidden' })
    await expect(notes.retire(other, 'fc_1')).rejects.toBeInstanceOf(AssistantNoteError)
    await expect(notes.edit(me, 'fc_1', '  ')).rejects.toMatchObject({ code: 'invalid_input' })
    cards.set('fc_x', { ...(note('别的知识', 'faq') as FactCard), id: 'fc_x', status: 'active' })
    await expect(notes.retire(me, 'fc_x')).rejects.toMatchObject({ code: 'not_found' })
  })

  it('撤销：只撤助理记的、还没退役的，回撤了几条', async () => {
    const { notes, cards } = make()
    await notes.write(me, {
      batch_id: 'fan_1',
      title: '周会',
      source: { name: '周会.md', kind: 'meeting' },
      cards: [note('a'), note('b'), note('c')],
      groups: [],
    })
    await notes.retire(me, 'fc_2')
    cards.set('fc_x', { ...(note('别的知识', 'faq') as FactCard), id: 'fc_x', status: 'active' })
    expect(await notes.retireMany(me, ['fc_1', 'fc_2', 'fc_3', 'fc_x', 'fc_nope'])).toBe(2)
    expect(cards.get('fc_x')?.status).toBe('active')
    expect([...cards.values()].filter((c) => c.status === 'retired').map((c) => c.id)).toEqual([
      'fc_1',
      'fc_2',
      'fc_3',
    ])
  })
})

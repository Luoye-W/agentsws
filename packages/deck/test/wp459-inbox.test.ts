/** WP459（决策 1500 甲）：收件箱急不急三组、组内顺序、计数、筛选。 */
import { describe, expect, it } from 'vitest'
import {
  filterInbox,
  INBOX_UNASSIGNED,
  type InboxItem,
  inboxCounts,
  inboxUrgencyOfCard,
  inboxUrgencyOfMail,
  sortInbox,
} from '../src/index.js'

const NOW = '2026-10-22T09:00:00.000Z'
const card = (over: { band?: 'P0' | 'P1' | 'P2' | 'P3'; expires?: string; created?: string }) => ({
  priority_band: over.band ?? 'P2',
  ...(over.expires === undefined ? {} : { expires_at: over.expires }),
  detail: { created_at: over.created ?? '2026-10-20T00:00:00.000Z' },
})

describe('急不急', () => {
  it('卡：客户在等 / 6 小时内到期 → 要紧；待你确认 / 24 小时内 / 今天来的 → 今天；其余不急', () => {
    expect(inboxUrgencyOfCard(card({ band: 'P0' }) as never, NOW)).toBe('urgent')
    expect(inboxUrgencyOfCard(card({ expires: '2026-10-22T13:00:00.000Z' }) as never, NOW)).toBe(
      'urgent',
    )
    expect(inboxUrgencyOfCard(card({ band: 'P1' }) as never, NOW)).toBe('today')
    expect(inboxUrgencyOfCard(card({ expires: '2026-10-23T05:00:00.000Z' }) as never, NOW)).toBe(
      'today',
    )
    expect(inboxUrgencyOfCard(card({ created: '2026-10-22T01:00:00.000Z' }) as never, NOW)).toBe(
      'today',
    )
    expect(inboxUrgencyOfCard(card({ band: 'P3' }) as never, NOW)).toBe('later')
  })

  it('信：急 → 要紧；今天来的 → 今天；不急的 / 前几天的 → 不急', () => {
    expect(inboxUrgencyOfMail({ priority: 'high', last_at: '2026-10-19T00:00:00.000Z' }, NOW)).toBe(
      'urgent',
    )
    expect(inboxUrgencyOfMail({ last_at: '2026-10-22T03:00:00.000Z' }, NOW)).toBe('today')
    expect(inboxUrgencyOfMail({ last_at: '2026-10-19T03:00:00.000Z' }, NOW)).toBe('later')
    expect(inboxUrgencyOfMail({ priority: 'low', last_at: '2026-10-22T03:00:00.000Z' }, NOW)).toBe(
      'later',
    )
  })
})

const item = (
  id: string,
  urgency: InboxItem['urgency'],
  at: string,
  over: Partial<InboxItem> = {},
): InboxItem => ({
  id,
  type: 'card',
  urgency,
  tag: 'card',
  primary: 'approve',
  at,
  ...over,
})

describe('排序、计数、筛选', () => {
  const items = [
    item('a', 'today', '2026-10-22T01:00:00.000Z', { position: 'customer-care' }),
    item('b', 'urgent', '2026-10-22T05:00:00.000Z'),
    item('c', 'urgent', '2026-10-22T02:00:00.000Z', { type: 'mail' }),
    item('d', 'later', '2026-10-20T02:00:00.000Z', { position: 'web-ops' }),
    item('e', 'today', '2026-10-22T04:00:00.000Z', { type: 'mail' }),
  ]
  it('要紧在前、等得最久的先办；今天 / 不急新的在前', () => {
    expect(sortInbox(items).map((i) => i.id)).toEqual(['c', 'b', 'e', 'a', 'd'])
  })
  it('计数与筛选', () => {
    expect(inboxCounts(items)).toEqual({ all: 5, cards: 3, mail: 2, urgent: 2, today: 2, later: 1 })
    expect(filterInbox(items, { type: 'mail' }).map((i) => i.id)).toEqual(['c', 'e'])
    expect(filterInbox(items, { position: 'web-ops' }).map((i) => i.id)).toEqual(['d'])
    expect(
      filterInbox(items, { position: INBOX_UNASSIGNED, type: 'card' }).map((i) => i.id),
    ).toEqual(['b'])
  })
})

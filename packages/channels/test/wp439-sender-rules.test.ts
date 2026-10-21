/**
 * WP439（docs/108 §5.1.5 / §6）：发件人规则的命中账、刚删的那几条（两种库一样）、回复建议的 stub 剧本。
 */
import type { Clock, SenderRule } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import {
  MemoryMessageStore,
  recordSenderRuleHit,
  replySuggestStubScript,
  SqliteMessageStore,
  SUGGEST_PROMPT_MARKER,
  senderRuleForList,
  senderRuleHits30d,
  undoableDeletedRules,
} from '../src/index.js'

const NOW = '2026-10-21T08:00:00.000Z'
const clock: Clock = { now: () => NOW, sleep: async () => undefined }
const daysAgo = (n: number): string => new Date(Date.parse(NOW) - n * 86_400_000).toISOString()

const rule = (over: Partial<SenderRule> = {}): SenderRule => ({
  id: 'rule_1',
  sender: 'ann@buyer.example',
  labels: [],
  by: 'p_owner',
  created_at: daysAgo(40),
  ...over,
})

describe('发件人规则命中账', () => {
  it('按信的日期记、按天合并；最近 30 天的才算', () => {
    let r = rule()
    r = recordSenderRuleHit(r, daysAgo(0), NOW)
    r = recordSenderRuleHit(r, daysAgo(0), NOW)
    r = recordSenderRuleHit(r, daysAgo(10), NOW)
    expect(senderRuleHits30d(r, NOW)).toBe(3)
    expect(r.last_hit_at).toBe(daysAgo(0))
    // 回填的老信（早于 30 天）不记，原样回
    const old = recordSenderRuleHit(r, daysAgo(45), NOW)
    expect(old).toBe(r)
    // 过了 25 天再看：10 天前那一次已经出了窗口
    const later = new Date(Date.parse(NOW) + 25 * 86_400_000).toISOString()
    expect(senderRuleHits30d(r, later)).toBe(2)
    // 记下一次时顺手把窗口外的天丢掉
    const pruned = recordSenderRuleHit(r, later, later)
    expect(Object.keys(pruned.hit_days ?? {})).toHaveLength(2)
  })

  it('最近一次命中只往后走（晚到的老信不把它拉回去）', () => {
    const r = recordSenderRuleHit(rule(), daysAgo(1), NOW)
    const back = recordSenderRuleHit(r, daysAgo(5), NOW)
    expect(back.last_hit_at).toBe(daysAgo(1))
    expect(senderRuleHits30d(back, NOW)).toBe(2)
  })

  it('清单里那一份：算好 hits_30d、不带账本、来源缺省按人教的', () => {
    const r = recordSenderRuleHit(rule(), daysAgo(2), NOW)
    const view = senderRuleForList(r, NOW)
    expect(view).toMatchObject({ hits_30d: 1, source: 'user', last_hit_at: daysAgo(2) })
    expect(view.hit_days).toBeUndefined()
    expect(senderRuleForList(rule({ source: 'ai' }), NOW).source).toBe('ai')
  })

  it('刚删的：7 天内能撤回，新的在前', () => {
    const rows = [
      { rule: rule({ id: 'a' }), deleted_by: 'p1', deleted_at: daysAgo(1) },
      { rule: rule({ id: 'b' }), deleted_by: 'p1', deleted_at: daysAgo(8) },
      { rule: rule({ id: 'c' }), deleted_by: 'p2', deleted_at: daysAgo(0) },
    ]
    expect(undoableDeletedRules(rows, NOW).map((r) => r.rule.id)).toEqual(['c', 'a'])
  })
})

describe.each([
  ['内存', () => new MemoryMessageStore()],
  ['SQLite', () => new SqliteMessageStore({ clock })],
])('%s 库：命中账与刚删的', (_name, make) => {
  it('命中账跟着规则存取；刚删的能放、能拿、按规则 id 一条', async () => {
    const store = make()
    const r = recordSenderRuleHit(rule(), daysAgo(1), NOW)
    await store.putSenderRule(r)
    const [back] = await store.senderRules()
    expect(back?.hit_days).toEqual(r.hit_days)
    // 内存库给的是一份拷贝：外面改不动里面
    if (back?.hit_days !== undefined) back.hit_days.x = 9
    expect((await store.senderRules())[0]?.hit_days).toEqual(r.hit_days)

    expect(await store.deleteSenderRule(r.id)).toBe(true)
    await store.putDeletedSenderRule?.({ rule: r, deleted_by: 'p_owner', deleted_at: NOW })
    await store.putDeletedSenderRule?.({ rule: r, deleted_by: 'p_two', deleted_at: NOW })
    const deleted = (await store.deletedSenderRules?.()) ?? []
    expect(deleted).toHaveLength(1)
    expect(deleted[0]).toMatchObject({ deleted_by: 'p_two', rule: { id: 'rule_1' } })
    expect(await store.dropDeletedSenderRule?.(r.id)).toBe(true)
    expect((await store.deletedSenderRules?.()) ?? []).toHaveLength(0)
  })
})

describe('回复建议的 stub 剧本（没接真模型时）', () => {
  const call = (lang: string) =>
    replySuggestStubScript([
      { role: 'system', content: `${SUGGEST_PROMPT_MARKER}给出若干条……` },
      {
        role: 'user',
        content: JSON.stringify({ lang, kinds: ['short', 'detailed', 'decline'] }),
      },
    ])

  it('认得出「回复建议」那一次，按 lang 写：英文来信三条英文、中文来信三条中文', () => {
    const en = JSON.parse(call('en') ?? '[]') as { kind: string; text: string }[]
    expect(en.map((r) => r.kind)).toEqual(['short', 'detailed', 'decline'])
    for (const r of en) expect(r.text).toMatch(/^[\x20-\x7e—’]+$/)
    const zh = JSON.parse(call('zh') ?? '[]') as { kind: string; text: string }[]
    for (const r of zh) expect(r.text).toMatch(/[一-龥]/)
    // 没备的语言按英文
    expect(JSON.parse(call('de') ?? '[]')[0].text).toBe(en[0]?.text)
  })

  it('别的调用一律不接', () => {
    expect(
      replySuggestStubScript([
        { role: 'system', content: '邮件分拣' },
        { role: 'user', content: '{}' },
      ]),
    ).toBeUndefined()
  })
})

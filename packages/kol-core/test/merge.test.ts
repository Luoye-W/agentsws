import { suppressionKey } from '@agentsws/core'
import { describe, expect, it } from 'vitest'
import { applyMerge, type MergeProfile, suggestMerge, suggestMerges } from '../src/index.js'

const profile = (over: Partial<MergeProfile> & { creator_id: string }): MergeProfile => ({
  display_name: '',
  accounts: [],
  contact_keys: [],
  ...over,
})

describe('同一人合并：只出建议卡，永远不自动合（48 §5.2）', () => {
  it('同一条联系方式一条判据就出建议，把握 0.95', () => {
    const a = profile({
      creator_id: 'cre_1',
      display_name: 'Jonas',
      accounts: [{ channel: 'youtube', handle: 'gadgetjonas' }],
      contact_keys: [suppressionKey('Jonas+kol@example.com')],
    })
    const b = profile({
      creator_id: 'cre_2',
      display_name: '完全不一样的名字',
      accounts: [{ channel: 'instagram', handle: 'jonasg' }],
      contact_keys: [suppressionKey('jonas@example.com')],
    })
    const s = suggestMerge(a, b)
    expect(s?.confidence).toBe(0.95)
    expect(s?.reasons.map((r) => r.id)).toContain('same_contact')
  })

  it('建议卡上不出现联系方式本身（键等于半个明文）', () => {
    const key = suppressionKey('jonas@example.com')
    const a = profile({ creator_id: 'cre_1', display_name: 'A', contact_keys: [key] })
    const b = profile({ creator_id: 'cre_2', display_name: 'B', contact_keys: [key] })
    const text = (suggestMerge(a, b)?.reasons ?? []).map((r) => r.text).join('')
    expect(text).not.toContain('jonas')
    expect(text).toContain('同一条联系方式')
  })

  it('跨渠道同 handle 一条判据不够——要配上名字像才出建议', () => {
    const onlyHandle = suggestMerge(
      profile({
        creator_id: 'cre_1',
        display_name: '张三',
        accounts: [{ channel: 'youtube', handle: 'desk' }],
      }),
      profile({
        creator_id: 'cre_2',
        display_name: 'Maria',
        accounts: [{ channel: 'tiktok', handle: 'desk' }],
      }),
    )
    expect(onlyHandle).toBeUndefined()

    const both = suggestMerge(
      profile({
        creator_id: 'cre_1',
        display_name: 'Desk Rosa',
        accounts: [{ channel: 'youtube', handle: 'deskrosa' }],
      }),
      profile({
        creator_id: 'cre_2',
        display_name: 'desk.rosa',
        accounts: [{ channel: 'instagram', handle: '@DeskRosa' }],
      }),
    )
    expect(both?.confidence).toBe(0.7)
    expect(both?.reasons.map((r) => r.id).sort()).toEqual(['same_handle', 'similar_name'])
  })

  it('同一渠道同 handle 不算"两个人"（那是同一条账号）——名字再像也只剩一条判据', () => {
    expect(
      suggestMerge(
        profile({
          creator_id: 'cre_1',
          display_name: 'Desk Rosa',
          accounts: [{ channel: 'youtube', handle: 'deskrosa' }],
        }),
        profile({
          creator_id: 'cre_2',
          display_name: 'Desk Rosa',
          accounts: [{ channel: 'youtube', handle: 'deskrosa' }],
        }),
      ),
    ).toBeUndefined()
  })

  it('保留账号多的那一条；一样多就按 id 定（要的是稳定，不是聪明）', () => {
    const a = profile({
      creator_id: 'cre_9',
      display_name: 'Jonas',
      accounts: [{ channel: 'youtube', handle: 'j' }],
      contact_keys: ['j@x.com'],
    })
    const b = profile({
      creator_id: 'cre_1',
      display_name: 'Jonas',
      accounts: [
        { channel: 'instagram', handle: 'j' },
        { channel: 'tiktok', handle: 'j' },
      ],
      contact_keys: ['j@x.com'],
    })
    expect(suggestMerge(a, b)?.keep_id).toBe('cre_1')
    expect(suggestMerge(a, b)?.merge_id).toBe('cre_9')
  })

  it('一批画像 → 全部建议，按把握排序；同一条可以出现在好几对里（不替人先挑）', () => {
    const list = [
      profile({ creator_id: 'a', display_name: 'Jonas', contact_keys: ['j@x.com'] }),
      profile({ creator_id: 'b', display_name: 'Jonas', contact_keys: ['j@x.com'] }),
      profile({
        creator_id: 'c',
        display_name: 'Jonas',
        accounts: [{ channel: 'youtube', handle: 'jonas' }],
      }),
      profile({
        creator_id: 'd',
        display_name: 'Jonas',
        accounts: [{ channel: 'tiktok', handle: 'jonas' }],
      }),
    ]
    const out = suggestMerges(list)
    expect(out.length).toBeGreaterThanOrEqual(2)
    expect(out[0]?.confidence).toBe(0.95)
    expect(out.at(-1)?.confidence).toBe(0.7)
  })

  it('applyMerge 把被合掉那条的 id 留着，所以合错了拆得回来', () => {
    const keep = { id: 'cre_1', display_name: 'Jonas', merged_from: ['cre_0'] }
    const merge = { id: 'cre_2', display_name: 'Jonas', merged_from: ['cre_3'] }
    expect(applyMerge(keep, merge).merged_from).toEqual(['cre_0', 'cre_2', 'cre_3'])
  })

  it('自己跟自己不出建议', () => {
    const p = profile({ creator_id: 'x', display_name: 'A', contact_keys: ['a@x.com'] })
    expect(suggestMerge(p, p)).toBeUndefined()
  })
})

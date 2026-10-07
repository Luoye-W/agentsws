/**
 * WP249：自家版的版务卡是「做之前」的卡——排成 ② 改动卡。
 * WP254（决策 117）：别的社群的版务卡也是做之前的卡，一样排成改动卡，按钮「批准执行 / 不做」。
 */
import { describe, expect, it } from 'vitest'
import { isOwnSubModerationItem, projectCard, verbKey } from '../src/index.js'
import { item, NOW } from './fixtures.js'

const ctx = { now: NOW, position_id: 'asg_1' }
const moderation = (after: Record<string, unknown>) =>
  item({
    kind: 'staged_change',
    payload: { change_id: 'chg_1', kind: 'community_moderation', before: {}, after },
  })

describe('WP249 自家版版务卡的排版', () => {
  it('own_sub_queue 来的与别的社群的：都是改动卡（WP254）', () => {
    const own = moderation({ source: 'own_sub_queue', action: 'delete_post', channel: 'reddit' })
    const other = moderation({ action: 'ban', channel: 'discord' })
    expect(isOwnSubModerationItem(own)).toBe(true)
    expect(isOwnSubModerationItem(other)).toBe(false)
    expect(projectCard(own, ctx)).toMatchObject({
      layout: 'change',
      change_kind: 'community_moderation',
    })
    expect(projectCard(other, ctx)).toMatchObject({
      layout: 'change',
      change_kind: 'community_moderation',
    })
  })

  it('按钮字：批准执行 / 不做（不再是「解除禁言」）', () => {
    expect(verbKey('change', 'approve', 'community_moderation')).toBe('verb.moderation.approve')
    expect(verbKey('change', 'reject', 'community_moderation')).toBe('verb.moderation.reject')
    // 别的改动卡照旧
    expect(verbKey('change', 'approve', 'price_change')).toBe('verb.change.approve')
  })
})

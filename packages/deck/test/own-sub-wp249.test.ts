/**
 * WP249：自家版的版务卡是「做之前」的卡——排成 ② 改动卡（主动词「批准」），
 * 别的 `community_moderation`（表里是 ⑦ 事后决定）一个字节不变。
 */
import { describe, expect, it } from 'vitest'
import { isOwnSubModerationItem, projectCard } from '../src/index.js'
import { item, NOW } from './fixtures.js'

const ctx = { now: NOW, position_id: 'asg_1' }
const moderation = (after: Record<string, unknown>) =>
  item({
    kind: 'staged_change',
    payload: { change_id: 'chg_1', kind: 'community_moderation', before: {}, after },
  })

describe('WP249 自家版版务卡的排版', () => {
  it('own_sub_queue 来的：改动卡；别的：照旧事后决定', () => {
    const own = moderation({ source: 'own_sub_queue', action: 'delete_post', channel: 'reddit' })
    const other = moderation({ action: 'ban', channel: 'discord' })
    expect(isOwnSubModerationItem(own)).toBe(true)
    expect(isOwnSubModerationItem(other)).toBe(false)
    expect(projectCard(own, ctx)).toMatchObject({
      layout: 'change',
      change_kind: 'community_moderation',
    })
    expect(projectCard(other, ctx).layout).toBe('aftermath')
  })
})

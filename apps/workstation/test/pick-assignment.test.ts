/**
 * WP139：独立页面按「要什么职责」挑自己名下的分配（docs/78 阻断 #2）。
 *
 * 三种情形：有 / 没有 / 多条时挑哪条。
 */
import { describe, expect, it } from 'vitest'
import type { Assignment } from '@/lib/api'
import {
  holdsDuty,
  KOL_NEED,
  LIVE_CHAT_NEED,
  LIVE_CHAT_TEACH_NEED,
  OWNER_NEED,
  pickAssignment,
} from '@/lib/pick-assignment'

const STORE = [{ kind: 'store', id: 'store_main' }]
const a = (id: string, role_id: string, ranges = STORE, revoked = false): Assignment => ({
  id,
  role_id,
  ranges,
  ...(revoked ? { revoked_at: '2026-09-01T00:00:00.000Z' } : {}),
})

const OWNER = a('asg_owner', 'common.owner', [])

describe('pickAssignment', () => {
  it('有：店主身份之外名下有在线客服，就挑在线客服那条', () => {
    const mine = [OWNER, a('asg_chat', 'dtc.live-chat')]
    expect(pickAssignment(mine, LIVE_CHAT_NEED, 'asg_owner')).toEqual({
      kind: 'ok',
      assignment: 'asg_chat',
      role_id: 'dtc.live-chat',
    })
  })

  it('没有：名下没有这条职责（撤销了的不算）', () => {
    const mine = [OWNER, a('asg_ads', 'ads.meta'), a('asg_chat', 'dtc.live-chat', STORE, true)]
    expect(pickAssignment(mine, LIVE_CHAT_NEED, 'asg_owner')).toEqual({ kind: 'none' })
    expect(pickAssignment(mine, KOL_NEED, null)).toEqual({ kind: 'none' })
  })

  it('多条：职责按需求里的先后挑，在线客服排在客服前面', () => {
    const mine = [OWNER, a('asg_support', 'dtc.support'), a('asg_chat', 'dtc.live-chat')]
    expect(pickAssignment(mine, LIVE_CHAT_NEED)).toMatchObject({ assignment: 'asg_chat' })
    // 教一句要 customer.stage：持有它的客服职责排前面
    expect(pickAssignment(mine, LIVE_CHAT_TEACH_NEED)).toMatchObject({
      assignment: 'asg_support',
    })
  })

  it('多条：有范围的优先——空范围的在线客服去读会话必被拒', () => {
    const mine = [a('asg_chat', 'dtc.live-chat', []), a('asg_support', 'dtc.support')]
    expect(pickAssignment(mine, LIVE_CHAT_NEED)).toMatchObject({
      kind: 'ok',
      assignment: 'asg_support',
    })
  })

  it('只有一条且范围为空：挑出来但标成 no_range（界面说去分配，不发必 403 的请求）', () => {
    const mine = [OWNER, a('asg_chat', 'dtc.live-chat', [])]
    expect(pickAssignment(mine, LIVE_CHAT_NEED)).toEqual({
      kind: 'no_range',
      assignment: 'asg_chat',
      role_id: 'dtc.live-chat',
    })
  })

  it('多条红人职责：同档里当前岗位优先，否则按顺序第一条', () => {
    const mine = [OWNER, a('asg_yt', 'kol.youtube'), a('asg_ig', 'kol.instagram')]
    expect(pickAssignment(mine, KOL_NEED, 'asg_owner')).toMatchObject({ assignment: 'asg_yt' })
    expect(pickAssignment(mine, KOL_NEED, 'asg_ig')).toMatchObject({ assignment: 'asg_ig' })
  })

  it('所有者那条不看范围（工作区级配置）', () => {
    expect(pickAssignment([a('asg_x', 'ads.meta'), OWNER], OWNER_NEED)).toMatchObject({
      kind: 'ok',
      assignment: 'asg_owner',
    })
  })
})

describe('holdsDuty', () => {
  it('没撤销的在线客服才算（范围空也算——入口照样该出现）', () => {
    expect(holdsDuty([OWNER, a('asg_chat', 'dtc.live-chat', [])], 'dtc.live-chat')).toBe(true)
    expect(holdsDuty([OWNER, a('asg_chat', 'dtc.live-chat', STORE, true)], 'dtc.live-chat')).toBe(
      false,
    )
    expect(holdsDuty([OWNER], 'dtc.live-chat')).toBe(false)
  })
})

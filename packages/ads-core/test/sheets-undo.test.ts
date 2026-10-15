/**
 * WP316：撤销底稿——改的改回去、新建的暂停（不删）、倒着来；新建的编号从改后导出里补。
 */
import { describe, expect, it } from 'vitest'
import type { AdSheetOp } from '../src/index.js'
import { buildAdUploadBundle, buildUndoOps, parseAdsExport } from '../src/index.js'

const ops: AdSheetOp[] = [
  { kind: 'create_campaign', campaign: 'New C', daily_budget: 20 },
  { kind: 'create_ad_group', campaign: 'New C', ad_group: 'G1' },
  { kind: 'add_keyword', campaign: 'New C', ad_group: 'G1', text: 'trail shoes', match: 'exact' },
  {
    kind: 'set_budget',
    level: 'campaign',
    ref: { campaign: 'Live One', campaign_id: '1001' },
    before: 200,
    after: 230,
  },
  {
    kind: 'set_status',
    level: 'campaign',
    ref: { campaign: 'Old', campaign_id: '1002' },
    status: 'paused',
  },
]

const AFTER = [
  'Campaign,Campaign ID,Campaign state,Budget,Ad group,Ad group ID,Ad group state,Keyword,Status',
  'New C,5001,Paused,20.00,,,,,',
  'New C,5001,Paused,20.00,G1,6001,Paused,,',
  'New C,5001,Paused,20.00,G1,6001,Paused,[trail shoes],Paused',
  'Live One,1001,Enabled,230.00,,,,,',
  'Old,1002,Paused,10.00,,,,,',
].join('\n')

describe('撤销底稿', () => {
  it('倒着来：先把最后那条改回去；预算换回原数、暂停换成启用；新建的一律暂停', () => {
    const plan = buildUndoOps(ops)
    expect(plan.ops.map((o) => o.kind)).toEqual([
      'set_status',
      'set_budget',
      'set_status',
      'set_status',
      'set_status',
    ])
    expect(plan.ops[0]).toMatchObject({ status: 'enabled', ref: { campaign_id: '1002' } })
    expect(plan.ops[1]).toMatchObject({ before: 230, after: 200 })
    expect(plan.ops.slice(2).every((o) => o.kind === 'set_status' && o.status === 'paused')).toBe(
      true,
    )
    expect(plan.sentence).toBe('撤销：2 条改回原样，新建的 3 个先暂停（不删）。')
  })

  it('给了改后导出：新建的补上平台给的编号', () => {
    const plan = buildUndoOps(ops, parseAdsExport(AFTER))
    const campaign = plan.ops.find(
      (o) => o.kind === 'set_status' && o.level === 'campaign' && o.ref.campaign === 'New C',
    )
    expect(campaign).toMatchObject({ ref: { campaign_id: '5001' } })
    const group = plan.ops.find((o) => o.kind === 'set_status' && o.level === 'ad_group')
    expect(group).toMatchObject({ ref: { campaign_id: '5001', ad_group_id: '6001' } })
  })

  it('拼出来的意图能直接出一张 Google 表（改预算那条超额也照出：这是改回去）', () => {
    const plan = buildUndoOps(ops, parseAdsExport(AFTER))
    const bundle = buildAdUploadBundle({
      platform: 'google',
      ops: plan.ops,
      context: { allow_over_cap: true },
    })
    expect(bundle.ok).toBe(true)
    expect(bundle.files.length).toBeGreaterThan(0)
  })

  it('什么都没有就照实说', () => {
    expect(buildUndoOps([]).sentence).toBe('没有能撤的改动。')
  })
})

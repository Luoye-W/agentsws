/**
 * WP316（docs/101 §5.1④ 出口）：素材流水线这一轮「交给插件」——拼成新建广告的意图，走投放那一张上传表卡；
 * 没装插件执行那一半的进程照实说，只能下载表自己传。
 */
import type { CopyComplete } from '@agentsws/ads-core'
import type { AdsActor, AdsChangesView } from '@agentsws/api'
import type { WorkspaceId } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import { createAdCreativeService } from '../src/ad-creative.js'
import { createAdsStore } from '../src/ads.js'

const WS = 'ws_1' as WorkspaceId
const actor: AdsActor = {
  workspace_id: WS,
  person_id: 'p_1' as never,
  assignment_id: 'as_1' as never,
  role_id: 'ads.google' as never,
}
const CSV = [
  'Campaign,Campaign ID,Ad group,Ad group ID,Ad ID,Headline 1,Description 1,Final URL,Impr.,Clicks',
  'PB,11,Commute,21,101,Magnetic Power Bank,Snaps on.,https://s.example/a,10000,300',
  'PB,11,Commute,21,102,Power on the go,Light.,https://s.example/a,8000,80',
  'PB,11,Gift,22,103,Gift idea,Nice.,https://s.example/b,9000,250',
].join('\n')

const complete: CopyComplete = async (req) =>
  JSON.stringify({
    lines:
      req.agent === 'headline'
        ? [
            { text: 'Snaps on, stays put' },
            { text: 'Charges while you walk' },
            { text: 'Pocket power' },
          ]
        : [{ text: 'Fits any pocket.' }, { text: 'Light enough for daily carry.' }],
  })

function setup(
  stageChanges?: (
    a: AdsActor,
    i: { account_id: string; ops: unknown[] },
  ) => Promise<AdsChangesView>,
) {
  const calls: { account_id: string; ops: unknown[] }[] = []
  const svc = createAdCreativeService({
    workspace_id: WS,
    clock: { now: () => '2026-10-15T09:00:00.000Z' },
    random: () => 0.42,
    store: createAdsStore({ workspace_id: WS }),
    appendEvent: () => undefined,
    complete: () => complete,
    ...(stageChanges === undefined
      ? {}
      : {
          stageChanges: async (a, i) => {
            calls.push(i)
            return stageChanges(a, i)
          },
        }),
  })
  return { port: svc.port, calls }
}

describe('素材流水线 → 交给插件', () => {
  it('这一轮拼成「新建广告」意图交给投放出卡（带上导出表里的编号与落地页）', async () => {
    const { port, calls } = setup(async () => ({
      route: 'sheet',
      reason: '里面有新建',
      views: [{ staged: true, approval_item_id: 'ap_1', level: 'L1' }],
    }))
    const imp = await port.importExport(actor, { platform: 'google', text: CSV })
    const round = await port.rewrite(actor, { import_id: imp.id })
    const out = await port.stageSheet?.(actor, round.id, { account_id: 'aa_g' })
    expect(out?.views[0]?.staged).toBe(true)
    expect(calls[0]?.account_id).toBe('aa_g')
    const ops = calls[0]?.ops as { kind: string; campaign_id?: string; final_url: string }[]
    expect(ops.length).toBeGreaterThan(0)
    expect(ops.every((o) => o.kind === 'create_ad')).toBe(true)
    expect(ops[0]).toMatchObject({ campaign_id: '11', final_url: 'https://s.example/a' })
  })

  it('没装插件执行那一半 → 照实说（下载表自己传）', async () => {
    const { port } = setup()
    const imp = await port.importExport(actor, { platform: 'google', text: CSV })
    const round = await port.rewrite(actor, { import_id: imp.id })
    await expect(port.stageSheet?.(actor, round.id, { account_id: 'aa_g' })).rejects.toThrow(
      /下载上传表/,
    )
  })
})

/**
 * WP316：Run 里的改广告工具——只给 Google / Meta 两条投放职责；提一批只出卡；
 * 插件没连 → 数据里带 `needs_connection: 'extension'`，运行就地出连接卡（WP324 的 `setupNeedOf` 认得它）。
 */
import type { AdsPort } from '@agentsws/api'
import { describe, expect, it } from 'vitest'
import { createAdsToolExecutor } from '../src/ads-tools.js'
import { setupNeedOf } from '../src/run-blocked.js'

const request = (role_id: string) =>
  ({
    actor: { person_id: 'p_1', assignment_id: 'as_1', role_id },
  }) as never

function exec(port: Partial<AdsPort>) {
  return createAdsToolExecutor({ workspace_id: 'ws_1' as never, port: () => port as AdsPort })
}

describe('改广告工具', () => {
  it('不是 Google / Meta 投放职责 → blocked', async () => {
    const out = await exec({})({
      name: 'propose_ad_changes',
      input: { account_id: 'aa', ops: [{ kind: 'set_status' }] },
      request: request('ads.tiktok'),
    } as never)
    expect(out.status).toBe('blocked')
  })

  it('提一批：回出了几张卡；插件没连 → needs_connection，运行认得出要出连接卡', async () => {
    const out = await exec({
      stageChanges: async () => ({
        route: 'sheet',
        reason: '里面有新建',
        views: [{ staged: true, approval_item_id: 'ap_1', change_id: 'chg_1', level: 'L1' }],
        needs_connection: 'extension',
      }),
    })({
      name: 'propose_ad_changes',
      input: { account_id: 'aa_g', ops: [{ kind: 'create_campaign', campaign: 'X' }] },
      request: request('ads.google'),
    } as never)
    expect(out.status).toBe('ok')
    expect(out.data).toMatchObject({
      route: 'sheet',
      cards: [{ approval_item_id: 'ap_1', level: 'L1' }],
      needs_connection: 'extension',
      kind: 'ads_change',
      change_id: 'chg_1',
    })
    expect(setupNeedOf('propose_ad_changes', out)).toMatchObject({
      kind: 'connect',
      need: { service: 'extension' },
    })
  })

  it('没装插件执行那一半 → 照实说，不假装出了卡', async () => {
    const out = await exec({})({
      name: 'propose_ad_changes',
      input: { account_id: 'aa_g', ops: [{ kind: 'create_campaign', campaign: 'X' }] },
      request: request('ads.meta'),
    } as never)
    expect(out.status).toBe('error')
  })
})

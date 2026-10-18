/**
 * WP420（自查 ads-amazon A11 / B2 / U23）：stub 的投放与 Amazon 运营剧本。
 * 投放：查今天 → 越线的出止损卡；Amazon：Listing 体检 / 词库 / 竞品——不再套客服回信卡。
 */
import type { RunRequest } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import { playbookOf } from '../src/runtime/playbook.js'
import type { ToolExecution } from '../src/runtime/stub.js'
import {
  adsAmazonScriptOf,
  runAdsScript,
  runAmazonScript,
  type ScriptStep,
} from '../src/runtime/stub-ads-amazon.js'

const reqOf = (role_id: string, allow: string[]): RunRequest =>
  ({ actor: { role_id }, tools: { allow } }) as unknown as RunRequest

function fakeExec(answers: Record<string, ToolExecution | ToolExecution[]>) {
  const calls: ScriptStep[] = []
  const exec = async (step: ScriptStep): Promise<ToolExecution> => {
    calls.push(step)
    const a = answers[step.tool]
    if (Array.isArray(a)) return a.shift() ?? { status: 'error', reason: 'none' }
    return a ?? { status: 'error', reason: 'none' }
  }
  return { exec, calls }
}

describe('哪条职责走哪套（B2 / U23）', () => {
  it('Amazon 客服照旧走客服剧本；店铺运营不再套客服', () => {
    expect(playbookOf('amz.support')).toBe('support')
    expect(playbookOf('amz.store')).toBeUndefined()
  })

  it('工具面里有那几个工具才进来', () => {
    expect(adsAmazonScriptOf(reqOf('ads.meta', ['ads.query_ads_data']))).toBe('ads')
    expect(adsAmazonScriptOf(reqOf('ads.meta', []))).toBeUndefined()
    expect(adsAmazonScriptOf(reqOf('ads.x', ['query_ads_data']))).toBeUndefined()
    expect(adsAmazonScriptOf(reqOf('amz.store', ['get_listing_checkup']))).toBe('amazon')
    expect(adsAmazonScriptOf(reqOf('amz.support', ['get_listing_checkup']))).toBeUndefined()
  })
})

describe('投放剧本（A11）', () => {
  it('查今天 → 越线的出止损卡 → 话里的数都来自工具', async () => {
    const { exec, calls } = fakeExec({
      query_ads_data: {
        status: 'ok',
        data: {
          ok: true,
          spend_gate: { spent: 700, remaining: 300 },
          stop_loss: [
            { campaign_id: 'c1', name: '老客再营销', outcome: 'trigger', reason: 'ROAS 0.6' },
            { campaign_id: 'c2', name: '新品', outcome: 'hold', reason: '还行' },
          ],
        },
      },
      stage_ads_stop_loss: { status: 'ok', data: { ok: true, staged: true, change_id: 'chg_9' } },
    })
    const out = await runAdsScript(exec)
    expect(calls.map((c) => c.tool)).toEqual(['query_ads_data', 'stage_ads_stop_loss'])
    expect(calls[1]?.input).toEqual({ campaign_id: 'c1' })
    expect(out.staged).toEqual(['chg_9'])
    expect(out.answer).toContain('今天一共花了 700，总闸还剩 300')
    expect(out.answer).toContain('老客再营销')
  })

  it('插件没连 → 照实说，不出止损卡', async () => {
    const { exec, calls } = fakeExec({
      query_ads_data: { status: 'ok', data: { ok: true, needs_connection: 'extension' } },
    })
    const out = await runAdsScript(exec)
    expect(calls).toHaveLength(1)
    expect(out.answer).toContain('插件还没连上')
  })
})

describe('Amazon 剧本（B2）', () => {
  it('「看看我的 Listing」：没体检过 → 体检一次；没设自家 ASIN → 照实说出了方案卡', async () => {
    const { exec, calls } = fakeExec({
      get_listing_checkup: { status: 'ok', data: { ok: false, message: '还没体检过' } },
      read_amazon_listings: { status: 'ok', data: { ok: false, needs_setup: 'amazon.own_asins' } },
    })
    const out = await runAmazonScript(exec, '看看我的 Listing')
    expect(calls.map((c) => c.tool)).toEqual(['get_listing_checkup', 'read_amazon_listings'])
    expect(out.answer).toContain('已出一张卡')
    expect(out.answer).not.toContain('回复')
  })

  it('体检过了 → 几个 ASIN、几处要改', async () => {
    const { exec } = fakeExec({
      get_listing_checkup: {
        status: 'ok',
        data: { ok: true, summary: { asins: 3, checked: 3, issues: 9 } },
      },
    })
    expect((await runAmazonScript(exec, '看看我的 Listing')).answer).toContain(
      '体检了 3 个 ASIN，9 处',
    )
  })

  it('说到词 → 看词库', async () => {
    const { exec, calls } = fakeExec({
      get_amazon_keywords: { status: 'ok', data: { ok: true, total: 102, gap_terms: 22 } },
    })
    const out = await runAmazonScript(exec, '看看词库差距')
    expect(calls.map((c) => c.tool)).toEqual(['get_amazon_keywords'])
    expect(out.answer).toContain('102 个词，22 个')
  })

  it('说到竞品 → 读一次竞品（没配好 → 方案卡）', async () => {
    const { exec, calls } = fakeExec({
      read_amazon_competitors: {
        status: 'ok',
        data: { needs_setup: 'amazon.competitor_watch' },
      },
    })
    const out = await runAmazonScript(exec, '帮我盯 Amazon 竞品', ['read_amazon_competitors'])
    expect(calls.map((c) => c.tool)).toEqual(['read_amazon_competitors'])
    expect(out.answer).toContain('方案卡')
  })
})

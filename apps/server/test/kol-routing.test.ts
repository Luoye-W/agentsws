/**
 * WP126：本机**四级路由**（派工单定论 1）。
 *
 * 每条都直接打 `createKolService` 的 `search`（不起整个进程），替身全在
 * `options` 上：
 *
 * ① 用户自己的官方平台 key → ② 用户自带的数据接口 → ③ 工坊官方数据接口（积分）
 * → ④ 都没有：人话 + 两个入口。
 *
 * 两条硬纪律钉在这里：
 * - **逐级回退只在「没配」或「不支持」时发生**；配了但报错不静默回退到花钱的那级，
 *   要说清哪一级失败 + 给一句「改用官方接口（约 N 积分）」；
 * - 结果上始终标「这份数据来自：我的 YouTube key / 我的数据接口 / 公共红人库」。
 */
import type { KolSearchResult } from '@agentsws/api'
import type { DataSourceRoute, KolChannel } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import type { ByoEndpointConfig } from '../src/kol-byo.js'
import { createKolService } from '../src/kol-service.js'

const T0 = '2026-09-15T09:00:00.000Z'

interface HarnessOptions {
  /** 官方 key（渠道适配器）配没配；配了时行为由 `ok` 定。 */
  adapter?: { ok?: boolean; message?: string }
  /** 自带接口：配了（可指定行为）或没配（false）。 */
  byo?: { ok?: boolean; message?: string } | false
  /** 工坊官方数据接口：ok = 关联且能查；false = 没配（未关联）。 */
  library?: { ok?: boolean } | false
  route?: DataSourceRoute
  /** 49 M2 的老开关。 */
  capabilitySource?: 'mine' | 'agentsws'
}

function harness(options: HarnessOptions = {}): {
  search(input: { q?: string; fallback?: 'workshop' }): Promise<KolSearchResult>
} {
  const service = createKolService({
    workspace_id: 'ws_1',
    store: {
      accounts: () => [],
      creators: () => [],
      contacts: () => [],
      collaborations: () => [],
    } as never,
    secrets: { available: true, get: () => undefined, put: () => ({}) as never } as never,
    clock: { now: () => T0 },
    approvals: {} as never,
    ledger: { stage: undefined as never, list: async () => [] },
    effectiveConfig: () => ({ actions: [], automation: {} }) as never,
    appendEvent: () => {},
    random: () => 0.5,
    assignmentsOf: () => [],
    holdersOf: () => [],
    brandName: () => '测试品牌',
    personName: (id) => id,
    // 第①级：渠道适配器
    ...(options.adapter === undefined
      ? {}
      : {
          channels: {
            adapters: {
              youtube: {
                search: async () =>
                  options.adapter?.ok === false
                    ? {
                        ok: false,
                        reason: 'upstream_error',
                        message: options.adapter.message ?? '上游炸了',
                      }
                    : {
                        ok: true,
                        data: [
                          {
                            channel: 'youtube',
                            handle: 'officialkey_hit',
                            display_name: '官方 key 找到的',
                            url: 'https://www.youtube.com/@officialkey_hit',
                            observed_at: T0,
                          },
                        ],
                        observed_at: T0,
                      },
              },
            },
          } as never,
        }),
    // 第②级：自带数据接口
    ...(options.byo === false
      ? {}
      : {
          byoDataSource: (channel: KolChannel): ByoEndpointConfig | undefined =>
            channel === 'youtube'
              ? {
                  service_url: 'https://byo.example',
                  secret_ref: 'kol.byo.youtube',
                  format: 'byo/v1',
                }
              : undefined,
          byoSecrets: () => 'byo-key',
          byoFetch: async (_url, init) => {
            void init
            const fail =
              options.byo !== undefined && options.byo !== false && options.byo.ok === false
            const message =
              options.byo !== undefined && options.byo !== false
                ? (options.byo.message ?? '你的接口限流了')
                : ''
            return new Response(
              fail
                ? JSON.stringify({ code: 'rate_limited', message })
                : JSON.stringify({
                    creators: [
                      {
                        channel: 'youtube',
                        handle: 'byo_hit',
                        display_name: '自带接口找到的',
                        url: 'https://www.youtube.com/@byo_hit',
                        observed_at: T0,
                      },
                    ],
                  }),
              { status: fail ? 429 : 200, headers: { 'content-type': 'application/json' } },
            )
          },
        }),
    ...(options.capabilitySource === undefined
      ? {}
      : { capabilitySource: () => options.capabilitySource as 'mine' | 'agentsws' }),
    ...(options.route === undefined
      ? {}
      : { dataSourceRoute: () => options.route as DataSourceRoute }),
    // 第③级：工坊官方数据接口
    ...(options.library === false
      ? {}
      : {
          publicLibrary: {
            linked: () => options.library?.ok !== false,
            browse: async () =>
              options.library?.ok === false
                ? {
                    ok: false,
                    reason: 'not_linked' as const,
                    message:
                      '这条渠道的开关拨到了"用 agentsws 的"，但这台机器还没关联 agentsws 账号。',
                  }
                : {
                    ok: true,
                    credits_spent: 0.2,
                    data: {
                      rows: [
                        {
                          public_id: 'youtube:library_hit',
                          channel: 'youtube',
                          handle: 'library_hit',
                          display_name: 'library_hit',
                          observed_at: T0,
                          has_contact: false,
                        },
                      ],
                    },
                  },
            audit: undefined as never,
            reveal: undefined as never,
          } as never,
        }),
    priceOf: async () => ({ credits: 0.2, unit: 'call' }),
  })
  return {
    search: (input) =>
      service.port.search(
        { workspace_id: 'ws_1', person_id: 'p_1', assignment_id: 'a_1', role_id: 'kol.youtube' },
        {
          channel: 'youtube',
          q: input.q ?? '',
          ...(input.fallback === undefined ? {} : { fallback: input.fallback }),
        },
      ),
  }
}

describe('WP126 四级路由', () => {
  it('①配了官方 key：用它，标「我的 YouTube key」，不碰后两级', async () => {
    const h = harness({ adapter: { ok: true }, byo: { ok: true } })
    const out = await h.search({})
    expect(out.ok).toBe(true)
    expect(out.source).toBe('channel')
    expect(out.source_label).toBe('我的 YouTube key')
    expect(out.rows[0]?.handle).toBe('officialkey_hit')
  })

  it('①没配、②配了：用自带接口，标「我的数据接口」', async () => {
    const h = harness({ byo: { ok: true } })
    const out = await h.search({ q: '美妆' })
    expect(out.ok).toBe(true)
    expect(out.source).toBe('byo_source')
    expect(out.source_label).toBe('我的数据接口')
    expect(out.rows[0]?.handle).toBe('byo_hit')
  })

  it('①②都没配：落③工坊官方接口，标「公共红人库」', async () => {
    const h = harness({ byo: false })
    const out = await h.search({ q: '美妆' })
    expect(out.ok).toBe(true)
    expect(out.source).toBe('public_library')
    expect(out.source_label).toBe('公共红人库')
    expect(out.rows[0]?.handle).toBe('library_hit')
  })

  it('①报错不静默回退：说清哪一级失败 + 给「改用官方接口（约 N 积分）」', async () => {
    const h = harness({ adapter: { ok: false, message: '配额用完了' }, byo: { ok: true } })
    const out = await h.search({ q: '美妆' })
    expect(out.ok).toBe(false)
    expect(out.failed_level).toBe('official_key')
    expect(out.message).toContain('YouTube')
    expect(out.message).toContain('配额用完了')
    expect(out.fallback_offer?.note).toContain('改用工坊官方数据接口')
    expect(out.fallback_offer?.credits).toBeGreaterThan(0)
    // ②是配了的，但没被碰——报错那级后面的级不自动走
    expect(out.rows).toHaveLength(0)
  })

  it('②报错同样不静默回退', async () => {
    const h = harness({ byo: { ok: false, message: '你的接口限流了' } })
    const out = await h.search({ q: '美妆' })
    expect(out.ok).toBe(false)
    expect(out.failed_level).toBe('byo_source')
    expect(out.message).toContain('你的接口限流了')
    expect(out.fallback_offer?.note).toContain('改用工坊官方数据接口')
  })

  it('顺序可调、可关：③提到最前、②关掉', async () => {
    const h = harness({
      adapter: { ok: true },
      byo: false,
      route: { order: ['workshop', 'official_key', 'byo_source'], disabled: ['byo_source'] },
    })
    const out = await h.search({})
    expect(out.ok).toBe(true)
    expect(out.source).toBe('public_library')
  })

  it('④都没有：一句人话 + 两个入口（关联送 10 积分 / 接自己的）', async () => {
    const h = harness({ byo: false, library: { ok: false } })
    const out = await h.search({ q: '美妆' })
    expect(out.ok).toBe(false)
    expect(out.reason).toBe('no_data_source')
    expect(out.message).toContain('任选其一')
    expect(out.entry_points?.map((e) => e.id)).toEqual(['link_account', 'byo'])
    expect(out.entry_points?.[0]?.note).toContain('10 积分')
  })

  it('49 M2 老开关拨到 agentsws：官方接口排最前', async () => {
    const h = harness({ adapter: { ok: true }, byo: { ok: true }, capabilitySource: 'agentsws' })
    const out = await h.search({})
    expect(out.ok).toBe(true)
    expect(out.source).toBe('public_library')
  })

  it('用户点了「改用官方接口」：fallback=workshop 直达③', async () => {
    const h = harness({ adapter: { ok: false, message: '配额用完了' }, byo: { ok: true } })
    const out = await h.search({ q: '美妆', fallback: 'workshop' })
    expect(out.ok).toBe(true)
    expect(out.source).toBe('public_library')
    expect(out.source_label).toBe('公共红人库')
  })
})

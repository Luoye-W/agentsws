/**
 * WP169：店铺校正改了目标市场 → 给工作区所有者推一条通知（首页告警区一行，点开到设置页公司档案）。
 *
 * 钉住：没改不推；只给所有者；人改过市场 / 过了 7 天就退场；点开去 `/settings#company`；
 * 真服务进程里连上店 → 首页告警区出这一行、事件日志有一条 `notification.sent`。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ActionMeta, ConnectToken, MarketsSource } from '@agentsws/contracts'
import { defaultState, MockOpenConnector } from '@agentsws/stand-ins'
import { afterEach, describe, expect, it } from 'vitest'
import type { ConnectLike } from '../src/connections.js'
import { createServer, type Server } from '../src/index.js'
import {
  createStoreMarketsNotices,
  createStoreMarketsSync,
  MARKETS_SETTINGS_PATH,
  STORE_MARKETS_NOTICE_DAYS,
  type StoreMarketsNotice,
} from '../src/markets.js'
import { SECRETS_KEY_ENV } from '../src/secret-store.js'

const AT = '2026-09-27T09:00:00.000Z'
const DAY = 86_400_000

const notice = (over: Partial<StoreMarketsNotice> = {}): StoreMarketsNotice => ({
  id: 'mkt_notice_1',
  note: '按店铺后台的「市场」校正：加上了 英国',
  markets: ['US', 'GB'],
  at: AT,
  owner: 'per_owner',
  position_id: 'asg_owner',
  ...over,
})

describe('WP169 · 校正通知（纯函数）', () => {
  it('没改不推：校正结果与档案一样时不调 onChanged；改了才调一次', async () => {
    const changes: string[][] = []
    let profile: { markets?: string[]; markets_source?: MarketsSource } = {
      markets: ['US', 'GB'],
      markets_source: { from: 'site', at: AT },
    }
    const connect = {
      actions: async () => [{ id: 'shopify_admin.list_markets' }],
      issueToken: async () => ({ token: 't' }),
      execute: async <T>(): Promise<T> =>
        ({ markets: [{ enabled: true, regions: [{ code: 'US' }, { code: 'GB' }] }] }) as T,
    }
    const make = (id: string) =>
      createStoreMarketsSync({
        connect,
        connection: () => ({ id, service: 'shopify_admin' }),
        current: () => profile,
        apply: (markets, markets_source) => {
          profile = { markets, markets_source }
          return true
        },
        now: () => AT,
        onChanged: ({ markets }) => {
          changes.push(markets)
        },
      })
    expect(await make('conn_same').check()).toEqual({ changed: false })
    expect(changes).toEqual([])
    profile = { markets: ['US'], markets_source: { from: 'site', at: AT } }
    expect((await make('conn_diff').check())?.changed).toBe(true)
    expect(changes).toEqual([['US', 'GB']])
  })

  it('只给所有者；出处还是这一次、7 天内才出；点开去设置页公司档案', () => {
    let now = AT
    const store = createStoreMarketsNotices({ now: () => now })
    const source: MarketsSource = { from: 'store', note: notice().note, at: AT }
    expect(store.alerts('per_owner', source)).toEqual([])
    store.push(notice())
    const [card] = store.alerts('per_owner', source)
    expect(card?.kind).toBe('system_alert')
    expect(card?.title).toBe('目标市场按店铺后台改了：加上了 英国')
    expect(card?.summary).toContain('去设置页「公司档案」改')
    expect(card?.channel).toBe('system')
    expect(card?.available_actions).toEqual(['open', 'snooze'])
    expect((card?.detail.payload as { open_path?: string } | undefined)?.open_path).toBe(
      MARKETS_SETTINGS_PATH,
    )
    expect(MARKETS_SETTINGS_PATH).toBe('/settings#company')
    // 别人看不到
    expect(store.alerts('per_member', source)).toEqual([])
    // 人在设置页改过（出处换成人改的）→ 退场
    expect(store.alerts('per_owner', { from: 'human', at: '2026-09-27T10:00:00.000Z' })).toEqual([])
    // 过了 7 天 → 退场
    now = new Date(Date.parse(AT) + STORE_MARKETS_NOTICE_DAYS * DAY).toISOString()
    expect(store.alerts('per_owner', source)).toEqual([])
  })

  it('落盘：重启后还在', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentsws-wp169-notice-'))
    try {
      createStoreMarketsNotices({ dir, now: () => AT }).push(notice())
      const again = createStoreMarketsNotices({ dir, now: () => AT })
      expect(again.current()?.note).toBe(notice().note)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

/* ── 真服务进程：连上店 → 首页告警区有这一行 ─────────────────────────── */

const SECRETS_KEY = 'b'.repeat(64)
const DEV_APP = {
  alias: '主店',
  fields: {
    shop_domain: 'https://admin.shopify.com/store/demo',
    client_id: '9a7bcd0e1f2a3b4c5d6e7f8091a2b3c4',
    client_secret: 'shpss_wp169_client_secret_never_logged',
  },
}

/** 替身连接器上补一条只读的 `list_markets`（替身本身没有这个 Action）。 */
function withMarkets(mock: MockOpenConnector, codes: string[]): ConnectLike {
  const LIST = 'shopify_admin.list_markets'
  return {
    providers: () => mock.providers(),
    actions: async (service: string): Promise<ActionMeta[]> => {
      const base = await mock.actions(service)
      return service === 'shopify_admin'
        ? [...base, { id: LIST, service, input_schema: {}, side_effect: 'read' }]
        : base
    },
    connections: (ws) => mock.connections(ws),
    beginConnect: (service, opts) => mock.beginConnect(service, opts),
    pollConnect: (id) => mock.pollConnect(id),
    submitForm: (service, input) => mock.submitForm(service, input),
    removeConnection: (id) => mock.removeConnection(id),
    issueToken: async (input): Promise<ConnectToken> =>
      input.allowed_actions.includes(LIST)
        ? ({ token: 'tok_markets_read', expires_at: AT } as ConnectToken)
        : mock.issueToken(input),
    revokeTokens: (id) => mock.revokeTokens(id),
    execute: async (action_id, input, opts) =>
      action_id === LIST
        ? { markets: [{ enabled: true, regions: codes.map((code) => ({ code })) }] }
        : mock.execute(action_id, input, opts),
  } as ConnectLike
}

let server: Server | undefined
let dir: string | undefined

afterEach(async () => {
  await server?.close()
  server = undefined
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
  dir = undefined
})

describe('WP169 · 店铺校正后推一条通知（真服务进程）', () => {
  it('连上店、市场被改 → 所有者首页告警区一行，点开到设置页；人改过市场就退场', async () => {
    dir = mkdtempSync(join(tmpdir(), 'agentsws-wp169-'))
    const mock = new MockOpenConnector({
      clock: { now: () => AT },
      random: () => 0.5,
      state: defaultState(AT),
      workspace_id: 'ws_stand_in',
    })
    const s = await createServer({
      dbDir: dir,
      clock: { now: () => AT },
      random: () => 0.42,
      quiet: true,
      startRun: false,
      scheduleIntervalMs: 0,
      tokenRefreshIntervalMs: 0,
      liveDataIntervalMs: 0,
      env: { [SECRETS_KEY_ENV]: SECRETS_KEY, AGENTSWS_OWNER_EMAIL: 'owner@localhost' },
      connect: withMarkets(mock, ['US', 'GB']),
      shopifyFetch: async () => ({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            access_token: `shpat_wp169_${'f'.repeat(20)}`,
            scope: 'read_orders',
            expires_in: 86_399,
          }),
      }),
      mdns: () => ({ mdns: { publish() {}, browse() {}, stop() {} } }),
    })
    server = s
    const owner = s.bootstrap.ownerAssignment.id
    const call = async (method: string, path: string, body?: unknown) => {
      const res = await s.gateway.fetch(
        new Request(`http://127.0.0.1${path}`, {
          method,
          headers: {
            Authorization: `Bearer ${s.bootstrap.internalToken}`,
            'X-Assignment': owner,
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
      )
      return { status: res.status, json: (await res.json()) as { data: Record<string, unknown> } }
    }
    const alerts = async () =>
      ((await call('GET', '/v1/home')).json.data.alerts ?? []) as {
        title: string
        detail: { payload: { open_path?: string } }
      }[]

    // 档案先有（没写市场）；这时首页没有告警
    expect((await call('PUT', '/v1/workspace/profile', { legal_name: 'Nordvik' })).status).toBe(200)
    expect(await alerts()).toEqual([])

    const conn = await call('POST', '/v1/connections/shopify_admin/submit', DEV_APP)
    expect(conn.status).toBe(200)
    // 校正挂在「连接清单变了」那一声上，异步跑完
    let got: Awaited<ReturnType<typeof alerts>> = []
    for (let i = 0; i < 50 && got.length === 0; i += 1) {
      await new Promise((r) => setTimeout(r, 20))
      got = await alerts()
    }
    expect(got).toHaveLength(1)
    expect(got[0]?.title).toBe('目标市场按店铺后台改了：设成了 美国、英国')
    expect(got[0]?.detail.payload.open_path).toBe('/settings#company')
    const state = await call('GET', '/v1/onboarding/state')
    expect((state.json.data.profile as { markets?: string[] }).markets).toEqual(['US', 'GB'])

    const events: string[] = []
    for await (const e of s.kernel.eventLog.read({
      workspace_id: s.bootstrap.workspace.id,
      limit: 5000,
    }))
      if (e.type === 'notification.sent') events.push(String(e.payload.reason))
    expect(events).toContain('markets_store_sync')

    // 所有者去设置页改了市场 → 通知退场
    await call('PUT', '/v1/workspace/profile', { legal_name: 'Nordvik', markets: ['US'] })
    expect(await alerts()).toEqual([])
  })
})

/**
 * WP315 端到端（真服务进程 + 替身插件走真 HTTP 口子；不打开真实广告后台、不起端口、不联网）：
 *
 * - 有人担 Google 投放 → 建了「导一次广告报表」的定时、装了看数据；
 * - 设好账户、插件配对并在插件里勾了风险告知 → 一拍排「建工坊日报」（L3 告知卡的编号当审批编号）；
 * - 插件领走、交回「做完了」→ 服务马上排第一次导出 → 插件领走、报「下到了哪」、交回 →
 *   读那份 CSV 入库、「今天」那份进广告库；
 * - 第一次有数 → 开一件「广告日报」、种一条每天 10 点的官方定时（提示词里有「发布」→ 先出卡请人确认）。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type ActionJob, ADS_CONSENT_TEXT_VERSION } from '@agentsws/browser-action'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { SECRETS_KEY_ENV } from '../src/secret-store.js'
import { createServer, type Server } from '../src/server.js'

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 })

const EXT_ORIGIN = 'chrome-extension://abcdefghijklmnop'
let server: Server
let dir: string

const data = async <T>(res: Response): Promise<T> => {
  const body = (await res.json()) as { data?: T; error?: unknown }
  if (!res.ok) throw new Error(`${res.status} ${JSON.stringify(body.error)}`)
  return body.data as T
}
const call = (method: string, path: string, body?: unknown) =>
  server.gateway.fetch(
    new Request(`http://127.0.0.1${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${server.bootstrap.internalToken}`,
        'X-Assignment': server.bootstrap.ownerAssignment.id,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  )
const plugin = (path: string, token: string, init: { method?: string; body?: unknown } = {}) =>
  server.gateway.fetch(
    new Request(`http://127.0.0.1${path}`, {
      method: init.method ?? 'GET',
      headers: {
        Origin: EXT_ORIGIN,
        Authorization: `Bearer ${token}`,
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    }),
  )
const settle = () => new Promise((r) => setTimeout(r, 20))

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'wp315-adsdata-'))
  server = await createServer({
    dbDir: dir,
    quiet: true,
    clock: { now: () => '2026-10-14T03:00:00.000Z' },
    env: { [SECRETS_KEY_ENV]: 'e'.repeat(64), AGENTSWS_OWNER_EMAIL: 'owner@example.com' },
    tokenRefreshIntervalMs: 0,
    scheduleIntervalMs: 0,
  })
})
afterAll(async () => {
  await server?.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('WP315 看数据（服务进程）', () => {
  it('建工坊日报 → 导出 → 入库 → 种日报定时', async () => {
    const position = await data<{ id: string }>(
      await call('POST', '/v1/org/positions', {
        name: '投放',
        roles: [{ role_id: 'ads.google', default: true }],
      }),
    )
    await data(
      await call('POST', '/v1/assignments', {
        person_id: server.bootstrap.ownerAssignment.person_id,
        position_id: position.id,
        ranges: [],
        range_groups: [],
      }),
    )
    const ws = server.bootstrap.workspace.id
    const brand = await server.brands.forWorkspace(ws)
    const ads = brand.adsData
    if (ads === undefined) throw new Error('没装看数据')
    expect(ads.wanted()).toEqual(['google'])
    // 定时跟着分配建（后台同步，等一下）
    for (
      let i = 0;
      i < 50 && server.schedule.scheduler.get('sched_ads_daily_export') === undefined;
      i += 1
    )
      await settle()
    expect(server.schedule.scheduler.get('sched_ads_daily_export')?.handler).toBe(
      'ads.daily_export',
    )

    // 没设账户：一拍不做；设好、插件配对、勾风险告知
    expect((await ads.tick()).skipped).toBe('no_account')
    await ads
      .setupTarget()
      .apply({ google: 'https://ads.google.com/aw/overview?ocid=42&__c=1234567890' })
    const pairing = await data<{ code: string }>(await call('POST', '/v1/extension/pairings', {}))
    const { token } = await data<{ token: string }>(
      await server.gateway.fetch(
        new Request('http://127.0.0.1/v1/extension/pair', {
          method: 'POST',
          headers: { Origin: EXT_ORIGIN, 'content-type': 'application/json' },
          body: JSON.stringify({ code: pairing.code }),
        }),
      ),
    )
    await data(
      await plugin('/v1/extension/ads-consent', token, {
        method: 'POST',
        body: { platform: 'google_ads', text_version: ADS_CONSENT_TEXT_VERSION },
      }),
    )
    const next = async (): Promise<ActionJob | undefined> =>
      (
        await data<{ job?: ActionJob }>(
          await plugin('/v1/extension/actions/next?platforms=google_ads&wait=0', token),
        )
      ).job

    // 一拍：排「建工坊日报」，审批编号是 L3 告知卡
    expect((await ads.tick()).queued).toHaveLength(1)
    const setup = await next()
    expect(setup?.plan.kind).toBe('setup_daily_report')
    const notice = await server.approvals.get(setup?.approval_id as string)
    // 告知卡（与 org.ts「范围变了」同一个做法：L3、只通知；活已经排上，不等它）
    expect(notice).toMatchObject({
      kind: 'policy_change',
      payload: { form: 'ads_report_setup' },
      automation: { level_at_creation: 'L3' },
    })
    await data(
      await plugin(`/v1/extension/actions/${setup?.id}/result`, token, {
        method: 'POST',
        body: { outcome: 'done', message: '建好了', step: 10, reads: {} },
      }),
    )
    await settle()

    // 建好马上导一次：插件下到本机（这里写一份手写样例）、报路径、交回
    const exp = await next()
    expect(exp?.plan.kind).toBe('export_daily_report')
    const path = join(dir, '工坊日报 · 广告系列.csv')
    writeFileSync(
      path,
      'Day,Campaign,Campaign ID,Campaign status,Budget,Currency code,Cost,Impr.,Clicks,Conversions,Conv. value\n' +
        '2026-10-14,Spring Sale,111,Enabled,200.00,USD,90.00,1800,30,0,0.00\n',
    )
    await data(
      await plugin(`/v1/extension/actions/${exp?.id}/download`, token, {
        method: 'POST',
        body: { tag: 'report', path, name: '工坊日报 · 广告系列.csv', bytes: 100 },
      }),
    )
    await settle()
    await data(
      await plugin(`/v1/extension/actions/${exp?.id}/result`, token, {
        method: 'POST',
        body: { outcome: 'done', message: '导好了', step: 25, reads: {} },
      }),
    )
    await settle()
    expect(ads.status()[0]).toMatchObject({
      setup: 'done',
      last_import: { source: 'plugin', rows: 1 },
    })
    expect(brand.ads.campaign('google:1234567890:111')?.metrics).toMatchObject({
      spend: 90,
      clicks: 30,
    })

    // 第一次有数：开了「广告日报」、种了一条每天的官方定时；提示词里有「发布」→ 先出卡（批了才开始）
    const task = server.schedule.scheduler
      .list({ workspace_id: ws })
      .find((t) => t.handler === 'automation.reminder' && t.title === '广告日报')
    expect(task).toBeDefined()
    expect(task?.params?.awaiting_approval).toBe(true)
    expect(brand.work.getMatter(task?.origin?.conversation_id as never)?.title).toBe('广告日报')
  })
})

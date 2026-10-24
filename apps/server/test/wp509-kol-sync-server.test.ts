/**
 * WP509：红人同步到飞书表 × **真服务进程**（落盘、stub）——卡被决定的那一跳接到同步上、`/v1/kol/sync` 看 / 停 / 现在同步、
 * 插件「数据同步」那一格 `GET /v1/extension/sync-status`、工具在红人职责上能调到、铃铛里「同步停了」。
 *
 * ego 是注入的假 ego（进程内 Playwright，本机假飞书）；不起真 ego、不联网、不碰真飞书。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Assignment } from '@agentsws/contracts'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { runEgoRead } from '../src/ego-read/runner.js'
import { runEgoSheetWrite } from '../src/kol-sync/runner.js'
import type { KolSyncEgo } from '../src/kol-sync/service.js'
import { SECRETS_KEY_ENV } from '../src/secret-store.js'
import { createServer, type Server } from '../src/server.js'
import { launchChromium, playwrightEgo } from './fixtures/fake-ego-playwright.js'
import { type FakeFeishu, startFakeFeishu } from './fixtures/fake-feishu.js'

vi.setConfig({ testTimeout: 180_000, hookTimeout: 120_000 })

const ROOT = resolve(import.meta.dirname, '../../..')
const EXT_ORIGIN = 'chrome-extension://mlbfinfiigagllemohnopbhfdghagijg'
const T0 = Date.parse('2026-10-24T02:00:00.000Z')
let t = T0
let server: Server
let dir: string
let kolAsg: Assignment
let browser: Awaited<ReturnType<typeof launchChromium>>
let fake: FakeFeishu
let egoOn = true

beforeAll(async () => {
  browser = await launchChromium(ROOT)
  fake = await startFakeFeishu({
    srvBase01: {
      kind: 'bitable',
      title: '红人合作表',
      fields: [
        { name: '红人', type: 1 },
        { name: '主页链接', type: 15 },
        { name: '合作状态', type: 3, options: ['已联系', '谈价中', '寄样中'] },
      ],
      rows: [
        ['', '', ''],
        ['', '', ''],
      ],
    },
    srvLogin1: {
      kind: 'bitable',
      title: 'x',
      fields: [{ name: '红人', type: 1 }],
      rows: [],
      gate: 'login',
    },
  })
})
afterAll(async () => {
  await fake?.close()
  await browser?.close()
})

const call = async (path: string, init: RequestInit & { plugin?: string; owner?: true } = {}) => {
  const headers = new Headers(init.headers)
  if (init.plugin !== undefined) {
    headers.set('Origin', EXT_ORIGIN)
    if (init.plugin !== '') headers.set('Authorization', `Bearer ${init.plugin}`)
  } else {
    headers.set('Authorization', `Bearer ${server.bootstrap.internalToken}`)
    headers.set(
      'X-Assignment',
      init.owner === true ? server.bootstrap.ownerAssignment.id : kolAsg.id,
    )
  }
  if (init.body !== undefined) headers.set('content-type', 'application/json')
  return server.gateway.fetch(new Request(`http://127.0.0.1${path}`, { ...init, headers }))
}
const data = async <T>(res: Response): Promise<T> => {
  const json = (await res.json()) as { data: T; message?: string }
  if (!res.ok) throw new Error(`${res.status} ${json.message ?? ''}`)
  return json.data
}

async function pairPlugin(): Promise<string> {
  const made = await data<{ code: string }>(
    await call('/v1/extension/pairings', { method: 'POST', body: '{}', owner: true }),
  )
  const issued = await data<{ token: string }>(
    await call('/v1/extension/pair', {
      method: 'POST',
      plugin: '',
      body: JSON.stringify({ code: made.code }),
    }),
  )
  return issued.token
}

beforeEach(async () => {
  t = T0
  egoOn = true
  dir = mkdtempSync(join(tmpdir(), 'wp509-sync-'))
  const pw = playwrightEgo(browser, {
    rewrite: (u) => {
      const url = new URL(u)
      return `${fake.origin}${url.pathname}${url.search}`
    },
  })
  const kolSheetEgo: KolSyncEgo = {
    available: () => egoOn,
    read: (c) => runEgoRead({ egoPath: '/fake/ego', call: c, spawn: pw.spawn }),
    write: (c) => runEgoSheetWrite({ egoPath: '/fake/ego', call: c, spawn: pw.spawn }),
  }
  server = await createServer({
    dbDir: dir,
    quiet: true,
    clock: { now: () => new Date(t).toISOString() },
    env: { [SECRETS_KEY_ENV]: 'e'.repeat(64), AGENTSWS_OWNER_EMAIL: 'owner@example.com' },
    tokenRefreshIntervalMs: 0,
    scheduleIntervalMs: 0,
    startRun: false,
    kolSheetEgo,
  })
  kolAsg = server.roles.assignments.create({
    person_id: server.bootstrap.person.id,
    workspace_id: server.bootstrap.workspace.id,
    granted_by: server.bootstrap.person.id,
    ranges: [{ kind: 'store' as const, id: 'store_1' }],
    role_id: 'kol.youtube',
  })
})
afterEach(async () => {
  await server?.close()
  rmSync(dir, { recursive: true, force: true })
})

const brand = () => server.brands.forWorkspace(server.bootstrap.workspace.id)

describe('WP509 × 真服务', () => {
  it('卡被决定 → 同步生效、第一批写进表尾空行；/v1/kol/sync 看 / 停；插件「数据同步」那一格', async () => {
    const b = await brand()
    const sync = b.kolSheetSync
    if (sync === undefined) throw new Error('本机档该有红人同步')
    b.kol.saveCreator({ id: 'cre_d', display_name: 'Desk Fixture', merged_from: [] })
    b.kol.saveAccount({
      id: 'pa_d',
      creator_id: 'cre_d',
      channel: 'youtube',
      handle: 'deskfixture',
      url: 'https://www.youtube.com/@deskfixture',
      followers: 48000,
      observed_at: new Date(t).toISOString(),
    })
    b.kol.saveCollaboration({
      id: 'col_d',
      creator_id: 'cre_d',
      channel: 'youtube',
      stage: 'negotiating',
      currency: 'USD',
    })

    // 插件那一格：还没配
    const token = await pairPlugin()
    const before = await data<{ configured: boolean; feishu: boolean; setup_path: string }>(
      await call('/v1/extension/sync-status', { plugin: token }),
    )
    expect(before).toMatchObject({
      configured: false,
      feishu: false,
      google_sheets: false,
      setup_path: '/influencer/sync',
    })

    const actor = {
      workspace_id: server.bootstrap.workspace.id,
      person_id: server.bootstrap.person.id,
      assignment_id: kolAsg.id,
      role_id: 'kol.youtube',
    } as never
    const got = await sync.propose(actor, {
      url: 'https://example.feishu.cn/base/srvBase01?table=tbl1',
    })
    expect(got.ok, got.message).toBe(true)
    const card = await server.approvals.get(got.card_id as string)
    expect(card?.payload).toMatchObject({ form: 'kol_sync', key_column: '主页链接' })

    // 工作台里点「开始同步」（选项 start + 卡上那一份）
    const decided = await call(`/v1/approvals/${got.card_id}/decide`, {
      method: 'POST',
      body: JSON.stringify({
        action: 'approve',
        selected_option_id: 'start',
        edited_payload: card?.payload,
        via: 'workstation',
      }),
    })
    expect(decided.status, await decided.clone().text()).toBe(200)
    await vi.waitFor(
      async () => {
        const list = await data<{ syncs: { last_ok_at?: string }[] }>(await call('/v1/kol/sync'))
        expect(list.syncs[0]?.last_ok_at).toBeDefined()
      },
      { timeout: 120_000, interval: 300 },
    )
    expect(fake.table('srvBase01').rows[0]).toEqual([
      'Desk Fixture',
      'https://www.youtube.com/@deskfixture',
      '谈价中',
    ])

    const list = await data<{ syncs: { id: string; state: string; name: string }[]; ego: boolean }>(
      await call('/v1/kol/sync'),
    )
    expect(list).toMatchObject({ ego: true, syncs: [{ state: 'active', name: '红人合作表' }] })
    const id = list.syncs[0]?.id as string
    const log = await data<{ rows: { trigger: string; appended: number }[] }>(
      await call(`/v1/kol/sync/${id}/log`),
    )
    expect(log.rows[0]).toMatchObject({ trigger: 'first', appended: 1 })

    const st = await data<{
      configured: boolean
      feishu: boolean
      name: string
      last_sync_at?: string
    }>(await call('/v1/extension/sync-status', { plugin: token }))
    expect(st).toMatchObject({ configured: true, feishu: true, name: '红人合作表' })
    expect(st.last_sync_at).toBeDefined()

    const paused = await data<{ state: string }>(
      await call(`/v1/kol/sync/${id}/pause`, { method: 'POST', body: '{}' }),
    )
    expect(paused.state).toBe('paused')
    expect((await call(`/v1/kol/sync/${id}/explode`, { method: 'POST', body: '{}' })).status).toBe(
      400,
    )
    expect((await call('/v1/kol/sync/nope/log')).status).toBe(404)
    const removed = await data<{ removed: boolean }>(
      await call(`/v1/kol/sync/${id}`, { method: 'DELETE' }),
    )
    expect(removed.removed).toBe(true)
  })

  it('读不了照实说：ego 里没登录飞书 / ego 用不了（不出卡）', async () => {
    const b = await brand()
    const sync = b.kolSheetSync
    if (sync === undefined) throw new Error('本机档该有红人同步')
    const actor = {
      workspace_id: server.bootstrap.workspace.id,
      person_id: server.bootstrap.person.id,
      assignment_id: kolAsg.id,
      role_id: 'kol.youtube',
    } as never
    const login = await sync.propose(actor, {
      url: 'https://example.feishu.cn/base/srvLogin1?table=tbl1',
    })
    expect(login.ok).toBe(false)
    expect(login.message).toContain('登录')
    egoOn = false
    const off = await sync.propose(actor, {
      url: 'https://example.feishu.cn/base/srvBase01?table=tbl1',
    })
    expect(off.message).toContain('ego 这会儿用不了')
    const cards = await server.approvals.queue({
      workspace_id: server.bootstrap.workspace.id,
      person_id: server.bootstrap.person.id,
      lane: 'mine',
    })
    expect(cards.filter((c) => c.proposer.id === 'kol-sync')).toHaveLength(0)
  })

  it('（顺手修的）WP489 导入红人表的卡在真服务里点了「导入」真导进去——这一跳原来没接到卡片总线上', async () => {
    const b = await brand()
    const imp = b.kolImport
    if (imp === undefined) throw new Error('该有表格导入')
    const actor = {
      workspace_id: server.bootstrap.workspace.id,
      person_id: server.bootstrap.person.id,
      assignment_id: kolAsg.id,
      role_id: 'kol.youtube',
    } as never
    const csv = '名字,主页链接,状态\nRosa Desk,https://www.youtube.com/@rosadesk,谈价中\n'
    await imp.previewCard(actor, {
      filename: '红人.csv',
      content_base64: Buffer.from(csv).toString('base64'),
    })
    const cards = await server.approvals.queue({
      workspace_id: server.bootstrap.workspace.id,
      person_id: server.bootstrap.person.id,
      lane: 'mine',
    })
    const card = cards.find((c) => c.proposer.id === 'kol-import')
    if (card === undefined) throw new Error('没出导入卡')
    const res = await call(`/v1/approvals/${card.id}/decide`, {
      method: 'POST',
      body: JSON.stringify({ action: 'approve', selected_option_id: 'import', via: 'workstation' }),
    })
    expect(res.status, await res.clone().text()).toBe(200)
    await vi.waitFor(
      () => expect(b.kol.creators().map((c) => c.display_name)).toContain('Rosa Desk'),
      {
        timeout: 20_000,
      },
    )
  })
})

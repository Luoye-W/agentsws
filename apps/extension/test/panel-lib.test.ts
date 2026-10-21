/**
 * WP413：侧边栏后台那一半与几句短话（不联网：本机服务是假的 fetch；不碰 `chrome.*`：权限是替身）。
 *
 * - 点图标：三个红人平台照旧开 / 关页面面板；别的页面同步打开侧边栏；打不开退回设置页；执行器等授权时只当授权；
 * - 后台：没配对 / 工坊没开 / 令牌不认分开说；「填进页面」成功马上去领活；本机回的 409 原话照印；
 * - 短话：每块一行、条数、下次几点、写的状态。
 */
import type { PanelSnapshot } from '@agentsws/browser-action'
import { describe, expect, it, vi } from 'vitest'
import { isKolPage, onActionClick } from '../src/lib/action-click'
import type { PermissionsLike } from '../src/lib/ads/permissions'
import {
  ONE_AT_A_TIME,
  panelDropWrite,
  panelFillCard,
  panelOpenWrite,
  panelSkipCard,
  panelState,
  panelUndoFollow,
} from '../src/lib/panel/broker'
import { clock, nextLine, partLine, progressHead, writeLine } from '../src/lib/panel/format'
import { memoryStore, SETTINGS_KEY } from '../src/lib/storage'

const perms = (granted: boolean): PermissionsLike => ({
  contains: async () => granted,
  request: async () => granted,
  remove: async () => true,
})

const snapshot: PanelSnapshot = {
  at: '2026-10-18T02:00:00.000Z',
  can_act: true,
  progress: { configured: true, reading: false, drafting: 1, pending: 2 },
  cards: [],
  writes: [],
  records: [],
  sinks: [],
}

function local(routes: Record<string, { status: number; body: unknown }>) {
  const calls: { method: string; path: string; body?: unknown; auth?: string | undefined }[] = []
  const fetch = (async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname
    calls.push({
      method: init.method ?? 'GET',
      path,
      ...(init.body === undefined ? {} : { body: JSON.parse(String(init.body)) }),
      auth: (init.headers as Record<string, string>).Authorization,
    })
    const hit = routes[`${init.method ?? 'GET'} ${path}`]
    if (hit === undefined) throw new Error('ECONNREFUSED')
    return new Response(JSON.stringify(hit.body), { status: hit.status })
  }) as unknown as typeof globalThis.fetch
  return { fetch, calls }
}

const paired = () => memoryStore({ [SETTINGS_KEY]: { port: 4317, token: 'tok_1' } })

describe('点工具栏图标', () => {
  const deps = () => ({
    noteActionClick: vi.fn(() => false),
    togglePanel: vi.fn(async () => undefined),
    openSidePanel: vi.fn(async () => undefined),
    openOptions: vi.fn(),
  })
  it('红人平台照旧开 / 关面板；别的页面同步打开侧边栏（不先 await）', () => {
    expect(isKolPage('https://www.youtube.com/@x')).toBe(true)
    expect(isKolPage('https://m.tiktok.com/@x')).toBe(true)
    expect(isKolPage('https://www.reddit.com/r/x')).toBe(false)
    expect(isKolPage('https://notyoutube.com/')).toBe(false)
    const d = deps()
    expect(onActionClick({ id: 1, windowId: 9, url: 'https://www.youtube.com/@x' }, d)).toBe('kol')
    expect(d.togglePanel).toHaveBeenCalledWith(1)
    expect(onActionClick({ id: 2, windowId: 9, url: 'https://www.reddit.com/' }, d)).toBe('side')
    // 同一拍里就调了（用户手势还在）
    expect(d.openSidePanel).toHaveBeenCalledWith(9)
    expect(onActionClick({ id: 3, windowId: 9 }, d)).toBe('side')
  })
  it('执行器等截图授权：只当授权；打不开侧边栏 / 没窗口：退回设置页', async () => {
    const d = deps()
    d.noteActionClick.mockReturnValueOnce(true)
    expect(onActionClick({ id: 1, windowId: 9, url: 'https://ads.google.com/' }, d)).toBe('capture')
    expect(d.openSidePanel).not.toHaveBeenCalled()
    expect(onActionClick({ id: 1 }, d)).toBe('options')
    d.openSidePanel.mockRejectedValueOnce(new Error('no side panel'))
    onActionClick({ id: 1, windowId: 9, url: 'https://example.com/' }, d)
    await new Promise((r) => setTimeout(r, 0))
    expect(d.openOptions).toHaveBeenCalledTimes(2)
  })
})

describe('侧边栏后台', () => {
  it('没配对 → unpaired（不打本机）；工坊没开 → offline；令牌不认 → unauthorized', async () => {
    const none = local({})
    expect(
      await panelState({
        store: memoryStore(),
        perms: perms(true),
        fetch: none.fetch,
        pollNow: () => {},
      }),
    ).toEqual({
      kind: 'unpaired',
    })
    expect(none.calls).toEqual([])
    expect(
      (
        await panelState({
          store: paired(),
          perms: perms(true),
          fetch: none.fetch,
          pollNow: () => {},
        })
      ).kind,
    ).toBe('offline')
    const denied = local({ 'GET /v1/extension/panel': { status: 401, body: {} } })
    expect(
      (
        await panelState({
          store: paired(),
          perms: perms(true),
          fetch: denied.fetch,
          pollNow: () => {},
        })
      ).kind,
    ).toBe('unauthorized')
  })
  it('快照带上「这个 Chrome 连没连 Reddit」；令牌只发给本机', async () => {
    const l = local({
      'GET /v1/extension/panel': { status: 200, body: { ok: true, data: snapshot } },
    })
    const out = await panelState({
      store: paired(),
      perms: perms(false),
      fetch: l.fetch,
      pollNow: () => {},
    })
    expect(out).toEqual({ kind: 'ok', snapshot, reddit_here: false })
    expect(l.calls[0]?.auth).toBe('Bearer tok_1')
  })
  it('WP432 批准并打开：批了就是人这一下点的「打开」——从本机拿那一件、在这个窗口开；不去定时领活；409 原话照印', async () => {
    const write = {
      job_id: 'aj_1',
      approval_item_id: 'ap_1',
      state: 'awaiting',
      subreddit: 'x',
      queued_at: '',
    }
    const job = { id: 'aj_1', plan: { platform: 'reddit' } }
    const l = local({
      'POST /v1/extension/panel/cards/ap_1/fill': {
        status: 200,
        body: { ok: true, data: { ok: true, write } },
      },
      'POST /v1/extension/panel/writes/aj_1/open': {
        status: 200,
        body: { ok: true, data: { ok: true, job, write: { ...write, state: 'queued' } } },
      },
      'POST /v1/extension/panel/cards/ap_2/fill': {
        status: 409,
        body: {
          ok: false,
          error: { code: 'conflict', message: '这张卡已经处理过了（在工坊里或另一处）。' },
        },
      },
      'POST /v1/extension/panel/cards/ap_1/skip': {
        status: 200,
        body: { ok: true, data: { ok: true } },
      },
    })
    const pollNow = vi.fn()
    const runJob = vi.fn(async () => ({ ok: true }))
    const d = { store: paired(), perms: perms(true), fetch: l.fetch, pollNow, runJob }
    expect(await panelFillCard(d, 'ap_1', { text: 'edited', version: 1 }, 7)).toEqual({
      ok: true,
      write: { ...write, state: 'queued' },
    })
    expect(l.calls[0]?.body).toEqual({ text: 'edited', version: 1 })
    expect(runJob).toHaveBeenCalledWith(job, 7)
    expect(pollNow).not.toHaveBeenCalled()
    expect(await panelFillCard(d, 'ap_2', {})).toEqual({
      ok: false,
      message: '这张卡已经处理过了（在工坊里或另一处）。',
    })
    expect(runJob).toHaveBeenCalledTimes(1)
    expect(await panelSkipCard(d, 'ap_1', 3)).toEqual({ ok: true })
    expect(l.calls.at(-1)?.body).toEqual({ version: 3 })
  })

  it('WP432 打开这一条：上一条还开着就不去本机拿（不让那一件卡在「开着」）；不发了照实回（WP445 新版旧版开关去掉了）', async () => {
    const l = local({
      'POST /v1/extension/panel/writes/aj_1/open': {
        status: 200,
        body: { ok: true, data: { ok: true, job: { id: 'aj_1' } } },
      },
      'POST /v1/extension/panel/writes/aj_1/drop': {
        status: 200,
        body: { ok: true, data: { ok: true } },
      },
    })
    const runJob = vi.fn(async () => ({ ok: true }))
    const busy = { now: true }
    const d = {
      store: paired(),
      perms: perms(true),
      fetch: l.fetch,
      pollNow: () => {},
      runJob,
      busy: () => busy.now,
    }
    expect(await panelOpenWrite(d, 'aj_1', {}, 3)).toEqual({ ok: false, message: ONE_AT_A_TIME })
    expect(l.calls).toEqual([])
    busy.now = false
    expect(await panelOpenWrite(d, 'aj_1', { text: 'edited' }, 3)).toEqual({ ok: true })
    expect(l.calls[0]?.body).toEqual({ text: 'edited' })
    expect(runJob).toHaveBeenCalledWith({ id: 'aj_1' }, 3)
    expect(await panelDropWrite(d, 'aj_1', '时机不对')).toEqual({ ok: true })
    expect(l.calls.at(-1)?.body).toEqual({ reason: '时机不对' })
    expect(l.calls.some((c) => c.path.includes('/settings'))).toBe(false)
  })

  it('WP445 不发 + 理由：带上理由；同类的一并不发了照实带回；撤回那几张', async () => {
    const l = local({
      'POST /v1/extension/panel/cards/ap_1/skip': {
        status: 200,
        body: {
          ok: true,
          data: { ok: true, followed: { leader_id: 'ap_1', ids: ['ap_2'], titles: ['回复 bob'] } },
        },
      },
      'POST /v1/extension/panel/cards/ap_1/follow/undo': {
        status: 200,
        body: { ok: true, data: { restored: 1 } },
      },
    })
    const d = { store: paired(), perms: perms(true), fetch: l.fetch, pollNow: () => {} }
    expect(await panelSkipCard(d, 'ap_1', 2, ' 不相关 ')).toEqual({
      ok: true,
      followed: { leader_id: 'ap_1', ids: ['ap_2'], titles: ['回复 bob'] },
    })
    expect(l.calls.at(-1)?.body).toEqual({ version: 2, reason: '不相关' })
    expect(await panelUndoFollow(d, 'ap_1', ['ap_2'])).toEqual({ ok: true })
    expect(l.calls.at(-1)?.body).toEqual({ ids: ['ap_2'] })
  })
})

describe('几句短话', () => {
  const now = new Date(2026, 9, 18, 15, 0)
  it('时间按本地说：今天只说钟点、昨天 / 明天、更远带日期', () => {
    expect(clock(new Date(2026, 9, 18, 9, 5).toISOString(), now)).toBe('09:05')
    expect(clock(new Date(2026, 9, 17, 21, 5).toISOString(), now)).toBe('昨天 21:05')
    expect(clock(new Date(2026, 9, 19, 9, 0).toISOString(), now)).toBe('明天 09:00')
    expect(clock(new Date(2026, 9, 11, 9, 0).toISOString(), now)).toBe('10-11 09:00')
  })
  it('进度：没设好 / 在读 / 几点读完；下次；每块条数', () => {
    const p = { configured: true, reading: false, drafting: 0, pending: 0 }
    expect(progressHead({ ...p, configured: false }, now)).toBe('巡查还没设好')
    expect(progressHead({ ...p, reading: true }, now)).toBe('正在读…')
    expect(progressHead(p, now)).toBe('还没读过')
    expect(
      progressHead(
        {
          ...p,
          last_run: {
            started_at: '',
            finished_at: new Date(2026, 9, 18, 9, 52).toISOString(),
            trigger: 'schedule',
            parts: [],
            pending: 0,
          },
        },
        now,
      ),
    ).toBe('09:52 读完')
    expect(nextLine({ ...p, next_run_at: new Date(2026, 9, 19, 9, 0).toISOString() }, now)).toBe(
      '下次约 明天 09:00',
    )
    expect(partLine({ part: 'inbox', status: 'ok', fetched: 7, fresh: 2 })).toBe('7 条 · 新 2')
    expect(
      partLine({ part: 'external', status: 'failed', fetched: 0, fresh: 0, message: '被拦了' }),
    ).toBe('没读成')
  })
  it('写：排着 / 填好了等你点 / 已发 · 已记录 / 没发出去照实说', () => {
    const w = { job_id: 'a', approval_item_id: 'b', subreddit: 'x', queued_at: '' }
    expect(writeLine({ ...w, state: 'queued' })).toBe('正在打开 Reddit…')
    expect(writeLine({ ...w, state: 'filling' })).toBe('填好了，看一眼，自己点发送')
    expect(writeLine({ ...w, state: 'sent', record_id: 'ob_1' })).toBe('已发 · 已记录')
    expect(writeLine({ ...w, state: 'failed', message: '没登录 Reddit' })).toBe('没登录 Reddit')
  })
})

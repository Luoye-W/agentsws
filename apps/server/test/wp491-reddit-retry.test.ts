/**
 * WP491（Luoye 10-23，Windows beta.13）：Reddit 没发出去那一行——
 *
 * | 钉的是什么 | 为什么 |
 * |---|---|
 * | 「再填一次」与出卡同一个选路：ego 能用 → 工坊自己在 ego 里发（`via: 'ego'`），不交插件 | 原来写死交给插件，插件没开就像「没反应」 |
 * | ego 要、但这会儿用不了 → 交给插件，照实一句；没要 ego（选了别的浏览器）→ 悄悄交插件 | 照实说、少字 |
 * | 插件侧边栏里点的「再填一次」照旧交给插件 | 人就在插件里 |
 * | 「修改」= 还原成原来那张审核卡（新开一项、`links.supersedes` 指原项、带上次的字），提醒条收起；批了按选路发、留痕连续 | 重走审核 |
 *
 * ego 是注入的假手（按剧本回结果），插件是本机内存那一份替身；不起 ego、不联网、什么都没真发。
 */

import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ApprovalItem, EgoWriteResult, PersonId, WorkspaceId } from '@agentsws/contracts'
import { isPluginDeskCard, redditWriteNotices } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import { memoryEvidenceStore } from '../src/ads-actions/evidence-store.js'
import { createAdsActionsService } from '../src/ads-actions/service.js'
import type { EgoWriteCall } from '../src/ego-write/writer.js'
import { createRedditWriteService } from '../src/reddit-write/service.js'

const WS = 'ws_r491' as WorkspaceId
const T0 = Date.parse('2026-10-23T09:00:00.000Z')
const ME = 'per_me' as PersonId
const actor = {
  workspace_id: WS,
  person_id: ME,
  assignment_id: 'asg_1',
  role_id: 'social.reddit',
} as never
const target = {
  kind: 'reply' as const,
  subreddit: 'ivraxr',
  parent_fullname: 't1_c1',
  permalink: '/r/ivraxr/comments/abc/slug/c1/',
  parent_author: 'alice',
  parent_text: 'Fogs up with glasses.',
}

const SENT: Partial<EgoWriteResult> = {
  state: 'sent',
  link: 'https://www.reddit.com/r/ivraxr/comments/abc/slug/c9/',
  external_id: 't1_c9',
  readback: 'link',
  clicked: true,
}

function make(o: { available: boolean; wanted?: boolean; script?: Partial<EgoWriteResult> }) {
  const created: ApprovalItem[] = []
  const emitted: { type: string; payload: Record<string, unknown> }[] = []
  const records: Record<string, unknown>[] = []
  const now = { ms: T0 }
  const ego = { available: o.available, wanted: o.wanted ?? o.available }
  const calls: EgoWriteCall[] = []
  const dir = mkdtempSync(join(tmpdir(), 'wp491-'))
  /** 落盘那一份（看 `previous_jobs` 这类不进视图的留痕）。 */
  const saved = (): { entries: Record<string, unknown>[] } =>
    JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'))
  const actions = createAdsActionsService({
    workspace_id: WS,
    nowMs: () => now.ms,
    evidence: memoryEvidenceStore({ nowMs: () => now.ms }),
    onEvent: (e) => svc.onActionEvent(e),
    wait: async (_ms, woke) => woke,
  })
  const svc = createRedditWriteService({
    workspace_id: WS,
    clock: { now: () => new Date(now.ms).toISOString() },
    approvals: {
      create: async (input) => {
        const item = {
          ...input,
          id: `ap_${created.length + 1}`,
          state: 'pending',
          links: { children: [], ...(input.links ?? {}) },
        } as never
        created.push(item)
        return item
      },
      get: async (id) => created.find((c) => c.id === id),
    },
    emit: (type, _a, payload) => emitted.push({ type, payload }),
    brand: () => 'IVRA',
    actions,
    record: (input) => {
      records.push(input as never)
      return { id: `ob_${records.length}` } as never
    },
    deskCards: () => created.filter((c) => isPluginDeskCard(c)),
    dir,
    ego: {
      available: () => ego.available,
      wanted: () => ego.wanted,
      run: async (cfg) => {
        calls.push(cfg as EgoWriteCall)
        return { platform: cfg.platform, state: 'failed', ...(o.script ?? SENT) }
      },
    },
  })
  const approveAndDeliver = async (card: ApprovalItem, text?: string) =>
    svc.deliver({
      ...card,
      state: text === undefined ? 'approved' : 'approved_edited',
      decision: {
        by: ME,
        at: new Date(now.ms).toISOString(),
        ...(text === undefined
          ? {}
          : {
              edited_payload: {
                ...(card.payload as object),
                body: { ...(card.payload as { body: object }).body, text },
              },
            }),
      },
    } as never)
  /** 插件那一路批了、7 天没在插件里打开 → 没发出去（`expired`）。 */
  const failInPlugin = async (): Promise<string> => {
    await svc.stage(actor, { target, text: 'Hi Alice!' })
    await approveAndDeliver(created[created.length - 1] as ApprovalItem)
    now.ms += 7 * 24 * 60 * 60 * 1000 + 1
    await actions.sweep()
    const row = svc.writes()[0]
    expect(row).toMatchObject({ state: 'failed', can_refill: true })
    return row?.job_id as string
  }
  const iso = (): string => new Date(now.ms).toISOString()
  return {
    saved,
    svc,
    created,
    emitted,
    records,
    now,
    actions,
    ego,
    calls,
    approveAndDeliver,
    failInPlugin,
    iso,
  }
}

describe('WP491「再填一次」按当前选路', () => {
  it('ego 能用：交给工坊在 ego 里发（via ego，不进插件），点了就有「在 ego 里发」，读回记「已发」', async () => {
    const m = make({ available: false, wanted: false })
    const first = await m.failInPlugin()
    m.ego.available = true
    const jobsBefore = m.actions.jobs().length
    const out = await m.svc.refill(first)
    expect(out.ok).toBe(true)
    const view = (out as { view: Record<string, unknown> }).view
    // 点了马上看得到：走 ego、正在发
    expect(view).toMatchObject({ state: 'queued', route: 'ego', refills: 1 })
    expect(view.job_id).not.toBe(first)
    expect(m.emitted.find((e) => e.type === 'reddit.write_refilled')?.payload).toMatchObject({
      route: 'ego',
    })
    await m.svc.idle()
    expect(m.calls).toHaveLength(1)
    expect(m.calls[0]).toMatchObject({ platform: 'reddit-reply', mode: 'write', submit: true })
    expect(m.svc.writes()[0]).toMatchObject({ state: 'sent', route: 'ego' })
    expect(m.records[0]).toMatchObject({ content: 'Hi Alice!', external_id: 't1_c9' })
    // 插件那边没再排新活
    expect(m.actions.jobs().length).toBe(jobsBefore)
  })

  it('ego 要、但这会儿用不了：交给插件「等你发」，照实一句', async () => {
    const m = make({ available: false, wanted: true })
    const first = await m.failInPlugin()
    const out = await m.svc.refill(first)
    expect(out.ok).toBe(true)
    const view = (out as { view: Record<string, unknown> }).view
    expect(view).toMatchObject({ state: 'awaiting' })
    expect(view.route).toBeUndefined()
    expect(view.message).toContain('ego 这会儿用不了')
    expect(view.route_note).toContain('ego 这会儿用不了')
    expect(m.calls).toHaveLength(0)
  })

  it('没要 ego（浏览器选了别的）：悄悄交给插件，不提 ego', async () => {
    const m = make({ available: false, wanted: false })
    const first = await m.failInPlugin()
    const out = await m.svc.refill(first)
    const view = (out as { view: Record<string, unknown> }).view
    expect(view).toMatchObject({ state: 'awaiting' })
    expect(view.route_note).toBeUndefined()
    expect(String(view.message ?? '')).not.toContain('ego')
  })

  it('ego 那一路被平台拦停下的，人点再填一次：ego 能用就还在 ego 里（新的一趟），留痕接着记', async () => {
    const m = make({ available: true, script: { state: 'blocked', why: 'captcha' } })
    await m.svc.stage(actor, { target, text: 'Hi Alice!' })
    await m.approveAndDeliver(m.created[0] as ApprovalItem)
    await m.svc.idle()
    const row = m.svc.writes()[0]
    expect(row).toMatchObject({ state: 'failed', outcome: 'blocked', can_refill: true })
    const out = await m.svc.refill(row?.job_id as string)
    expect((out as { view: Record<string, unknown> }).view).toMatchObject({
      state: 'queued',
      route: 'ego',
    })
    await m.svc.idle()
    expect(m.calls).toHaveLength(2)
    // 还在 ego 里跑的那一趟不能再填（等它做完）
    expect(m.actions.jobs()).toHaveLength(0)
  })

  it('插件侧边栏里点的再填一次：交给插件（人就在插件里）', async () => {
    const m = make({ available: false, wanted: false })
    const first = await m.failInPlugin()
    m.ego.available = true
    const out = await m.svc.refill(first, undefined, { route: 'plugin' })
    expect((out as { view: Record<string, unknown> }).view).toMatchObject({ state: 'awaiting' })
    expect(m.calls).toHaveLength(0)
  })
})

describe('WP491「修改」= 还原成原来那张审核卡', () => {
  it('还原出原卡（同一个卡面、带上次的字、工坊里审），提醒条收起；改字批了按选路走 ego，留痕连续', async () => {
    const m = make({ available: false, wanted: false })
    const first = await m.failInPlugin()
    const orig = m.created[0] as ApprovalItem
    m.ego.available = true
    m.ego.wanted = true
    const out = await m.svc.revise(actor, first)
    expect(out).toMatchObject({ ok: true, approval_item_id: 'ap_2', route: 'ego' })
    const card = m.created[1] as ApprovalItem
    expect(card.kind).toBe('outbound_draft')
    expect(card.title).toBe(orig.title)
    expect(card.links).toMatchObject({ supersedes: orig.id })
    expect(card.routing.recipients).toEqual([{ person: ME, via: 'role_holder' }])
    expect(card.payload).toMatchObject({
      form: 'reddit_write',
      reddit: { kind: 'reply', parent_fullname: 't1_c1', parent_author: 'alice' },
      body: { text: 'Hi Alice!' },
      desk: 'workshop',
      route: 'ego',
      revises: { approval_item_id: orig.id, job_id: first },
    })
    // 在工坊里审（不是插件里那一种）
    expect(isPluginDeskCard(card)).toBe(false)
    // 那一行收起，不能再填 / 再修改
    const row = m.svc.writes()[0]
    expect(row).toMatchObject({ revised_to: 'ap_2' })
    expect(row?.can_refill).toBeUndefined()
    expect(redditWriteNotices(m.svc.writes(), m.iso())).toEqual([])
    expect(await m.svc.refill(first)).toMatchObject({ ok: false })
    // 再点一次「修改」不另起一张
    expect(await m.svc.revise(actor, first)).toMatchObject({ ok: true, approval_item_id: 'ap_2' })
    expect(m.created).toHaveLength(2)

    // 卡上改字、批 → 工坊在 ego 里发改过的字
    const res = await m.approveAndDeliver(card, 'Hi Alice, try the anti-fog wipe.')
    expect(res?.execution_id).toMatch(/^reddit_ego_/u)
    await m.svc.idle()
    expect(m.calls[0]?.text).toBe('Hi Alice, try the anti-fog wipe.')
    const w = m.svc.writes()[0] as Record<string, unknown>
    expect(w).toMatchObject({ approval_item_id: 'ap_2', state: 'sent', route: 'ego' })
    expect(m.records[0]).toMatchObject({ content: 'Hi Alice, try the anti-fog wipe.' })
    // 留痕连续：新那一条接着记原来那件活
    const entry = m.saved().entries.find((e) => e.approval_item_id === 'ap_2')
    expect(entry?.previous_jobs).toEqual([first])
  })

  it('批的时候 ego 用不了（但要 ego）：交给插件，照实一句', async () => {
    const m = make({ available: false, wanted: true })
    const first = await m.failInPlugin()
    const out = await m.svc.revise(actor, first)
    expect(out).toMatchObject({ ok: true })
    expect((out as { route?: string }).route).toBeUndefined()
    const card = m.created[1] as ApprovalItem
    expect(card.payload).toMatchObject({ desk: 'workshop' })
    expect((card.payload as { route?: string }).route).toBeUndefined()
    await m.approveAndDeliver(card)
    const w = m.svc.writes()[0]
    expect(w).toMatchObject({ approval_item_id: 'ap_2', state: 'awaiting' })
    expect(w?.route_note).toContain('ego 这会儿用不了')
  })

  it('已经发出去的 / 还在发的 / 找不到的：不还原，照实说', async () => {
    const m = make({ available: true })
    await m.svc.stage(actor, { target, text: 'Hi Alice!' })
    await m.approveAndDeliver(m.created[0] as ApprovalItem)
    const running = m.svc.writes()[0]?.job_id as string
    expect(await m.svc.revise(actor, running)).toMatchObject({ ok: false })
    await m.svc.idle()
    expect(await m.svc.revise(actor, running)).toMatchObject({
      ok: false,
      message: '这一条已经发出去了。',
    })
    expect(await m.svc.revise(actor, 'rdw_nope')).toMatchObject({ ok: false })
  })

  it('原卡不是 Reddit「发出去」卡（社媒回帖卡批出来的）：按进度里记的拼一张', async () => {
    const m = make({ available: false, wanted: false })
    await m.svc.send({
      approval_item_id: 'ap_social',
      write: { kind: 'reply', parent: 't1_c1', permalink: target.permalink },
      text: 'Thanks!',
      subreddit: 'ivraxr',
      record: {
        source_key: 'approval:ap_social',
        channel: 'reddit',
        action: 'reply',
        kind: 'social_reply',
        content: 'Thanks!',
        counterpart: 'bob',
        counterpart_text: 'Love it',
        role_id: 'social.reddit',
      } as never,
      source: { type: 'community_thread', id: 'th_1' },
      label: '回复 bob',
      route: 'auto',
    })
    m.now.ms += 7 * 24 * 60 * 60 * 1000 + 1
    await m.actions.sweep()
    const job = m.svc.writes()[0]?.job_id as string
    const out = await m.svc.revise(actor, job)
    expect(out).toMatchObject({ ok: true })
    const card = m.created[0] as ApprovalItem
    expect(card.title).toBe('回复 bob')
    expect(card.payload).toMatchObject({
      reddit: {
        kind: 'reply',
        parent_fullname: 't1_c1',
        parent_author: 'bob',
        source: { type: 'community_thread', id: 'th_1' },
      },
      body: { text: 'Thanks!' },
      author: 'bob',
      in_reply_to: 'Love it',
      revises: { approval_item_id: 'ap_social' },
    })
  })
})

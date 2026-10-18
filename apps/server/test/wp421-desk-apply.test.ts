/**
 * WP421（自查 general R1 / 2.1 / 2.4）：新闻稿 / 论坛帖 / 内容改动 / 定稿入库 / 设计需求单**批了以后到底做了什么**。
 *
 * 钉住的事：
 *
 * 1. 新闻稿草稿批了 = 定稿（状态「已批」、人改过的正文回写、读回）；发稿卡批了**不标已发**，照实回「没发 + 原因」；
 * 2. 论坛帖批了照实回「没发，请自己去发」；内容改动（没走店铺写法）照实回「店里没改」——都不再回「已执行」；
 * 3. 论坛没读到版规时不再编「版规明写着禁推广」把帖子拦下：照实写「没读到版规」出卡，人判；
 * 4. 设计需求单：建单交给做设计职责的人（开事项 + 待办），定稿入库后交付、回到下单那件事上；没人做照实说。
 */
import type { Assignment, PressRelease } from '@agentsws/contracts'
import { explainRuleCheck } from '@agentsws/pr-core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { deskApply, NOT_WIRED } from '../src/desk-apply.js'
import { createServer, type Server } from '../src/index.js'

const T0 = '2026-10-19T01:00:00.000Z'
const SECRETS_KEY = 'e'.repeat(64)

const release = (over: Partial<PressRelease> = {}): PressRelease => ({
  id: 'prl_1',
  workspace_id: 'ws_1' as never,
  status: 'draft',
  headline: '旧标题',
  dek: '',
  body: '旧正文',
  quotes: [],
  boilerplate: '',
  contact: { name: '', email: '' },
  facts_cited: [],
  created_at: T0,
  updated_at: T0,
  ...over,
})

function memPr() {
  const rows = new Map<string, PressRelease>([['prl_1', release()]])
  const posts = new Map<string, never>()
  return {
    rows,
    store: {
      release: (id: string) => rows.get(id),
      saveRelease: (r: PressRelease) => rows.set(r.id, r),
      post: (id: string) => posts.get(id),
      savePost: (p: never) => posts.set((p as { id: string }).id, p),
    },
  }
}

describe('deskApply：有执行器的真做并读回，做不到的照实说', () => {
  it('新闻稿草稿批了 = 定稿，人改过的正文回写', async () => {
    const pr = memPr()
    const out = await deskApply(
      {
        id: 'chg_1',
        kind: 'press_release',
        workspace_id: 'ws_1' as never,
        target: { type: 'press_release', id: 'prl_1' },
        after: { headline: '新标题', body: '人改过的正文' },
      },
      { pr: pr.store as never, now: () => T0 },
    )
    expect(out?.status).toBe('ok')
    expect(pr.rows.get('prl_1')).toMatchObject({
      status: 'approved',
      headline: '新标题',
      body: '人改过的正文',
    })
  })

  it('发稿卡批了：不标已发，回「没发 + 原因」', async () => {
    const pr = memPr()
    const out = await deskApply(
      {
        id: 'chg_2',
        kind: 'press_release',
        workspace_id: 'ws_1' as never,
        target: { type: 'press_release', id: 'prl_1' },
        after: { distributed: true },
      },
      { pr: pr.store as never, now: () => T0 },
    )
    expect(out).toEqual({
      status: 'failed',
      not_wired: true,
      error: { message: NOT_WIRED.press_distribute, retryable: false },
    })
    expect(pr.rows.get('prl_1')?.status).toBe('approved')
  })

  it('内容改动没走店铺写法：回「店里没改」；走了店铺写法的不碰；Reddit 帖子不碰', async () => {
    const base = { id: 'c', workspace_id: 'ws_1' as never, target: { type: 'page', id: 'u' } }
    for (const kind of [
      'page_seo_edit',
      'page_section_add',
      'internal_link_edit',
      'publish_post',
    ]) {
      const out = await deskApply({ ...base, kind, after: {} } as never, { now: () => T0 })
      expect(out?.status).toBe('failed')
      expect(out?.error?.message).toBe(NOT_WIRED.content)
    }
    expect(
      await deskApply({ ...base, kind: 'page_seo_edit', after: { via: 'shop_admin' } } as never, {
        now: () => T0,
      }),
    ).toBeUndefined()
    expect(
      await deskApply(
        {
          ...base,
          kind: 'community_post',
          target: { type: 'external_post', id: 'ep' },
          after: { platform: 'reddit' },
        } as never,
        { now: () => T0 },
      ),
    ).toBeUndefined()
  })

  it('论坛版规文案：别的平台不加 r/ 前缀', () => {
    const check = { ok: false, reasons: ['no_self_promotion'], checked_at: T0 }
    expect(explainRuleCheck(check, '充电器', 'zhihu')).toContain('zhihu「充电器」')
    expect(explainRuleCheck(check, 'ebikes')).toContain('r/ebikes')
  })
})

// ── 端到端：真进程 ─────────────────────────────────────────────────────────

let server: Server

const assign = (role_id: string): Assignment =>
  server.roles.assignments.create({
    person_id: server.bootstrap.person.id,
    workspace_id: server.bootstrap.workspace.id,
    role_id,
    granted_by: server.bootstrap.person.id,
    ranges: [{ kind: 'brand', id: server.bootstrap.workspace.id }],
  })

describe('端到端（真服务）', () => {
  beforeEach(async () => {
    server = await createServer({
      quiet: true,
      clock: { now: () => T0 },
      random: () => 0.42,
      scheduleIntervalMs: 0,
      tokenRefreshIntervalMs: 0,
      env: { AGENTSWS_OWNER_EMAIL: 'owner@example.com', AGENTSWS_SECRETS_KEY: SECRETS_KEY },
    })
  })
  afterEach(async () => {
    await server.close()
  })

  const actorOf = (a: Assignment) => ({
    workspace_id: server.bootstrap.workspace.id,
    person_id: server.bootstrap.person.id,
    assignment_id: a.id,
    role_id: a.role_id,
  })

  it('论坛没读到版规：不拦、照实写「没读到版规」出卡', async () => {
    const forums = assign('pr.forums')
    const brand = await server.brands.forWorkspace(server.bootstrap.workspace.id)
    const out = await brand.prPort.proposeExternalPost(actorOf(forums) as never, {
      platform: 'zhihu',
      venue: '有哪些好用的氮化镓充电器',
      kind: 'answer',
      body: '我们自己在用这款，体积小。',
    })
    expect(out.staged).toBe(true)
    expect(out.rules_explained).toContain('没读到')
    expect(out.rules_explained).not.toContain('明写着')
  })

  it('设计需求单：没人做照实说；有人做 → 开事项 + 待办；定稿入库 → 交付、回到下单那件事', async () => {
    const store = assign('dtc.store')
    const brand = await server.brands.forWorkspace(server.bootstrap.workspace.id)
    const work = brand.work
    const asking = work.createMatter({
      kind: 'conversation',
      title: '新品上线',
      position_id: store.id,
      role_id: 'dtc.store',
    })
    const none = await brand.designService.port.createRequest(actorOf(store) as never, {
      title: '首页主视觉',
      need: '桌面和手机各一张',
      matter_id: asking.id,
    })
    expect(none.staged.message ?? '').not.toContain('收到了')
    expect(
      work
        .matterView(asking.id)
        .timeline.map((e) => e.text)
        .join('\n'),
    ).toContain('还没人做')

    const designer = assign('design.dtc')
    const out = await brand.designService.port.createRequest(actorOf(store) as never, {
      title: '新品横幅',
      need: '首页横幅 3:1',
      matter_id: asking.id,
    })
    // 同一个来源、同一个标题、还没做完的单不下第二张
    const again = await brand.designService.port.createRequest(actorOf(store) as never, {
      title: '新品横幅',
      need: '首页横幅 3:1',
    })
    expect(again.request.id).toBe(out.request.id)
    expect(again.staged.staged).toBe(false)
    const designMatter = work
      .listMatters({ kind: 'conversation' })
      .find((m) => m.context.pinned.some((p) => p.id === out.request.id))
    expect(designMatter?.position_id).toBe(designer.id)
    expect(
      work
        .listTodos({ owner: server.bootstrap.person.id })
        .some((t) => t.title.includes('新品横幅')),
    ).toBe(true)

    brand.design.saveAsset({
      id: 'dasset_1',
      workspace_id: server.bootstrap.workspace.id,
      duty: 'dtc',
      request_id: out.request.id,
      spec_id: 'web.hero.desktop',
      status: 'picked',
      provenance: { source: 'generated' } as never,
      created_at: T0,
    })
    const applied = await brand.designService.applyPublish({
      kind: 'asset_publish',
      workspace_id: server.bootstrap.workspace.id,
      after: { asset_id: 'dasset_1' },
    })
    expect(applied?.status).toBe('ok')
    expect(brand.design.asset('dasset_1')?.status).toBe('published')
    expect(brand.design.request(out.request.id)?.status).toBe('delivered')
    expect(
      work
        .matterView(asking.id)
        .timeline.map((e) => e.text)
        .join('\n'),
    ).toContain('设计岗交付了')
  })
})

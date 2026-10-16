/**
 * WP360（决策 947）端到端：真服务进程（落盘档 + stub 运行时）+ 替身插件，一行网都不出。
 *
 * - 首次设置第 ④ 步：勾了 Reddit / 红人职责 → 计划里多一项「装插件」（用途、谁要它、配上没有）；没勾就没有；
 * - 岗位页那张卡：要不要、配上没有、配上之后还差哪步（插件里连 Reddit）、接哪张方案卡；「稍后」当天收起；
 * - 第一次在要插件的岗位上说话：事项里先说一句、带上装插件那张连接卡（不挂「连好接着做」）；同一条分配只一次；
 *   第二个要插件的岗位再说话 → 复用同一张卡（一个品牌只一张）；
 * - 配对 → 插件来问（连着 Reddit）→ 「连 Reddit」那步打勾 → 插件交回登着哪个号 → 自动出 Reddit 巡查方案卡。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ExtensionNeedsView, OnboardingPlanView } from '@agentsws/api'
import type { ApprovalItem, ConnectRequestPayload } from '@agentsws/contracts'
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
const call = (method: string, path: string, body?: unknown, assignment?: string) =>
  server.gateway.fetch(
    new Request(`http://127.0.0.1${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${server.bootstrap.internalToken}`,
        'X-Assignment': assignment ?? server.bootstrap.ownerAssignment.id,
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
const waitFor = async (fn: () => Promise<boolean> | boolean, what: string): Promise<void> => {
  for (let i = 0; i < 400; i++) {
    if (await fn()) return
    await new Promise((r) => setTimeout(r, 25))
  }
  throw new Error(`等不到：${what}`)
}

/** 建一个岗位并分给负责人本人，回这几条职责各自的分配。 */
async function position(name: string, role_ids: string[]): Promise<Record<string, string>> {
  const p = await data<{ id: string }>(
    await call('POST', '/v1/org/positions', {
      name,
      roles: role_ids.map((role_id) => ({ role_id, default: true })),
    }),
  )
  await data(
    await call('POST', '/v1/assignments', {
      person_id: server.bootstrap.ownerAssignment.person_id,
      position_id: p.id,
      ranges: [],
      range_groups: [],
    }),
  )
  const ws = server.bootstrap.workspace.id
  const out: Record<string, string> = {}
  for (const r of role_ids) {
    const a = server.roles.assignments
      .listByRole(r as never)
      .find((x) => x.workspace_id === ws && x.revoked_at === undefined)
    if (a !== undefined) out[r] = a.id
  }
  return out
}

type Tl = { kind: string; text: string; approval_item_id?: string }[]
const timeline = async (m: string): Promise<Tl> =>
  (await data<{ timeline: Tl }>(await call('GET', `/v1/matters/${m}`))).timeline
const queue = async (): Promise<ApprovalItem[]> =>
  server.txn.approvals.queue({
    workspace_id: server.bootstrap.workspace.id,
    person_id: server.bootstrap.person.id,
    lane: 'mine',
  })
const extensionCards = async (): Promise<ApprovalItem<ConnectRequestPayload>[]> =>
  (await queue()).filter(
    (c) =>
      c.kind === 'connect_request' &&
      (c.payload as ConnectRequestPayload).needs.some((n) => n.kind === 'extension'),
  ) as ApprovalItem<ConnectRequestPayload>[]

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'wp360-ext-'))
  server = await createServer({
    dbDir: dir,
    quiet: true,
    env: { [SECRETS_KEY_ENV]: 'f'.repeat(64), AGENTSWS_OWNER_EMAIL: 'owner@example.com' },
    tokenRefreshIntervalMs: 0,
    scheduleIntervalMs: 0,
    liveDataIntervalMs: 0,
    mdns: () => ({ mdns: { publish() {}, browse() {}, stop() {} } }),
  })
})
afterAll(async () => {
  await server?.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('WP360 需要插件的岗位一开始就引导装插件', () => {
  it('首次设置第 ④ 步：勾了 Reddit / 红人 → 计划里有「装插件」；没勾就没有', async () => {
    const plan = await data<OnboardingPlanView>(
      await call('POST', '/v1/onboarding/plan', {
        position_ids: [],
        role_ids: [],
        positions: [
          { name: 'Reddit 运营', role_ids: ['social.reddit', 'pr.reddit'] },
          { name: '红人营销', role_ids: ['kol.youtube', 'kol.x'] },
        ],
      }),
    )
    expect(plan.extension).toEqual({
      uses: ['reddit', 'kol'],
      needed_by: ['自家版运营', 'Reddit 营销', 'YouTube 红人'],
      paired: false,
    })
    const none = await data<OnboardingPlanView>(
      await call('POST', '/v1/onboarding/plan', {
        position_ids: [],
        role_ids: [],
        positions: [{ name: '客服', role_ids: ['dtc.support'] }],
      }),
    )
    expect(none.extension).toBeUndefined()
  })

  it('岗位页那张卡 → 第一次对话带卡（只一次、全品牌一张）→ 稍后 → 配对 → 连 Reddit → 自动出巡查方案卡', async () => {
    const reddit = await position('Reddit 运营', ['social.reddit', 'pr.reddit'])
    const own = reddit['social.reddit']
    if (own === undefined) throw new Error('没分到自家版运营')

    // ① 岗位页那张卡要的数
    const needs = (asg: string, roles: string) =>
      call('GET', `/v1/extension/needs?roles=${roles}`, undefined, asg).then((r) =>
        data<ExtensionNeedsView>(r),
      )
    const v0 = await needs(own, 'social.reddit,pr.reddit')
    expect(v0).toMatchObject({
      needed: true,
      uses: ['reddit'],
      paired: false,
      steps: [{ step: 'reddit', done: false }],
      plans: [{ target: 'reddit.watch', satisfied: false }],
      snoozed: false,
    })
    expect(v0.roles.map((r) => r.role_id)).toEqual(['social.reddit', 'pr.reddit'])
    expect((await needs(own, 'dtc.support')).needed).toBe(false)

    // ② 第一次在这个岗位说话：先说一句 + 装插件那张卡挂进这件事
    const m1 = await data<{ matter: { id: string } }>(
      await call('POST', `/v1/positions/${own}/matters`, {
        title: '看看 Reddit 上最近大家在聊我们什么',
        role_id: 'social.reddit',
      }),
    )
    await waitFor(async () => (await extensionCards()).length === 1, '装插件卡')
    const card = (await extensionCards())[0]
    if (card === undefined) throw new Error('没出卡')
    expect(card.payload.why).toContain('读 Reddit')
    // 主动带的卡不挂「连好按原话再跑一次」
    expect(card.payload.resume).toBeUndefined()
    await waitFor(
      async () => (await timeline(m1.matter.id)).some((e) => e.approval_item_id === card.id),
      '卡进时间线',
    )
    const tl1 = await timeline(m1.matter.id)
    const said = tl1.findIndex((e) => e.text.includes('在下面这张卡上装好、配个对'))
    expect(said).toBeGreaterThanOrEqual(0)
    expect(tl1.findIndex((e) => e.approval_item_id === card.id)).toBeGreaterThan(said)
    // 先说这一句、带上卡，再起跑（AI 的回话在它们后面）
    const reply = tl1.findIndex((e) => e.kind === 'agent_message')
    if (reply >= 0) expect(reply).toBeGreaterThan(said)

    // 同一条分配再说话：不再带
    const m2 = await data<{ matter: { id: string } }>(
      await call('POST', `/v1/positions/${own}/matters`, {
        title: '再看看 r/gadgets 里有没有人提到我们',
        role_id: 'social.reddit',
      }),
    )
    await new Promise((r) => setTimeout(r, 300))
    expect((await timeline(m2.matter.id)).some((e) => e.text.includes('浏览器插件'))).toBe(false)

    // 第二个要插件的岗位（红人）第一次说话：复用同一张卡（一个品牌只一张）
    const kol = await position('红人营销', ['kol.youtube'])
    const yt = kol['kol.youtube']
    if (yt === undefined) throw new Error('没分到 YouTube 红人')
    const m3 = await data<{ matter: { id: string } }>(
      await call('POST', `/v1/positions/${yt}/matters`, {
        title: '帮我找几个做户外装备测评的 YouTube 博主',
        role_id: 'kol.youtube',
      }),
    )
    await waitFor(
      async () => (await timeline(m3.matter.id)).some((e) => e.text.includes('之前已经出过')),
      '复用那张卡',
    )
    expect(await extensionCards()).toHaveLength(1)

    // ③ 稍后：当天收起（同一品牌所有岗位一起）；当天再说话也不带
    const snoozed = await data<ExtensionNeedsView>(
      await call('POST', '/v1/extension/needs/snooze', { roles: ['kol.youtube'] }, yt),
    )
    expect(snoozed.snoozed).toBe(true)
    expect((await needs(own, 'social.reddit,pr.reddit')).snoozed).toBe(true)

    // ④ 配对 → 插件来问（连着 Reddit）→ 那一步打勾
    const pairing = await data<{ code: string }>(await call('POST', '/v1/extension/pairings', {}))
    const redeemed = await data<{ token: string }>(
      await server.gateway.fetch(
        new Request('http://127.0.0.1/v1/extension/pair', {
          method: 'POST',
          headers: { Origin: EXT_ORIGIN, 'content-type': 'application/json' },
          body: JSON.stringify({ code: pairing.code }),
        }),
      ),
    )
    const v1 = await needs(own, 'social.reddit,pr.reddit')
    expect(v1.paired).toBe(true)
    expect(v1.steps).toEqual([{ step: 'reddit', done: false }])
    const next = await data<{ job?: { id: string; reads: unknown[] } }>(
      await plugin('/v1/extension/reddit/next?connected=1', redeemed.token),
    )
    expect((await needs(own, 'social.reddit,pr.reddit')).steps).toEqual([
      { step: 'reddit', done: true },
    ])

    // ⑤ 插件交回登着哪个号（还没配巡查时的那一件）→ 不等人开口，出巡查方案卡
    const job = next.job
    if (job === undefined) throw new Error('没领到「看登着哪个号」那一件')
    expect(job.reads).toEqual([])
    const back = await plugin(`/v1/extension/reddit/${job.id}/result`, redeemed.token, {
      method: 'POST',
      body: { outcome: 'done', message: '', user: 'nordvolt_official', parts: [] },
    })
    expect(back.status).toBe(200)
    await waitFor(
      async () =>
        (await queue()).some(
          (c) =>
            c.kind === 'setup_request' &&
            (c.payload as { target?: string }).target === 'reddit.watch',
        ),
      '巡查方案卡',
    )
    // 岗位页上的「下一步」按钮出的是同一张（不重复出）
    const planned = await data<{ card_id?: string }>(
      await call('POST', '/v1/extension/needs/plan', { target: 'reddit.watch' }, own),
    )
    const setupCards = (await queue()).filter((c) => c.kind === 'setup_request')
    expect(setupCards).toHaveLength(1)
    expect(planned.card_id).toBe(setupCards[0]?.id)
    // 不是这个人担着的岗位要的那几张：不出
    expect(
      await data<{ card_id?: string }>(
        await call('POST', '/v1/extension/needs/plan', { target: 'company.profile' }, own),
      ),
    ).toEqual({})
  })
})

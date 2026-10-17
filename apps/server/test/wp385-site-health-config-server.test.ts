/**
 * WP385（决策 1076 → 690）端到端：真服务进程（落盘档 + 真网关 + stub 运行时）+ 网页替身，一行网都不出、不连真店。
 *
 * 店铺管理的对话里说一句「我们的 Google 商品 feed 是 …」→ AI 调 `request_setup`（`site.health` + 建议值）→
 * 这一轮收尾出一张「我打算改成这样」的卡（只列 feed 那一格：现值空 → 新地址）→ 人点「就这样」→ 存好、后台重新体检一次
 * （这次就去读了那个 feed）→ 原来那件事按原话接着做：AI 再要一次时工具说「已经是这样了」，不再出卡、不记卡住，
 * 读一次体检结论接着说。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ApprovalItem, Assignment, SetupRequestPayload } from '@agentsws/contracts'
import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from '../src/index.js'
import { SECRETS_KEY_ENV } from '../src/secret-store.js'

let server: Server | undefined
const dirs: string[] = []

afterEach(async () => {
  await server?.close()
  server = undefined
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const waitFor = async (fn: () => Promise<boolean> | boolean, what: string): Promise<void> => {
  for (let i = 0; i < 400; i++) {
    if (await fn()) return
    await new Promise((r) => setTimeout(r, 20))
  }
  throw new Error(`等不到：${what}`)
}

const ORIGIN = 'https://nordvolt.example'
const FEED = 'https://feeds.nordvolt.example/google.xml'
const PAGES: Record<string, string> = {
  [`${ORIGIN}/robots.txt`]: 'User-agent: PerplexityBot\nDisallow: /\n',
  [FEED]: '<?xml version="1.0"?><rss><channel></channel></rss>',
}

describe('WP385 体检设置在对话里完成（stub）', () => {
  it('说一句 feed 地址 → 改设置卡（只列那一格）→ 就这样 → 存好、按新设置体检 → 接着做不再出卡', async () => {
    const dbDir = mkdtempSync(join(tmpdir(), 'wp385-config-'))
    dirs.push(dbDir)
    const fetched: string[] = []
    server = await createServer({
      dbDir,
      quiet: true,
      env: { [SECRETS_KEY_ENV]: 'c'.repeat(64) },
      tokenRefreshIntervalMs: 0,
      scheduleIntervalMs: 0,
      liveDataIntervalMs: 0,
      mdns: () => ({ mdns: { publish() {}, browse() {}, stop() {} } }),
      siteHealthRenderer: false,
      siteHealthFetch: async (url: string) => {
        fetched.push(url)
        const hit = PAGES[url]
        return {
          ok: hit !== undefined,
          status: hit === undefined ? 404 : 200,
          text: async () => hit ?? '',
        }
      },
    })
    const s = server
    const ws = s.bootstrap.workspace.id
    await s.onboarding.port.setProfile(
      { workspace_id: ws, person_id: s.bootstrap.person.id, assignment_id: '', role_id: '' },
      { legal_name: 'NordVolt GmbH', domain: 'nordvolt.example' } as never,
    )
    const store: Assignment = s.roles.assignments.create({
      person_id: s.bootstrap.person.id,
      workspace_id: ws,
      role_id: 'dtc.store',
      granted_by: s.bootstrap.person.id,
      ranges: [{ kind: 'brand', id: ws }],
    })
    const call = async (method: string, path: string, body?: unknown) =>
      s.gateway.fetch(
        new Request(`http://127.0.0.1${path}`, {
          method,
          headers: {
            Authorization: `Bearer ${s.bootstrap.internalToken}`,
            'X-Assignment': store.id,
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
      )
    const dataOf = async <T>(res: Response): Promise<T> => ((await res.json()) as { data: T }).data
    type Tl = { kind: string; text: string; approval_item_id?: string; blocked?: unknown }[]
    const timeline = async (m: string): Promise<Tl> =>
      (await dataOf<{ timeline: Tl }>(await call('GET', `/v1/matters/${m}`))).timeline
    const cards = async (): Promise<ApprovalItem[]> =>
      (
        await s.txn.approvals.queue({
          workspace_id: ws,
          person_id: s.bootstrap.person.id,
          lane: 'mine',
        })
      ).filter((c) => c.kind === 'setup_request')

    // ① 对话里说一句
    const m = await dataOf<{ matter: { id: string } }>(
      await call('POST', `/v1/positions/${store.id}/matters`, {
        title: `我们的 Google 商品 feed 是 ${FEED}`,
        role_id: 'dtc.store',
      }),
    )
    await waitFor(async () => (await cards()).length > 0, '体检设置卡')
    const card = (await cards())[0] as ApprovalItem<SetupRequestPayload>
    expect(card.title).toBe('网站体检设置：我打算改成这样')
    expect(card.payload.mode).toBe('change')
    const changed = card.payload.fields.filter((f) => (f.suggested ?? '') !== (f.current ?? ''))
    expect(changed).toEqual([
      expect.objectContaining({ key: 'feed_url', current: '', suggested: FEED }),
    ])
    const tl = await timeline(m.matter.id)
    expect(tl.some((e) => e.kind === 'card' && e.approval_item_id === card.id)).toBe(true)
    expect(tl.some((e) => e.kind === 'agent_message' && /下面这张卡上点头/.test(e.text))).toBe(true)
    expect(fetched).not.toContain(FEED)

    // ② 就这样 → 存好、后台按新设置体检一次 → 原来那件事接着做
    const res = await call('POST', `/v1/approvals/${card.id}/decide`, {
      action: 'approve',
      version: card.revision,
      via: 'workstation',
    })
    expect(res.status).toBeLessThan(300)
    await waitFor(
      async () =>
        (await timeline(m.matter.id)).some(
          (e) => e.kind === 'agent_message' && e.text.startsWith('设好了。'),
        ),
      '接着做那一轮的回话',
    )
    const view = await dataOf<{
      settings: { feed_url?: string }
      run?: { started_at: string; notes: string[] }
    }>(await call('GET', '/v1/site-health'))
    expect(view.settings.feed_url).toBe(FEED)
    expect(view.run).toBeDefined()
    expect(view.run?.notes).not.toContain('这次没读到商品 feed')
    expect(fetched).toContain(FEED)
    const after = await timeline(m.matter.id)
    expect(after.filter((e) => e.kind === 'run').map((e) => e.text)).toContain('设好了，接着做')
    const reply = after.filter((e) => e.kind === 'agent_message').at(-1)?.text ?? ''
    expect(reply).toContain('PerplexityBot')
    // 接着做那一轮：不再出卡、不记卡住
    expect(await cards()).toHaveLength(0)
    expect(after.filter((e) => e.blocked !== undefined)).toHaveLength(1)
  })
})

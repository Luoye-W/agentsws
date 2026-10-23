/**
 * WP487（决策 1661 补，Luoye 10-23：「红人的联系方式是要进云端工坊的」）：
 * 插件路与 ego 路上云的红人数据，加上**主页上公开写着的**联系方式（`public_contacts`）。
 *
 * 钉住：
 * ① 两条路送上云的是同一个形状，`public_contacts` 逐条只有 kind / value / label；
 * ② 私信内容、账号凭据、用户自己的数据**一个字节都不出门**：用户点「收下」的 `contact`（哪怕是私信）、
 *    简介、搜索词、列表来源、插件令牌、云令牌、带 token 的链接、私信页链接——请求体里都没有；
 * ③ 公开邮箱在本机也收一条（进本机加密库，来源 `public_profile`），库里已经有就不动；
 * ④ 没登录云账号就只落本机（和 WP483 一样）。
 * 公共库是契约替身，不联网。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ExtensionObservation, ExtensionSession } from '@agentsws/api'
import type { Clock, PersonId, WorkspaceId } from '@agentsws/contracts'
import {
  cloudStandInFetch,
  KolPublicStandIn,
  type StandInKolPrincipal,
  StandInWallet,
} from '@agentsws/stand-ins'
import { afterEach, describe, expect, it } from 'vitest'
import { CLOUD_TOKEN_SECRET_ID } from '../src/cloud-account.js'
import { createExtensionContributor } from '../src/extension-contribute.js'
import { createExtensionService } from '../src/extension-service.js'
import { createKolStore } from '../src/kol.js'
import type { KolPublicFetch } from '../src/kol-public-client.js'
import { CONTACT_SECRET_FIELD } from '../src/kol-service.js'
import { createKolToolExecutor, observeViaIngest } from '../src/kol-tools.js'
import { createSecretStore } from '../src/secret-store.js'

const WS = 'ws_1' as WorkspaceId
const NOW = '2026-10-23T10:00:00.000Z'
const clock: Clock = { now: () => NOW }
const CLOUD_TOKEN = 'wst_fixture_token_SECRET'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function assemble(linked = true) {
  let seq = 0
  const newId = (prefix: string): string => `${prefix}_${String(++seq)}`
  const cloud = new KolPublicStandIn({
    wallet: new StandInWallet({ now: () => NOW, newId }),
    now: () => NOW,
    newId,
  })
  const verified: StandInKolPrincipal = {
    account_id: 'acc_1',
    org_id: 'org_1',
    workspace_id: WS,
    scopes: ['data'],
  }
  const wire = cloudStandInFetch({
    kolPublic: cloud,
    kolPrincipalOf: (t) => (t === CLOUD_TOKEN ? verified : undefined),
  })
  const calls: { path: string; body: unknown; status: number }[] = []
  const fetch: KolPublicFetch = async (url, init) => {
    const res = await wire.fetch(url, init)
    calls.push({
      path: `${init.method} ${new URL(url).pathname}`,
      body: init.body === undefined ? undefined : JSON.parse(String(init.body)),
      status: res.status,
    })
    return res
  }
  const dir = mkdtempSync(join(tmpdir(), 'agentsws-wp487-'))
  dirs.push(dir)
  const kol = createKolStore({ workspace_id: WS, dbDir: dir })
  const secrets = createSecretStore({
    dbPath: ':memory:',
    clock,
    env: { AGENTSWS_SECRETS_KEY: 'a'.repeat(64) },
  })
  if (linked) secrets.put(CLOUD_TOKEN_SECRET_ID, { token: CLOUD_TOKEN })
  const port = createExtensionService({
    workspace_id: WS,
    workspaceName: () => '我的品牌',
    store: {} as never,
    kol,
    secrets,
    clock,
    random: () => 0.5,
    publicLibrary: createExtensionContributor({ secrets, env: {}, fetch }),
    serverVersion: '0.1.0',
  })
  const tools = createKolToolExecutor({
    workspace_id: WS,
    port: () => ({}) as never,
    now: () => NOW,
    observe: observeViaIngest(async (session, input) => port.ingest(session as never, input)),
  })
  return { port, kol, secrets, calls, tools, cloud }
}

const session: ExtensionSession = {
  token_id: 'ext_token_SECRET',
  workspace_id: WS,
  person_id: 'pr_1' as PersonId,
  extension_id: 'abcdefghijklmnop',
  scopes: ['kol.observe'],
}

const request = {
  actor: { person_id: 'pr_1', assignment_id: 'asg_1', role_id: 'kol.tiktok' },
} as never

/** 页面上读到的（含几条不该出门的：私信页、带 token 的链接、账号密码、私货键）。 */
const SEEN_ON_PAGE = [
  { kind: 'email', value: 'mailto:Hello@GymChef.example' },
  { kind: 'business', value: 'deals@talent.example', label: '  Business   inquiries ' },
  { kind: 'website', value: 'https://gymchef.example/shop?utm_source=tt#top' },
  { kind: 'social', value: 'https://www.instagram.com/gymchef/' },
  { kind: 'agent', value: 'https://talent.example/roster/gymchef', label: 'Managed by Talent Co' },
  { kind: 'social', value: 'https://www.instagram.com/direct/t/340282366841710300949128' },
  { kind: 'website', value: 'https://gymchef.example/account?session=SECRET_SESSION' },
  { kind: 'website', value: 'https://me:SECRET_PASSWORD@gymchef.example/' },
  { kind: 'website', value: 'https://login.gymchef.example/?access_token=SECRET_TOKEN' },
]

/** 筛完、上云的样子。 */
const EXPECTED_CONTACTS = [
  { kind: 'email', value: 'hello@gymchef.example' },
  { kind: 'business', value: 'deals@talent.example', label: 'Business inquiries' },
  { kind: 'website', value: 'https://gymchef.example/shop' },
  { kind: 'social', value: 'https://www.instagram.com/gymchef/' },
  { kind: 'agent', value: 'https://talent.example/roster/gymchef', label: 'Managed by Talent Co' },
]

/** 这些一个都不许出现在发往云端的任何一个请求里。 */
const MUST_NOT_LEAVE = [
  'SECRET',
  'direct/t',
  'private DM',
  'what is your rate',
  'Meal prep for lifters',
  'my own search words',
  'hunter2',
  'session_cookie',
  'owner@my-brand.example',
  'utm_source',
]

describe('WP487 决策 1661 补：主页上公开的联系方式随两条路上云', () => {
  it('插件路与 ego 路送上云的是同一个形状，联系方式筛过、逐条只有三格', async () => {
    const plugin = assemble()
    const viaPlugin: ExtensionObservation = {
      channel: 'tiktok',
      handle: 'gymchef',
      display_name: 'Gym Chef',
      followers: 48_200,
      bio: 'Meal prep for lifters',
      // 用户点「收下」的那一条：私信——只进本机，不跟观测上云
      contact: { kind: 'dm', value: 'private DM: what is your rate?' },
      public_contacts: SEEN_ON_PAGE as never,
      observed_at: NOW,
      page_url: 'https://www.tiktok.com/@gymchef',
      source: 'channel_page',
      source_query: 'my own search words',
    }
    await plugin.port.ingest(session, { observations: [viaPlugin] })

    const ego = assemble()
    const res = await ego.tools({
      name: 'record_creator_observations',
      input: {
        observations: [
          {
            handle: '@gymchef',
            display_name: 'Gym Chef',
            followers: 48_200,
            bio: 'Meal prep for lifters',
            public_contacts: SEEN_ON_PAGE,
            // 塞进来的私货：工具一格都不收
            dm_messages: ['private DM: what is your rate?'],
            password: 'hunter2',
            cookies: 'session_cookie=abc',
            my_email: 'owner@my-brand.example',
          },
        ],
      },
      request,
    })
    expect(res.status).toBe('ok')
    expect(res.data).toMatchObject({ rows: 1, saved: 1, backed_up_to_cloud: 1 })

    const expected = {
      via: 'extension',
      observations: [
        {
          channel: 'tiktok',
          handle: 'gymchef',
          followers: 48_200,
          public_contacts: EXPECTED_CONTACTS,
          observed_at: NOW,
        },
      ],
    }
    expect(plugin.calls.map((c) => [c.path, c.status])).toEqual([
      ['POST /v1/data/kol/creators/tiktok/gymchef/observations', 201],
    ])
    expect(plugin.calls[0]?.body).toEqual(expected)
    expect(ego.calls[0]?.body).toEqual(expected)
  })

  it('私信内容、账号凭据、用户自己的数据：发往云端的请求里一个字节都没有', async () => {
    const plugin = assemble()
    await plugin.port.ingest(session, {
      observations: [
        {
          channel: 'tiktok',
          handle: 'gymchef',
          followers: 48_200,
          bio: 'Meal prep for lifters',
          contact: { kind: 'dm', value: 'private DM: what is your rate?' },
          public_contacts: SEEN_ON_PAGE as never,
          observed_at: NOW,
          source: 'search_results',
          source_page: 'search',
          source_query: 'my own search words',
          relevance_score: 80,
        },
      ],
    })
    const ego = assemble()
    await ego.tools({
      name: 'record_creator_observations',
      input: {
        observations: [
          {
            handle: 'gymchef',
            followers: 1000,
            public_contacts: [
              ...SEEN_ON_PAGE,
              // 塞进单条联系方式里的私货键：只留 kind / value / label
              { kind: 'website', value: 'https://gymchef.example/', dm_text: 'private DM' },
            ],
            dm_messages: ['private DM: what is your rate?'],
            password: 'hunter2',
            cookies: 'session_cookie=abc',
            my_email: 'owner@my-brand.example',
          },
        ],
      },
      request,
    })
    for (const { calls } of [plugin, ego]) {
      expect(calls.length).toBeGreaterThan(0)
      const wire = JSON.stringify(calls)
      for (const secret of MUST_NOT_LEAVE) expect(wire).not.toContain(secret)
      // 每一行只有白名单那几格；每条联系方式只有那三格
      for (const c of calls) {
        const body = c.body as { observations: Record<string, unknown>[] }
        for (const o of body.observations) {
          for (const k of Object.keys(o))
            expect([
              'channel',
              'handle',
              'followers',
              'posts_30d',
              'engagement_rate',
              'public_contacts',
              'observed_at',
            ]).toContain(k)
          for (const pc of (o.public_contacts ?? []) as Record<string, unknown>[])
            for (const k of Object.keys(pc)) expect(['kind', 'value', 'label']).toContain(k)
        }
      }
    }
  })

  it('公开邮箱在本机也收一条（加密库，来源 public_profile）；已经有联系方式就不动', async () => {
    const { tools, kol, secrets } = assemble(false)
    await tools({
      name: 'record_creator_observations',
      input: {
        observations: [
          {
            handle: 'gymchef',
            followers: 1000,
            public_contacts: [{ kind: 'business', value: 'Deals@Talent.example' }],
          },
        ],
      },
      request,
    })
    const account = kol.accounts({ channel: 'tiktok' })[0]
    const contacts = kol.contacts(account?.creator_id)
    expect(contacts).toHaveLength(1)
    expect(contacts[0]).toMatchObject({ kind: 'email', source: 'public_profile' })
    // 库里只有 key 名，明文在加密库
    expect(JSON.stringify(contacts)).not.toContain('talent.example')
    expect(secrets.get(contacts[0]?.value_ref ?? '')?.[CONTACT_SECRET_FIELD]).toBe(
      'deals@talent.example',
    )

    // 再来一条不同的公开邮箱：已经有了，不动
    await tools({
      name: 'record_creator_observations',
      input: {
        observations: [
          {
            handle: 'gymchef',
            followers: 1000,
            public_contacts: [{ kind: 'email', value: 'other@gymchef.example' }],
          },
        ],
      },
      request,
    })
    expect(kol.contacts(account?.creator_id)).toHaveLength(1)
  })

  it('没登录云账号：联系方式也只落本机，一条都不出这台电脑', async () => {
    const { tools, calls } = assemble(false)
    const res = await tools({
      name: 'record_creator_observations',
      input: {
        observations: [{ handle: 'gymchef', followers: 10, public_contacts: SEEN_ON_PAGE }],
      },
      request,
    })
    expect(res.data).toMatchObject({ saved: 1, backed_up_to_cloud: 0 })
    expect(calls).toHaveLength(0)
  })

  it('替身云收下公开邮箱：卡上 has_contact 变 true（与真云同一条口径）', async () => {
    const { tools, cloud } = assemble()
    await tools({
      name: 'record_creator_observations',
      input: {
        observations: [{ handle: 'gymchef', followers: 10, public_contacts: SEEN_ON_PAGE }],
      },
      request,
    })
    expect(cloud.creator('tiktok', 'gymchef')?.has_contact).toBe(true)
    // 观察行里不留联系方式（与真云一样：联系方式另存）
    expect(JSON.stringify(cloud.observationsOf('tiktok', 'gymchef'))).not.toContain('@')
  })
})

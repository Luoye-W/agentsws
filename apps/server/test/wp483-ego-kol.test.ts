/**
 * WP483（决策 1661）：红人营销走 ego 时，浏览器里读到的红人**公开**数据和插件那条路一样——
 * 进同一个入口（`ExtensionService.ingest`）：存进本机红人库，登录了云账号就同一批备份到工坊云端（公共红人库）。
 *
 * 钉住：① 两条路上云的是同一份窄行（只有渠道、账号、粉丝数、时间，`via: extension`）；
 * ② 工具只收白名单那几格，私信 / 密码 / 联系方式这类塞进来也一格不进；③ 没登录云账号就只落本机。
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
import { createKolToolExecutor, observeViaIngest } from '../src/kol-tools.js'
import { createSecretStore } from '../src/secret-store.js'

const WS = 'ws_1' as WorkspaceId
const NOW = '2026-10-23T10:00:00.000Z'
const clock: Clock = { now: () => NOW }

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function assemble(linked = true) {
  let seq = 0
  const newId = (prefix: string): string => `${prefix}_${String(++seq)}`
  const cloudStore = new KolPublicStandIn({
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
    kolPublic: cloudStore,
    kolPrincipalOf: (t) => (t === 'wst_fixture_token' ? verified : undefined),
  })
  const calls: { path: string; body: unknown }[] = []
  const fetch: KolPublicFetch = async (url, init) => {
    calls.push({
      path: `${init.method} ${new URL(url).pathname}`,
      body: init.body === undefined ? undefined : JSON.parse(String(init.body)),
    })
    return wire.fetch(url, init)
  }
  const dir = mkdtempSync(join(tmpdir(), 'agentsws-wp483-'))
  dirs.push(dir)
  const kol = createKolStore({ workspace_id: WS, dbDir: dir })
  const secrets = createSecretStore({
    dbPath: ':memory:',
    clock,
    env: { AGENTSWS_SECRETS_KEY: 'a'.repeat(64) },
  })
  if (linked) secrets.put(CLOUD_TOKEN_SECRET_ID, { token: 'wst_fixture_token' })
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
  return { port, kol, calls, tools }
}

const request = {
  actor: { person_id: 'pr_1', assignment_id: 'asg_1', role_id: 'kol.tiktok' },
} as never

describe('WP483 决策 1661：ego 路采到的红人数据，和插件路一样上云备份 + 落本机', () => {
  it('两条路上云的是同一份窄行（同一个接口、同一个形状）', async () => {
    // 插件那一路
    const plugin = assemble()
    const session: ExtensionSession = {
      token_id: 'ext_1',
      workspace_id: WS,
      person_id: 'pr_1' as PersonId,
      extension_id: 'abcdefghijklmnop',
      scopes: ['kol.observe'],
    }
    const viaPlugin: ExtensionObservation = {
      channel: 'tiktok',
      handle: 'gymchef',
      display_name: 'Gym Chef',
      followers: 48_200,
      observed_at: NOW,
      source: 'channel_page',
    }
    await plugin.port.ingest(session, { observations: [viaPlugin] })

    // ego 那一路（AI 调工具）
    const ego = assemble()
    const res = await ego.tools({
      name: 'record_creator_observations',
      input: {
        observations: [
          {
            handle: '@gymchef',
            display_name: 'Gym Chef',
            followers: 48_200,
            bio: 'Meal prep',
            url: 'https://www.tiktok.com/@gymchef',
          },
        ],
      },
      request,
    })
    expect(res.status).toBe('ok')
    expect(res.data).toMatchObject({ rows: 1, saved: 1, backed_up_to_cloud: 1 })

    expect(plugin.calls.map((c) => c.path)).toEqual(ego.calls.map((c) => c.path))
    expect(ego.calls[0]?.path).toBe('POST /v1/data/kol/creators/tiktok/gymchef/observations')
    expect(ego.calls[0]?.body).toEqual(plugin.calls[0]?.body)
    // 上云那一行只有这几格（名字、简介、链接只在本机）
    expect(ego.calls[0]?.body).toEqual({
      via: 'extension',
      observations: [{ channel: 'tiktok', handle: 'gymchef', followers: 48_200, observed_at: NOW }],
    })
    // 本机也有了
    expect(ego.kol.accounts({ channel: 'tiktok' }).map((a) => a.handle)).toEqual(['gymchef'])
  })

  it('工具只收白名单那几格：私信、密码、联系方式塞进来也一格不进', async () => {
    const { tools, calls, kol } = assemble()
    await tools({
      name: 'record_creator_observations',
      input: {
        observations: [
          {
            handle: 'gymchef',
            followers: 1000,
            dm_text: 'hey, private message',
            password: 'x',
            contact: { kind: 'email', value: 'a@b.test' },
            business_email: 'a@b.test',
          },
        ],
      },
      request,
    })
    const sent = JSON.stringify(calls.map((c) => c.body))
    expect(sent).not.toMatch(/private message|password|a@b\.test/u)
    // 联系方式没进本机加密库那一格（ego 这一路不收联系方式）
    const creator = kol.accounts({ channel: 'tiktok' })[0]
    expect(creator).toBeDefined()
    expect(JSON.stringify(creator)).not.toContain('a@b.test')
  })

  it('没登录云账号：只落本机，一条都不出这台电脑（和插件一样）', async () => {
    const { tools, calls, kol } = assemble(false)
    const res = await tools({
      name: 'record_creator_observations',
      input: { observations: [{ handle: 'gymchef', followers: 10 }] },
      request,
    })
    expect(res.data).toMatchObject({ saved: 1, backed_up_to_cloud: 0 })
    expect(calls).toHaveLength(0)
    expect(kol.accounts({ channel: 'tiktok' })).toHaveLength(1)
  })

  it('一次最多 50 个；没有 handle 的不收', async () => {
    const { tools } = assemble(false)
    const many = Array.from({ length: 60 }, (_, i) => ({ handle: `c${i}`, followers: i }))
    const res = await tools({
      name: 'record_creator_observations',
      input: { observations: [{ followers: 3 }, ...many] },
      request,
    })
    expect(res.data).toMatchObject({ rows: 49, note: expect.stringContaining('50') })
  })
})

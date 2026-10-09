/**
 * WP283（决策 310）：生图 / 改图打 Agents 工坊云时带「谁 / 哪个岗位」（之前只有对话、搜索数据、
 * 公共红人库、`/v1/data/*` 带，生图那条的积分全落进「没标注」）；顺带补上插件那一路（reveal 按次扣积分）。
 *
 * 起真服务进程 + 假上游（不联网、不花钱）。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ExtensionSession } from '@agentsws/api'
import type { Clock, PersonId, WorkspaceId } from '@agentsws/contracts'
import { MEMBER_HEADER } from '@agentsws/contracts'
import type { FetchLike } from '@agentsws/model-gateway'
import { afterEach, describe, expect, it } from 'vitest'
import { CLOUD_TOKEN_SECRET_ID as ACCOUNT_TOKEN_ID } from '../src/cloud-account.js'
import { createExtensionContributor } from '../src/extension-contribute.js'
import { brandExtensionPort } from '../src/extension-port.js'
import { createServer, type Server } from '../src/index.js'
import { createKolStore } from '../src/kol.js'
import type { KolPublicFetch } from '../src/kol-public-client.js'
import { CLOUD_TOKEN_SECRET_ID } from '../src/models.js'
import { createSecretStore, SECRETS_KEY_ENV } from '../src/secret-store.js'

const T0 = '2026-10-09T09:00:00.000Z'
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1])

interface Call {
  url: string
  headers: Record<string, string>
}

function fakeUpstream(): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = []
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, headers: init.headers })
    const body = url.includes('/images/')
      ? { data: [{ b64_json: Buffer.from([1, 2]).toString('base64') }] }
      : url.endsWith('/models')
        ? { object: 'list', data: [{ id: 'm-1' }] }
        : { choices: [{ message: { content: '好' } }], usage: { prompt_tokens: 1 } }
    return {
      ok: true,
      status: 200,
      json: async () => body,
      text: async () => JSON.stringify(body),
    }
  }
  return { fetch, calls }
}

const servers: Server[] = []
const dirs: string[] = []
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

async function boot(): Promise<{ server: Server; calls: Call[] }> {
  let t = Date.parse(T0)
  const upstream = fakeUpstream()
  const dir = mkdtempSync(join(tmpdir(), 'agentsws-wp283-'))
  dirs.push(dir)
  const server = await createServer({
    dbDir: dir,
    clock: { now: () => new Date(t).toISOString() },
    random: () => {
      t += 1
      return 0.5
    },
    quiet: true,
    startRun: false,
    tokenRefreshIntervalMs: 0,
    scheduleIntervalMs: 0,
    liveDataIntervalMs: 0,
    env: {
      AGENTSWS_OWNER_EMAIL: 'owner@example.test',
      AGENTSWS_WORKSPACE_NAME: '测试品牌',
      [SECRETS_KEY_ENV]: 'c'.repeat(64),
    },
    mdns: () => ({ reason: '测试里不开局域网' }),
    modelFetch: upstream.fetch,
    cloudFetch: async () => ({
      ok: false,
      status: 404,
      json: async () => ({}),
      text: async () => '',
    }),
  })
  servers.push(server)
  return { server, calls: upstream.calls }
}

async function put(server: Server, path: string, body: unknown): Promise<number> {
  const res = await server.gateway.fetch(
    new Request(`http://127.0.0.1${path}`, {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        Authorization: `Bearer ${server.bootstrap.internalToken}`,
        'X-Assignment': server.bootstrap.ownerAssignment.id,
      },
      body: JSON.stringify(body),
    }),
  )
  return res.status
}

describe('WP283 生图 / 改图打云带归属头', () => {
  it('走 Agents 工坊积分：出图、改图两次请求都带 X-Agentsws-Member（就是这次分配的那个人）', async () => {
    const { server, calls } = await boot()
    expect(
      await put(server, '/v1/models/providers/deepseek', {
        kind: 'deepseek',
        base_url: 'https://api.deepseek.com',
        model: 'deepseek-flash',
        api_key: 'sk-wp283-deepseek',
      }),
    ).toBe(200)
    server.secrets.put(CLOUD_TOKEN_SECRET_ID, { token: 'wst_wp283_cloud' })
    const meta = {
      workspace_id: server.bootstrap.workspace.id,
      assignment_id: server.bootstrap.ownerAssignment.id,
      role_id: server.bootstrap.ownerAssignment.role_id,
      run_id: 'run_wp283',
      purpose: 'run',
    } as never
    const images = server.models.images
    await images.generate({ prompt: 'banner', meta })
    await images.edit?.({
      prompt: 'swap bg',
      images: [{ bytes: png, content_type: 'image/png' }],
      meta,
    })
    const gen = calls.find((c) => c.url.endsWith('/v1/ai/images/generations'))
    const edit = calls.find((c) => c.url.endsWith('/v1/ai/images/edits'))
    expect(gen?.headers.authorization).toBe('Bearer wst_wp283_cloud')
    expect(gen?.headers[MEMBER_HEADER]).toBe(server.bootstrap.person.id)
    expect(edit?.headers[MEMBER_HEADER]).toBe(server.bootstrap.person.id)
  })

  it('走自己的 OpenAI key：一个归属头都不带（不把本机成员 id 发给别家）', async () => {
    const { server, calls } = await boot()
    await put(server, '/v1/models/providers/openai', {
      kind: 'openai_compatible',
      base_url: 'https://api.openai.com/v1',
      model: 'gpt-4o-mini',
      region: 'global',
      api_key: 'sk-wp283-openai',
    })
    await server.models.images.generate({
      prompt: 'banner',
      meta: {
        workspace_id: server.bootstrap.workspace.id,
        assignment_id: server.bootstrap.ownerAssignment.id,
        role_id: server.bootstrap.ownerAssignment.role_id,
        run_id: 'run_wp283',
        purpose: 'run',
      } as never,
    })
    const gen = calls.find((c) => c.url === 'https://api.openai.com/v1/images/generations')
    expect(gen).toBeDefined()
    expect(gen?.headers[MEMBER_HEADER]).toBeUndefined()
  })
})

describe('WP283 插件那一路打云也带「谁」', () => {
  it('reveal 与观测转发：算在配对插件的那个人身上', async () => {
    const WS = 'ws_1' as WorkspaceId
    const clock: Clock = { now: () => T0 }
    const dir = mkdtempSync(join(tmpdir(), 'agentsws-wp283-ext-'))
    dirs.push(dir)
    const secrets = createSecretStore({
      dbPath: ':memory:',
      clock,
      env: { AGENTSWS_SECRETS_KEY: 'a'.repeat(64) },
    })
    secrets.put(ACCOUNT_TOKEN_ID, { token: 'wst_fixture_token' })
    const seen: { path: string; headers: Record<string, string> }[] = []
    const fetch: KolPublicFetch = async (url, init) => {
      seen.push({ path: new URL(url).pathname, headers: init.headers as Record<string, string> })
      return {
        ok: false,
        status: 404,
        json: async () => ({ code: 'not_found', message: '库里没有' }),
        text: async () => JSON.stringify({ code: 'not_found', message: '库里没有' }),
      } as never
    }
    const port = brandExtensionPort({
      store: {} as never,
      serviceOf: async () => ({
        workspaceName: () => '我的品牌',
        kol: createKolStore({ workspace_id: WS, dbDir: dir }),
        secrets,
        clock,
        random: () => 0.5,
        publicLibrary: createExtensionContributor({ secrets, env: {}, fetch }),
        serverVersion: '0.1.0',
      }),
    })
    const session: ExtensionSession = {
      token_id: 'ext_0001',
      workspace_id: WS,
      person_id: 'p_plugin' as PersonId,
      extension_id: 'abcdefghijklmnop',
      scopes: ['kol.observe', 'kol.capture', 'kol.read'],
    }
    await port.contactLookup(session, { channel: 'tiktok', handle: 'gymchef' })
    await port.ingest(session, {
      observations: [
        {
          channel: 'tiktok',
          handle: 'gymchef',
          followers: 48_200,
          observed_at: T0,
          page_url: 'https://www.tiktok.com/@gymchef',
          source: 'channel_page',
        },
      ],
    })
    const reveal = seen.find((s) => s.path.includes('reveal'))
    expect(reveal).toBeDefined()
    expect(reveal?.headers[MEMBER_HEADER]).toBe('p_plugin')
    const forwarded = seen.filter((s) => !s.path.includes('reveal'))
    expect(forwarded.length).toBeGreaterThan(0)
    for (const f of forwarded) expect(f.headers[MEMBER_HEADER]).toBe('p_plugin')
  })
})

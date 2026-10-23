/**
 * WP489（决策 1707）：表格导入的红人把公开资料送去公共红人库——走插件同一条转发路
 * （`extension-service` 的 `forward`：登录了才送、失败退避重试），同样的筛法，不落本机。
 * 送云那一跳（`extension-contribute`）：WP495（1707b）云端白名单放开了资料那几格，名字、主页、类目规整后照送。
 */
import type { ExtensionProfileRow, ExtensionSession } from '@agentsws/api'
import type { Clock, PersonId, WorkspaceId } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import { CLOUD_TOKEN_SECRET_ID } from '../src/cloud-account.js'
import { createExtensionContributor } from '../src/extension-contribute.js'
import {
  createExtensionService,
  type PublicLibraryContributor,
  type PublicObservationRow,
} from '../src/extension-service.js'
import { createKolStore } from '../src/kol.js'
import { createSecretStore } from '../src/secret-store.js'

const WS = 'ws_1' as WorkspaceId
const NOW = '2026-10-23T09:00:00.000Z'
const clock: Clock = { now: () => NOW }
const session: ExtensionSession = {
  token_id: 'sheet_import',
  workspace_id: WS,
  person_id: 'p_1' as PersonId,
  extension_id: 'sheet_import',
  scopes: ['kol.observe'],
}
const secrets = () =>
  createSecretStore({ dbPath: ':memory:', clock, env: { AGENTSWS_SECRETS_KEY: 'a'.repeat(64) } })

function service(cloud: PublicLibraryContributor) {
  const kol = createKolStore({ workspace_id: WS })
  const port = createExtensionService({
    workspace_id: WS,
    workspaceName: () => '我的品牌',
    store: {} as never,
    kol,
    secrets: secrets(),
    clock,
    random: () => 0.5,
    publicLibrary: cloud,
    serverVersion: '0.1.0',
  })
  return { kol, port }
}

const row = (over: Partial<ExtensionProfileRow>): ExtensionProfileRow => ({
  channel: 'youtube',
  handle: 'kaisetuplab',
  display_name: 'Kai Setup',
  url: 'https://youtube.com/@kaisetuplab',
  followers: 48_000,
  category: '桌搭',
  email: 'kai@kaisetup.example',
  observed_at: NOW,
  ...over,
})

describe('WP489 决策 1707：导入的公开资料 → 公共红人库', () => {
  it('登录了才送；认不出 handle、没有粉丝数的不送；不落本机', async () => {
    const got: PublicObservationRow[] = []
    const cloud: PublicLibraryContributor = {
      linked: () => true,
      contribute: async (rows) => {
        got.push(...rows)
        return { accepted: rows.length }
      },
    }
    const { kol, port } = service(cloud)
    const out = await port.contributeProfiles?.(session, [
      row({}),
      row({ handle: 'UCabcdefghijklmnopqrstuv' }),
      row({ handle: 'nofollowers', followers: undefined }),
    ])
    expect(out).toEqual({ queued: 1 })
    await port.publicForwardIdle()
    expect(got).toHaveLength(1)
    expect(got[0]).toMatchObject({
      channel: 'youtube',
      handle: 'kaisetuplab',
      followers: 48_000,
      contact: { value: 'kai@kaisetup.example', source: 'import' },
      // WP495（1707b）：邮箱照 WP487 那一格上云
      public_contacts: [{ kind: 'email', value: 'kai@kaisetup.example' }],
    })
    expect(kol.creators()).toHaveLength(0)

    const off = service({ linked: () => false, contribute: async () => ({ accepted: 0 }) })
    expect(await off.port.contributeProfiles?.(session, [row({})])).toEqual({ queued: 0 })
  })

  it('WP495（1707b）：送云那一跳不再裁资料——名字、主页、类目规整后在请求体里', async () => {
    const store = secrets()
    store.put(CLOUD_TOKEN_SECRET_ID, { token: 'tok_test' })
    const bodies: string[] = []
    const contributor = createExtensionContributor({
      secrets: store,
      env: { AGENTSWS_CLOUD_URL: 'https://cloud.test' },
      fetch: (async (_url: string, init: { body?: string }) => {
        bodies.push(init.body ?? '')
        return { ok: true, status: 201, json: async () => ({}), text: async () => '{}' }
      }) as never,
    })
    await contributor.contribute([
      {
        channel: 'youtube',
        handle: 'kaisetuplab',
        followers: 48_000,
        observed_at: NOW,
        display_name: 'Kai Setup',
        url: 'https://youtube.com/@kaisetuplab',
        category: '桌搭',
      },
    ])
    expect(bodies).toHaveLength(1)
    const body = bodies[0] as string
    expect(body).toContain('"followers":48000')
    const obs = (JSON.parse(body) as { observations: Record<string, unknown>[] }).observations[0]
    expect(obs).toMatchObject({
      display_name: 'Kai Setup',
      profile_url: 'https://youtube.com/@kaisetuplab',
      categories: ['桌搭'],
    })
    expect(obs).not.toHaveProperty('url')
    expect(obs).not.toHaveProperty('category')
  })
})

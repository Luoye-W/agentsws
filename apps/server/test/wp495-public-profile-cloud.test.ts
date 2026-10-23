/**
 * WP495（1707b）：导入的红人送公共红人库——云端白名单放开了资料那几格，本机送云那一跳不再裁掉
 * 名字 / 主页链接 / 类目 / 语言 / 地区，邮箱照 WP487 走 `public_contacts`。
 *
 * 钉住整条路（导入 → 拼行 → 转发 → HTTP 请求体）：表里那一行带着报价、备注、合作状态、日期、负责人，
 * 最后发出去的请求体里**一个都没有**，键也只在契约白名单里。
 */
import type { ExtensionProfileRow, ExtensionSession, KolActor } from '@agentsws/api'
import type { Clock, PersonId, WorkspaceId } from '@agentsws/contracts'
import {
  PUBLIC_CONTACT_FIELDS,
  PUBLIC_LIBRARY_BUSINESS_KEYS,
  PUBLIC_OBSERVATION_FIELDS,
} from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import { CLOUD_TOKEN_SECRET_ID } from '../src/cloud-account.js'
import { createExtensionContributor } from '../src/extension-contribute.js'
import { createExtensionService } from '../src/extension-service.js'
import { createKolStore } from '../src/kol.js'
import { createKolImport } from '../src/kol-import.js'
import { createSecretStore } from '../src/secret-store.js'

const WS = 'ws_1' as WorkspaceId
const NOW = '2026-10-23T09:00:00.000Z'
const clock: Clock = { now: () => NOW }
const actor = { workspace_id: WS, person_id: 'p_1' } as unknown as KolActor
const session: ExtensionSession = {
  token_id: 'sheet_import',
  workspace_id: WS,
  person_id: 'p_1' as PersonId,
  extension_id: 'sheet_import',
  scopes: ['kol.observe'],
}
const secrets = () =>
  createSecretStore({ dbPath: ':memory:', clock, env: { AGENTSWS_SECRETS_KEY: 'a'.repeat(64) } })

/** 真的转发那一跳（`createExtensionContributor`），fetch 换成记下请求体。 */
function cloudHop() {
  const store = secrets()
  store.put(CLOUD_TOKEN_SECRET_ID, { token: 'tok_test' })
  const bodies: Record<string, unknown>[] = []
  const contributor = createExtensionContributor({
    secrets: store,
    env: { AGENTSWS_CLOUD_URL: 'https://cloud.test' },
    fetch: (async (_url: string, init: { body?: string }) => {
      bodies.push(JSON.parse(init.body ?? '{}') as Record<string, unknown>)
      return { ok: true, status: 201, json: async () => ({}), text: async () => '{}' }
    }) as never,
  })
  const port = createExtensionService({
    workspace_id: WS,
    workspaceName: () => '我的品牌',
    store: {} as never,
    kol: createKolStore({ workspace_id: WS }),
    secrets: secrets(),
    clock,
    random: () => 0.5,
    publicLibrary: contributor,
    serverVersion: '0.1.0',
  })
  const observations = () =>
    bodies.flatMap((b) => (b.observations as Record<string, unknown>[] | undefined) ?? [])
  return { port, bodies, observations }
}

describe('WP495 1707b：资料那几格上云，生意数据永远不上', () => {
  it('导入 → 转发 → 请求体：名字 / 主页 / 类目 / 语言 / 地区 / 公开邮箱都在；报价 / 备注 / 状态 / 日期 / 负责人一个都没有', async () => {
    const cloud = cloudHop()
    let n = 0
    const imp = createKolImport({
      workspace_id: WS,
      store: createKolStore({ workspace_id: WS }),
      secrets: secrets(),
      clock,
      approvals: { create: async (input: unknown) => input } as never,
      random: () => (n++ % 97) / 97,
      contributePublic: async (_a, rows) =>
        cloud.port.contributeProfiles?.(session, rows) ?? { queued: 0 },
    })
    const csv = [
      '达人名称,主页链接,邮箱,粉丝,类目,语言,国家,合作进度,报价,日期,备注,负责人',
      'Kai Setup,https://www.youtube.com/@kaisetuplab,kai@kaisetup.example,48000,"桌搭, Tech",English,美国,已合作,"¥3,000",2025-11-10,效果很好别外传,阿林',
    ].join('\n')
    const view = await imp.previewImport(actor, { filename: 'k.csv', content: csv })
    const done = await imp.commitImport(actor, { job_id: view.job_id as string })
    expect(done.public_library_queued).toBe(1)
    await cloud.port.publicForwardIdle()

    const [obs] = cloud.observations()
    expect(obs).toMatchObject({
      channel: 'youtube',
      handle: 'kaisetuplab',
      followers: 48000,
      display_name: 'Kai Setup',
      profile_url: 'https://youtube.com/@kaisetuplab',
      categories: ['桌搭', 'tech'],
      language: 'en',
      region: 'US',
      public_contacts: [{ kind: 'email', value: 'kai@kaisetup.example' }],
    })
    // 键只在契约白名单里；生意数据的键一个都没有
    const allowed = new Set<string>(PUBLIC_OBSERVATION_FIELDS)
    for (const key of Object.keys(obs ?? {})) expect(allowed.has(key)).toBe(true)
    for (const key of PUBLIC_LIBRARY_BUSINESS_KEYS) expect(obs).not.toHaveProperty(key)
    for (const c of (obs?.public_contacts as Record<string, unknown>[]) ?? [])
      for (const key of Object.keys(c))
        expect((PUBLIC_CONTACT_FIELDS as readonly string[]).includes(key)).toBe(true)
    // 值也一个都不出去
    const text = JSON.stringify(cloud.bodies)
    for (const leak of [
      '3,000',
      '3000',
      '已合作',
      '2025-11-10',
      '效果很好',
      '别外传',
      '阿林',
      'CNY',
    ])
      expect(text).not.toContain(leak)
  })

  it('认不出的那一格丢掉、别的照送（云端一格不合格整批拒，本机先筛干净）', async () => {
    const cloud = cloudHop()
    const row: ExtensionProfileRow = {
      channel: 'tiktok',
      handle: 'deskbuddy',
      display_name: '  Desk\u0007 Buddy  ',
      url: 'https://www.tiktok.com/@deskbuddy?session=abc',
      followers: 9_000,
      category: '',
      language: '火星语',
      region: 'North America',
      email: 'not-an-email',
      observed_at: NOW,
    }
    expect(await cloud.port.contributeProfiles?.(session, [row])).toEqual({ queued: 1 })
    await cloud.port.publicForwardIdle()
    const [obs] = cloud.observations()
    expect(obs).toEqual({
      channel: 'tiktok',
      handle: 'deskbuddy',
      followers: 9000,
      display_name: 'Desk Buddy',
      observed_at: NOW,
    })
  })

  it('插件来的观察（没有资料那几格）请求体不变', async () => {
    const cloud = cloudHop()
    await cloud.port.contributeProfiles?.(session, [
      { channel: 'youtube', handle: 'plain', followers: 10, observed_at: NOW },
    ])
    await cloud.port.publicForwardIdle()
    expect(cloud.observations()).toEqual([
      { channel: 'youtube', handle: 'plain', followers: 10, observed_at: NOW },
    ])
  })
})

/**
 * WP416（自查 kol D「插件收录」）：同一个 YouTube 频道先从 `/channel/UC…` 收、再从 `/@name` 收，
 * 是同一个人（以前只按 handle 比，变成两个人；`saveCreator` 还回「已去重」实际却新建了一条）。
 */
import type { ExtensionSession } from '@agentsws/api'
import type { PersonId, WorkspaceId } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import { createExtensionService } from '../src/extension-service.js'
import { createKolStore } from '../src/kol.js'
import { createSecretStore } from '../src/secret-store.js'

const WS = 'ws_1' as WorkspaceId
const NOW = '2026-10-19T10:00:00.000Z'
const UC = 'UCabcdefghijklmnopqrstuv'

const session: ExtensionSession = {
  token_id: 'ext_0001',
  workspace_id: WS,
  person_id: 'pr_1' as PersonId,
  extension_id: 'abcdefghijklmnop',
  scopes: ['kol.observe', 'kol.capture', 'kol.read'],
}

function assemble() {
  const clock = { now: () => NOW }
  const kol = createKolStore({ workspace_id: WS })
  const secrets = createSecretStore({
    dbPath: ':memory:',
    clock,
    env: { AGENTSWS_SECRETS_KEY: 'a'.repeat(64) },
  })
  const port = createExtensionService({
    workspace_id: WS,
    workspaceName: () => '我的品牌',
    store: {} as never,
    kol,
    secrets,
    clock,
    random: () => 0.5,
    serverVersion: '0.1.0',
  })
  return { port, kol }
}

describe('WP416 插件收录：同一频道两种链接收成同一个人', () => {
  it('先 /channel/UC…、再 /@name：一个人；handle 换成真名字；第二次回「已去重」', async () => {
    const { port, kol } = assemble()
    const a = await port.saveCreator(session, {
      channel: 'youtube',
      handle: UC,
      external_id: UC,
      followers: 48_000,
      observed_at: NOW,
    })
    expect(a.status).toBe('ok')
    const b = await port.saveCreator(session, {
      channel: 'youtube',
      handle: '@deskcraft',
      external_id: UC,
      followers: 48_100,
      observed_at: NOW,
    })
    expect(b.status).toBe('deduped')
    expect(b.creator_id).toBe(a.creator_id)
    const accounts = kol.accounts({ channel: 'youtube' })
    expect(accounts).toHaveLength(1)
    expect(accounts[0]?.handle).toBe('@deskcraft')
    expect(accounts[0]?.external_id).toBe(UC)
  })

  it('反过来（先 /@name 带着 id、再 /channel/UC…）也是一个人，handle 不被 UC… 盖掉', async () => {
    const { port, kol } = assemble()
    await port.saveCreator(session, {
      channel: 'youtube',
      handle: '@deskcraft',
      external_id: UC,
      observed_at: NOW,
    })
    const b = await port.saveCreator(session, {
      channel: 'youtube',
      handle: UC,
      external_id: UC,
      observed_at: NOW,
    })
    expect(b.status).toBe('deduped')
    const accounts = kol.accounts({ channel: 'youtube' })
    expect(accounts).toHaveLength(1)
    expect(accounts[0]?.handle).toBe('@deskcraft')
  })
})

/**
 * WP119（68）：插件报上来的观测怎么落本机、什么时候往公共红人库送。
 *
 * 这一组守的是 Luoye 09-19 那条定论的两面：
 * - **登录了就默认共享，没有勾选项**——所以测试里没有任何「打开贡献开关」的一步；
 * - **没登录一条都不上传**——这一条比上一条更要紧，所以单独测。
 *
 * 还有一条贯穿的：**本机先落，云是加分项**。云挂了、云拒了、没登录，
 * 用户按下的那一下都必须留在他自己的电脑上。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ExtensionObservation, ExtensionSession } from '@agentsws/api'
import type { Clock, PersonId, WorkspaceId } from '@agentsws/contracts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PublicLibraryContributor } from '../src/extension-service.js'
import { createExtensionService, normalizeHandle } from '../src/extension-service.js'
import type { KolStore } from '../src/kol.js'
import { createKolStore } from '../src/kol.js'
import type { SecretStore } from '../src/secret-store.js'
import { createSecretStore } from '../src/secret-store.js'

const WS = 'ws_1' as WorkspaceId
const NOW = '2026-09-19T10:00:00.000Z'
const clock: Clock = { now: () => NOW }

const dirs: string[] = []
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'agentsws-ext-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const session: ExtensionSession = {
  token_id: 'ext_0001',
  workspace_id: WS,
  person_id: 'pr_1' as PersonId,
  extension_id: 'abcdefghijklmnop',
  scopes: ['kol.observe', 'kol.capture', 'kol.read'],
}

const obs = (over: Partial<ExtensionObservation> = {}): ExtensionObservation => ({
  channel: 'youtube',
  handle: '@fixture',
  display_name: '夹具频道',
  followers: 123_000,
  followers_text: '12.3万位订阅者',
  observed_at: NOW,
  source: 'channel_page',
  ...over,
})

/** 建一套真的库（sqlite 落临时目录）+ 一把加密库。 */
function assemble(cloud?: PublicLibraryContributor): {
  kol: KolStore
  secrets: SecretStore
  port: ReturnType<typeof createExtensionService>
} {
  const dir = tmp()
  const kol = createKolStore({ workspace_id: WS, dbDir: dir })
  const secrets = createSecretStore({
    dbPath: ':memory:',
    clock,
    // 64 位十六进制：一把测试用的密钥，仓库里没有任何真钥
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
    ...(cloud === undefined ? {} : { publicLibrary: cloud }),
    serverVersion: '0.1.0',
  })
  return { kol, secrets, port }
}

describe('normalizeHandle', () => {
  it('@Foo / foo / @foo 是同一个人', () => {
    expect(normalizeHandle('@Foo')).toBe('foo')
    expect(normalizeHandle(' foo ')).toBe('foo')
    expect(normalizeHandle('@@foo')).toBe('foo')
  })
})

describe('落本机', () => {
  it('第一次是 ok，第二次是 deduped（而且数字被刷新了）', async () => {
    const { kol, port } = assemble()
    const first = await port.ingest(session, { observations: [obs()] })
    expect(first.rows[0]?.status).toBe('ok')
    expect(kol.creators()).toHaveLength(1)
    expect(kol.accounts({ channel: 'youtube' })[0]?.followers).toBe(123_000)

    const second = await port.ingest(session, {
      observations: [obs({ followers: 130_000, observed_at: '2026-09-20T10:00:00.000Z' })],
    })
    expect(second.rows[0]?.status).toBe('deduped')
    expect(kol.creators()).toHaveLength(1)
    // deduped **不是失败**：库里那条的数字已经被这一次刷新了
    expect(kol.accounts({ channel: 'youtube' })[0]?.followers).toBe(130_000)
    expect(kol.accounts({ channel: 'youtube' })[0]?.observed_at).toBe('2026-09-20T10:00:00.000Z')
  })

  it('handle 归一化之后是同一个人，不会堆出三条', async () => {
    const { kol, port } = assemble()
    await port.ingest(session, { observations: [obs({ handle: '@Fixture' })] })
    await port.ingest(session, { observations: [obs({ handle: 'fixture' })] })
    expect(kol.creators()).toHaveLength(1)
  })

  it('同一个 handle 在两条渠道上是两个账号', async () => {
    const { kol, port } = assemble()
    await port.ingest(session, {
      observations: [obs(), obs({ channel: 'tiktok' })],
    })
    expect(kol.accounts({ channel: 'youtube' })).toHaveLength(1)
    expect(kol.accounts({ channel: 'tiktok' })).toHaveLength(1)
  })

  it('没有 handle 的那条记 invalid，**不影响同一批里的其它条**', async () => {
    const { kol, port } = assemble()
    const out = await port.ingest(session, { observations: [obs({ handle: '  ' }), obs()] })
    expect(out.rows[0]?.status).toBe('invalid')
    expect(out.rows[1]?.status).toBe('ok')
    expect(kol.creators()).toHaveLength(1)
  })
})

describe('联系方式', () => {
  it('明文进加密库，库里只留 value_ref', async () => {
    const { kol, secrets, port } = assemble()
    await port.ingest(session, {
      observations: [
        obs({
          contact: { kind: 'email', value: 'hi@example.com', source: 'https://youtube.com/@f' },
        }),
      ],
    })
    const creator = kol.creators()[0]
    if (creator === undefined) throw new Error('unreachable')
    const contact = kol.contacts(creator.id)[0]
    expect(contact?.value_ref).toBeDefined()
    // 库里那一行从头到尾没有明文
    expect(JSON.stringify(contact)).not.toContain('hi@example.com')
    // 明文只在加密库里
    expect(secrets.get(contact?.value_ref ?? '')?.value).toBe('hi@example.com')
  })

  it('没带联系方式就不建（页面上读到 ≠ 用户收下）', async () => {
    const { kol, port } = assemble()
    await port.ingest(session, { observations: [obs()] })
    const creator = kol.creators()[0]
    expect(kol.contacts(creator?.id ?? '')).toHaveLength(0)
  })
})

describe('往公共红人库转发（Luoye 09-19：登录了就默认共享，没有勾选项）', () => {
  const linkedCloud = (accepted = 1): PublicLibraryContributor & { rows: unknown[] } => {
    const rows: unknown[] = []
    return {
      rows,
      linked: () => true,
      contribute: async (input) => {
        rows.push(...input)
        return { accepted: accepted * input.length }
      },
    }
  }

  it('没关联云账号 = 一条都不上传', async () => {
    const cloud: PublicLibraryContributor = {
      linked: () => false,
      contribute: vi.fn(async () => ({ accepted: 99 })),
    }
    const { port } = assemble(cloud)
    const out = await port.ingest(session, { observations: [obs()] })
    expect(out.forwarded_to_public_library).toBe(0)
    expect(cloud.contribute).not.toHaveBeenCalled()
  })

  it('关联了就送——没有任何开关要打开', async () => {
    const cloud = linkedCloud()
    const { port } = assemble(cloud)
    const out = await port.ingest(session, { observations: [obs()] })
    expect(out.forwarded_to_public_library).toBe(1)
  })

  it('送上去的是**页面原文**与渠道 / handle，不带 bio、不带主页参数', async () => {
    const cloud = linkedCloud()
    const { port } = assemble(cloud)
    await port.ingest(session, {
      observations: [obs({ bio: '这是他写的一段文案', url: 'https://www.youtube.com/@f?si=abc' })],
    })
    const sent = cloud.rows[0] as Record<string, unknown>
    expect(sent.followers_text).toBe('12.3万位订阅者')
    expect(sent.bio).toBe(undefined)
    expect(sent.url).toBe(undefined)
    expect(sent.avatar_url).toBe(undefined)
  })

  it('私信 / 表单那种联系方式不往公共库送，只有公开邮箱送', async () => {
    const cloud = linkedCloud()
    const { port } = assemble(cloud)
    await port.ingest(session, {
      observations: [
        obs({ handle: '@a', contact: { kind: 'dm', value: 'https://ig.com/direct/x' } }),
        obs({ handle: '@b', contact: { kind: 'email', value: 'hi@example.com' } }),
      ],
    })
    expect((cloud.rows[0] as Record<string, unknown>).contact).toBe(undefined)
    expect((cloud.rows[1] as Record<string, unknown>).contact).toEqual({
      value: 'hi@example.com',
    })
  })

  it('云那一跳挂了**不影响本机那一半**，回执里如实报 0', async () => {
    const cloud: PublicLibraryContributor = {
      linked: () => true,
      contribute: async () => {
        throw new Error('云炸了')
      },
    }
    const { kol, port } = assemble(cloud)
    const out = await port.ingest(session, { observations: [obs()] })
    expect(out.rows[0]?.status).toBe('ok')
    expect(out.forwarded_to_public_library).toBe(0)
    expect(kol.creators()).toHaveLength(1)
  })
})

describe('hello', () => {
  it('没关联时如实说不共享', async () => {
    const { port } = assemble()
    const said = await port.hello(session)
    expect(said.workspace_name).toBe('我的品牌')
    expect(said.cloud_linked).toBe(false)
    expect(said.shares_to_public_library).toBe(false)
  })

  it('关联了 = 共享。两格是同一个事实，不是两个设置', async () => {
    const { port } = assemble({ linked: () => true, contribute: async () => ({ accepted: 0 }) })
    const said = await port.hello(session)
    expect(said.cloud_linked).toBe(true)
    expect(said.shares_to_public_library).toBe(true)
  })
})

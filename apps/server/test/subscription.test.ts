/**
 * WP90（55 §9 Q8）：订阅登录的服务端装配。
 *
 * 五件事各钉一条：
 * - **只在个人档**：`AGENTSWS_RUNTIME_MODE=docker|hosted` 上整块不可用，
 *   `login` 直接被拒；没有秘密库密钥也一样（凭据无处安全存放）。
 * - **凭据按人分开**：key 名是 `subscription:<person_id>:<provider>`，
 *   别人的那一条**读不到**（不是"没权限"，是"不存在"）。
 * - **登录流是官方的**：这里只把 `begin()` 报上来的"去这个网址、输这串码"
 *   转给界面，并在人贴回授权码时把那一条问题答掉。
 * - **登出销毁**：本机那条记录当场没有。
 * - **零泄漏**：token 一个字节都不在任何一个返回值里。
 *
 * 对手方是 `fakeLogin()`——一个把 `createSubscriptionLogin` 整个换掉的替身
 * （dsh 那一侧另有 `packages/dsh-adapter/test/subscription.test.ts` 用假 OAuth
 * 服务器跑真流程）。这里要证的是**装配与边界**，不是再跑一遍 OAuth。
 */
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ModelsActor } from '@agentsws/api'
import type { Clock } from '@agentsws/contracts'
import type { SubscriptionLoginHandle } from '@agentsws/dsh-adapter'
import { afterEach, describe, expect, it } from 'vitest'
import { createSecretStore, SECRETS_KEY_ENV, type SecretStore } from '../src/secret-store.js'
import {
  createSubscription,
  SUBSCRIPTION_UNAVAILABLE,
  subscriptionSecretId,
} from '../src/subscription.js'

const CLOCK: Clock = { now: () => '2026-09-17T09:00:00.000Z' }
const KEY = randomBytes(32).toString('hex')

const dirs: string[] = []
const stores: SecretStore[] = []
afterEach(() => {
  for (const s of stores.splice(0)) s.close()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agentsws-subscription-'))
  dirs.push(dir)
  return dir
}

function secretStore(withKey = true): SecretStore {
  const s = createSecretStore({
    dbPath: ':memory:',
    clock: CLOCK,
    env: withKey ? { [SECRETS_KEY_ENV]: KEY } : {},
  })
  stores.push(s)
  return s
}

const actor = (person_id = 'p_luoye'): ModelsActor => ({
  workspace_id: 'ws_local',
  person_id,
  assignment_id: 'asg_1',
  role_id: 'owner',
})

/** 这个替身的"本机库"就是调用方给的那个 provider 插件读写的那一个——见下。 */
interface FakeLogin extends SubscriptionLoginHandle {
  /** 用例手动推进流程：喂一条进展 / 一个问题 / 结束。 */
  notices: { message: string; url?: string; code?: string }[]
  finish(): void
  fail(message: string): void
  askNow(): void
  answered: string[]
  signedOut: string[]
  rows: Map<string, { access: string; refresh: string; accountId: string; expires: number }>
}

/**
 * 换掉 dsh 那一整棵树。
 *
 * 它不碰 `credentials` 插件——那一半在 `packages/dsh-adapter` 的用例里跑过真的了；
 * 这里要证的是服务端这一层的边界与状态机，所以记录就放在替身自己的 Map 里。
 */
function fakeLogin(): FakeLogin {
  const rows = new Map<
    string,
    { access: string; refresh: string; accountId: string; expires: number }
  >()
  const notices: { message: string; url?: string; code?: string }[] = []
  const answered: string[] = []
  const signedOut: string[] = []
  let settle: (() => void) | undefined
  let reject: ((e: Error) => void) | undefined
  let ask: (() => void) | undefined

  const handle: FakeLogin = {
    notices,
    answered,
    signedOut,
    rows,
    finish: () => settle?.(),
    fail: (message) => reject?.(new Error(message)),
    askNow: () => ask?.(),
    async status(provider) {
      const row = rows.get(provider)
      return row === undefined
        ? { provider, signed_in: false }
        : {
            provider,
            signed_in: true,
            // 与真的那一半同一条规矩：头四位 + 尾四位
            account: `${row.accountId.slice(0, 4)}…${row.accountId.slice(-4)}`,
            expires_at: new Date(row.expires).toISOString(),
          }
    },
    async models(provider) {
      return provider === 'anthropic'
        ? [{ id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5' }]
        : [{ id: 'gpt-5.4', name: 'GPT-5.4' }]
    },
    async begin(request) {
      request.notify({
        message: '在这一页上输入这串码',
        url: 'https://auth.openai.com/codex/device',
        code: 'ABCD-1234',
      })
      notices.push({ message: 'begin', code: 'ABCD-1234' })
      ask = () => {
        void request
          .ask({ kind: 'text', message: '把授权码贴回来', placeholder: 'http://localhost:1455' })
          .then((v) => answered.push(v))
      }
      return new Promise<'authorized' | 'cancelled'>((resolve, rej) => {
        settle = () => {
          rows.set(request.provider, {
            access: 'ACCESS-TOKEN-SECRET',
            refresh: 'REFRESH-TOKEN-SECRET',
            accountId: 'acct_0123456789abcdef',
            expires: Date.parse('2026-09-17T10:00:00.000Z'),
          })
          resolve('authorized')
        }
        reject = rej
      })
    },
    cancel() {
      settle = undefined
    },
    async signOut(provider) {
      signedOut.push(provider)
      rows.delete(provider)
    },
    async dispose() {
      settle = undefined
    },
  }
  return handle
}

function assembly(
  over: {
    mode?: 'local' | 'docker' | 'hosted'
    secrets?: SecretStore
    login?: FakeLogin
    dbDir?: string
  } = {},
) {
  const login = over.login ?? fakeLogin()
  const a = createSubscription({
    clock: CLOCK,
    secrets: over.secrets ?? secretStore(),
    runtimeMode: () => over.mode ?? 'local',
    ...(over.dbDir === undefined ? {} : { dbDir: over.dbDir }),
    createLogin: async () => login,
  })
  return { ...a, login }
}

describe('只在个人档', () => {
  it('公司档 / 托管档：整块不可用，起登录直接被拒', async () => {
    for (const mode of ['docker', 'hosted'] as const) {
      const a = assembly({ mode })
      const rows = await a.port.list(actor())
      expect(rows).toHaveLength(2)
      for (const row of rows) {
        expect(row.available).toBe(false)
        expect(row.unavailable_reason).toBe(SUBSCRIPTION_UNAVAILABLE)
        expect(row.signed_in).toBe(false)
      }
      await expect(
        a.port.login(actor(), { provider: 'openai-codex', method: 'device' }),
      ).rejects.toThrow(/公司档/)
      await a.close()
    }
  })

  it('没有秘密库密钥也不开（凭据无处安全存放），但话说得不一样', async () => {
    const a = assembly({ secrets: secretStore(false) })
    const row = await a.port.get(actor(), 'openai-codex')
    expect(row.available).toBe(false)
    expect(row.unavailable_reason).toContain('秘密库密钥')
    await a.close()
  })

  it('个人档 + 有密钥：两张卡都能用，方式是实测出来的那两套', async () => {
    const a = assembly()
    const rows = await a.port.list(actor())
    const chatgpt = rows.find((r) => r.provider === 'openai-codex')
    const claude = rows.find((r) => r.provider === 'anthropic')
    expect(chatgpt?.available).toBe(true)
    expect(chatgpt?.methods).toEqual(['device', 'browser'])
    // Claude 没有设备码（pi-ai 的 anthropic 流只有浏览器）
    expect(claude?.methods).toEqual(['browser'])
    for (const row of rows) {
      expect(row.risk_note).toContain('可能被限流或封禁')
      expect(row.risk_note).toContain('账号只属于你本人')
    }
    await a.close()
  })
})

describe('登录 → 落库 → 选模型 → 登出', () => {
  it('设备码那一条原样转给界面；登录完状态是脱敏的', async () => {
    const a = assembly()
    const started = await a.port.login(actor(), { provider: 'openai-codex', method: 'device' })
    expect(started.in_flight).toBe(true)
    expect(started.notice?.code).toBe('ABCD-1234')
    expect(started.notice?.url).toBe('https://auth.openai.com/codex/device')
    expect(started.signed_in).toBe(false)

    a.login.finish()
    // 让 begin 的 then 链跑完
    await new Promise((r) => setTimeout(r, 0))

    const done = await a.port.get(actor(), 'openai-codex')
    expect(done.signed_in).toBe(true)
    expect(done.in_flight).toBe(false)
    expect(done.account).toBe('acct…cdef')
    expect(done.expires_at).toBe('2026-09-17T10:00:00.000Z')
    // 登录之后才有模型清单（目录来自 pi-ai）
    expect(done.models).toEqual([{ id: 'gpt-5.4', name: 'GPT-5.4' }])

    const chosen = await a.port.selectModel(actor(), 'openai-codex', 'gpt-5.4')
    expect(chosen.selected_model).toBe('gpt-5.4')

    await a.port.signOut(actor(), 'openai-codex')
    expect(a.login.signedOut).toEqual(['openai-codex'])
    expect((await a.port.get(actor(), 'openai-codex')).signed_in).toBe(false)
    await a.close()
  })

  it('浏览器流问"把授权码贴回来"：问题露给界面，答完就消失', async () => {
    const a = assembly()
    await a.port.login(actor(), { provider: 'anthropic', method: 'browser' })
    a.login.askNow()
    await new Promise((r) => setTimeout(r, 0))

    const asking = await a.port.get(actor(), 'anthropic')
    expect(asking.question?.message).toBe('把授权码贴回来')
    expect(asking.question?.kind).toBe('text')

    await a.port.answer(actor(), 'anthropic', 'code-from-browser')
    expect(a.login.answered).toEqual(['code-from-browser'])
    expect((await a.port.get(actor(), 'anthropic')).question).toBeUndefined()
    await a.close()
  })

  it('登录失败时把那句人话留在卡上，不留 token 线索', async () => {
    const a = assembly()
    await a.port.login(actor(), { provider: 'openai-codex', method: 'device' })
    a.login.fail('OpenAI Codex device auth failed with status 429')
    await new Promise((r) => setTimeout(r, 0))
    const row = await a.port.get(actor(), 'openai-codex')
    expect(row.in_flight).toBe(false)
    expect(row.last_error).toContain('429')
    expect(JSON.stringify(row)).not.toContain('ACCESS-TOKEN-SECRET')
    await a.close()
  })
})

describe('按人分开：别人的那一条读不到', () => {
  it('key 名带 person_id；另一个人的记录在这个人眼里不存在', async () => {
    const secrets = secretStore()
    // 先手工塞一条"另一个人"的记录（模拟同一台机器上两个人各登各的）
    secrets.put(subscriptionSecretId('p_other', 'openai-codex'), {
      record: JSON.stringify({ type: 'oauth', access: 'OTHER-SECRET', expires: 1 }),
    })
    expect(secrets.list().map((r) => r.connection_id)).toEqual([
      'subscription:p_other:openai-codex',
    ])

    // 这个人的登录落在自己的那条 key 下
    const a = assembly({ secrets })
    const rows = await a.port.list(actor('p_luoye'))
    expect(rows.every((r) => r.signed_in === false)).toBe(true)
    // 别人的值一个字节都不在这个人的返回里
    expect(JSON.stringify(rows)).not.toContain('OTHER-SECRET')
    await a.close()
  })
})

describe('零泄漏', () => {
  it('列表、单条、登录返回值里都查不到 access / refresh token', async () => {
    const a = assembly()
    await a.port.login(actor(), { provider: 'openai-codex', method: 'device' })
    a.login.finish()
    await new Promise((r) => setTimeout(r, 0))
    const haystack = JSON.stringify([
      await a.port.list(actor()),
      await a.port.get(actor(), 'openai-codex'),
    ])
    expect(haystack).not.toContain('ACCESS-TOKEN-SECRET')
    expect(haystack).not.toContain('REFRESH-TOKEN-SECRET')
    expect(haystack).not.toContain('acct_0123456789abcdef')
    await a.close()
  })
})

/**
 * WP117 交付 4：**演练模式**，端到端（起真进程 → 打 HTTP）。
 *
 * 钉五件事，第一件是安全底线，其余四件是"演练真能玩得起来"：
 *
 * 1. **真发送路径在演练活动里被硬拦。** 这是本单唯一一条"错了会真伤人"的
 *    规矩——一封演练的信真发到某个红人邮箱里，是收不回来的。所以拦的那一句
 *    钉在**出站那一跳**（`deliverOutbound` 的 `kolSandboxIntercept`），
 *    不是钉在界面开关上：界面能被绕过，那一句绕不过去。
 * 2. 开演练 = 库里多一批带 `sandbox` 标记的合成红人（六种性格都在）。
 * 3. 时间能快进，快进之后回信真的到了，并把合作推到「有回音」；退信那一条
 *    推到「谢绝了」。
 * 4. 一键清空只清带标记的，真数据一条不碰。
 * 5. 演练红人的邮箱一律在 example 那一族——库里不该出现一个可能真存在的地址。
 */
import type { Assignment } from '@agentsws/contracts'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from '../src/index.js'
import { kolSandboxIntercept, SANDBOX_BANNER } from '../src/kol-sandbox.js'

const T0 = '2026-09-15T09:00:00.000Z'
const SECRETS_KEY = 'd'.repeat(64)

function seeded(seed = 117): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

let server: Server
let url: string
let youtube: Assignment

const api = async (path: string, init: RequestInit = {}): Promise<Response> => {
  const headers = new Headers(init.headers)
  headers.set('Authorization', `Bearer ${server.bootstrap.internalToken}`)
  headers.set('X-Assignment', youtube.id)
  if (init.body !== undefined) headers.set('content-type', 'application/json')
  return fetch(`${url}${path}`, { ...init, headers })
}

const data = async <T>(res: Response): Promise<T> => ((await res.json()) as { data: T }).data

interface SandboxStatus {
  on: boolean
  now: string
  creators: number
  collaborations: number
  sent: number
  replies: number
  pending: number
  banner: string
}

interface AdvanceResult extends SandboxStatus {
  advanced_days: number
  received: {
    creator_id: string
    display_name: string
    collaboration_id?: string
    subject: string
    body: string
    bounce_reason?: string
  }[]
}

/** bootstrap 品牌那一套（库、加密库、演练场都按品牌一份）。 */
const brand = async () => server.brands.forWorkspace(server.bootstrap.workspace.id)

const start = async (): Promise<SandboxStatus> =>
  data<SandboxStatus>(
    await api('/v1/kol/sandbox', { method: 'POST', body: JSON.stringify({ channel: 'youtube' }) }),
  )

const advance = async (days: number): Promise<AdvanceResult> =>
  data<AdvanceResult>(
    await api('/v1/kol/sandbox/advance', { method: 'POST', body: JSON.stringify({ days }) }),
  )

beforeEach(async () => {
  server = await createServer({
    quiet: true,
    clock: { now: () => T0 },
    random: seeded(),
    scheduleIntervalMs: 0,
    startRun: false,
    env: { AGENTSWS_OWNER_EMAIL: 'luoye@example.com', AGENTSWS_SECRETS_KEY: SECRETS_KEY },
  })
  ;({ url } = await server.listen(0))
  youtube = server.roles.assignments.create({
    person_id: server.bootstrap.person.id,
    workspace_id: server.bootstrap.workspace.id,
    role_id: 'kol.youtube',
    granted_by: server.bootstrap.person.id,
    ranges: [{ kind: 'store', id: 'store_1' }],
  })
})

afterEach(async () => {
  await server.close()
})

describe('开演练', () => {
  it('没开之前：status 说 on=false，库里一条演练数据都没有', async () => {
    const before = await data<SandboxStatus>(await api('/v1/kol/sandbox'))
    expect(before.on).toBe(false)
    expect(before.creators).toBe(0)
    expect(before.banner).toBe(SANDBOX_BANNER)
  })

  it('开了之后：库里多一批带 sandbox 标记的人，每人一条合作', async () => {
    const status = await start()
    expect(status.on).toBe(true)
    expect(status.creators).toBeGreaterThan(10)
    expect(status.collaborations).toBe(status.creators)

    const { kol } = await brand()
    const sandboxed = kol.creators().filter((c) => c.sandbox === true)
    expect(sandboxed.length).toBe(status.creators)
    // 真数据与演练数据分得开：demo 那几条没有这一格
    expect(kol.creators().every((c) => c.sandbox === true)).toBe(true)
  })

  it('再开一次是幂等的，不会铺出两批人', async () => {
    const first = await start()
    const second = await start()
    expect(second.creators).toBe(first.creators)
  })

  it('演练红人的邮箱一律在 example 那一族', async () => {
    await start()
    const { kol } = await brand()
    for (const creator of kol.creators().filter((c) => c.sandbox === true)) {
      for (const contact of kol.contacts(creator.id)) {
        const value = (await brand()).secrets.get(contact.value_ref)?.value
        expect(typeof value).toBe('string')
        expect(value as string).toMatch(/@(example\.com|invalid\.example)$/)
      }
    }
  })
})

describe('时间快进', () => {
  it('不发信就没有回信——世界不会自己开口', async () => {
    await start()
    const got = await advance(7)
    expect(got.advanced_days).toBe(7)
    expect(got.received).toEqual([])
  })

  it('发了信再快进：回信到了，合作推到「有回音」；退信那条推到「谢绝了」', async () => {
    await start()
    const { kol } = await brand()
    const { kolSandbox: sandbox } = await brand()

    // 照真路子把信递给出站那一跳（payload 里是加密库 key 名，不是地址）
    for (const creator of kol.creators().filter((c) => c.sandbox === true)) {
      const contact = kol.contacts(creator.id)[0]
      if (contact === undefined) continue
      const verdict = sandbox.intercept({
        recipients: [contact.value_ref],
        subject: 'Collab with Acme',
        body: 'Hi, we would love to work with you.',
      })
      expect(verdict, '演练红人的信必须被拦下').toBeDefined()
    }

    const got = await advance(10)
    expect(got.received.length).toBeGreaterThan(0)

    const bounced = got.received.filter((r) => r.bounce_reason !== undefined)
    expect(bounced.length, '合成世界里必须有退信那一条分叉').toBeGreaterThan(0)
    for (const row of bounced) {
      const collab = kol.collaborations().find((c) => c.id === row.collaboration_id)
      expect(collab?.stage).toBe('declined')
    }

    const replied = got.received.filter((r) => r.bounce_reason === undefined)
    expect(replied.length).toBeGreaterThan(0)
    for (const row of replied) {
      const collab = kol.collaborations().find((c) => c.id === row.collaboration_id)
      expect(collab?.stage).toBe('replied')
    }
  })

  it('演练世界的钟往前走，真时钟一秒不动', async () => {
    await start()
    const before = await data<SandboxStatus>(await api('/v1/kol/sandbox'))
    const after = await advance(3)
    expect(Date.parse(after.now) - Date.parse(before.now)).toBe(3 * 86_400_000)
    // 真时钟是测试里钉死的那一个：演练推的是另一个钟
    expect(before.now).toBe(T0)
  })
})

describe('出站硬闸（本单唯一一条「错了会真伤人」的规矩）', () => {
  it('收件人是演练红人 → 拦下，改投内存邮箱；回 ok，不让执行器无限重试', async () => {
    await start()
    const { kol } = await brand()
    const creator = kol.creators().find((c) => c.sandbox === true)
    const contact = kol.contacts(creator?.id ?? '')[0]
    expect(contact).toBeDefined()

    const verdict = kolSandboxIntercept(
      { kolSandbox: (await brand()).kolSandbox },
      { payload: { recipients: [contact?.value_ref], subject: 's', body: 'b' } },
    )
    expect(verdict?.status).toBe('ok')
    expect(verdict?.outcome_ref.type).toBe('kol_sandbox_mail')
    // 真投进了内存邮箱
    expect((await data<SandboxStatus>(await api('/v1/kol/sandbox'))).sent).toBe(1)
  })

  it('收件人不是演练红人 → 不拦，照常往真渠道走', async () => {
    await start()
    const verdict = kolSandboxIntercept(
      { kolSandbox: (await brand()).kolSandbox },
      { payload: { recipients: ['kol.contact.ctc_real_1'], subject: 's', body: 'b' } },
    )
    expect(verdict).toBeUndefined()
  })

  it('一封信里混了真人与演练红人 → **一律拦**（宁可少发一封，不许误发一封）', async () => {
    await start()
    const { kol } = await brand()
    const creator = kol.creators().find((c) => c.sandbox === true)
    const contact = kol.contacts(creator?.id ?? '')[0]
    const verdict = kolSandboxIntercept(
      { kolSandbox: (await brand()).kolSandbox },
      {
        payload: {
          recipients: ['kol.contact.ctc_real_1', contact?.value_ref],
          subject: 's',
          body: 'b',
        },
      },
    )
    expect(verdict?.status).toBe('ok')
  })

  it('演练没开着的时候，这一句什么都不拦', async () => {
    const verdict = kolSandboxIntercept(
      { kolSandbox: (await brand()).kolSandbox },
      { payload: { recipients: ['kol.contact.whatever'], subject: 's', body: 'b' } },
    )
    expect(verdict).toBeUndefined()
  })

  it('不是开发信的出站（没有 recipients 那一格）不归它管', async () => {
    await start()
    expect(
      kolSandboxIntercept(
        { kolSandbox: (await brand()).kolSandbox },
        { payload: { channel: 'chat', text: 'hi' } },
      ),
    ).toBeUndefined()
  })
})

describe('一键清空', () => {
  it('清掉所有带标记的；真红人一条不碰', async () => {
    const { kol } = await brand()
    // 一条真红人（没有 sandbox 那一格）
    kol.saveCreator({ id: 'cre_real_1', display_name: '真的红人', merged_from: [] })
    await start()
    expect(kol.creators().length).toBeGreaterThan(10)

    const after = await data<SandboxStatus>(await api('/v1/kol/sandbox', { method: 'DELETE' }))
    expect(after.on).toBe(false)
    expect(after.creators).toBe(0)
    expect(kol.creators().map((c) => c.id)).toEqual(['cre_real_1'])
    expect(kol.collaborations()).toEqual([])
  })

  it('清空也把加密库里那批地址删掉——不留一堆没人管的钥匙', async () => {
    await start()
    const { kol } = await brand()
    const refs = kol
      .creators()
      .filter((c) => c.sandbox === true)
      .flatMap((c) => kol.contacts(c.id).map((ct) => ct.value_ref))
    expect(refs.length).toBeGreaterThan(0)
    await api('/v1/kol/sandbox', { method: 'DELETE' })
    for (const ref of refs) expect((await brand()).secrets.get(ref)).toBeUndefined()
  })

  it('清空之后再开是一场新的——上一场的信不串过来', async () => {
    await start()
    const { kol } = await brand()
    const contact = kol.contacts(kol.creators().find((c) => c.sandbox === true)?.id ?? '')[0]
    const { kolSandbox } = await brand()
    kolSandbox.intercept({ recipients: [contact?.value_ref ?? ''], subject: 's', body: 'b' })
    expect((await data<SandboxStatus>(await api('/v1/kol/sandbox'))).sent).toBe(1)
    await api('/v1/kol/sandbox', { method: 'DELETE' })
    const fresh = await start()
    expect(fresh.sent).toBe(0)
    expect(fresh.replies).toBe(0)
  })
})

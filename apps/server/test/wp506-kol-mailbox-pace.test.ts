/**
 * WP506（决策 1795 C）：批量开发信缺省每小时几封按**发信邮箱的「年龄」**——
 * 老邮箱（已同步的已发信最早一封在 90 天前、且至少 50 封；或 B2B 那边标过「已经正常发信很久」）15 封，
 * 其余（新的、认不出来的、没连邮箱的）5 封。卡上一句「新邮箱，」/「老邮箱，」，人改过节奏就不再说。
 *
 * 发信全走假发件口（`b2bStandIns.sendMail`），一封真信都不发。
 */
import type { Assignment, MessageRecord } from '@agentsws/contracts'
import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from '../src/index.js'
import { outreachPaceFor } from '../src/kol-service.js'

const T0 = '2026-09-15T09:00:00.000Z'
const DAY = 86_400_000
const SENDER = 'hello@brand.example'

describe('outreachPaceFor（纯函数）', () => {
  const ago = (days: number): string => new Date(Date.parse(T0) - days * DAY).toISOString()
  it('没连邮箱 / 没同步到已发信：新邮箱 5 封', () => {
    expect(outreachPaceFor(undefined, T0)).toMatchObject({ per_hour: 5, basis: 'new' })
    expect(outreachPaceFor({ address: SENDER, sent: 0 }, T0)).toMatchObject({
      per_hour: 5,
      basis: 'new',
    })
  })
  it('90 天以上、50 封以上：老邮箱 15 封；差一条都按新的', () => {
    expect(
      outreachPaceFor({ address: SENDER, sent: 50, earliest_sent_at: ago(90) }, T0),
    ).toMatchObject({ per_hour: 15, basis: 'established' })
    const young = outreachPaceFor({ address: SENDER, sent: 400, earliest_sent_at: ago(30) }, T0)
    expect(young).toMatchObject({ per_hour: 5, basis: 'new' })
    expect(young.why).toContain('30 天前')
    const quiet = outreachPaceFor({ address: SENDER, sent: 49, earliest_sent_at: ago(400) }, T0)
    expect(quiet).toMatchObject({ per_hour: 5, basis: 'new' })
    expect(quiet.why).toContain('49 封')
  })
  it('B2B 那边标过「已经正常发信很久」：老邮箱', () => {
    expect(
      outreachPaceFor({ address: SENDER, sent: 0, declared_established: true }, T0),
    ).toMatchObject({ per_hour: 15, basis: 'established' })
  })
})

describe('真进程：出卡时按默认发件那只邮箱的已发历史定节奏', () => {
  let server: Server
  let url: string
  let youtube: Assignment
  afterEach(async () => {
    await server.close()
  })

  const api = async (path: string, init: RequestInit = {}): Promise<Response> => {
    const headers = new Headers(init.headers)
    headers.set('Authorization', `Bearer ${server.bootstrap.internalToken}`)
    headers.set('X-Assignment', youtube.id)
    if (init.body !== undefined) headers.set('content-type', 'application/json')
    return fetch(`${url}${path}`, { ...init, headers })
  }
  const post = (path: string, body: unknown): Promise<Response> =>
    api(path, { method: 'POST', body: JSON.stringify(body) })
  const data = async <T>(res: Response): Promise<T> => ((await res.json()) as { data: T }).data

  async function boot(): Promise<void> {
    server = await createServer({
      quiet: true,
      clock: { now: () => T0 },
      scheduleIntervalMs: 0,
      startRun: false,
      env: { AGENTSWS_OWNER_EMAIL: 'luoye@example.com', AGENTSWS_SECRETS_KEY: 'e'.repeat(64) },
      b2bStandIns: {
        mailboxes: [SENDER],
        // 假发件口：收下就算发了，一封真信都不出门
        sendMail: async () => ({
          ok: true,
          outbox_id: 'obx_fake',
          message_id: '<fake@brand.example>',
          account: SENDER,
        }),
      } as never,
    })
    ;({ url } = await server.listen(0))
    youtube = server.roles.assignments.create({
      person_id: server.bootstrap.person.id,
      workspace_id: server.bootstrap.workspace.id,
      role_id: 'kol.youtube',
      granted_by: server.bootstrap.person.id,
      ranges: [{ kind: 'store', id: 'store_1' }],
    })
  }

  /** 往「已发送」里放 n 封，最早那封在 days 天前。 */
  async function sentHistory(n: number, days: number): Promise<void> {
    const brand = await server.brands.forWorkspace(server.bootstrap.workspace.id)
    for (let i = 0; i < n; i++) {
      const at = new Date(Date.parse(T0) - (days - (i * days) / n) * DAY).toISOString()
      await brand.messages.store.put({
        id: `msg_sent_${i}`,
        workspace_id: server.bootstrap.workspace.id,
        source: 'imap',
        account: SENDER,
        folder: 'Sent',
        folder_kind: 'sent',
        thread_id: `thr_${i}`,
        message_id: `<s${i}@brand.example>`,
        references: [],
        headers: {},
        from: { email: SENDER },
        to: [{ email: `buyer${i}@shop.example` }],
        cc: [],
        bcc: [],
        subject: '回复',
        snippet: '',
        text: '',
        has_remote_images: false,
        attachments: [],
        date: at,
        received_at: at,
        flags: { read: true, starred: false, answered: false },
        labels: [],
        route: 'other',
      } as unknown as MessageRecord)
    }
  }

  async function planCard(): Promise<{ per_hour: number; pace_basis: string; pace_why: string }> {
    const c = await data<{ creator: { id: string } }>(
      await post('/v1/kol/creators', {
        display_name: 'Gadget Jonas',
        channel: 'youtube',
        handle: 'gadgetjonas',
        followers: 48_000,
        engagement_rate: 0.06,
        category: '数码',
      }),
    )
    await post(`/v1/kol/creators/${c.creator.id}/contacts`, {
      kind: 'email',
      value: 'gadgetjonas@example.com',
    })
    const out = await data<{ ok: boolean; approval_item_id: string }>(
      await post('/v1/kol/outreach/batch', {
        channel: 'youtube',
        creator_ids: [c.creator.id],
        product: '65W 氮化镓充电器',
        brand_pitch: '我们做桌面周边的充电与理线。',
      }),
    )
    expect(out.ok).toBe(true)
    const card = await server.txn.approvals.get(out.approval_item_id)
    return card?.payload as { per_hour: number; pace_basis: string; pace_why: string }
  }

  it('发了 120 天、60 封的老邮箱：每小时 15 封（卡上「老邮箱」+ 依据）', async () => {
    await boot()
    await sentHistory(60, 120)
    const payload = await planCard()
    expect(payload).toMatchObject({ per_hour: 15, pace_basis: 'established' })
    expect(payload.pace_why).toContain('60 封')
  })

  it('刚连上（已发信只同步到 30 天内）：新邮箱 5 封', async () => {
    await boot()
    await sentHistory(200, 30)
    const payload = await planCard()
    expect(payload).toMatchObject({ per_hour: 5, pace_basis: 'new' })
    expect(payload.pace_why).toContain('不到 90 天')
  })

  it('还没同步到已发信：按新邮箱 5 封', async () => {
    await boot()
    const payload = await planCard()
    expect(payload).toMatchObject({ per_hour: 5, pace_basis: 'new' })
  })
})

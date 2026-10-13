/**
 * WP306：飞书绑定成功后私聊问话没有任何回复（Luoye 10-13 Windows 真机）。
 *
 * 真服务进程（`createServer` + 落盘档 + 真网关）+ 假飞书长连接（`imTransports.feishu`），
 * 一行网都不出。钉住：绑定后问话必有回复；代理挂住时超时回话；异常回话；
 * 点名岗位路由到对应分配；没岗位回话；诊断事件 `im.received` / `im.ask_failed`。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FeishuConnState, FeishuMessageEvent, FeishuTransport } from '@agentsws/channels'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { IM_TEXT } from '../src/im-team-bots.js'
import { createServer, type Server } from '../src/index.js'
import { SECRETS_KEY_ENV } from '../src/secret-store.js'

const APP_ID = 'cli_a1b2c3d4e5f60718'

class FakeFeishu implements FeishuTransport {
  replies: { message_id: string; text: string }[] = []
  #onEvent: ((e: FeishuMessageEvent) => void) | undefined
  #onState: ((s: FeishuConnState, d?: string) => void) | undefined
  async start(input: Parameters<FeishuTransport['start']>[0]): Promise<void> {
    this.#onEvent = input.onEvent
    this.#onState = input.onState
    input.onState('connected')
  }
  state(s: FeishuConnState): void {
    this.#onState?.(s)
  }
  texts(): string[] {
    return this.replies.map((r) => r.text)
  }
  async stop(): Promise<void> {}
  async reply(input: { message_id: string; text: string }): Promise<void> {
    this.replies.push(input)
  }
  async botOpenId(): Promise<string | undefined> {
    return 'ou_bot'
  }
  push(id: string, text: string, from = 'ou_luoye'): void {
    this.#onEvent?.({
      sender: { sender_id: { open_id: from }, sender_type: 'user' },
      message: {
        message_id: id,
        chat_id: 'oc_p2p',
        chat_type: 'p2p',
        message_type: 'text',
        content: JSON.stringify({ text }),
      },
    })
  }
}

let server: Server | undefined
const dirs: string[] = []

afterEach(async () => {
  await server?.close()
  server = undefined
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

async function boot(pace: { ackAfterMs?: number; askTimeoutMs?: number } = {}) {
  const dbDir = mkdtempSync(join(tmpdir(), 'wp306-feishu-'))
  dirs.push(dbDir)
  const feishu = new FakeFeishu()
  server = await createServer({
    dbDir,
    quiet: true,
    env: { [SECRETS_KEY_ENV]: 'c'.repeat(64) },
    tokenRefreshIntervalMs: 0,
    scheduleIntervalMs: 0,
    liveDataIntervalMs: 0,
    imTransports: { feishu: () => feishu },
    imPace: { ackAfterMs: 5_000, askTimeoutMs: 20_000, ...pace },
  })
  const s = server
  const call = async (method: string, path: string, body?: unknown) =>
    s.gateway.fetch(
      new Request(`http://127.0.0.1${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${s.bootstrap.internalToken}`,
          'X-Assignment': s.bootstrap.ownerAssignment.id,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    )
  // 直接读事件日志（「没岗位」那条把调用方自己的分配也撤了，走 /v1/events 会被可见性挡住）
  const imEvents = async (): Promise<Record<string, unknown>[]> =>
    s.kernel.eventLog
      .readSync({ workspace_id: s.bootstrap.workspace.id })
      .filter((e) => e.type === 'connection.changed' || e.type.startsWith('inbound.'))
      .map((e) => ({ type: e.type, ...((e.payload ?? {}) as Record<string, unknown>) }))
  return { s, feishu, call, imEvents }
}

async function waitFor(pred: () => boolean, label: string, ms = 5000): Promise<void> {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (pred()) return
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error(`waitFor 超时：${label}`)
}

async function waitForAsync(pred: () => Promise<boolean>, label: string, ms = 10_000) {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (await pred()) return
    await new Promise((r) => setTimeout(r, 20))
  }
  throw new Error(`waitFor 超时：${label}`)
}

async function bindLuoye(r: Awaited<ReturnType<typeof boot>>): Promise<void> {
  const put = await r.call('PUT', '/v1/im/feishu', { app_id: APP_ID, app_secret: 'S' })
  expect(put.status).toBe(200)
  const res = await r.call('POST', '/v1/im/bind-code')
  const { code } = ((await res.json()) as { data: { code: string } }).data
  r.feishu.push('om_bind', `绑定 ${code}`)
  await waitFor(() => r.feishu.replies.length === 1, '绑好了')
}

const QUESTION = 'Reddit 运营今天有没有什么需要我处理的'
const LINK = 'http://127.0.0.1'

const ofIm = (events: Record<string, unknown>[], im_event: string) =>
  events.filter((e) => e.im_event === im_event)

/** 秘书端口（IM 问代理走的就是它）。 */
const portOf = (r: Awaited<ReturnType<typeof boot>>) => r.s.secretary.port

describe('WP306：绑定后问话必有回复', () => {
  it('复现 Luoye 10-13：名册从没刷新过（没人打开过人员页），问话照样答、记 im.received / im.answered', async () => {
    const r = await boot()
    await bindLuoye(r)
    r.feishu.push('om_q1', QUESTION)
    await waitForAsync(async () => ofIm(await r.imEvents(), 'im.answered').length > 0, '答了')
    const last = r.feishu.texts().at(-1) ?? ''
    expect(last).not.toBe(IM_TEXT.ack)
    expect(last.startsWith(IM_TEXT.failed)).toBe(false)
    expect(r.feishu.replies.at(-1)?.message_id).toBe('om_q1')
    const events = await r.imEvents()
    expect(ofIm(events, 'im.ask_failed')).toEqual([])
    expect(ofIm(events, 'im.received').at(-1)).toMatchObject({
      channel: 'feishu',
      kind: 'question',
      chars: QUESTION.length,
    })
    // 21 §5：正文不进事件
    expect(JSON.stringify(ofIm(events, 'im.received'))).not.toContain('Reddit 运营今天')
  })

  it('答案慢：先回「收到，我查一下」，答案随后回在同一条消息下', async () => {
    const r = await boot({ ackAfterMs: 50 })
    await bindLuoye(r)
    vi.spyOn(portOf(r), 'ask').mockImplementation(async () => {
      await new Promise((res) => setTimeout(res, 300))
      return {
        answer: '今天有两张卡等你定。',
        kind: 'other',
        fields: [],
        refused: false,
        run_id: 'run_x',
      } as never
    })
    r.feishu.push('om_slow', '今天有什么要我定的')
    await waitFor(() => r.feishu.replies.length === 3, '收到 + 答案')
    expect(r.feishu.texts().slice(1)).toEqual([IM_TEXT.ack, '今天有两张卡等你定。'])
    expect(r.feishu.replies.slice(1).map((x) => x.message_id)).toEqual(['om_slow', 'om_slow'])
  })

  it('代理挂住：超时回一句人话 + 工作台链接、记 im.ask_failed{timeout}；答案晚到再补发', async () => {
    const r = await boot({ ackAfterMs: 20, askTimeoutMs: 200 })
    await bindLuoye(r)
    let release: (v: unknown) => void = () => {}
    vi.spyOn(portOf(r), 'ask').mockImplementation(
      () =>
        new Promise((res) => {
          release = res
        }) as never,
    )
    r.feishu.push('om_hang', QUESTION)
    await waitFor(() => r.feishu.texts().some((t) => t.startsWith(IM_TEXT.timeout)), '超时回话')
    const timeoutText = r.feishu.texts().find((t) => t.startsWith(IM_TEXT.timeout)) ?? ''
    expect(timeoutText).toContain(LINK)
    expect(ofIm(await r.imEvents(), 'im.ask_failed')).toEqual([
      expect.objectContaining({ channel: 'feishu', reason: 'timeout' }),
    ])
    release({ answer: '晚到的答案', kind: 'other', fields: [], refused: false, run_id: 'run_y' })
    await waitFor(() => r.feishu.texts().some((t) => t.includes('晚到的答案')), '补发')
    expect(r.feishu.texts().at(-1)).toBe(`${IM_TEXT.late}\n晚到的答案`)
    expect(ofIm(await r.imEvents(), 'im.answered').at(-1)).toMatchObject({ late: true })
  })

  it('代理抛错：回一句人话 + 链接、记 im.ask_failed（只有原因码，不带错误原文与正文）', async () => {
    const r = await boot()
    await bindLuoye(r)
    vi.spyOn(portOf(r), 'ask').mockRejectedValue(
      Object.assign(new Error('模型网关炸了：机密细节'), { code: 'internal' }),
    )
    r.feishu.push('om_err', QUESTION)
    await waitFor(() => r.feishu.replies.length === 2, '回了人话')
    expect(r.feishu.texts()[1]?.startsWith(IM_TEXT.failed)).toBe(true)
    expect(r.feishu.texts()[1]).toContain(LINK)
    const failed = ofIm(await r.imEvents(), 'im.ask_failed')
    expect(failed).toEqual([
      expect.objectContaining({ channel: 'feishu', reason: 'agent_error', error_code: 'internal' }),
    ])
    expect(JSON.stringify(failed)).not.toContain('机密细节')
    expect(JSON.stringify(failed)).not.toContain('Reddit')
  })

  it('点名岗位：「Reddit 运营」→ 他的 Reddit 那条分配所在岗位（WP308 起直接问岗位 Agent，不经秘书）；没点名的闲聊 → 秘书、主要岗位', async () => {
    const r = await boot()
    await bindLuoye(r)
    const me = r.s.bootstrap
    const reddit = r.s.roles.assignments.create({
      person_id: me.person.id,
      workspace_id: me.workspace.id,
      granted_by: me.person.id,
      ranges: [],
      role_id: 'social.reddit',
    })
    const support = r.s.roles.assignments.create({
      person_id: me.person.id,
      workspace_id: me.workspace.id,
      granted_by: me.person.id,
      ranges: [],
      role_id: 'dtc.support',
    })
    const asked: string[] = []
    vi.spyOn(portOf(r), 'ask').mockImplementation(async (actor) => {
      asked.push(actor.assignment_id)
      return { answer: '好', kind: 'other', fields: [], refused: false, run_id: 'run_z' } as never
    })
    r.feishu.push('om_r', QUESTION)
    await waitFor(() => r.feishu.replies.length === 2, '答了')
    // WP308（决策 447）：点名岗位的工作问题直接问那个岗位（Reddit 那条分配所在的「社媒运营」），秘书不碰
    expect(asked).toEqual([])
    expect(r.feishu.texts()[1]).toMatch(/^「社媒运营」今天/)
    expect(reddit.id).toBeDefined()
    r.feishu.push('om_hi', '你好')
    await waitFor(() => asked.length === 1, '问了秘书')
    // 没点名：第一条干活的分配（负责人 / 成员这两条底座排后面）
    expect([reddit.id, support.id]).toContain(asked[0])
  })

  it('没有岗位：回「你在这个品牌还没有岗位」+ 链接，记 im.ask_failed{no_position}', async () => {
    const r = await boot()
    await bindLuoye(r)
    const me = r.s.bootstrap
    for (const a of r.s.roles.assignments.listByPerson(me.person.id, {
      workspace_id: me.workspace.id,
    }))
      if (a.revoked_at === undefined) r.s.roles.assignments.revoke(a.id)
    r.feishu.push('om_none', QUESTION)
    await waitFor(() => r.feishu.replies.length === 2, '回了人话')
    expect(r.feishu.texts()[1]?.startsWith(IM_TEXT.noPosition)).toBe(true)
    expect(r.feishu.texts()[1]).toContain(LINK)
    expect(ofIm(await r.imEvents(), 'im.ask_failed')).toEqual([
      expect.objectContaining({ reason: 'no_position' }),
    ])
  })
})

describe('WP306：长连接断了要如实', () => {
  it('断了：状态变「断了，在重连」、记 im.disconnected；连回来记 im.reconnected', async () => {
    const r = await boot()
    await bindLuoye(r)
    const status = async () =>
      (
        (await (await r.call('GET', '/v1/im/status')).json()) as {
          data: { feishu: { state: string; connected: boolean } }
        }
      ).data.feishu
    expect(await status()).toMatchObject({ state: 'connected', connected: true })
    r.feishu.state('reconnecting')
    expect(await status()).toMatchObject({ state: 'reconnecting', connected: false })
    r.feishu.state('connecting')
    r.feishu.state('connected')
    const events = await r.imEvents()
    expect(ofIm(events, 'im.disconnected')).toEqual([
      expect.objectContaining({ channel: 'feishu', state: 'reconnecting' }),
    ])
    expect(ofIm(events, 'im.reconnected')).toEqual([expect.objectContaining({ channel: 'feishu' })])
  })
})

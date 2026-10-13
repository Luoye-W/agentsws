/**
 * WP308（决策 447 / 451 / 453）：消息渠道二期。
 *
 * 真服务进程（`createServer` + 落盘档 + 真网关 + stub 运行时）+ 假渠道（飞书长连接、钉钉 / 企业微信的
 * 长连接与 HTTP 都是内存替身），一行网都不出。钉住：
 * - 点名岗位的工作问题直接问岗位 Agent：得到这个岗位今天的摘要 + 去工作台的链接，不经秘书；
 * - 交代型（「帮我回一下…」）在那个岗位建任务，聊天里只回「已记成任务，在工作台确认」；
 * - 闲聊仍走秘书；
 * - 钉钉 / 企业微信断线重连记 `im.disconnected` / `im.reconnected`，慢了先回「收到，我查一下」；
 * - 事件里不再出现原始聊天账号 id（只有加盐哈希）。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  DingtalkHttp,
  DingtalkSocket,
  FeishuConnState,
  FeishuMessageEvent,
  FeishuTransport,
  WecomSocket,
} from '@agentsws/channels'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { IM_TEXT } from '../src/im-team-bots.js'
import { createServer, type Server } from '../src/index.js'
import { SECRETS_KEY_ENV } from '../src/secret-store.js'

const APP_ID = 'cli_a1b2c3d4e5f60718'
const OPEN_ID = 'ou_luoye_raw_open_id'

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
  push(id: string, text: string, from = OPEN_ID): void {
    this.#onEvent?.({
      sender: { sender_id: { open_id: from }, sender_type: 'user' },
      message: {
        message_id: id,
        chat_id: 'oc_p2p_chat',
        chat_type: 'p2p',
        message_type: 'text',
        content: JSON.stringify({ text }),
      },
    })
  }
}

/** 钉钉 / 企业微信共用的内存长连接。 */
class FakeSocket implements DingtalkSocket, WecomSocket {
  readonly sent: Record<string, unknown>[] = []
  closed = false
  #h: Record<string, ((a: never) => void)[]> = {}
  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>)
  }
  close(): void {
    if (this.closed) return
    this.closed = true
    this.emit('close', undefined)
  }
  on(event: string, cb: (a: never) => void): void {
    this.#h[event] = [...(this.#h[event] ?? []), cb]
  }
  emit(event: string, arg: unknown): void {
    for (const cb of this.#h[event] ?? []) (cb as (a: unknown) => void)(arg)
  }
}

const HOOK = 'https://oapi.dingtalk.com/robot/sendBySession?session=s1'

let server: Server | undefined
const dirs: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  await server?.close()
  server = undefined
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

async function boot(pace: { ackAfterMs?: number; askTimeoutMs?: number } = {}) {
  const dbDir = mkdtempSync(join(tmpdir(), 'wp308-im-'))
  dirs.push(dbDir)
  const feishu = new FakeFeishu()
  const dingSockets: FakeSocket[] = []
  const wecomSockets: FakeSocket[] = []
  const dingPosts: string[] = []
  const dingtalkHttp: DingtalkHttp = async (url, init) => {
    if (url.includes('gateway/connections/open'))
      return {
        status: 200,
        json: async () => ({ endpoint: 'wss://wss-open-connection.dingtalk.com/c', ticket: 'T' }),
      }
    dingPosts.push((JSON.parse(init.body) as { text: { content: string } }).text.content)
    return { status: 200, json: async () => ({ errcode: 0 }) }
  }
  server = await createServer({
    dbDir,
    quiet: true,
    env: { [SECRETS_KEY_ENV]: 'c'.repeat(64) },
    tokenRefreshIntervalMs: 0,
    scheduleIntervalMs: 0,
    liveDataIntervalMs: 0,
    imTransports: {
      feishu: () => feishu,
      dingtalkSocket: () => {
        const s = new FakeSocket()
        dingSockets.push(s)
        return s
      },
      dingtalkHttp,
      wecomSocket: () => {
        const s = new FakeSocket()
        wecomSockets.push(s)
        return s
      },
    },
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
  const allEvents = () =>
    s.kernel.eventLog
      .readSync({ workspace_id: s.bootstrap.workspace.id })
      .map((e) => ({ type: e.type, ...((e.payload ?? {}) as Record<string, unknown>) }))
  const imEvents = () =>
    allEvents().filter((e) => e.type === 'connection.changed' || e.type.startsWith('inbound.'))
  return { s, feishu, call, allEvents, imEvents, dingSockets, wecomSockets, dingPosts }
}
type Rig = Awaited<ReturnType<typeof boot>>

async function waitFor(pred: () => boolean, label: string, ms = 8000): Promise<void> {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (pred()) return
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error(`waitFor 超时：${label}`)
}

const ofIm = (events: Record<string, unknown>[], im_event: string) =>
  events.filter((e) => e.im_event === im_event)

async function bindFeishu(r: Rig): Promise<void> {
  const put = await r.call('PUT', '/v1/im/feishu', { app_id: APP_ID, app_secret: 'S' })
  expect(put.status).toBe(200)
  const res = await r.call('POST', '/v1/im/bind-code')
  const { code } = ((await res.json()) as { data: { code: string } }).data
  r.feishu.push('om_bind', `绑定 ${code}`)
  await waitFor(() => r.feishu.replies.length === 1, '绑好了')
}

/** 给负责人加一条 Reddit 的分配（与 WP306 那条用例同一个做法）。 */
function giveReddit(r: Rig) {
  const me = r.s.bootstrap
  return r.s.roles.assignments.create({
    person_id: me.person.id,
    workspace_id: me.workspace.id,
    granted_by: me.person.id,
    ranges: [],
    role_id: 'social.reddit',
  })
}

describe('WP308 / 447：点名岗位直接问岗位 Agent', () => {
  it('「Reddit 运营今天有没有什么需要我处理的」→ 这个岗位今天的摘要 + 去工作台链接，不经秘书', async () => {
    const r = await boot()
    await bindFeishu(r)
    const reddit = giveReddit(r)
    r.s.work.createTodo({
      title: '回 r/gadgets 那条长评论',
      owner: r.s.bootstrap.person.id,
      position_id: reddit.id,
      due: new Date().toISOString(),
    })
    const secretary = vi.spyOn(r.s.secretary.port, 'ask')
    r.feishu.push('om_q', 'Reddit 运营今天有没有什么需要我处理的')
    await waitFor(() => r.feishu.replies.length === 2, '答了')
    const text = r.feishu.texts()[1] ?? ''
    expect(text).toMatch(/^「.+」今天：/)
    expect(text).toContain('1 个待办')
    expect(text).toContain(`${IM_TEXT.goWorkbench}http://127.0.0.1`)
    expect(text).toMatch(/\/positions\/[^/\s]+$/)
    // 不放任何批准按钮 / 决定动作
    expect(text).not.toMatch(/批准|decision_token/)
    expect(secretary).not.toHaveBeenCalled()
    expect(ofIm(r.imEvents(), 'im.answered').at(-1)).toMatchObject({
      to: 'position',
      via: 'feishu',
    })
    expect(ofIm(r.imEvents(), 'im.ask_failed')).toEqual([])
  })

  it('点名岗位的别的工作问题 → 岗位当场问答（只读运行）一句 + 链接', async () => {
    const r = await boot()
    await bindFeishu(r)
    giveReddit(r)
    const secretary = vi.spyOn(r.s.secretary.port, 'ask')
    r.feishu.push('om_q2', 'Reddit 运营上周发了几条帖子')
    await waitFor(() => r.feishu.replies.length === 2, '答了', 20_000)
    const text = r.feishu.texts()[1] ?? ''
    expect(text).toContain(`${IM_TEXT.goWorkbench}http://127.0.0.1`)
    expect(text.startsWith(IM_TEXT.failed)).toBe(false)
    expect(secretary).not.toHaveBeenCalled()
    // 当场问答隐身：不进岗位「工作」、不算在办
    const quick = r.s.work.listMatters({ quick: true })
    expect(quick.length).toBe(1)
    expect(ofIm(r.imEvents(), 'im.answered').at(-1)).toMatchObject({ to: 'position' })
  }, 30_000)

  it('交代型（「帮我回一下…」）→ 在岗位建任务，聊天里回「已记成任务，在工作台确认」+ 事项链接', async () => {
    const r = await boot()
    await bindFeishu(r)
    giveReddit(r)
    const secretary = vi.spyOn(r.s.secretary.port, 'ask')
    r.feishu.push('om_t', 'Reddit 运营帮我回一下 r/gadgets 那条评论')
    await waitFor(() => r.feishu.replies.length === 2, '回了')
    const text = r.feishu.texts()[1] ?? ''
    expect(text).toMatch(/^已记成「.+」的任务，在工作台确认。/)
    const matter_id = /\/matters\/([^/\s]+)$/.exec(text)?.[1]
    expect(matter_id).toBeDefined()
    const matter = r.s.work.getMatter(decodeURIComponent(matter_id ?? ''))
    expect(matter).toMatchObject({ entry: 'position', role_id: 'social.reddit' })
    // 任务，不是一问一答
    expect(matter?.ask).toBeUndefined()
    expect(secretary).not.toHaveBeenCalled()
    expect(ofIm(r.imEvents(), 'im.answered').at(-1)).toMatchObject({ to: 'position', task: true })
  })

  it('闲聊（「你好」）仍走秘书', async () => {
    const r = await boot()
    await bindFeishu(r)
    giveReddit(r)
    const asked: string[] = []
    vi.spyOn(r.s.secretary.port, 'ask').mockImplementation(async (actor) => {
      asked.push(actor.assignment_id)
      return { answer: '你好', kind: 'other', fields: [], refused: false, run_id: 'r' } as never
    })
    r.feishu.push('om_hi', '你好')
    await waitFor(() => asked.length === 1, '问了秘书')
    await waitFor(() => r.feishu.replies.length === 2, '回了')
    expect(ofIm(r.imEvents(), 'im.answered').at(-1)).toMatchObject({ to: 'secretary' })
  })
})

describe('WP308 / 453：事件里不再出现原始聊天账号 id', () => {
  it('绑定 + 问话之后，整个事件日志里找不到飞书 open_id 与会话 id；同一个人的哈希稳定', async () => {
    const r = await boot()
    await bindFeishu(r)
    r.feishu.push('om_x1', '你好')
    await waitFor(() => r.feishu.replies.length === 2, '回了')
    const dump = JSON.stringify(r.allEvents())
    expect(dump).not.toContain(OPEN_ID)
    expect(dump).not.toContain('oc_p2p_chat')
    const received = r.imEvents().filter((e) => e.type === 'inbound.received')
    expect(received.length).toBe(2)
    expect(received[0]?.actor_external_id).toBeUndefined()
    expect(typeof received[0]?.actor_hash).toBe('string')
    expect(received[0]?.actor_hash).toBe(received[1]?.actor_hash)
  })
})

describe('WP308 / 451：钉钉 / 企业微信断线重连与先回「收到」', () => {
  it('钉钉：断了记 im.disconnected、状态「在重连」；连回来记 im.reconnected', async () => {
    const r = await boot()
    const put = await r.call('PUT', '/v1/im/dingtalk', { client_id: 'ding_x', client_secret: 'S' })
    expect(put.status).toBe(200)
    await waitFor(() => r.dingSockets.length === 1, '连了')
    r.dingSockets[0]?.emit('open', undefined)
    r.dingSockets[0]?.close()
    const status = async () =>
      (
        (await (await r.call('GET', '/v1/im/status')).json()) as {
          data: { dingtalk: { state: string } }
        }
      ).data.dingtalk
    expect((await status()).state).toBe('reconnecting')
    await waitFor(() => r.dingSockets.length === 2, '重连', 5000)
    r.dingSockets[1]?.emit('open', undefined)
    expect((await status()).state).toBe('connected')
    expect(ofIm(r.imEvents(), 'im.disconnected')).toEqual([
      expect.objectContaining({ channel: 'dingtalk', state: 'reconnecting' }),
    ])
    expect(ofIm(r.imEvents(), 'im.reconnected')).toEqual([
      expect.objectContaining({ channel: 'dingtalk' }),
    ])
  })

  it('企业微信：断了记 im.disconnected、状态「在重连」；连回来记 im.reconnected', async () => {
    const r = await boot()
    const put = await r.call('PUT', '/v1/im/wecom', { bot_id: 'BOT', secret: 'S' })
    expect(put.status).toBe(200)
    const up = (s: FakeSocket | undefined) => {
      s?.emit('open', undefined)
      s?.emit('message', JSON.stringify({ cmd: 'aibot_subscribe', errcode: 0 }))
    }
    up(r.wecomSockets[0])
    r.wecomSockets[0]?.close()
    const status = async () =>
      (
        (await (await r.call('GET', '/v1/im/status')).json()) as {
          data: { wecom: { state: string } }
        }
      ).data.wecom
    expect((await status()).state).toBe('reconnecting')
    await waitFor(() => r.wecomSockets.length === 2, '重连', 5000)
    up(r.wecomSockets[1])
    expect((await status()).state).toBe('connected')
    expect(ofIm(r.imEvents(), 'im.disconnected')).toEqual([
      expect.objectContaining({ channel: 'wecom', state: 'reconnecting' }),
    ])
    expect(ofIm(r.imEvents(), 'im.reconnected')).toEqual([
      expect.objectContaining({ channel: 'wecom' }),
    ])
  })

  it('钉钉：答案慢先回「收到，我查一下」，答案经同一个 sessionWebhook 再回；事件里没有员工 userid', async () => {
    const r = await boot({ ackAfterMs: 30 })
    await r.call('PUT', '/v1/im/dingtalk', { client_id: 'ding_x', client_secret: 'S' })
    await waitFor(() => r.dingSockets.length === 1, '连了')
    const sock = r.dingSockets[0] as FakeSocket
    sock.emit('open', undefined)
    const res = await r.call('POST', '/v1/im/bind-code')
    const { code } = ((await res.json()) as { data: { code: string } }).data
    const robot = (msgId: string, content: string) =>
      sock.emit(
        'message',
        JSON.stringify({
          type: 'CALLBACK',
          headers: { topic: '/v1.0/im/bot/messages/get', messageId: `m_${msgId}` },
          data: JSON.stringify({
            msgId,
            msgtype: 'text',
            text: { content },
            conversationId: 'cid_raw_conv',
            conversationType: '1',
            senderStaffId: 'staff_raw_userid',
            sessionWebhook: HOOK,
            sessionWebhookExpiredTime: Date.now() + 3_600_000,
          }),
        }),
      )
    robot('b1', `绑定 ${code}`)
    await waitFor(() => r.dingPosts.length === 1, '绑好了')
    vi.spyOn(r.s.secretary.port, 'ask').mockImplementation(async () => {
      await new Promise((res2) => setTimeout(res2, 300))
      return {
        answer: '慢慢的答案',
        kind: 'other',
        fields: [],
        refused: false,
        run_id: 'r',
      } as never
    })
    robot('q1', '你好')
    await waitFor(() => r.dingPosts.length === 3, '收到 + 答案')
    expect(r.dingPosts.slice(1)).toEqual([IM_TEXT.ack, '慢慢的答案'])
    const dump = JSON.stringify(r.allEvents())
    expect(dump).not.toContain('staff_raw_userid')
    expect(dump).not.toContain('cid_raw_conv')
  })
})

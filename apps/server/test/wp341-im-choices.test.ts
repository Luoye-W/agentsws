/**
 * WP341（决策 847）：聊天软件出口降级——AI 回话里的按钮在四个聊天软件里都变成**编号选项**，人回编号
 * 就当他说了那个选项那句话（下一问问到代理的就是那句）。表单变成要回答的问题（契约测试钉住）。
 *
 * 同 `im-channels.test.ts` 的装法：`createImChannels` + 内存替身（个人微信 iLink、飞书长连接、钉钉长连接 +
 * HTTP、企业微信用本机真 ws），一行网都不出。
 */
import { randomBytes } from 'node:crypto'
import type { GatewayEnv } from '@agentsws/api'
import { ApiError, errorBody } from '@agentsws/api'
import {
  ChannelInboundPipeline,
  type ClawBotTransport,
  type DingtalkHttp,
  type DingtalkSocket,
  type FeishuConnState,
  type FeishuMessageEvent,
  type FeishuTransport,
  MemoryClawBotStateStore,
  MemoryRawStore,
  type WecomSocket,
} from '@agentsws/channels'
import type {
  ChannelAdapter,
  InboundEvent,
  Iso8601,
  PersonId,
  RouteInput,
} from '@agentsws/contracts'
import { Hono } from 'hono'
import { afterEach, describe, expect, it } from 'vitest'
import { WebSocket, WebSocketServer } from 'ws'
import { createImChannels, type ImChannelsAssembly } from '../src/im-channels.js'
import { createSecretStore, type SecretStore } from '../src/secret-store.js'

const WS_ID = 'ws_1'
const ME: PersonId = 'per_me'
const WX_USER = 'ilink_user_me'

/** AI 回的那一句：两个按钮（一个带写好的那句话）。 */
const WITH_BUTTONS = [
  '先做哪件？',
  '```dsh-ui',
  JSON.stringify({
    items: [
      { type: 'button', label: '改价', action: 'say:先把耳机改价' },
      { type: 'button', label: '上新', action: 'pick' },
    ],
  }),
  '```',
].join('\n')

const answerOf = (question: string): string =>
  question.includes('先做哪件') ? WITH_BUTTONS : `收到：${question}`

async function waitFor(pred: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 600; i++) {
    if (pred()) return
    await new Promise<void>((r) => setTimeout(r, 5))
  }
  throw new Error(`waitFor 超时：${label}`)
}

interface Rig {
  app: Hono<GatewayEnv>
  im: ImChannelsAssembly
  secrets: SecretStore
  asked: string[]
}
const rigs: Rig[] = []
const closers: (() => Promise<void>)[] = []
afterEach(async () => {
  while (rigs.length > 0) {
    const rig = rigs.pop()
    await rig?.im.close()
    rig?.secrets.close()
  }
  for (const c of closers.splice(0)) await c()
})

function makeRig(over: Partial<Parameters<typeof createImChannels>[0]> = {}): Rig {
  const clock = { now: () => new Date().toISOString() as Iso8601 }
  const secrets = createSecretStore({
    dbPath: ':memory:',
    clock,
    env: { AGENTSWS_SECRETS_KEY: randomBytes(32).toString('hex') },
  })
  const asked: string[] = []
  const raw = new MemoryRawStore({ clock })
  let n = 0
  const im = createImChannels({
    clock,
    workspace_id: WS_ID,
    secrets,
    identity: {
      authenticate: async (bearer) =>
        bearer === 'tok_me'
          ? { person_id: ME, workspace_id: WS_ID, kind: 'session' as const }
          : undefined,
    },
    rawStore: raw,
    makePipeline: (input) =>
      new ChannelInboundPipeline({
        clock,
        adapters: input.adapters as readonly ChannelAdapter[],
        workspace_id: WS_ID,
        rawStore: raw,
        route: (r: RouteInput) => input.route(r),
        onEvent: (e: InboundEvent) => input.onEvent(e),
      }),
    appendEvent: () => undefined,
    newId: () => `id_${++n}`,
    random: () => 0.42,
    storageTier: () => 'local',
    askAgent: async ({ question }) => {
      asked.push(question)
      return { answer: answerOf(question) }
    },
    assignmentOf: (p) => (p === ME ? `asg_${p}` : undefined),
    canManageTeamBots: (p) => p === ME,
    deepLinkBase: () => 'http://127.0.0.1:7777',
    clawbotState: new MemoryClawBotStateStore(),
    pace: { idle_delay_ms: 1, retry_delay_ms: 1, backoff_delay_ms: 1 },
    ...over,
  })
  const app = new Hono<GatewayEnv>()
  im.mount(app)
  app.onError((err, c) => {
    const e = err instanceof ApiError ? err : new ApiError('internal', String(err))
    return c.json(errorBody(e, ''), e.status as 400)
  })
  const rig = { app, im, secrets, asked }
  rigs.push(rig)
  return rig
}

const call = (rig: Rig, method: string, path: string, body?: unknown): Promise<Response> =>
  rig.app.request(path, {
    method,
    headers: {
      Authorization: 'Bearer tok_me',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })

const bindCode = async (rig: Rig): Promise<string> =>
  ((await (await call(rig, 'POST', '/v1/im/bind-code')).json()) as { data: { code: string } }).data
    .code

/** 回出去的字里：按钮是编号选项，没有 JSON。 */
function expectNumbered(text: string): void {
  expect(text).toContain('1. 改价\n2. 上新')
  expect(text).toContain('回编号就行')
  expect(text).not.toContain('{')
  expect(text).not.toContain('dsh-ui')
}

describe('WP341 聊天软件里按钮成编号选项、回编号就是那句话', () => {
  it('个人微信', async () => {
    const sent: string[] = []
    const inbox: string[] = ['先做哪件']
    let msgId = 900100
    const transport: ClawBotTransport = {
      qrcode: async () => ({ qrcode: 'QR', qrcode_img_content: 'https://weixin.example/qr' }),
      qrcodeStatus: async () => ({
        status: 'confirmed' as const,
        bot_token: 'SECRET-BOT-TOKEN',
        ilink_bot_id: 'bot_9',
        baseurl: 'https://ilink.example',
        ilink_user_id: WX_USER,
      }),
      getUpdates: async () => {
        const text = inbox.shift()
        if (text === undefined) return { ret: 0, msgs: [], get_updates_buf: 'B' }
        msgId += 1
        return {
          ret: 0,
          get_updates_buf: `B${String(msgId)}`,
          msgs: [
            {
              message_id: String(msgId),
              from_user_id: WX_USER,
              message_type: 1,
              context_token: 'ctx-1',
              item_list: [{ type: 1, text_item: { text } }],
            },
          ],
        }
      },
      sendMessage: async (input) => {
        sent.push(JSON.stringify(input.body))
        return { ret: 0, message_id: `m_${String(sent.length)}` }
      },
    }
    const rig = makeRig({ clawbotTransport: transport })
    const started = (
      (await (await call(rig, 'POST', '/v1/im/wechat/login', { token: 'tok_me' })).json()) as {
        data: { login_id: string }
      }
    ).data
    await call(rig, 'GET', `/v1/im/wechat/login/${started.login_id}`)
    await waitFor(() => sent.length > 0, '回到微信')
    const first = (
      JSON.parse(sent[0] ?? '{}') as { msg: { item_list: { text_item: { text: string } }[] } }
    ).msg.item_list[0]?.text_item.text
    expectNumbered(first ?? '')
    inbox.push('1')
    await waitFor(() => rig.asked.length === 2, '第二问')
    expect(rig.asked[1]).toBe('先把耳机改价')
  })

  it('企业微信（本机真 ws）', async () => {
    const replies: string[] = []
    const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' })
    await new Promise<void>((r) => wss.on('listening', r))
    closers.push(
      () =>
        new Promise<void>((r) => {
          for (const c of wss.clients) c.terminate()
          wss.close(() => r())
        }),
    )
    let sock: import('ws').WebSocket | undefined
    const push = (id: string, content: string) =>
      sock?.send(
        JSON.stringify({
          cmd: 'aibot_msg_callback',
          headers: { req_id: `req-${id}` },
          body: {
            msgid: `wm_${id}`,
            chatid: 'chat_9',
            chattype: 'single',
            from: { userid: 'wecom_me' },
            msgtype: 'text',
            text: { content },
          },
        }),
      )
    wss.on('connection', (socket) => {
      sock = socket
      socket.on('message', (raw: Buffer) => {
        const frame = JSON.parse(raw.toString('utf8')) as { cmd?: string }
        if (frame.cmd === 'aibot_subscribe') {
          socket.send(JSON.stringify({ cmd: 'aibot_subscribe', errcode: 0 }))
          push('1', '先做哪件')
        }
        if (frame.cmd === 'aibot_respond_msg') replies.push(JSON.stringify(frame))
      })
    })
    const address = wss.address() as { port: number }
    const rig = makeRig({
      wecomUrl: `ws://127.0.0.1:${String(address.port)}`,
      wecomSocket: (target: string) => new WebSocket(target) as unknown as WecomSocket,
      personByWecomUser: (u) => (u === 'wecom_me' ? ME : undefined),
    })
    await call(rig, 'PUT', '/v1/im/wecom', { bot_id: 'BID', secret: 'SEC' })
    await waitFor(() => replies.some((r) => r.includes('回编号就行')), '回了编号选项')
    const answer = replies.find((r) => r.includes('回编号就行')) ?? ''
    expect(answer).toContain('1. 改价\\n2. 上新')
    expect(answer).not.toContain('dsh-ui')
    push('2', '2')
    await waitFor(() => rig.asked.length === 2, '第二问')
    expect(rig.asked[1]).toBe('上新')
  })

  it('飞书', async () => {
    const replies: string[] = []
    let onEvent: ((e: FeishuMessageEvent) => void) | undefined
    const feishu: FeishuTransport = {
      async start(input) {
        onEvent = input.onEvent
        input.onState('connected' as FeishuConnState)
      },
      async stop() {},
      async reply(input) {
        replies.push(input.text)
      },
      async botOpenId() {
        return 'ou_bot'
      },
    }
    const push = (id: string, text: string) =>
      onEvent?.({
        sender: { sender_id: { open_id: 'ou_me' }, sender_type: 'user' },
        message: {
          message_id: id,
          chat_id: 'oc_p2p',
          chat_type: 'p2p',
          message_type: 'text',
          content: JSON.stringify({ text }),
        },
      })
    const rig = makeRig({ feishuTransport: () => feishu })
    expect(
      (await call(rig, 'PUT', '/v1/im/feishu', { app_id: 'cli_a1b2c3d4e5f60718', app_secret: 'S' }))
        .status,
    ).toBe(200)
    push('om_bind', `绑定 ${await bindCode(rig)}`)
    await waitFor(() => replies.length === 1, '绑好了')
    push('om_q', '先做哪件')
    await waitFor(() => replies.some((r) => r.includes('回编号就行')), '回了编号选项')
    expectNumbered(replies.find((r) => r.includes('回编号就行')) ?? '')
    push('om_a', '2')
    await waitFor(() => rig.asked.length === 2, '第二问')
    expect(rig.asked[1]).toBe('上新')
  })

  it('钉钉', async () => {
    const posts: string[] = []
    const sockets: FakeSocket[] = []
    const http: DingtalkHttp = async (url, init) => {
      if (url.includes('gateway/connections/open'))
        return {
          status: 200,
          json: async () => ({ endpoint: 'wss://wss-open-connection.dingtalk.com/c', ticket: 'T' }),
        }
      posts.push((JSON.parse(init.body) as { text: { content: string } }).text.content)
      return { status: 200, json: async () => ({ errcode: 0 }) }
    }
    const rig = makeRig({
      dingtalkHttp: http,
      dingtalkSocket: () => {
        const s = new FakeSocket()
        sockets.push(s)
        return s
      },
    })
    await call(rig, 'PUT', '/v1/im/dingtalk', { client_id: 'ding_x', client_secret: 'S' })
    await waitFor(() => sockets.length === 1, '连了')
    const sock = sockets[0] as FakeSocket
    sock.emit('open', undefined)
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
            conversationId: 'cid_conv',
            conversationType: '1',
            senderStaffId: 'staff_me',
            sessionWebhook: 'https://oapi.dingtalk.com/robot/sendBySession?session=s1',
            sessionWebhookExpiredTime: Date.now() + 3_600_000,
          }),
        }),
      )
    robot('b1', `绑定 ${await bindCode(rig)}`)
    await waitFor(() => posts.length === 1, '绑好了')
    robot('q1', '先做哪件')
    await waitFor(() => posts.some((p) => p.includes('回编号就行')), '回了编号选项')
    expectNumbered(posts.find((p) => p.includes('回编号就行')) ?? '')
    robot('a1', '1')
    await waitFor(() => rig.asked.length === 2, '第二问')
    expect(rig.asked[1]).toBe('先把耳机改价')
  })
})

/** 钉钉的内存长连接（同 wp308）。 */
class FakeSocket implements DingtalkSocket {
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

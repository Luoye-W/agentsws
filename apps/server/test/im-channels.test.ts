/**
 * 两条 IM 渠道的服务端一面（WP85；54 §5）。
 *
 * 钉六件事：
 * 1. 五条路由都要凭据，别人的扫码轮询不到；
 * 2. `bot_token` 只进秘密库——**不在任何响应体里**，解绑就销毁；
 * 3. 共享档 / 托管档**不让绑**个人微信，而且给的是一句人话；
 * 4. 入站 → 这个人的代理 → 回到原来那条会话（微信）；
 * 5. 企业微信群里 @：认不出的账号不代答，认得出的按**他自己**的身份问；
 * 6. 企业微信那条长连接与**真 `ws`** 对得上（本机 `127.0.0.1`，不出网）。
 */
import { randomBytes } from 'node:crypto'
import type { GatewayEnv } from '@agentsws/api'
import { ApiError, errorBody } from '@agentsws/api'
import {
  ChannelInboundPipeline,
  type ClawBotTransport,
  MemoryClawBotStateStore,
  MemoryRawStore,
  subscribeFrame,
  WECOM_WS_URL,
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
import {
  createImChannels,
  type ImChannelsAssembly,
  storageTierOf,
  WECHAT_LOCAL_ONLY,
  wechatSecretId,
  wecomSecretId,
} from '../src/im-channels.js'
import { createSecretStore, type SecretStore } from '../src/secret-store.js'

const WS_ID = 'ws_1'
const ME: PersonId = 'per_me'
const OTHER: PersonId = 'per_other'
const WX_USER = 'ilink_user_me'

function makeClock(start = '2026-09-16T09:00:00.000Z'): {
  now(): Iso8601
  advance(ms: number): void
} {
  let t = Date.parse(start)
  return {
    now: () => new Date(t).toISOString(),
    advance: (ms) => {
      t += ms
    },
  }
}

/** 假 iLink：扫码一步到位，长轮询按脚本，发信记下来。 */
function fakeTransport(script: {
  updates?: (() => unknown)[]
  onSend?: (body: unknown) => void
}): ClawBotTransport {
  let i = 0
  return {
    qrcode: async () => ({ qrcode: 'QR', qrcode_img_content: 'https://weixin.example/qr' }),
    qrcodeStatus: async () => ({
      status: 'confirmed' as const,
      bot_token: 'SECRET-BOT-TOKEN',
      ilink_bot_id: 'bot_9',
      baseurl: 'https://ilink.example',
      ilink_user_id: WX_USER,
    }),
    getUpdates: async () => {
      const next = script.updates?.[i]
      i += 1
      if (next === undefined) return { ret: 0, msgs: [], get_updates_buf: 'B' }
      return next() as { ret: number }
    },
    sendMessage: async (input) => {
      script.onSend?.(input.body)
      return { ret: 0, message_id: `m_${i}` }
    },
  }
}

interface Rig {
  app: Hono<GatewayEnv>
  im: ImChannelsAssembly
  secrets: SecretStore
  clock: ReturnType<typeof makeClock>
  asked: { viewer: PersonId; question: string }[]
  answers: string[]
  sent: unknown[]
  events: { type: string; payload: Record<string, unknown> }[]
}

const rigs: Rig[] = []
afterEach(async () => {
  while (rigs.length > 0) {
    const rig = rigs.pop()
    await rig?.im.close()
    rig?.secrets.close()
  }
})

function makeRig(
  over: Partial<Parameters<typeof createImChannels>[0]> = {},
  script: { updates?: (() => unknown)[] } = {},
): Rig {
  const clock = makeClock()
  const secrets = createSecretStore({
    dbPath: ':memory:',
    clock,
    env: { AGENTSWS_SECRETS_KEY: randomBytes(32).toString('hex') },
  })
  const asked: { viewer: PersonId; question: string }[] = []
  const sent: unknown[] = []
  const answers: string[] = []
  const events: { type: string; payload: Record<string, unknown> }[] = []
  const raw = new MemoryRawStore({ clock })
  let n = 0

  const im = createImChannels({
    clock,
    workspace_id: WS_ID,
    secrets,
    // 只认一张 token：`tok_me` 是 ME，`tok_other` 是另一个人
    identity: {
      authenticate: async (bearer) => {
        if (bearer === 'tok_me')
          return { person_id: ME, workspace_id: WS_ID, kind: 'session' as const }
        if (bearer === 'tok_other')
          return { person_id: OTHER, workspace_id: WS_ID, kind: 'session' as const }
        return undefined
      },
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
    appendEvent: (e) => {
      events.push({ type: e.type, payload: e.payload as Record<string, unknown> })
    },
    newId: () => `id_${++n}`,
    random: () => 0.42,
    storageTier: () => 'local',
    askAgent: async ({ viewer, question }) => {
      asked.push({ viewer, question })
      const answer = `代理答：${question}`
      answers.push(answer)
      return { answer }
    },
    assignmentOf: (p) => (p === ME || p === OTHER ? `asg_${p}` : undefined),
    deepLinkBase: () => 'http://127.0.0.1:7777',
    clawbotState: new MemoryClawBotStateStore(),
    clawbotTransport: fakeTransport({
      ...(script.updates === undefined ? {} : { updates: script.updates }),
      onSend: (body) => {
        sent.push(body)
      },
    }),
    pace: { idle_delay_ms: 1, retry_delay_ms: 1, backoff_delay_ms: 1 },
    ...over,
  })

  const app = new Hono<GatewayEnv>()
  im.mount(app)
  app.onError((err, c) => {
    const e = err instanceof ApiError ? err : new ApiError('internal', String(err))
    return c.json(errorBody(e, ''), e.status as 400)
  })

  const rig: Rig = { app, im, secrets, clock, asked, answers, sent, events }
  rigs.push(rig)
  return rig
}

const call = (
  rig: Rig,
  method: string,
  path: string,
  init: { token?: string; body?: unknown } = {},
): Promise<Response> => {
  const headers = new Headers()
  if (init.token !== undefined) headers.set('Authorization', `Bearer ${init.token}`)
  if (init.body !== undefined) headers.set('content-type', 'application/json')
  return rig.app.request(path, {
    method,
    headers,
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  })
}

const dataOf = async <T>(res: Response): Promise<T> => ((await res.json()) as { data: T }).data

describe('IM 路由：凭据与归属', () => {
  it('五条路由都要凭据', async () => {
    const rig = makeRig()
    for (const [method, path] of [
      ['POST', '/v1/im/wechat/login'],
      ['GET', '/v1/im/wechat/login/x'],
      ['DELETE', '/v1/im/wechat'],
      ['GET', '/v1/im/status'],
      ['PUT', '/v1/im/wecom'],
    ] as const) {
      expect((await call(rig, method, path)).status).toBe(401)
    }
  })

  it('别人的扫码轮询不到（一次扫码属于发起它的那个人）', async () => {
    const rig = makeRig()
    const started = await dataOf<{ login_id: string }>(
      await call(rig, 'POST', '/v1/im/wechat/login', { token: 'tok_me' }),
    )
    const stolen = await call(rig, 'GET', `/v1/im/wechat/login/${started.login_id}`, {
      token: 'tok_other',
    })
    expect(stolen.status).toBe(404)
  })
})

describe('bot_token 只进秘密库', () => {
  it('扫完码：token 在秘密库里，一个字都不在响应体里', async () => {
    const rig = makeRig()
    const started = await dataOf<{ login_id: string; qrcode_url: string }>(
      await call(rig, 'POST', '/v1/im/wechat/login', { token: 'tok_me' }),
    )
    expect(started.qrcode_url).toBe('https://weixin.example/qr')

    const polled = await call(rig, 'GET', `/v1/im/wechat/login/${started.login_id}`, {
      token: 'tok_me',
    })
    const text = await polled.clone().text()
    expect(text).not.toContain('SECRET-BOT-TOKEN')
    expect(await dataOf<{ status: string; account_id: string }>(polled)).toMatchObject({
      status: 'confirmed',
      account_id: 'bot_9',
    })

    // 13 §4.3：值只在秘密库里
    expect(rig.secrets.get(wechatSecretId(ME))?.bot_token).toBe('SECRET-BOT-TOKEN')
    // 秘密库对外只说得出**字段名**
    const record = rig.secrets.record(wechatSecretId(ME))
    expect(record?.field_names).toContain('bot_token')

    // 状态里也没有
    const status = await call(rig, 'GET', '/v1/im/status', { token: 'tok_me' })
    expect(await status.clone().text()).not.toContain('SECRET-BOT-TOKEN')
    expect(await dataOf<{ wechat: { bound: boolean; account_id: string } }>(status)).toMatchObject({
      wechat: { bound: true, account_id: 'bot_9' },
    })
  })

  it('解绑 = 销毁 token（不是停掉轮询）', async () => {
    const rig = makeRig()
    const started = await dataOf<{ login_id: string }>(
      await call(rig, 'POST', '/v1/im/wechat/login', { token: 'tok_me' }),
    )
    await call(rig, 'GET', `/v1/im/wechat/login/${started.login_id}`, { token: 'tok_me' })
    expect(rig.secrets.get(wechatSecretId(ME))).toBeDefined()

    const out = await call(rig, 'DELETE', '/v1/im/wechat', { token: 'tok_me' })
    expect(await dataOf<{ unbound: boolean }>(out)).toMatchObject({ unbound: true })
    expect(rig.secrets.get(wechatSecretId(ME))).toBeUndefined()
    expect(rig.im.status(ME).wechat.bound).toBe(false)
  })

  it('token 按 person 键存：一台机器上两个人各绑各的', () => {
    const rig = makeRig()
    expect(wechatSecretId(ME)).toBe(`im:wechat:${ME}`)
    expect(wechatSecretId(OTHER)).not.toBe(wechatSecretId(ME))
    expect(wecomSecretId(WS_ID)).toBe(`im:wecom:${WS_ID}`)
    expect(rig.im.status(OTHER).wechat.bound).toBe(false)
  })
})

describe('共享档 / 托管档不让绑个人微信（20：个人身份类渠道留本机）', () => {
  it('第二档：拒绝，而且给的是一句人话', async () => {
    const rig = makeRig({ storageTier: () => 'byo_cloud' })
    const res = await call(rig, 'POST', '/v1/im/wechat/login', { token: 'tok_me' })
    expect(res.status).toBe(403)
    const body = (await res.json()) as { code: string; message: string }
    expect(body.code).toBe('forbidden')
    expect(body.message).toBe(WECHAT_LOCAL_ONLY)
    expect(body.message).toContain('你自己这台机器')
  })

  it('第三档：状态里明说不让绑，并带上原因', () => {
    const rig = makeRig({ storageTier: () => 'managed' })
    const status = rig.im.status(ME).wechat
    expect(status.allowed).toBe(false)
    expect(status.reason).toContain('本机档')
  })

  it('档位判据与 storage.ts 的那两行环境变量一致', () => {
    expect(storageTierOf({})).toBe('local')
    expect(storageTierOf({ AGENTSWS_BLOB_URL: '/var/blobs' })).toBe('local')
    expect(storageTierOf({ DATABASE_URL: 'postgres://x' })).toBe('byo_cloud')
    expect(storageTierOf({ AGENTSWS_BLOB_URL: 's3://bucket' })).toBe('byo_cloud')
  })

  it('企业微信不受这条限制（它是公司资产，不是个人身份）', async () => {
    const rig = makeRig({ storageTier: () => 'byo_cloud' })
    const res = await call(rig, 'PUT', '/v1/im/wecom', {
      token: 'tok_me',
      body: { bot_id: 'BID', secret: 'SEC' },
    })
    expect(res.status).toBe(200)
    expect(rig.secrets.get(wecomSecretId(WS_ID))?.secret).toBe('SEC')
  })
})

describe('企业微信设置：Secret 不经模型、不回显', () => {
  it('缺一个字段就拒；填了就只进秘密库', async () => {
    const rig = makeRig()
    expect(
      (await call(rig, 'PUT', '/v1/im/wecom', { token: 'tok_me', body: { bot_id: 'B' } })).status,
    ).toBe(400)

    const res = await call(rig, 'PUT', '/v1/im/wecom', {
      token: 'tok_me',
      body: { bot_id: 'BID', secret: 'SUPER-SECRET' },
    })
    expect(await res.clone().text()).not.toContain('SUPER-SECRET')
    expect(await dataOf<{ bot_id: string }>(res)).toMatchObject({ bot_id: 'BID' })
    // 事件日志里也没有（21 §5）
    expect(JSON.stringify(rig.events)).not.toContain('SUPER-SECRET')
  })
})

describe('入站路由到「我的代理」', () => {
  it('微信：本人问一句 → 代理答 → 回到同一条会话', async () => {
    const rig = makeRig(
      {},
      {
        updates: [
          () => ({
            ret: 0,
            get_updates_buf: 'B1',
            msgs: [
              {
                message_id: '900001',
                from_user_id: WX_USER,
                message_type: 1,
                context_token: 'ctx-1',
                item_list: [{ type: 1, text_item: { text: '我今天有几张卡要定？' } }],
              },
            ],
          }),
        ],
      },
    )
    const started = await dataOf<{ login_id: string }>(
      await call(rig, 'POST', '/v1/im/wechat/login', { token: 'tok_me' }),
    )
    await call(rig, 'GET', `/v1/im/wechat/login/${started.login_id}`, { token: 'tok_me' })

    await waitFor(() => rig.asked.length > 0, '问到代理')
    // 41：问的是**本人自己的**代理
    expect(rig.asked[0]?.viewer).toBe(ME)
    // 注：管线的围栏层会把全角标点归一化，所以这里比的是正文而不是逐字
    expect(rig.asked[0]?.question).toContain('我今天有几张卡要定')
    // 围栏标记不进问题（它是给模型上下文用的，不是给代理读的这一句）
    expect(rig.asked[0]?.question).not.toContain('external_data')

    await waitFor(() => rig.sent.length > 0, '回到微信')
    const msg = (rig.sent[0] as { msg: { to_user_id: string; context_token: string } }).msg
    expect(msg.to_user_id).toBe(WX_USER)
    // 回信带回入站那条的会话上下文
    expect(msg.context_token).toBe('ctx-1')
  })

  it('没有岗位的人不答（也不炸）', async () => {
    const rig = makeRig(
      { assignmentOf: () => undefined },
      {
        updates: [
          () => ({
            ret: 0,
            get_updates_buf: 'B1',
            msgs: [
              {
                message_id: '900002',
                from_user_id: WX_USER,
                message_type: 1,
                context_token: 'ctx-1',
                item_list: [{ type: 1, text_item: { text: '在吗' } }],
              },
            ],
          }),
        ],
      },
    )
    const started = await dataOf<{ login_id: string }>(
      await call(rig, 'POST', '/v1/im/wechat/login', { token: 'tok_me' }),
    )
    await call(rig, 'GET', `/v1/im/wechat/login/${started.login_id}`, { token: 'tok_me' })
    await new Promise((r) => setTimeout(r, 60))
    expect(rig.asked).toHaveLength(0)
    expect(rig.sent).toHaveLength(0)
  })
})

describe('企业微信长连接：真 ws（本机，不出网）', () => {
  it('订阅握手、群里 @ 之后按提问人身份问他自己的代理', async () => {
    const seen: Record<string, unknown>[] = []
    const replies: Record<string, unknown>[] = []
    const wss = await startWss((socket) => {
      socket.on('message', (raw: Buffer) => {
        const frame = JSON.parse(raw.toString('utf8')) as Record<string, unknown>
        seen.push(frame)
        if (frame.cmd === 'aibot_subscribe') {
          socket.send(JSON.stringify({ cmd: 'aibot_subscribe', errcode: 0 }))
          socket.send(
            JSON.stringify({
              cmd: 'aibot_msg_callback',
              headers: { req_id: 'req-9' },
              body: {
                msgid: 'wm_9',
                chatid: 'chat_9',
                chattype: 'group',
                from: { userid: 'wecom_zhangsan' },
                msgtype: 'text',
                text: { content: '@bot 这周谁在管退款？' },
              },
            }),
          )
        }
        if (frame.cmd === 'aibot_respond_msg') replies.push(frame)
      })
    })

    const rig = makeRig({
      wecomUrl: wss.url,
      // 真 `ws` 的 WebSocket 结构上就是 `WecomSocket`
      wecomSocket: (target: string) => new WebSocket(target) as unknown as WecomSocket,
      personByWecomUser: (userid) => (userid === 'wecom_zhangsan' ? OTHER : undefined),
    })
    await call(rig, 'PUT', '/v1/im/wecom', {
      token: 'tok_me',
      body: { bot_id: 'BID', secret: 'SEC' },
    })

    await waitFor(() => replies.length > 0, '群里回了一句')
    // 握手用的是 BotID + Secret（官方文档：明文，无签名）
    expect(seen[0]).toMatchObject({
      cmd: 'aibot_subscribe',
      body: { bot_id: 'BID', secret: 'SEC' },
    })
    // 41：按**提问人**的身份问他自己的代理
    expect(rig.asked[0]?.viewer).toBe(OTHER)
    expect(replies[0]).toMatchObject({
      headers: { req_id: 'req-9' },
      body: { msgtype: 'text' },
    })
    await rig.im.close()
    await wss.close()
  })

  it('认不出的企业微信账号不代答，只回一句「先对上人」', async () => {
    const replies: { text: string }[] = []
    const wss = await startWss((socket) => {
      socket.on('message', (raw: Buffer) => {
        const frame = JSON.parse(raw.toString('utf8')) as {
          cmd?: string
          body?: { text?: { content?: string } }
        }
        if (frame.cmd === 'aibot_subscribe') {
          socket.send(JSON.stringify({ cmd: 'aibot_subscribe', errcode: 0 }))
          socket.send(
            JSON.stringify({
              cmd: 'aibot_msg_callback',
              headers: { req_id: 'req-x' },
              body: {
                msgid: 'wm_x',
                chatid: 'chat_x',
                chattype: 'group',
                from: { userid: 'nobody' },
                msgtype: 'text',
                text: { content: '@bot 公司现在有多少订单？' },
              },
            }),
          )
        }
        if (frame.cmd === 'aibot_respond_msg')
          replies.push({ text: frame.body?.text?.content ?? '' })
      })
    })
    const rig = makeRig({
      wecomUrl: wss.url,
      wecomSocket: (target: string) => new WebSocket(target) as unknown as WecomSocket,
      personByWecomUser: () => undefined,
    })
    await call(rig, 'PUT', '/v1/im/wecom', {
      token: 'tok_me',
      body: { bot_id: 'BID', secret: 'SEC' },
    })
    await waitFor(() => replies.length > 0, '回了一句')
    expect(rig.asked).toHaveLength(0)
    expect(replies[0]?.text).toContain('还不认识你')
    await rig.im.close()
    await wss.close()
  })

  it('官方地址就是文档里那一个（真跑时不打本机）', () => {
    expect(WECOM_WS_URL).toBe('wss://openws.work.weixin.qq.com')
    expect(subscribeFrame({ bot_id: 'b', secret: 's', req_id: 'r' })).toMatchObject({
      cmd: 'aibot_subscribe',
    })
  })
})

/** 起一个本机 WS 服务器，等它真的 listening 之后再回地址。 */
async function startWss(
  onConnection: (socket: import('ws').WebSocket) => void,
): Promise<{ url: string; close(): Promise<void> }> {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' })
  await new Promise<void>((resolve) => {
    wss.on('listening', resolve)
  })
  wss.on('connection', onConnection)
  const address = wss.address() as { port: number }
  return {
    url: `ws://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve) => {
        wss.close(() => {
          resolve()
        })
      }),
  }
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (predicate()) return
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 5)
    })
  }
  throw new Error(`waitFor 超时：${label}`)
}

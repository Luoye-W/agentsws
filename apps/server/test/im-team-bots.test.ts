/**
 * 飞书 / 钉钉两条团队渠道的服务端一面（WP211）。
 *
 * 钉六件事（全部用替身，不连真飞书 / 钉钉）：
 * 1. 新路由都要凭据；Secret 只进秘密库——**不在任何响应体、状态里**；
 * 2. 私聊：认不出的人不代答，只回一句怎么绑；
 * 3. 绑定：工作台发码 → 私聊机器人发「绑定 123456」→ 之后按**他自己**的身份问代理；
 *    码只能用一次、10 分钟过期、猜错太多次就不认；
 * 4. 群里 @：一样按提问人身份答（钉钉群里顺手 @ 回提问人）；
 * 5. 凭据错误：状态里是一句人话，不是原始错误串；
 * 6. 官方飞书 SDK 的包装：参数与回调接对了（假模块），真包离线装得上、形状对得上。
 */
import { randomBytes } from 'node:crypto'
import { ApiError, errorBody, type GatewayEnv } from '@agentsws/api'
import {
  ChannelInboundPipeline,
  type DingtalkHttp,
  type DingtalkSocket,
  type FeishuConnState,
  type FeishuMessageEvent,
  type FeishuTransport,
  MemoryRawStore,
  TOPIC_ROBOT,
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
import { createImChannels, type ImChannelsAssembly, type ImStatusView } from '../src/im-channels.js'
import { createFeishuSdkTransport, loadLarkSdk } from '../src/im-sdk.js'
import {
  BIND_MAX_MISSES,
  createTeamBotManagerCheck,
  feishuSecretId,
  IM_TEXT,
  ImBindCodes,
  parseBindCommand,
} from '../src/im-team-bots.js'
import { createSecretStore, type SecretStore } from '../src/secret-store.js'

const WS_ID = 'ws_1'
const ME: PersonId = 'per_me'
const MEMBER: PersonId = 'per_member'
const APP_ID = 'cli_a1b2c3d4e5f60718'
const HOOK = 'https://oapi.dingtalk.com/robot/sendBySession?session=s1'

class FakeFeishu implements FeishuTransport {
  replies: { message_id: string; text: string }[] = []
  started: string[] = []
  #onEvent: ((e: FeishuMessageEvent) => void) | undefined
  #onState: ((s: FeishuConnState, d?: string) => void) | undefined
  async start(input: Parameters<FeishuTransport['start']>[0]): Promise<void> {
    this.started.push(input.app_id)
    this.#onEvent = input.onEvent
    this.#onState = input.onState
    input.onState('connected')
  }
  async stop(): Promise<void> {}
  async reply(input: { message_id: string; text: string }): Promise<void> {
    this.replies.push(input)
  }
  async botOpenId(): Promise<string | undefined> {
    return 'ou_bot'
  }
  push(e: FeishuMessageEvent): void {
    this.#onEvent?.(e)
  }
  state(s: FeishuConnState, d?: string): void {
    this.#onState?.(s, d)
  }
}

class FakeDingSocket implements DingtalkSocket {
  sent: Record<string, unknown>[] = []
  #h: Record<string, ((a: never) => void)[]> = {}
  send(d: string): void {
    this.sent.push(JSON.parse(d) as Record<string, unknown>)
  }
  close(): void {}
  on(event: string, cb: (a: never) => void): void {
    this.#h[event] = [...(this.#h[event] ?? []), cb]
  }
  emit(event: string, arg: unknown): void {
    for (const cb of this.#h[event] ?? []) (cb as (a: unknown) => void)(arg)
  }
  robot(m: Record<string, unknown>, id: string): void {
    this.emit(
      'message',
      JSON.stringify({
        type: 'CALLBACK',
        headers: { topic: TOPIC_ROBOT, messageId: id },
        data: JSON.stringify(m),
      }),
    )
  }
}

interface Rig {
  app: Hono<GatewayEnv>
  im: ImChannelsAssembly
  secrets: SecretStore
  feishu: FakeFeishu
  ding: FakeDingSocket[]
  hooks: { url: string; body: Record<string, unknown> }[]
  asked: { viewer: PersonId; question: string }[]
  events: Record<string, unknown>[]
  gatewayStatus: number[]
  clock: { now(): Iso8601; advance(ms: number): void }
}

const rigs: Rig[] = []
afterEach(async () => {
  while (rigs.length > 0) {
    const r = rigs.pop()
    await r?.im.close()
    r?.secrets.close()
  }
})

function makeRig(): Rig {
  let t = Date.parse('2026-09-30T09:00:00.000Z')
  const clock = {
    now: () => new Date(t).toISOString(),
    advance: (ms: number) => {
      t += ms
    },
  }
  const secrets = createSecretStore({
    dbPath: ':memory:',
    clock,
    env: { AGENTSWS_SECRETS_KEY: randomBytes(32).toString('hex') },
  })
  const raw = new MemoryRawStore({ clock })
  const feishu = new FakeFeishu()
  const ding: FakeDingSocket[] = []
  const hooks: Rig['hooks'] = []
  const asked: Rig['asked'] = []
  const events: Rig['events'] = []
  const gatewayStatus: number[] = []
  let n = 0
  let rnd = 0
  const http: DingtalkHttp = async (url, init) => {
    const body = JSON.parse(init.body) as Record<string, unknown>
    if (url.includes('gateway')) {
      const status = gatewayStatus.shift() ?? 200
      return {
        status,
        json: async () => ({ endpoint: 'wss://x.dingtalk.com/connect', ticket: 'T' }),
      }
    }
    hooks.push({ url, body })
    return { status: 200, json: async () => ({ errcode: 0 }) }
  }
  const im = createImChannels({
    clock,
    workspace_id: WS_ID,
    secrets,
    identity: {
      authenticate: async (bearer) =>
        bearer === 'tok_me'
          ? { person_id: ME, workspace_id: WS_ID, kind: 'session' as const }
          : bearer === 'tok_member'
            ? { person_id: MEMBER, workspace_id: WS_ID, kind: 'session' as const }
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
    appendEvent: (e) => {
      events.push(e.payload as Record<string, unknown>)
    },
    newId: () => `id_${++n}`,
    // 绑定码由它生成：每次换一个，测试里可预期
    random: () => {
      rnd += 1
      return (123456 + rnd) / 1_000_000
    },
    storageTier: () => 'local',
    askAgent: async ({ viewer, question }) => {
      asked.push({ viewer, question })
      return { answer: `代理答：${question}` }
    },
    assignmentOf: (p) => (p === ME || p === MEMBER ? `asg_${p}` : undefined),
    // ME 是负责人；MEMBER 是普通成员
    canManageTeamBots: (p) => p === ME,
    deepLinkBase: () => 'http://127.0.0.1:7777',
    feishuTransport: () => feishu,
    dingtalkSocket: () => {
      const s = new FakeDingSocket()
      ding.push(s)
      return s
    },
    dingtalkHttp: http,
  })
  const app = new Hono<GatewayEnv>()
  im.mount(app)
  app.onError((err, c) => {
    const e = err instanceof ApiError ? err : new ApiError('internal', String(err))
    return c.json(errorBody(e, ''), e.status as 400)
  })
  const r: Rig = { app, im, secrets, feishu, ding, hooks, asked, events, gatewayStatus, clock }
  rigs.push(r)
  return r
}

const call = (r: Rig, method: string, path: string, body?: unknown, token = 'tok_me') =>
  r.app.request(path, {
    method,
    headers: {
      ...(token === '' ? {} : { Authorization: `Bearer ${token}` }),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })

const dataOf = async <T>(res: Response): Promise<T> => ((await res.json()) as { data: T }).data

async function waitFor(pred: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (pred()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`waitFor 超时：${label}`)
}

const feishuMsg = (
  id: string,
  text: string,
  over: Partial<{ group: boolean; from: string }> = {},
) => ({
  sender: { sender_id: { open_id: over.from ?? 'ou_me' }, sender_type: 'user' },
  message: {
    message_id: id,
    chat_id: 'oc_1',
    chat_type: over.group === true ? 'group' : 'p2p',
    message_type: 'text',
    content: JSON.stringify({ text: over.group === true ? `@_user_1 ${text}` : text }),
    ...(over.group === true ? { mentions: [{ key: '@_user_1', id: { open_id: 'ou_bot' } }] } : {}),
  },
})

describe('路由与凭据', () => {
  it('新路由都要凭据', async () => {
    const r = makeRig()
    for (const [m, path] of [
      ['PUT', '/v1/im/feishu'],
      ['DELETE', '/v1/im/feishu'],
      ['PUT', '/v1/im/dingtalk'],
      ['DELETE', '/v1/im/dingtalk'],
      ['POST', '/v1/im/bind-code'],
      ['DELETE', '/v1/im/bind/feishu'],
    ] as const)
      expect((await call(r, m, path, undefined, '')).status, path).toBe(401)
  })

  it('飞书：Secret 只进秘密库，不在响应体、状态里；App ID 形状不对当场说', async () => {
    const r = makeRig()
    const bad = await call(r, 'PUT', '/v1/im/feishu', { app_id: 'abc', app_secret: 'S' })
    expect(bad.status).toBe(400)
    expect(await bad.text()).toContain('cli_')
    const res = await call(r, 'PUT', '/v1/im/feishu', {
      app_id: APP_ID,
      app_secret: 'FEISHU-SECRET-1',
    })
    expect(await res.clone().text()).not.toContain('FEISHU-SECRET-1')
    expect(r.secrets.get(feishuSecretId(WS_ID))?.app_secret).toBe('FEISHU-SECRET-1')
    const status = await call(r, 'GET', '/v1/im/status')
    expect(await status.clone().text()).not.toContain('FEISHU-SECRET-1')
    expect((await dataOf<ImStatusView>(status)).feishu).toMatchObject({
      configured: true,
      connected: true,
      app_id: APP_ID,
      me_bound: false,
    })
    expect(JSON.stringify(r.events)).not.toContain('FEISHU-SECRET-1')
    // 断开 = 销毁凭据
    expect(await dataOf(await call(r, 'DELETE', '/v1/im/feishu'))).toEqual({ removed: true })
    expect(r.secrets.get(feishuSecretId(WS_ID))).toBeUndefined()
  })
})

describe('飞书：认人、绑定、按提问人身份答', () => {
  it('没绑的人私聊：不代答，只回一句怎么绑', async () => {
    const r = makeRig()
    await call(r, 'PUT', '/v1/im/feishu', { app_id: APP_ID, app_secret: 'S' })
    r.feishu.push(feishuMsg('om_1', '公司现在有多少订单？'))
    await waitFor(() => r.feishu.replies.length === 1, '回了一句')
    expect(r.asked).toHaveLength(0)
    expect(r.feishu.replies[0]?.text).toBe(IM_TEXT.unknown)
  })

  it('工作台发码 → 私聊发「绑定 xxxxxx」→ 之后私聊与群 @ 都按他自己的身份答', async () => {
    const r = makeRig()
    await call(r, 'PUT', '/v1/im/feishu', { app_id: APP_ID, app_secret: 'S' })
    const { code } = await dataOf<{ code: string }>(await call(r, 'POST', '/v1/im/bind-code'))
    expect(code).toMatch(/^\d{6}$/)
    r.feishu.push(feishuMsg('om_b', `绑定 ${code}`))
    await waitFor(() => r.feishu.replies.length === 1, '绑好了')
    expect(r.feishu.replies[0]?.text).toBe(IM_TEXT.bound)
    // 聊天账号 id 不进事件
    expect(JSON.stringify(r.events)).not.toContain('ou_me')
    expect(
      (await dataOf<ImStatusView>(await call(r, 'GET', '/v1/im/status'))).feishu?.me_bound,
    ).toBe(true)

    r.feishu.push(feishuMsg('om_q', '这周谁在管退款？'))
    await waitFor(() => r.feishu.replies.length === 2, '私聊答了')
    // 问题进管线时全角标点会被规范化（围栏那一层），只看人与内容
    expect(r.asked[0]?.viewer).toBe(ME)
    expect(r.asked[0]?.question).toContain('谁在管退款')
    expect(r.feishu.replies[1]?.message_id).toBe('om_q')
    expect(r.feishu.replies[1]?.text).toContain('代理答：')

    r.feishu.push(feishuMsg('om_g', '今天有什么要定的？', { group: true }))
    await waitFor(() => r.feishu.replies.length === 3, '群 @ 答了')
    expect(r.asked[1]?.viewer).toBe(ME)
    expect(r.asked[1]?.question).toContain('今天有什么要定的')

    // 码只能用一次：别人拿同一个码来，不认
    r.feishu.push(feishuMsg('om_x', `绑定 ${code}`, { from: 'ou_other' }))
    await waitFor(() => r.feishu.replies.length === 4, '不认')
    expect(r.feishu.replies[3]?.text).toBe(IM_TEXT.badCode)

    // 解绑之后又不认识了
    expect(await dataOf(await call(r, 'DELETE', '/v1/im/bind/feishu'))).toEqual({ removed: 1 })
    r.feishu.push(feishuMsg('om_after', '还认识我吗'))
    await waitFor(() => r.feishu.replies.length === 5, '不认识了')
    expect(r.feishu.replies[4]?.text).toBe(IM_TEXT.unknown)
  })

  it('凭据错误：状态里是一句人话，不是原始错误串', async () => {
    const r = makeRig()
    await call(r, 'PUT', '/v1/im/feishu', { app_id: APP_ID, app_secret: 'S' })
    r.feishu.state('failed', 'pullConnectConfig failed: code=514, msg=auth failed')
    const view = (await dataOf<ImStatusView>(await call(r, 'GET', '/v1/im/status'))).feishu
    expect(view?.state).toBe('failed')
    expect(view?.error).toContain('App Secret')
    expect(view?.error).not.toContain('pullConnectConfig')
  })
})

describe('钉钉：认人、绑定、群 @、凭据错误', () => {
  const robot = (
    id: string,
    text: string,
    over: Partial<{ group: boolean; staff: string }> = {},
  ) => ({
    msgId: id,
    msgtype: 'text',
    text: { content: text },
    conversationId: 'cid',
    conversationType: over.group === true ? '2' : '1',
    isInAtList: true,
    senderStaffId: over.staff ?? 'staff_me',
    sessionWebhook: HOOK,
    sessionWebhookExpiredTime: Date.parse('2026-09-30T10:00:00.000Z'),
  })

  it('没绑不代答 → 绑定 → 群 @ 按他的身份答，并 @ 回他', async () => {
    const r = makeRig()
    await call(r, 'PUT', '/v1/im/dingtalk', { client_id: 'ding_a', client_secret: 'DING-SECRET-1' })
    expect(r.secrets.get('im:dingtalk:ws_1')?.client_secret).toBe('DING-SECRET-1')
    const s = r.ding[0] as FakeDingSocket
    s.emit('open', undefined)
    s.robot(robot('m1', '公司多少订单'), 'x1')
    await waitFor(() => r.hooks.length === 1, '回了一句')
    expect(r.hooks[0]?.body).toMatchObject({ text: { content: IM_TEXT.unknown } })
    expect(r.asked).toHaveLength(0)

    const { code } = await dataOf<{ code: string }>(await call(r, 'POST', '/v1/im/bind-code'))
    s.robot(robot('m2', `bind ${code}`), 'x2')
    await waitFor(() => r.hooks.length === 2, '绑好了')
    expect(r.hooks[1]?.body).toMatchObject({ text: { content: IM_TEXT.bound } })

    s.robot(robot('m3', '这周谁在管退款？', { group: true }), 'x3')
    await waitFor(() => r.hooks.length === 3, '群里答了')
    expect(r.asked[0]?.viewer).toBe(ME)
    expect(r.asked[0]?.question).toContain('谁在管退款')
    expect(r.hooks[2]?.body).toMatchObject({ msgtype: 'text', at: { atUserIds: ['staff_me'] } })
    expect(JSON.stringify(r.hooks[2]?.body)).toContain('代理答：')
    const view = (await dataOf<ImStatusView>(await call(r, 'GET', '/v1/im/status'))).dingtalk
    expect(view).toMatchObject({
      configured: true,
      connected: true,
      client_id: 'ding_a',
      me_bound: true,
    })
    expect(JSON.stringify(view)).not.toContain('DING-SECRET-1')
  })

  it('凭据错误（换 ticket 回 401）：状态里一句人话、停在 failed', async () => {
    const r = makeRig()
    r.gatewayStatus.push(401)
    await call(r, 'PUT', '/v1/im/dingtalk', { client_id: 'ding_a', client_secret: 'bad' })
    const view = (await dataOf<ImStatusView>(await call(r, 'GET', '/v1/im/status'))).dingtalk
    expect(view?.state).toBe('failed')
    expect(view?.error).toContain('Client Secret')
    expect(r.ding).toHaveLength(0)
  })
})

describe('谁能管公司的应用凭据（Fable 09-30）', () => {
  it('普通成员：三条渠道的填 / 改 / 断开一律 403，状态里 can_manage=false；自己的绑定照旧能用', async () => {
    const r = makeRig()
    for (const [m, path, body] of [
      ['PUT', '/v1/im/wecom', { bot_id: 'B', secret: 'S' }],
      ['PUT', '/v1/im/feishu', { app_id: APP_ID, app_secret: 'S' }],
      ['DELETE', '/v1/im/feishu', undefined],
      ['PUT', '/v1/im/dingtalk', { client_id: 'd', client_secret: 'S' }],
      ['DELETE', '/v1/im/dingtalk', undefined],
    ] as const) {
      const res = await call(r, m, path, body, 'tok_member')
      expect(res.status, `${m} ${path}`).toBe(403)
      expect(await res.text()).toContain('负责人或公司管理员')
    }
    expect(r.secrets.list()).toHaveLength(0)
    const view = await dataOf<ImStatusView>(
      await call(r, 'GET', '/v1/im/status', undefined, 'tok_member'),
    )
    expect(view.can_manage).toBe(false)
    expect((await call(r, 'POST', '/v1/im/bind-code', undefined, 'tok_member')).status).toBe(200)
    expect((await call(r, 'DELETE', '/v1/im/bind/feishu', undefined, 'tok_member')).status).toBe(
      200,
    )
  })

  it('负责人：能填能断；状态里 can_manage=true；普通成员断不开负责人配好的', async () => {
    const r = makeRig()
    expect(
      (await call(r, 'PUT', '/v1/im/feishu', { app_id: APP_ID, app_secret: 'S' })).status,
    ).toBe(200)
    expect((await dataOf<ImStatusView>(await call(r, 'GET', '/v1/im/status'))).can_manage).toBe(
      true,
    )
    expect((await call(r, 'DELETE', '/v1/im/feishu', undefined, 'tok_member')).status).toBe(403)
    expect(r.secrets.get(feishuSecretId(WS_ID))).toBeDefined()
  })

  it('判定：持有 common.owner 的负责人，或公司的所有者 / 管理员；普通成员与外人都不行', async () => {
    const org = {
      id: 'org_1',
      owner_id: 'per_boss',
      members: [
        { person_id: 'per_boss', role: 'owner' },
        { person_id: 'per_admin', role: 'admin' },
        { person_id: 'per_member', role: 'member' },
        { person_id: 'per_left', role: 'admin', left_at: '2026-09-01T00:00:00.000Z' },
      ],
    } as never
    const check = createTeamBotManagerCheck({
      isOwner: (p) => p === 'per_role_owner',
      organization: async () => org,
    })
    expect(await check('per_role_owner')).toBe(true)
    expect(await check('per_boss')).toBe(true)
    expect(await check('per_admin')).toBe(true)
    expect(await check('per_member')).toBe(false)
    expect(await check('per_left')).toBe(false)
    expect(await check('per_stranger')).toBe(false)
    // 取不到公司：只认负责人
    const noOrg = createTeamBotManagerCheck({
      isOwner: () => false,
      organization: async () => undefined,
    })
    expect(await noOrg('per_admin')).toBe(false)
  })
})

describe('绑定码', () => {
  it('认得「绑定 123456」「bind:123456」，别的不认', () => {
    expect(parseBindCommand('绑定 123456')).toBe('123456')
    expect(parseBindCommand(' BIND：654321 ')).toBe('654321')
    expect(parseBindCommand('绑定123')).toBeUndefined()
    expect(parseBindCommand('请帮我绑定 123456 这个订单')).toBeUndefined()
  })

  it('10 分钟过期；同一个账号猜错太多次就一律不认', () => {
    const codes = new ImBindCodes(() => 0.111111)
    const now = 1_000_000
    const { code } = codes.issue(ME, now)
    expect(codes.consume(code, 'feishu:x', now + 10 * 60 * 1000)).toBeUndefined()
    const again = codes.issue(ME, now)
    for (let i = 0; i < BIND_MAX_MISSES; i++) codes.consume('000000', 'feishu:y', now)
    expect(codes.consume(again.code, 'feishu:y', now)).toBeUndefined()
    // 别的账号不受牵连
    expect(codes.consume(again.code, 'feishu:z', now)).toBe(ME)
  })
})

describe('官方飞书 SDK 的包装', () => {
  it('参数、事件回调、回复与机器人 open_id 都接对了（假模块，不出网）', async () => {
    const seen: Record<string, unknown> = {}
    let handler: ((d: unknown) => unknown) | undefined
    const fakeLark = {
      Domain: { Feishu: 'F', Lark: 'L' },
      LoggerLevel: { error: 1 },
      Client: class {
        im = {
          v1: {
            message: {
              reply: async (p: unknown) => {
                seen.reply = p
                return { code: 0 }
              },
            },
          },
        }
        request = async () => ({ bot: { open_id: 'ou_bot' } })
        constructor(p: unknown) {
          seen.client = p
        }
      },
      WSClient: class {
        constructor(p: Record<string, unknown>) {
          seen.ws = p
        }
        async start(): Promise<void> {
          ;(seen.ws as { onReady: () => void }).onReady()
        }
        close(): void {}
      },
      EventDispatcher: class {
        register(h: Record<string, (d: unknown) => unknown>) {
          handler = h['im.message.receive_v1']
          return this
        }
      },
    }
    const t = createFeishuSdkTransport(async () => fakeLark as never)
    const states: string[] = []
    const events: unknown[] = []
    await t.start({
      app_id: APP_ID,
      app_secret: 'S',
      domain: 'lark',
      onEvent: (e) => events.push(e),
      onState: (s) => states.push(s),
    })
    expect(seen.ws).toMatchObject({
      appId: APP_ID,
      appSecret: 'S',
      domain: 'L',
      autoReconnect: true,
    })
    expect(states).toEqual(['connecting', 'connected'])
    handler?.({ message: { message_id: 'om' } })
    expect(events).toHaveLength(1)
    await t.reply({ message_id: 'om', text: '答' })
    expect(seen.reply).toEqual({
      path: { message_id: 'om' },
      data: { msg_type: 'text', content: '{"text":"答"}' },
    })
    expect(await t.botOpenId()).toBe('ou_bot')
  })

  it('真包离线装得上、形状对得上（只 new，不 start，不出网）', async () => {
    const lark = await loadLarkSdk()
    expect(typeof lark.WSClient).toBe('function')
    expect(typeof lark.EventDispatcher).toBe('function')
    const ws = new lark.WSClient({ appId: APP_ID, appSecret: 'S', autoReconnect: true })
    expect(typeof ws.start).toBe('function')
    const client = new lark.Client({ appId: APP_ID, appSecret: 'S' })
    expect(typeof client.im.v1.message.reply).toBe('function')
  })
})

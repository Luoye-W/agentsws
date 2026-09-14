/**
 * 在线聊天的实时车道在服务进程里真接起来（WP57；48 §4 L3 #11 的本地部分）。
 *
 * 跑的是真链路：真适配器 → 真入站管线（去重 / 围栏 / 脱敏 / 路由）→ 真受控原始材料区
 * → 真工作模型事项 → 真审批总线。只有模型是桩（`complete` 回一句固定话，
 * 断言看的是"走没走模型""说了什么"，不是模型写得好不好）。
 */

import { MemoryRawStore } from '@agentsws/channels'
import type {
  ApprovalItem,
  Clock,
  CreateApprovalInput,
  EventEnvelope,
  ObjectRef,
} from '@agentsws/contracts'
import { MemoryHalt } from '@agentsws/kernel'
import type { ModelGatewayApi } from '@agentsws/model-gateway'
import { createWork, type Work } from '@agentsws/work'
import { describe, expect, it } from 'vitest'
import { CHAT_ASSIST_TIMEOUT_HANDLER, type ChatLane, createChatLane } from '../src/chat.js'

const WS = 'ws_1'
const T0 = '2026-09-14T10:00:00.000Z'

class StepClock implements Clock {
  private ms = Date.parse(T0)
  now(): string {
    return new Date(this.ms).toISOString()
  }
  async sleep(): Promise<void> {
    return undefined
  }
  advance(ms: number): void {
    this.ms += ms
  }
}

/** 只记不判的审批总线（真总线在 txn 里，这里要断的是"出没出卡、卡里写了什么"）。 */
class RecordingApprovals {
  readonly items: ApprovalItem[] = []
  async create<P>(input: CreateApprovalInput<P>): Promise<ApprovalItem<P>> {
    const item = {
      ...input,
      id: `ai_${this.items.length + 1}`,
      state: 'pending',
      created_at: T0,
      updated_at: T0,
      revision: 1,
      deliveries: [],
      links: { children: [] },
    } as unknown as ApprovalItem<P>
    this.items.push(item as ApprovalItem)
    return item
  }
}

/** 模型桩：记下每次调用，回一句固定话。 */
function stubModels(text = 'Shipping to the US is free over $50.'): {
  api: ModelGatewayApi
  calls: { system: string; user: string }[]
} {
  const calls: { system: string; user: string }[] = []
  const api = {
    async complete(req: { messages: { role: string; content: string }[] }) {
      calls.push({
        system: req.messages.find((m) => m.role === 'system')?.content ?? '',
        user: req.messages.find((m) => m.role === 'user')?.content ?? '',
      })
      return {
        text,
        usage: { input_tokens: 10, output_tokens: 10, cached_tokens: 0, cost_base: 1 },
        model: { provider: 'stub', model: 'stub' },
        static_prefix_hash: 'h',
      }
    },
  } as unknown as ModelGatewayApi
  return { api, calls }
}

interface Rig {
  clock: StepClock
  chat: ChatLane
  work: Work
  approvals: RecordingApprovals
  events: (Omit<EventEnvelope, 'id' | 'at'> & { at?: string })[]
  models: ReturnType<typeof stubModels>
  emails: { session_id: string }[]
}

function rig(over: { models?: boolean; answer?: string } = {}): Rig {
  const clock = new StepClock()
  const approvals = new RecordingApprovals()
  const events: (Omit<EventEnvelope, 'id' | 'at'> & { at?: string })[] = []
  const work = createWork({ workspace_id: WS, clock, random: () => 0.5, tz_offset_minutes: 0 })
  const models = stubModels(over.answer)
  const emails: { session_id: string }[] = []
  const chat = createChatLane({
    clock,
    workspace_id: WS,
    appendEvent: (e) => {
      events.push(e)
    },
    halt: new MemoryHalt(),
    raw: new MemoryRawStore({ clock }),
    work,
    approvals,
    ...(over.models === false ? {} : { models: models.api }),
    searchKnowledge: async () => [
      { fact_card_id: 'fc_1', statement: '美国订单满 $50 免邮，否则 $6.9。' },
    ],
    position: () => ({ person_id: 'p_wang', assignment_id: 'as_1', role_id: 'dtc.live-chat' }),
    emailFollowUp: async ({ session }) => {
      emails.push({ session_id: session.id })
      return { sent: true }
    },
    // 测试自己驱动轮次：不挂真定时器
    schedule_turn: () => undefined,
  })
  return { clock, chat, work, approvals, events, models, emails }
}

const open = (r: Rig) => r.chat.openSandbox('p_wang')

/**
 * 访客说一句，然后等过 2 秒静默窗口。
 *
 * 单独一个 `receive` **拿不到计划**是对的：那一刻这一轮还没说完（2s 静默窗口），
 * 车道要等。测试里把这一步写清楚，就顺手钉住了"不抢答"这条。
 */
async function say(r: Rig, session_id: string, text: string, external_id?: string) {
  await r.chat.receive({
    session_id,
    text,
    ...(external_id === undefined ? {} : { external_id }),
  })
  r.clock.advance(2_500)
  return r.chat.advanceTurn(session_id)
}

describe('实时车道：五种动作各走一遍', () => {
  it('answer：问运费 → 词表命中售前 → 轻模型答，并推进会话', async () => {
    const r = rig()
    const s = await open(r)
    const out = await say(r, s.id, 'how much is shipping to the US?')
    expect(out.plan?.action).toBe('answer')
    expect(out.used_model).toBe(true)
    expect(out.reply).toContain('free over $50')
    const messages = await r.chat.messages(s.id)
    expect(messages.map((m) => m.role)).toEqual(['visitor', 'agent'])
    expect(messages[1]?.plan_action).toBe('answer')
  })

  it('answer 的材料里有知识命中，访客原话在围栏里', async () => {
    const r = rig()
    const s = await open(r)
    await say(r, s.id, 'how much is shipping to the US?')
    const user = r.models.calls[0]?.user ?? ''
    expect(user).toContain('美国订单满 $50 免邮')
    expect(user).toContain('<external_data>')
    expect(r.models.calls[0]?.system).toContain('不承诺钱')
  })

  it('collect_info：查订单没给单号 → 追问，且不花模型', async () => {
    const r = rig()
    const s = await open(r)
    const out = await say(r, s.id, 'where is my package?')
    expect(out.plan?.action).toBe('collect_info')
    expect(out.used_model).toBe(false)
    expect(r.models.calls).toHaveLength(0)
    expect(out.reply).toContain('订单号或下单邮箱')
  })

  it('human_review：问退款 → 出卡，聊天里只安抚不承诺', async () => {
    const r = rig()
    const s = await open(r)
    const out = await say(r, s.id, 'can I get a refund for #1001?')
    expect(out.plan?.action).toBe('human_review')
    expect(out.plan?.money_touch).toBe(true)
    expect(out.approval_item_id).toBeDefined()
    // 卡是 outbound_draft 的聊天形态：`payload.channel === 'chat'`，出站由聊天车道接
    const card = r.approvals.items[0] as ApprovalItem
    expect(card.kind).toBe('outbound_draft')
    expect(card.payload as { channel: string; money_touch: boolean }).toMatchObject({
      channel: 'chat',
      money_touch: true,
    })
    // **卡上的话还没说出去**：会话里 AI 说的是那句安抚，不是卡上的建议话术
    expect(out.reply).not.toContain('退款')
    expect(r.models.calls).toHaveLength(0)
  })

  it('assist：要人工 → 出卡 + 起超时钟', async () => {
    const r = rig()
    const s = await open(r)
    const out = await say(r, s.id, 'I want to talk to a human')
    expect(out.plan?.action).toBe('assist')
    expect(out.approval_item_id).toBeDefined()
    const after = await r.chat.session(s.id)
    expect(after?.status).toBe('assist_requested')
    expect(after?.assist_requested_at).toBeDefined()
  })

  it('handoff：人接管之后 AI 一句都不答', async () => {
    const r = rig()
    const s = await open(r)
    await r.chat.setTakeover(s.id, true)
    const out = await say(r, s.id, 'how much is shipping?')
    expect(out.plan?.action).toBe('handoff')
    expect(out.reply).toBeUndefined()
    expect(r.models.calls).toHaveLength(0)
    expect((await r.chat.messages(s.id)).filter((m) => m.role === 'agent')).toHaveLength(0)
  })

  it('放手接管 → AI 又能答了', async () => {
    const r = rig()
    const s = await open(r)
    await r.chat.setTakeover(s.id, true)
    await r.chat.setTakeover(s.id, false)
    const out = await say(r, s.id, 'how much is shipping?')
    expect(out.plan?.action).toBe('answer')
  })
})

describe('轮次聚合：连着发三条是一轮', () => {
  it('2 秒之内的三条并成一轮，只答一次', async () => {
    const r = rig()
    const s = await open(r)
    await r.chat.receive({ session_id: s.id, text: '你好', external_id: 'm1' })
    r.clock.advance(300)
    await r.chat.receive({ session_id: s.id, text: '想问下运费', external_id: 'm2' })
    r.clock.advance(300)
    await r.chat.receive({ session_id: s.id, text: '寄美国', external_id: 'm3' })
    // 这三下都在静默窗口里：一句都没答
    expect((await r.chat.messages(s.id)).filter((m) => m.role === 'agent')).toHaveLength(0)
    // 停手 2 秒之后推进一次
    r.clock.advance(2_500)
    const out = await r.chat.advanceTurn(s.id)
    expect(out.plan?.action).toBe('answer')
    expect(r.models.calls).toHaveLength(1)
    expect(r.models.calls[0]?.user).toContain('寄美国')
  })
})

describe('求助超时：T+3 提醒 / T+10 转邮件', () => {
  const arm = async (r: Rig) => {
    const s = await open(r)
    await say(r, s.id, 'I want to talk to a human')
    return s
  }

  it('T+1 分钟：什么都不做', async () => {
    const r = rig()
    const s = await arm(r)
    r.clock.advance(60_000)
    await r.chat.touch(s.id)
    expect(await r.chat.sweepAssistTimeouts()).toMatchObject({ reminded: 0, demoted: 0 })
  })

  it('T+3 分钟、人还在：提醒一次，且只提醒一次', async () => {
    const r = rig()
    const s = await arm(r)
    r.clock.advance(3 * 60_000 + 1_000)
    // 访客还挂在页面上（widget 心跳 / SSE）
    await r.chat.touch(s.id)
    expect(await r.chat.sweepAssistTimeouts()).toMatchObject({ reminded: 1 })
    r.clock.advance(30_000)
    await r.chat.touch(s.id)
    expect(await r.chat.sweepAssistTimeouts()).toMatchObject({ reminded: 0 })
    const texts = (await r.chat.messages(s.id)).map((m) => m.text)
    expect(texts.filter((t) => t.includes('留个邮箱'))).toHaveLength(1)
  })

  it('T+3 但人已经离开页面：不提醒一个空页面', async () => {
    const r = rig()
    await arm(r)
    r.clock.advance(4 * 60_000)
    expect(await r.chat.sweepAssistTimeouts()).toMatchObject({ reminded: 0, demoted: 0 })
  })

  it('T+10 分钟：转邮件跟进，会话状态跟着变', async () => {
    const r = rig()
    const s = await arm(r)
    r.clock.advance(10 * 60_000 + 1_000)
    expect(await r.chat.sweepAssistTimeouts()).toMatchObject({ demoted: 1 })
    expect((await r.chat.session(s.id))?.status).toBe('email_follow_up')
    expect(r.emails).toEqual([{ session_id: s.id }])
    // 转过邮件之后，访客再说话 AI 也不自动答（会话已不在自动回复态）
    const out = await say(r, s.id, 'how much is shipping?')
    expect(out.plan?.action).toBe('handoff')
  })

  it('没接邮件渠道时**不假装发了邮件**：会话照样转态，事件里写着没交出去', async () => {
    const r = rig()
    const s = await open(r)
    // 换一条没有 emailFollowUp 的车道
    const bare = createChatLane({
      clock: r.clock,
      workspace_id: WS,
      appendEvent: (e) => r.events.push(e),
      halt: new MemoryHalt(),
      raw: new MemoryRawStore({ clock: r.clock }),
      store: r.chat.store,
      position: () => ({ person_id: 'p_wang', assignment_id: 'as_1', role_id: 'dtc.live-chat' }),
      schedule_turn: () => undefined,
    })
    await say(r, s.id, 'I want a human')
    r.clock.advance(11 * 60_000)
    await bare.sweepAssistTimeouts()
    const event = r.events.find((e) => e.type === 'chat.assist_timeout')
    expect(event?.payload).toMatchObject({ handed_off: false })
    await bare.close()
  })

  it('巡检的 handler 名是契约的一部分', () => {
    expect(CHAT_ASSIST_TIMEOUT_HANDLER).toBe('support.chat_assist_timeout')
  })
})

describe('教 AI', () => {
  it('商家中文指导 → AI 用访客语言说出去，并沉淀成候选', async () => {
    const r = rig({ answer: 'Yes, we ship to Brazil via DHL in about two weeks.' })
    const s = await open(r)
    await say(r, s.id, 'I want a human')
    const result = await r.chat.teach({
      session_id: s.id,
      instruction: '巴西我们发的，走 DHL，大概两周到，运费另算。',
      scope: 'similar_cases',
      taught_by: 'p_wang',
    })
    expect(result.outcome).toBe('sent')
    expect(result.candidate_saved).toBe(true)
    // 19：承诺类永不自动发布——候选事件里这一格必须是 false
    const event = r.events.find((e) => e.type === 'knowledge.candidate_created')
    expect(event?.payload).toMatchObject({ auto_publishable: false })
    const messages = await r.chat.messages(s.id)
    // 商家那句中文以 operator 存着（内部），对客的是 agent 那条
    expect(messages.some((m) => m.role === 'operator' && m.text.includes('DHL'))).toBe(true)
    expect(messages.some((m) => m.role === 'agent' && m.text.includes('Brazil'))).toBe(true)
    expect((await r.chat.session(s.id))?.status).toBe('assist_answered')
  })

  it('模型复读了商家原话 → 拒发，指导仍然沉淀', async () => {
    const r = rig({ answer: '巴西我们发的，走 DHL，大概两周到，运费另算。' })
    const s = await open(r)
    const result = await r.chat.teach({
      session_id: s.id,
      instruction: '巴西我们发的，走 DHL，大概两周到，运费另算。',
      scope: 'global_rule',
      taught_by: 'p_wang',
    })
    expect(result.outcome).toBe('blocked_verbatim_leak')
    expect(result.candidate_saved).toBe(true)
    expect((await r.chat.messages(s.id)).some((m) => m.role === 'agent')).toBe(false)
  })
})

describe('接线：事项、事件、出站', () => {
  it('一条会话 = 一件事项，钉的是 thread ref（与邮件同一套）', async () => {
    const r = rig()
    const s = await open(r)
    await say(r, s.id, 'how much is shipping?')
    const matters = r.work.listMatters({ kind: 'conversation' })
    expect(matters).toHaveLength(1)
    const pinned = matters[0]?.context.pinned as ObjectRef[]
    expect(pinned).toContainEqual({ type: 'thread', id: s.thread_external_id })
  })

  it('同一条会话的第二轮不再开新事项', async () => {
    const r = rig()
    const s = await open(r)
    await say(r, s.id, 'how much is shipping?', 'm1')
    await say(r, s.id, 'and to Canada?', 'm2')
    expect(r.work.listMatters({ kind: 'conversation' })).toHaveLength(1)
  })

  it('每一轮的判定进事件日志（意图 / 动作 / 涉不涉钱）', async () => {
    const r = rig()
    const s = await open(r)
    await say(r, s.id, 'can I get a refund?')
    const planned = r.events.find((e) => e.type === 'chat.turn_planned')
    expect(planned?.payload).toMatchObject({
      intent: 'return_refund',
      action: 'human_review',
      money_touch: true,
    })
  })

  it('接管开关留痕', async () => {
    const r = rig()
    const s = await open(r)
    await r.chat.setTakeover(s.id, true)
    expect(r.events.some((e) => e.type === 'chat.takeover_changed')).toBe(true)
  })

  it('出站：批了的聊天卡推进会话；不是聊天的卡不接', async () => {
    const r = rig()
    const s = await open(r)
    await say(r, s.id, 'can I get a refund for #1001?')
    const card = r.approvals.items[0] as ApprovalItem
    const out = await r.chat.deliver(card, { idempotencyKey: 'idem_1' })
    expect(out?.status).toBe('ok')
    const last = (await r.chat.messages(s.id)).at(-1)
    expect(last?.text).toBe((card.payload as { body: { text: string } }).body.text)

    const notMine = { ...card, payload: { channel: 'email', thread_ref: 'x' } } as ApprovalItem
    expect(await r.chat.deliver(notMine, { idempotencyKey: 'idem_2' })).toBeUndefined()
  })

  it('急停 outbound：卡推不出去，且说得出为什么', async () => {
    const clock = new StepClock()
    const halt = new MemoryHalt()
    const chat = createChatLane({
      clock,
      workspace_id: WS,
      appendEvent: () => undefined,
      halt,
      raw: new MemoryRawStore({ clock }),
      position: () => ({ person_id: 'p_wang', assignment_id: 'as_1', role_id: 'dtc.live-chat' }),
      schedule_turn: () => undefined,
    })
    const s = await chat.openSandbox('p_wang')
    halt.set('outbound', true, 'test')
    const out = await chat.deliver(
      {
        payload: { channel: 'chat', thread_ref: s.thread_external_id, body: { text: 'hi' } },
      } as unknown as ApprovalItem,
      { idempotencyKey: 'idem_1' },
    )
    expect(out?.status).toBe('failed')
    await chat.close()
  })

  it('没有模型：不编一句话顶上去，转求助', async () => {
    const r = rig({ models: false })
    const s = await open(r)
    const out = await say(r, s.id, 'how much is shipping?')
    expect(out.blocked).toBe('no_model')
    expect(out.approval_item_id).toBeDefined()
    expect((await r.chat.session(s.id))?.status).toBe('assist_requested')
  })
})

/**
 * WP417（自查客服 C10 / C15 / C20 · 决策 1232）：聊天里查订单、超时转邮件真出跟进信、跟进信经邮箱真发 / 没邮箱照实失败。
 */
import { MemoryRawStore } from '@agentsws/channels'
import type { ApprovalItem, Clock, CreateApprovalInput } from '@agentsws/contracts'
import { MemoryHalt } from '@agentsws/kernel'
import type { ModelGatewayApi } from '@agentsws/model-gateway'
import { createWork } from '@agentsws/work'
import { describe, expect, it } from 'vitest'
import type { DirectMailInput } from '../src/channels.js'
import { createChatLane, emailIn, orderRefIn } from '../src/chat.js'

const WS = 'ws_1'
const T0 = '2026-10-19T10:00:00.000Z'

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

const models = (calls: string[]): ModelGatewayApi =>
  ({
    async complete(req: { messages: { role: string; content: string }[] }) {
      calls.push(req.messages.find((m) => m.role === 'user')?.content ?? '')
      return {
        text: 'Your order #1001 is paid and not shipped yet.',
        usage: { input_tokens: 1, output_tokens: 1, cached_tokens: 0, cost_base: 1 },
        model: { provider: 'stub', model: 'stub' },
        static_prefix_hash: 'h',
      }
    },
  }) as unknown as ModelGatewayApi

function rig(over: { sendMail?: boolean } = {}) {
  const clock = new StepClock()
  const approvals = new RecordingApprovals()
  const calls: string[] = []
  const mails: DirectMailInput[] = []
  const work = createWork({ workspace_id: WS, clock, random: () => 0.5, tz_offset_minutes: 0 })
  const chat = createChatLane({
    clock,
    workspace_id: WS,
    assistWaitSeconds: () => 60,
    appendEvent: () => undefined,
    halt: new MemoryHalt(),
    raw: new MemoryRawStore({ clock }),
    work,
    approvals,
    models: models(calls),
    position: () => ({ person_id: 'p_me', assignment_id: 'as_chat', role_id: 'dtc.live-chat' }),
    emailPosition: () => ({ person_id: 'p_me', assignment_id: 'as_sup', role_id: 'dtc.support' }),
    lookupOrder: async (ref) =>
      ref === '#1001'
        ? { name: '#1001', financial_status: 'paid', fulfillment: 'unfulfilled' }
        : undefined,
    ...(over.sendMail === false
      ? {}
      : {
          sendMail: async (input: DirectMailInput) => {
            mails.push(input)
            return { ok: true, outbox_id: 'ob_1', message_id: '<m1@x>', account: 'me@shop.test' }
          },
        }),
    schedule_turn: () => undefined,
  })
  const say = async (session_id: string, text: string) => {
    await chat.receive({ session_id, text })
    clock.advance(2_500)
    return chat.advanceTurn(session_id)
  }
  return { clock, chat, approvals, calls, mails, say }
}

describe('WP417 聊天', () => {
  it('认得出订单号与邮箱', () => {
    expect(orderRefIn('where is my order #1001?')).toBe('#1001')
    expect(orderRefIn('我的订单号：20345 到哪了')).toBe('#20345')
    expect(orderRefIn('order number 5521')).toBe('#5521')
    expect(orderRefIn('hello')).toBeUndefined()
    expect(emailIn('my mail is Anna.Lee@Example.com thanks')).toBe('anna.lee@example.com')
  })

  it('C10：访客报了订单号 → 现查这一单，查到的进起草材料', async () => {
    const r = rig()
    const s = await r.chat.openSandbox('p_me')
    await r.say(s.id, 'has order #1001 shipped yet?')
    // WP428：直答那一轮订单现查结果当一条带编号的出处（O1）进材料
    expect(r.calls.join('\n')).toContain('[O1]')
    expect(r.calls.join('\n')).toContain('unfulfilled')
  })

  it('C15：超时转邮件 → 访客留了邮箱 → 跟进邮件卡挂网站客服；批了经邮箱真发', async () => {
    const r = rig()
    const s = await r.chat.openSandbox('p_me')
    await r.say(s.id, 'I want to talk to a human')
    r.clock.advance(61_000)
    await r.chat.sweepAssistTimeouts()
    expect((await r.chat.session(s.id))?.status).toBe('email_follow_up')
    const out = await r.say(s.id, 'ok, anna@example.com')
    expect(out.reply).toContain('anna@example.com')
    const card = r.approvals.items.at(-1) as ApprovalItem
    expect(card.role_id).toBe('dtc.support')
    expect(card.payload).toMatchObject({ channel: 'email', compose_to: 'anna@example.com' })
    const res = await r.chat.deliver(card, { idempotencyKey: card.id })
    expect(res?.status).toBe('ok')
    expect(r.mails[0]?.to).toEqual(['anna@example.com'])
    expect(r.mails[0]?.text.length).toBeGreaterThan(0)
  })

  it('C15：访客早留过邮箱 → 到点直接出跟进邮件卡', async () => {
    const r = rig()
    const s = await r.chat.openSandbox('p_me')
    await r.say(s.id, 'I want to talk to a human, mail me at bob@example.com')
    r.clock.advance(61_000)
    await r.chat.sweepAssistTimeouts()
    const card = r.approvals.items.at(-1) as ApprovalItem
    expect(card.payload).toMatchObject({ compose_to: 'bob@example.com' })
  })

  it('C15：没连邮箱 → 跟进信照实「没发出去」，不假装发了', async () => {
    const r = rig({ sendMail: false })
    const s = await r.chat.openSandbox('p_me')
    await r.say(s.id, 'I want to talk to a human, mail me at bob@example.com')
    r.clock.advance(61_000)
    await r.chat.sweepAssistTimeouts()
    const card = r.approvals.items.at(-1) as ApprovalItem
    const res = await r.chat.deliver(card, { idempotencyKey: card.id })
    expect(res?.status).toBe('failed')
    expect(res?.error?.message).toContain('没发出去')
  })
})

/**
 * 聊天沙盒页（WP57）。
 *
 * 这一页的价值在于**把判断摆出来给人看**，所以断言盯的是那几件事说没说清楚：
 * 这一轮判成了哪种、为什么（tooltip）、碰没碰钱、花没花模型、出没出卡、
 * 接管开关有没有真的让 AI 闭嘴，以及商家教的那句中文有没有被标成"不对外"。
 *
 * 36 §2.3：界面上不出裸枚举——`human_review` 这种名字一个都不许露出来。
 */
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatMessageView, ChatSessionView, ChatTurnView } from '@/lib/api'
import { ChatSandboxPage } from '@/pages/chat-sandbox'
import { renderWithProviders } from './helpers'

const T0 = '2026-09-14T10:00:00.000Z'

const SESSION: ChatSessionView = {
  id: 'cs_0001',
  source: 'sandbox',
  external_session_id: 'sandbox:p_me',
  visitor_display: '沙盒访客',
  status: 'open',
  takeover: false,
  thread_external_id: 'chat-thread:cs_0001',
  created_at: T0,
  updated_at: T0,
}

const ANSWER: ChatTurnView = {
  session_id: 'cs_0001',
  used_model: true,
  plan: {
    action: 'answer',
    intent: 'presales_product',
    risk: 'normal',
    can_auto_reply: true,
    money_touch: false,
    missing_info: [],
    summary: '低风险问题，可以按知识与订单事实直接回复。',
    next_question: '我会按现在的商品、订单与客服知识继续帮你处理。',
  },
  reply: '美国订单满 $50 免邮。',
}

const REVIEW: ChatTurnView = {
  session_id: 'cs_0001',
  used_model: false,
  approval_item_id: 'ai_1',
  plan: {
    action: 'human_review',
    intent: 'return_refund',
    risk: 'high',
    can_auto_reply: false,
    money_touch: true,
    missing_info: [],
    summary: '这一轮碰到了钱或订单变更：聊天里只答不承诺，出卡给人定。',
    next_question: '这件事涉及订单与金额，我在聊天里不能替你定下来。',
  },
  reply: '这件事涉及订单与金额，我在聊天里不能替你定下来。',
}

const state = {
  session: { ...SESSION },
  messages: [] as ChatMessageView[],
  next: ANSWER,
  sent: [] as string[],
  taught: [] as string[],
  takeovers: [] as boolean[],
  teachOutcome: 'sent',
}

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    openChatSession: async () => state.session,
    getChatMessages: async () => ({ session: state.session, messages: state.messages }),
    sendChatMessage: async (_id: string, text: string) => {
      state.sent.push(text)
      state.messages.push({ id: `m${state.messages.length}`, role: 'visitor', text, at: T0 })
      const turn = state.next
      if (turn.reply !== undefined) {
        state.messages.push({
          id: `a${state.messages.length}`,
          role: 'agent',
          text: turn.reply,
          at: T0,
          ...(turn.plan === undefined ? {} : { plan_action: turn.plan.action }),
        })
      }
      return turn
    },
    advanceChatTurn: async () => state.next,
    setChatTakeover: async (_id: string, on: boolean) => {
      state.takeovers.push(on)
      state.session = { ...state.session, takeover: on, status: on ? 'human_takeover' : 'open' }
      return state.session
    },
    teachChatSession: async (_id: string, input: { instruction: string }) => {
      state.taught.push(input.instruction)
      state.messages.push({
        id: `o${state.messages.length}`,
        role: 'operator',
        text: input.instruction,
        at: T0,
      })
      return { outcome: state.teachOutcome, sediment: 'knowledge_candidate' }
    },
  }
})

beforeEach(() => {
  state.session = { ...SESSION }
  state.messages = []
  state.next = ANSWER
  state.sent = []
  state.taught = []
  state.takeovers = []
  state.teachOutcome = 'sent'
})

const say = async (text: string): Promise<void> => {
  const user = userEvent.setup()
  await user.type(await screen.findByTestId('chat-visitor-input'), text)
  await user.click(screen.getByTestId('chat-visitor-send'))
}

describe('聊天沙盒', () => {
  it('访客问运费 → 右边显示「直接答」，左边多一条 AI 回复', async () => {
    renderWithProviders(<ChatSandboxPage />)
    await say('运费多少')
    await waitFor(() => {
      expect(screen.getByTestId('chat-plan').dataset.action).toBe('answer')
    })
    expect(screen.getByTestId('chat-plan-action').textContent).toContain('直接答')
    expect(screen.getByTestId('chat-plan-intent').textContent).toContain('买之前的产品问题')
    expect(screen.getByTestId('chat-plan-money').textContent).toContain('没有')
    expect(screen.getByTestId('chat-plan-model').textContent).toContain('叫了一次轻模型')
    await waitFor(() => {
      expect(screen.getAllByTestId('chat-message')).toHaveLength(2)
    })
    expect(screen.getAllByTestId('chat-message')[1]?.dataset.role).toBe('agent')
  })

  it('访客问退款 → 「要你定」，说明碰到了钱，并指出已经出卡', async () => {
    state.next = REVIEW
    renderWithProviders(<ChatSandboxPage />)
    await say('能退款吗')
    await waitFor(() => {
      expect(screen.getByTestId('chat-plan').dataset.action).toBe('human_review')
    })
    expect(screen.getByTestId('chat-plan-action').textContent).toContain('要你定')
    expect(screen.getByTestId('chat-plan-money').textContent).toContain('碰到了，已经转给你定')
    expect(screen.getByTestId('chat-plan-card')).not.toBeNull()
    // 这一支不花模型：判定是词表做的
    expect(screen.getByTestId('chat-plan-model').textContent).toContain('没有，纯规则')
  })

  it('36 §2.3：界面上不出裸枚举', async () => {
    state.next = REVIEW
    renderWithProviders(<ChatSandboxPage />)
    await say('能退款吗')
    await waitFor(() => {
      expect(screen.getByTestId('chat-plan')).not.toBeNull()
    })
    for (const raw of ['human_review', 'return_refund', 'money_touch']) {
      expect(document.body.textContent).not.toContain(raw)
    }
  })

  it('解释性文字进 tooltip（36 §7），不铺一页灰字', async () => {
    renderWithProviders(<ChatSandboxPage />)
    await say('运费多少')
    await waitFor(() => {
      expect(screen.getByTestId('chat-plan-why')).not.toBeNull()
    })
    expect(screen.getByTestId('chat-plan-why').dataset.hint).toContain('低风险')
    // WP124（修订第 1 条）：接管开关拆掉了，沙盒页只剩教 AI——守卫测试
    // test/no-direct-reply.test.ts 钉住「对客直发入口数 = 0」。
  })

  it('教 AI：商家那句中文标成"不对外"', async () => {
    const user = userEvent.setup()
    renderWithProviders(<ChatSandboxPage />)
    await user.type(await screen.findByTestId('chat-teach-input'), '巴西我们发，走 DHL')
    await user.click(screen.getByTestId('chat-teach-send'))
    await waitFor(() => {
      expect(state.taught).toEqual(['巴西我们发，走 DHL'])
    })
    expect((await screen.findByTestId('chat-teach-outcome')).textContent).toContain('知识候选')
    const operator = (await screen.findAllByTestId('chat-message')).find(
      (el) => el.getAttribute('data-role') === 'operator',
    )
    expect(operator?.textContent).toContain('不会出现在访客屏幕上')
  })

  it('模型复读了商家原话 → 页面说清楚拦下了', async () => {
    state.teachOutcome = 'blocked_verbatim_leak'
    const user = userEvent.setup()
    renderWithProviders(<ChatSandboxPage />)
    await user.type(await screen.findByTestId('chat-teach-input'), '巴西我们发，走 DHL')
    await user.click(screen.getByTestId('chat-teach-send'))
    expect((await screen.findByTestId('chat-teach-outcome')).textContent).toContain('已经拦下')
  })

  it('空输入按不动', async () => {
    renderWithProviders(<ChatSandboxPage />)
    expect((await screen.findByTestId('chat-visitor-send')) as HTMLButtonElement).toHaveProperty(
      'disabled',
      true,
    )
    expect(screen.getByTestId('chat-teach-send') as HTMLButtonElement).toHaveProperty(
      'disabled',
      true,
    )
  })
})

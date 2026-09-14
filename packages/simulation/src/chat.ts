/**
 * 把在线客服的实时车道接进模拟世界（48 §4 L3 #11，WP57）。
 *
 * 与 `routine` / `learning` / `secretary` 一样是**惰性**的：场景里没有 `chat.*`
 * 事件就一个都不装，原有场景的事件序列与指标一个字节不变。
 *
 * 这里用的判定与服务进程**是同一份代码**——`@agentsws/support-core` 的聊天纯函数
 * （轮次聚合 / 词表分类 / 五种动作 / 求助超时）。模拟里替掉的只有两样：
 *
 * - **会话表**：不接 `@agentsws/channels` 的 SQLite 档，就在内存里记一条会话与
 *   一串消息。模拟要验的是"判定与卡片对不对"，不是"库写得对不对"（那在
 *   channels 包自己的一致性套件里，两档各跑一遍）。
 * - **访客那一头**：没有 SSE，AI 说的话直接进这串消息。
 *
 * **卡是真的**：`human_review` / `assist` 出的是一张真的 `outbound_draft`，
 * 走真的审批总线、真的投递与决定。这一条是整个场景的价值所在——
 * "聊天里碰到钱不能自己定"这件事，要能在一条回归题里看见它真的变成了一张卡。
 */
import type { Iso8601, PersonId } from '@agentsws/contracts'
import {
  buildChatPlan,
  type ChatPlanAction,
  type ChatResponsePlan,
  type ChatSessionStatus,
  type ChatTurnMessage,
  chatAssistSchedule,
  classifyChatTurn,
  DEFAULT_CHAT_PACK,
  evaluateChatAssist,
  evaluateChatTurn,
} from '@agentsws/support-core'
import type { World } from './world.js'

/** 模拟里的一条会话。 */
export interface SimChatSession {
  id: string
  visitor: string
  status: ChatSessionStatus
  takeover: boolean
  messages: ChatTurnMessage[]
  assist_requested_at?: Iso8601
  assist_reminded_at?: Iso8601
  last_seen_at?: Iso8601
}

/** 一轮判完的记录（场景的 `chat_actions` 断言读它）。 */
export interface SimChatTurn {
  session_id: string
  action: ChatPlanAction
  intent: string
  money_touch: boolean
  used_model: boolean
  reply?: string
  approval_item_id?: string
}

export interface ChatLoop {
  sessions: SimChatSession[]
  turns: SimChatTurn[]
  /** 访客说了一句；静默窗口过了就当场判完这一轮。 */
  visitorMessage(input: { visitor: string; text: string }): Promise<SimChatTurn | undefined>
  /** 人工接管开关。 */
  takeover(input: { visitor?: string; on: boolean }): Promise<void>
  /**
   * 一拍：先把还在静默窗口里的那一轮判完，再跑一次求助超时巡检。
   *
   * 合成时钟每推进一步调一次（真实进程里这是两样东西：轮次的定时器与
   * `support.chat_assist_timeout` 那条巡检）。
   */
  tick(): Promise<{ replied: number; reminded: number; demoted: number }>
}

const PACK = DEFAULT_CHAT_PACK

/**
 * 装上聊天车道。
 *
 * `position` 是这条会话挂谁名下：模拟世界里就是那条客服岗位（与邮件同一条）。
 */
export function installChat(world: World): ChatLoop {
  const sessions: SimChatSession[] = []
  const turns: SimChatTurn[] = []
  let seq = 0
  let msgSeq = 0

  const sessionOf = (visitor: string): SimChatSession => {
    const found = sessions.find((s) => s.visitor === visitor)
    if (found !== undefined) return found
    seq += 1
    const session: SimChatSession = {
      id: `cs_${String(seq).padStart(4, '0')}`,
      visitor,
      status: 'open',
      takeover: false,
      messages: [],
    }
    sessions.push(session)
    world.appendEvent(
      'simulation.chat_session_opened',
      { session_id: session.id, visitor },
      { subject: { type: 'thread', id: threadIdOf(session) } },
    )
    return session
  }

  const threadIdOf = (session: SimChatSession): string => `chat-thread:${session.id}`

  const say = (
    session: SimChatSession,
    role: ChatTurnMessage['role'],
    text: string,
    action?: string,
  ): ChatTurnMessage => {
    msgSeq += 1
    const message: ChatTurnMessage = {
      id: `cm_${String(msgSeq).padStart(4, '0')}`,
      role,
      text,
      at: world.clock.now(),
    }
    session.messages.push(message)
    world.appendEvent(
      'simulation.chat_message',
      {
        session_id: session.id,
        role,
        ...(action === undefined ? {} : { action }),
        chars: text.length,
      },
      { subject: { type: 'thread', id: threadIdOf(session) } },
    )
    return message
  }

  /** 出一张真卡（`human_review` / `assist`）。 */
  const raiseCard = async (
    session: SimChatSession,
    plan: ChatResponsePlan,
    turn_text: string,
  ): Promise<string | undefined> => {
    const item = await world.txn.approvals.create({
      workspace_id: world.workspace_id,
      schema_version: 1,
      kind: 'outbound_draft',
      role_id: world.assignment.role_id,
      subject: {
        object: { type: 'thread', id: threadIdOf(session) },
        conversation_id: session.id,
      },
      dedupe_key: `${world.workspace_id}:chat:${session.id}:${plan.action}`,
      title:
        plan.action === 'assist'
          ? `${session.visitor} 在聊天里要人工`
          : `${session.visitor} 的聊天涉及${plan.money_touch ? '金额或订单变更' : '高风险问题'}`,
      summary: plan.summary,
      payload: {
        channel: 'chat',
        session_id: session.id,
        thread_ref: threadIdOf(session),
        plan_action: plan.action,
        intent: plan.intent,
        money_touch: plan.money_touch,
        /*
         * 31 §3.3 收件人门禁：`outbound_draft` 的收件人必须是**这次读过的**
         * 线程参与者。聊天里的收件人就是这条会话里的那个访客——
         * 漏了这一格，卡会被预检直接打成 `blocked`，人永远看不到它。
         */
        to: { type: 'contact', id: session.visitor },
        body: { text: plan.next_question },
        visitor_said: turn_text.slice(0, 500),
      },
      evidence: {
        source_events: [],
        provenance: {
          seen: [
            { type: 'thread', id: threadIdOf(session) },
            { type: 'contact', id: session.visitor },
          ],
        },
        precheck: {},
      },
      proposer: {
        kind: 'agent',
        id: world.assignment.id,
        assignment_id: world.assignment.id,
      },
      automation: {
        level_at_creation: 'L1',
        auto_approved: false,
        mandate_check: { within: true, caps_hit: [] },
        sampling: { selected: false },
      },
      routing: {
        recipients: [{ person: world.assignment.person_id as PersonId, via: 'role_holder' }],
        rule: 'role_holder',
        escalation: { after_hours: 1, business_hours: false, chain: ['owner'], escalated_at: [] },
        separation_of_duties: true,
      },
      // 访客在等：这张卡不排队
      priority: 'immediate',
      context: { thread_participants: [session.visitor], verified_contacts: [session.visitor] },
    })
    return item.state === 'blocked' ? undefined : item.id
  }

  /**
   * `answer` 那一支的轻模型。
   *
   * 走的是世界里那一个模型网关，所以 22 §3 的三级预算、`model.usage` 记账、
   * 模型不可用时的冻结，在聊天这条车道上与邮件那条是同一套。
   */
  const answerWith = async (
    session: SimChatSession,
    turn_text: string,
  ): Promise<string | undefined> => {
    try {
      const completion = await world.gateway().complete({
        messages: [
          { role: 'system', content: '你是网站聊天窗里的客服。短、具体、不承诺钱。' },
          { role: 'user', content: turn_text },
        ],
        meta: {
          workspace_id: world.workspace_id,
          assignment_id: world.assignment.id,
          role_id: world.assignment.role_id,
          run_id: `run_chat_${session.id}_${session.messages.length}`,
          purpose: 'run',
        },
      })
      return completion.text.trim().length === 0 ? undefined : completion.text.trim()
    } catch {
      // 模型挂了 / 预算耗尽：聊天里不编一句话顶上去
      return undefined
    }
  }

  const runTurn = async (
    session: SimChatSession,
    turn_text: string,
  ): Promise<SimChatTurn | undefined> => {
    const classification = classifyChatTurn(turn_text, { pack: PACK })
    const plan = buildChatPlan({
      classification,
      turn_text,
      pack: PACK,
      status: session.status,
      takeover: session.takeover,
    })
    world.appendEvent(
      'simulation.chat_turn',
      {
        session_id: session.id,
        action: plan.action,
        intent: plan.intent,
        money_touch: plan.money_touch,
        matched_terms: classification.matched_terms,
      },
      { subject: { type: 'thread', id: threadIdOf(session) } },
    )
    const record: SimChatTurn = {
      session_id: session.id,
      action: plan.action,
      intent: plan.intent,
      money_touch: plan.money_touch,
      used_model: false,
    }

    if (plan.action === 'handoff') {
      turns.push(record)
      return record
    }

    if (plan.action === 'assist') {
      const card = await raiseCard(session, plan, turn_text)
      if (card !== undefined) record.approval_item_id = card
      session.status = 'assist_requested'
      session.assist_requested_at = world.clock.now()
      delete session.assist_reminded_at
      record.reply = say(session, 'agent', PACK.assist_reply, plan.action).text
      turns.push(record)
      return record
    }

    if (plan.action === 'human_review') {
      const card = await raiseCard(session, plan, turn_text)
      if (card !== undefined) record.approval_item_id = card
      record.reply = say(session, 'agent', PACK.money_handoff_reply, plan.action).text
      turns.push(record)
      return record
    }

    if (plan.action === 'collect_info') {
      record.reply = say(session, 'agent', plan.next_question, plan.action).text
      turns.push(record)
      return record
    }

    const answer = await answerWith(session, turn_text)
    record.used_model = true
    if (answer === undefined) {
      // 答不出来就转求助，不编
      const assist: ChatResponsePlan = { ...plan, action: 'assist' }
      record.action = 'assist'
      const card = await raiseCard(session, assist, turn_text)
      if (card !== undefined) record.approval_item_id = card
      session.status = 'assist_requested'
      session.assist_requested_at = world.clock.now()
      record.reply = say(session, 'agent', PACK.assist_reply, 'assist').text
      turns.push(record)
      return record
    }
    record.reply = say(session, 'agent', answer, plan.action).text
    turns.push(record)
    return record
  }

  return {
    sessions,
    turns,

    async visitorMessage(input): Promise<SimChatTurn | undefined> {
      const session = sessionOf(input.visitor)
      session.last_seen_at = world.clock.now()
      say(session, 'visitor', input.text)
      const turn = evaluateChatTurn({ messages: session.messages, now: world.clock.now() })
      // 还在 2 秒静默窗口里：这一轮没说完，等下一次 `clock.advance`
      if (turn.state !== 'ready') return undefined
      return runTurn(session, turn.turn_text)
    },

    async takeover(input): Promise<void> {
      const session =
        input.visitor === undefined ? sessions[sessions.length - 1] : sessionOf(input.visitor)
      if (session === undefined) return
      session.takeover = input.on
      session.status = input.on ? 'human_takeover' : 'open'
      if (!input.on) {
        delete session.assist_requested_at
        delete session.assist_reminded_at
      }
      world.appendEvent(
        'simulation.chat_takeover',
        { session_id: session.id, on: input.on },
        { subject: { type: 'thread', id: threadIdOf(session) } },
      )
    },

    async tick(): Promise<{ replied: number; reminded: number; demoted: number }> {
      const now = world.clock.now()
      let replied = 0
      let reminded = 0
      let demoted = 0

      // ① 静默窗口过了的那几轮：现在判完
      for (const session of sessions) {
        const turn = evaluateChatTurn({ messages: session.messages, now })
        if (turn.state !== 'ready') continue
        const out = await runTurn(session, turn.turn_text)
        if (out !== undefined) replied += 1
      }

      for (const session of sessions) {
        if (session.status !== 'assist_requested') continue
        if (session.assist_requested_at === undefined) continue
        const decision = evaluateChatAssist({
          requested_at: session.assist_requested_at,
          now,
          ...(session.assist_reminded_at === undefined
            ? {}
            : { reminded_at: session.assist_reminded_at }),
          ...(session.last_seen_at === undefined ? {} : { last_seen_at: session.last_seen_at }),
        })
        if (decision.action === 'remind') {
          say(session, 'agent', PACK.assist_reminder_reply, 'assist')
          session.assist_reminded_at = now
          world.appendEvent(
            'simulation.chat_assist',
            {
              session_id: session.id,
              action: 'reminder',
              due_at: chatAssistSchedule(session.assist_requested_at).remind_at,
            },
            { subject: { type: 'thread', id: threadIdOf(session) } },
          )
          reminded += 1
          continue
        }
        if (decision.action === 'email_follow_up') {
          say(session, 'agent', PACK.email_follow_up_reply, 'assist')
          session.status = 'email_follow_up'
          delete session.assist_requested_at
          world.appendEvent(
            'simulation.chat_assist',
            { session_id: session.id, action: 'email_follow_up' },
            { subject: { type: 'thread', id: threadIdOf(session) } },
          )
          demoted += 1
        }
      }
      return { replied, reminded, demoted }
    },
  }
}

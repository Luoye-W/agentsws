/**
 * WP440（docs/108 M9）：模拟回路里的**邮件客服「有把握就直接回」**。
 *
 * 和服务进程（`apps/server/src/email-auto-reply.ts`）**同一套判定**：剥引用与签名、同一个分类与涉钱词表、
 * 一次轻模型起草（材料带编号、句后标出处、末尾自评；没接真模型时三个运行时都套 `emailAnswerStubScript`）、
 * `scoreAutoAnswer`、三道自主门扫真要发的那一版、经审批总线的自动批路径（`confident_reply`）发出去。
 *
 * 模拟里替掉的只有一样：没有 `support-judgment` 的入站判断层（它在服务进程里），这里用的是同一组纯函数里
 * 能判「这一封能不能自主」的那一道——三道自主门（`evaluateAutonomyGates`）扫真要发的那一版。
 *
 * **惰性**：退款 / 改单 / 要人工、Amazon、不是客服那一路的信，一次模型都不多问、一个事件都不多记——
 * 原有场景的事件序列与指标不因它变化；只有真走到「问模型」的那几封才多一条 `simulation.email_auto_reply`。
 */
import type { ApprovalItem, InboundEvent, ObjectRef, PersonId } from '@agentsws/contracts'
import {
  type AutoAnswerSource,
  classifyText,
  composeEmailReply,
  EMAIL_AUTO_REPLY_EXCLUDED_SUB_CHANNELS,
  emailAnswerPlan,
  emailAnswerPrompt,
  emailAnswerSystem,
  evaluateAutonomyGates,
  scoreAutoAnswer,
  splitEmailForAnswer,
} from '@agentsws/support-core'
import type { World } from './world.js'

export interface EmailAutoLoop {
  /**
   * 一封客服来信：能直接回就回（回 `true`，这一封不再起 Run）；不能回 `false`（照旧起 Run 出卡）。
   * 拦下后退回成卡也回 `true`（卡已经出了，不再重复出一张）。
   */
  attempt(input: {
    inbound: InboundEvent
    thread: { id: string; ref: ObjectRef }
    text: string
    subject: string
  }): Promise<boolean>
  /** 这一轮直接回 / 没回的记录（场景断言与报告读它）。 */
  readonly outcomes: { thread_id: string; decision: 'sent' | 'held'; kind?: string }[]
}

const isSupportRoute = (role_id: string | undefined): boolean =>
  role_id === undefined || role_id.endsWith('.support') || role_id === 'dtc.aftersales'

export function installEmailAuto(world: World): EmailAutoLoop {
  const outcomes: EmailAutoLoop['outcomes'] = []
  let seq = 0

  const record = (
    thread_id: string,
    decision: 'sent' | 'held',
    extra: { kind?: string; score?: number; approval_item_id?: string } = {},
  ): void => {
    outcomes.push({
      thread_id,
      decision,
      ...(extra.kind === undefined ? {} : { kind: extra.kind }),
    })
    world.appendEvent(
      'simulation.email_auto_reply',
      {
        decision,
        ...(extra.kind === undefined ? {} : { hold: extra.kind }),
        ...(extra.score === undefined ? {} : { score: extra.score }),
        ...(extra.approval_item_id === undefined
          ? {}
          : { approval_item_id: extra.approval_item_id }),
      },
      { subject: { type: 'thread', id: thread_id } },
    )
  }

  const sourcesFor = async (question: string): Promise<AutoAnswerSource[]> => {
    const sources: AutoAnswerSource[] = []
    try {
      const res = await world.knowledge.retrieval.search({
        text: question,
        k: 4,
        actor: {
          person_id: world.assignment.person_id,
          workspace_id: world.workspace_id,
          assignment_id: world.assignment.id,
          role_id: world.assignment.role_id,
          grants: [...world.effective.scopes],
          ranges: [...world.effective.ranges],
        },
      })
      for (const [i, h] of res.hits.entries())
        sources.push({
          ref: `K${i + 1}`,
          kind: h.layer === 'policy' ? 'policy' : 'fact_card',
          id: h.fact_card_id,
          label: h.statement_redacted.slice(0, 24),
          text: h.statement_redacted,
          ...(h.verification === 'stale' ? { stale: true } : {}),
        })
    } catch {
      // 知识层不可用：没有出处（之后按「没出处」转人）
    }
    return sources
  }

  const create = (input: {
    thread: { id: string; ref: ObjectRef }
    contact: ObjectRef
    subject: string
    text: string
    auto: Record<string, unknown>
    citations: { fact_card_id: string; quote: string }[]
    gates: ReturnType<typeof evaluateAutonomyGates>
    direct: { score: number; strictness: string; source_ids: string[] } | undefined
  }): Promise<ApprovalItem> => {
    seq += 1
    return world.txn.approvals.create({
      workspace_id: world.workspace_id,
      schema_version: 1,
      kind: 'outbound_draft',
      role_id: world.assignment.role_id,
      subject: { object: input.thread.ref, conversation_id: input.thread.id },
      dedupe_key: `${world.workspace_id}:email_auto_reply:${input.thread.id}:${seq}`,
      title: `回复 ${input.contact.id}：${input.subject}${input.direct === undefined ? '（出站门拦下）' : ''}`,
      summary: input.text.split('\n').filter((l) => l.trim() !== '')[1] ?? input.subject,
      payload: {
        channel: 'email',
        to: input.contact,
        thread_ref: input.thread.id,
        body: {
          subject: /^re\s*:/i.test(input.subject) ? input.subject : `Re: ${input.subject}`,
          text: input.text,
        },
        auto_reply: input.auto,
      },
      evidence: {
        source_events: [],
        provenance: { seen: [input.thread.ref, input.contact] },
        precheck: {},
        // 直接回的那封引用了哪几张知识卡（同服务进程；「高召回低认可」也要它）
        citations: input.citations,
      },
      proposer: { kind: 'agent', id: world.assignment.id, assignment_id: world.assignment.id },
      automation: {
        level_at_creation: input.direct === undefined ? 'L1' : 'L2',
        auto_approved: false,
        mandate_check: { within: true, caps_hit: [] },
        sampling: { selected: false },
      },
      routing: {
        recipients: [{ person: world.assignment.person_id as PersonId, via: 'role_holder' }],
        rule: 'role_holder',
        escalation: { after_hours: 8, business_hours: true, chain: ['owner'], escalated_at: [] },
        separation_of_duties: true,
      },
      priority: 'queue',
      context: {
        thread_participants: [input.contact.id],
        verified_contacts: [input.contact.id],
        connection_id: 'conn_gmail',
        gates: input.gates.results.map((r) => ({
          gate: r.gate,
          status: r.status,
          ruleset_hash: r.ruleset_hash,
          ...(r.reason === undefined ? {} : { reason: r.reason }),
        })),
        ...(input.direct === undefined ? {} : { confident_reply: input.direct }),
      },
    })
  }

  return {
    outcomes,
    async attempt({ inbound, thread, text, subject }): Promise<boolean> {
      const contact = inbound.actor?.resolved
      // 能不能试（同服务进程的 `emailAutoReplyGate`）：客服那一路、认得出原发件人、不是 Amazon
      if (contact === undefined || !isSupportRoute(inbound.routing.role_id)) return false
      if (
        inbound.sub_channel !== undefined &&
        EMAIL_AUTO_REPLY_EXCLUDED_SUB_CHANNELS.includes(inbound.sub_channel)
      )
        return false
      // 先剥；退款 / 改单 / 要人工不问模型
      const { question } = splitEmailForAnswer(text)
      const plan = emailAnswerPlan(question)
      if (plan.action !== 'answer' || plan.money_touch) return false

      const sources = await sourcesFor(question)
      // 一条材料都没有：不花这一次模型（同服务进程），照旧起 Run
      if (sources.length === 0) return false
      let raw = ''
      try {
        const completion = await world.gateway().complete({
          messages: [
            {
              role: 'system',
              // WP471：与服务进程同一个排法（出处要求在系统提示）
              content: emailAnswerSystem(
                '你是这家店的邮件客服。只按给你的材料回答；材料里没有的事不编。',
              ),
            },
            { role: 'user', content: emailAnswerPrompt({ sources, question, subject }) },
          ],
          meta: {
            workspace_id: world.workspace_id,
            assignment_id: world.assignment.id,
            role_id: world.assignment.role_id,
            run_id: `run_email_auto_${thread.id}_${seq}`,
            purpose: 'run',
          },
        })
        raw = completion.text.trim()
      } catch {
        // 模型挂了：不编一封信，照旧起 Run
      }
      if (raw === '') {
        record(thread.id, 'held', { kind: 'no_model' })
        return false
      }
      const verdict = scoreAutoAnswer({ plan, turn_text: question, reply: raw, sources })
      if (!verdict.send) {
        record(thread.id, 'held', {
          kind: verdict.hold?.kind ?? 'low_confidence',
          score: verdict.score,
        })
        return false
      }
      const body = composeEmailReply({ answer: verdict.text, question })
      // 三道自主门扫真要发的那一版（服务进程里还有入站那一遍，这里是同一组门）
      const classification = classifyText({ text: question, subject }, { now: world.clock.now() })
      const gates = evaluateAutonomyGates({
        channel: 'email',
        classification: {
          intent: classification.intent,
          source: 'email_classification',
          risk_level: classification.urgency === 'high' ? 'high' : 'normal',
        },
        inbound_text: question,
        proposed_reply_text: body,
        draft: { generated_by: 'ai' },
      })
      if (!gates.autonomous) {
        record(thread.id, 'held', { kind: 'not_autonomous', score: verdict.score })
        return false
      }
      const used = verdict.sources_used.map((x) => ({ kind: x.kind, id: x.id, label: x.label }))
      const citations = verdict.sources_used
        .filter((x) => x.kind !== 'order')
        .map((x) => ({ fact_card_id: x.id, quote: x.text.slice(0, 200) }))
      const auto = { score: verdict.score, strictness: verdict.strictness, sources: used }
      const item = await create({
        thread,
        contact,
        subject,
        text: body,
        auto,
        citations,
        gates,
        direct: {
          score: verdict.score,
          strictness: verdict.strictness,
          source_ids: used.map((x) => x.id),
        },
      })
      if (item.state !== 'auto_approved') {
        record(thread.id, 'held', { kind: 'not_autonomous', score: verdict.score })
        return item.state !== 'blocked'
      }
      let applied: ApprovalItem | undefined
      try {
        applied = await world.txn.executor.applyApproval(item.id, { skip_cancel_window: true })
      } catch {
        applied = undefined
      }
      if (applied?.state === 'applied') {
        record(thread.id, 'sent', { score: verdict.score, approval_item_id: item.id })
        return true
      }
      // 出站门拦下：退回成卡（L1）
      const card = await create({
        thread,
        contact,
        subject,
        text: body,
        auto: { ...auto, held: 'outbound_blocked' },
        citations,
        gates,
        direct: undefined,
      })
      record(thread.id, 'held', { kind: 'outbound_blocked', score: verdict.score })
      return card.state !== 'blocked'
    },
  }
}

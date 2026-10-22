/**
 * WP459（决策 1497–1505）：**收件箱**——`GET /v1/inbox`。
 *
 * 一条队列「要你处理」，混两种东西：
 * 1. 所有岗位等你批的卡（回信草稿、改价、广告改动、催一下……）——**就是岗位里那张卡**（同一个审批项，
 *    批 / 改 / 不要走 `POST /v1/approvals/:id/decide`），批了岗位里那张一起没了；
 *    要在浏览器插件里发的（Reddit「等你发」）也列着，行上只给「去发」；
 * 2. 要你判断的信：AI 猜不出归谁的、只能你定的（`GET /v1/messages/threads?claim=unclaimed` 那一堆）。
 *
 * 外加：急不急三组（决策 1500 甲）、三个分段与岗位下拉的件数（决策 1501 甲）、今天 AI 猜着交给岗位的几封、
 * 简报要的几个数。告警本身在铃铛（WP466）；系统卡不进这里。
 *
 * 没装配消息面时只有卡；没装配工作台面时只有信（两样都没有回 501）。
 */
import type {
  ApprovalItem,
  MessageGuessRow,
  MessageOverview,
  MessagePositionOption,
  MessageThreadSummary,
  PositionInstance,
} from '@agentsws/contracts'
import { isFollowUpNudgePayload, isPluginDeskCard } from '@agentsws/contracts'
import {
  DECIDABLE_STATES,
  type DeckCard,
  foldCards,
  type InboxGuess,
  type InboxItem,
  type InboxMail,
  type InboxPosition,
  type InboxView,
  inboxCounts,
  inboxUrgencyOfCard,
  inboxUrgencyOfMail,
  isQueueCard,
  projectCard,
  sortCards,
  sortInbox,
} from '@agentsws/deck'
import { ApiError } from '../errors.js'
import { assignmentOf, ok, principalOf } from '../helpers.js'
import { type Route, route } from '../route-spec.js'
import type { GatewayDeps, WorkstationActor } from '../types.js'
import { decidableBy } from './approvals.js'
import type { MessageActor } from './messages.js'
import { todaysReport } from './workstation.js'

const READ = { domain: 'approval', op: 'read', range: 'own', sensitivity: 'internal' } as const

/** 一张卡挂在哪个岗位（按职责找岗位实体）。 */
function positionOfRole(
  instances: readonly PositionInstance[],
  role_id: string,
): PositionInstance | undefined {
  return instances.find((i) => i.roles.some((r) => r.role_id === role_id))
}

/** 卡上那张原件（来自哪条会话）。 */
const threadOfCard = (card: DeckCard): string | undefined => card.original?.thread_id

/** 一张卡这一行：标签、行尾按钮。 */
function cardRow(card: DeckCard, item: ApprovalItem): Pick<InboxItem, 'tag' | 'primary'> {
  if (isPluginDeskCard(item)) return { tag: 'post', primary: 'go_post' }
  if (isFollowUpNudgePayload(card.detail.payload)) return { tag: 'nudge', primary: 'approve' }
  // 选择题 / 挑图 / 走哪条职责：点开选（行上不替人选）
  if ((card.options?.length ?? 0) > 0 || card.layout === 'variants' || card.layout === 'choice')
    return { tag: 'card', primary: 'open' }
  if (!card.available_actions.includes('approve')) return { tag: 'card', primary: 'open' }
  return { tag: 'card', primary: 'approve' }
}

/** 一封没人接的信 → 一行。 */
function mailRow(t: MessageThreadSummary): InboxMail | undefined {
  const message_id = t.claim_message_id ?? t.last_message_id
  const from = t.participants[0]
  if (from === undefined) return undefined
  return {
    thread_id: t.thread_id,
    message_id,
    subject: t.subject,
    from: from.name === undefined ? { email: from.email } : { email: from.email, name: from.name },
    ...(t.summary === undefined ? {} : { summary: t.summary }),
    ...(t.kind === undefined ? {} : { kind: t.kind }),
    ...(t.kind_confidence === undefined ? {} : { kind_confidence: t.kind_confidence }),
    ...(t.priority === undefined ? {} : { priority: t.priority }),
    last_at: t.last_at,
    ...(t.suggest === undefined
      ? {}
      : {
          suggest:
            t.suggest.position === undefined
              ? { action: t.suggest.action }
              : { action: t.suggest.action, position: t.suggest.position },
        }),
    ...(t.accounts[0] === undefined ? {} : { account: t.accounts[0] }),
  }
}

async function cardsOfEveryone(
  deps: GatewayDeps,
  actor: WorkstationActor,
): Promise<{ cards: { card: DeckCard; item: ApprovalItem }[]; tz: number }> {
  const w = deps.workstation
  if (w === undefined) return { cards: [], tz: 0 }
  const positions = await w.positions(actor)
  const can = decidableBy(deps, actor.person_id, actor.workspace_id)
  const now = deps.clock.now()
  const live = (i: { expires_at?: string }): boolean =>
    i.expires_at === undefined || Date.parse(i.expires_at) > Date.parse(now)
  const seen = new Map<string, { card: DeckCard; item: ApprovalItem }>()
  const take = (items: readonly ApprovalItem[], position_id: string): void => {
    for (const item of items) {
      // 定过的（批了 / 不要了 / 稍后）不在队列里：「批了两边一起消失」
      if (seen.has(item.id) || !DECIDABLE_STATES.includes(item.state)) continue
      if (!can(item) || !live(item)) continue
      const card = projectCard(item, {
        now,
        position_id,
        label: (r) => w.labelFor?.(actor, r) ?? w.label(r),
        ...(deps.executionWiring === undefined ? {} : { wiring: deps.executionWiring }),
      })
      if (card.kind === 'system_alert' || card.kind === 'digest') continue
      if (!isQueueCard(card.kind, card.change_kind)) continue
      seen.set(item.id, { card, item })
    }
  }
  let tz = 0
  for (const position of positions) take(await w.items(actor, position), position.position_id)
  // WP278：发给本人、挂在底座职责上、他手上又没有那条底座分配的卡（同首页）
  const held = new Set(positions.map((x) => x.role_id))
  const host = positions.find((x) => x.role_id.startsWith('common.')) ?? positions[0]
  if (host !== undefined) {
    const orphans = ((await w.baseItems?.(actor)) ?? []).filter((i) => !held.has(i.role_id))
    take(orphans, host.position_id)
    try {
      tz = (await w.queryContext(actor, host, 'yesterday')).tz_offset_minutes
    } catch {
      tz = 0
    }
  }
  // 同类合并后代表那一张（与岗位页同一个口径：一行 = 牌堆里的一张）
  const folded = foldCards(sortCards([...seen.values()].map((x) => x.card)))
  return {
    cards: folded.flatMap((card) => {
      const hit = seen.get(card.id)
      return hit === undefined ? [] : [{ card, item: hit.item }]
    }),
    tz,
  }
}

export function inboxRoutes(): Route[] {
  return [
    route(
      {
        method: 'get',
        path: '/v1/inbox',
        operationId: 'getInbox',
        summary:
          '收件箱：所有岗位等你批的卡 + 要你判断的信一条队列（要紧 / 今天 / 不急）、筛选件数、AI 猜着交给岗位的、简报的数（决策 1497–1505；WP459）',
        tag: 'workstation',
        auth: 'bearer',
        assignment: true,
        authz: READ,
        returns:
          '{ items: InboxItem[], counts, positions: InboxPosition[], unassigned, guessed: InboxGuess[], brief }',
      },
      async (c, deps) => {
        const p = principalOf(c)
        const assignment = assignmentOf(c)
        if (deps.workstation === undefined && deps.messages === undefined)
          throw new ApiError('not_implemented', '这个服务进程没有装配工作台面和消息面')
        const actor: WorkstationActor = { workspace_id: p.workspace_id, person_id: p.person_id }
        const mActor: MessageActor = { ...actor, assignment_id: assignment.id }
        const now = deps.clock.now()
        const instances =
          deps.positions === undefined
            ? []
            : await deps.positions.mine({ ...actor, assignment_id: assignment.id })

        const { cards, tz } = await cardsOfEveryone(deps, actor)

        // 消息那一侧：没人接的信、AI 猜着交的、几捆通知
        const port = deps.messages
        let unclaimed: MessageThreadSummary[] = []
        let guessRows: MessageGuessRow[] = []
        let overview: MessageOverview | undefined
        if (port !== undefined) {
          try {
            unclaimed = (await port.threads(mActor, { claim: 'unclaimed', limit: 200 })).threads
          } catch {
            unclaimed = []
          }
          try {
            guessRows = (await port.guessed?.(mActor))?.rows ?? []
          } catch {
            guessRows = []
          }
          try {
            overview = await port.overview?.(mActor)
          } catch {
            overview = undefined
          }
        }
        const guessByThread = new Map(guessRows.map((g) => [g.thread_id, g]))
        const guessByMatter = new Map(
          guessRows.flatMap((g) => (g.matter_id === undefined ? [] : [[g.matter_id, g] as const])),
        )

        const items: InboxItem[] = []
        for (const { card, item } of cards) {
          const inst = positionOfRole(instances, card.role_id)
          const thread = threadOfCard(card)
          const guess =
            (thread === undefined ? undefined : guessByThread.get(thread)) ??
            (card.matter_id === undefined ? undefined : guessByMatter.get(card.matter_id))
          items.push({
            id: `card:${card.id}`,
            type: 'card',
            urgency: inboxUrgencyOfCard(card, now, tz),
            ...cardRow(card, item),
            at: card.detail.created_at,
            ...(inst === undefined ? {} : { position: inst.position_id }),
            card,
            ...(guess === undefined
              ? {}
              : {
                  guessed: {
                    message_id: guess.message_id,
                    position: guess.position_id,
                    confidence: guess.confidence,
                  },
                }),
          })
        }
        for (const t of unclaimed) {
          const mail = mailRow(t)
          if (mail === undefined) continue
          const self = mail.suggest?.action === 'self'
          items.push({
            id: `mail:${t.thread_id}`,
            type: 'mail',
            urgency: inboxUrgencyOfMail(mail, now, tz),
            tag: self ? 'only_you' : 'unsure',
            primary: self ? 'self' : mail.suggest?.action === 'hand' ? 'hand' : 'open',
            at: mail.last_at,
            mail,
          })
        }
        const sorted = sortInbox(items)

        // 岗位下拉：本人持着的每个岗位都列（0 件也列，件数灰）；名字从岗位实体，退回消息面那一列
        const names = new Map<string, MessagePositionOption>(
          (overview?.positions ?? []).map((x) => [x.id, x]),
        )
        const positions: InboxPosition[] = instances
          .filter((inst) => inst.roles.some((r) => r.my_assignment_id !== undefined))
          .map((inst) => {
            const mine = inst.roles.map((r) => r.my_assignment_id).find((x) => x !== undefined)
            return {
              id: inst.position_id,
              name_zh: inst.name.zh,
              name_en: inst.name.en,
              ...(inst.icon === undefined ? {} : { icon: inst.icon }),
              ...(mine === undefined ? {} : { assignment_id: mine }),
              count: sorted.filter((i) => i.position === inst.position_id).length,
            }
          })
        // 卡挂着、却不在本人岗位里的（底座卡之类），和消息面那一列里开着的岗位（「交给 B2B」要它的名字）也列上
        const extra = [
          ...sorted.flatMap((i) => (i.position === undefined ? [] : [i.position])),
          ...(overview?.positions ?? []).filter((x) => x.open).map((x) => x.id),
        ]
        for (const id of extra) {
          if (positions.some((x) => x.id === id)) continue
          const n = names.get(id)
          positions.push({
            id,
            name_zh: n?.name_zh ?? id,
            name_en: n?.name_en ?? id,
            count: sorted.filter((x) => x.position === id).length,
          })
        }

        const dayOf = (ms: number): string => new Date(ms + tz * 60_000).toISOString().slice(0, 10)
        const today = dayOf(Date.parse(now))
        const guessed: InboxGuess[] = guessRows.map((g) => ({
          message_id: g.message_id,
          thread_id: g.thread_id,
          subject: g.subject,
          from:
            g.from.name === undefined
              ? { email: g.from.email }
              : { email: g.from.email, name: g.from.name },
          position: g.position_id,
          confidence: g.confidence,
          at: g.at,
          ...(g.open_card_count === undefined ? {} : { open_card_count: g.open_card_count }),
        }))
        const report = await todaysReport(deps, p.workspace_id, tz).catch(() => undefined)
        const top = sorted.find((i) => i.urgency === 'urgent')
        const view: InboxView = {
          items: sorted,
          counts: inboxCounts(sorted),
          positions,
          unassigned: sorted.filter((i) => i.position === undefined && i.type === 'mail').length,
          guessed,
          brief: {
            done: (report?.ai_handled ?? 0) + (report?.auto_sent ?? 0),
            auto_sent: report?.auto_sent ?? 0,
            guessed: guessRows.filter((g) => dayOf(Date.parse(g.at)) === today).length,
            notices: overview?.notice ?? 0,
            ...(top === undefined ? {} : { top: top.card?.title ?? top.mail?.subject ?? '' }),
          },
        }
        return ok(c, view)
      },
    ),
  ]
}

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
  ApprovalState,
  MessageGuessRow,
  MessageOverview,
  MessagePositionOption,
  MessageThreadSummary,
  OwnerRoute,
  PositionInstance,
  TeamMember,
} from '@agentsws/contracts'
import { isFollowUpNudgePayload, isPluginDeskCard } from '@agentsws/contracts'
import {
  DECIDABLE_STATES,
  type DeckCard,
  foldCards,
  handledAction,
  type InboxGuess,
  type InboxHandled,
  type InboxItem,
  type InboxMail,
  type InboxPerson,
  type InboxPosition,
  type InboxScope,
  type InboxView,
  inboxCounts,
  inboxUrgencyOfCard,
  inboxUrgencyOfMail,
  isQueueCard,
  projectCard,
  scopeInbox,
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

/**
 * WP510（决策 1515）：收件箱的团队那一面要的东西——这个品牌里是 ② / ③、有哪些同事。
 * ① 个人、没装配、读不到都回 `undefined`（收件箱和以前一模一样）。
 */
export interface InboxTeamContext {
  mode: 'peers' | 'company'
  me: string
  members: TeamMember[]
  /** 人 id → 名字（看的人自己回 `undefined`：自己定的卡不写名字）。 */
  nameOf(id: string): string | undefined
}

export async function inboxTeamOf(
  deps: GatewayDeps,
  actor: WorkstationActor,
): Promise<InboxTeamContext | undefined> {
  const port = deps.teamInbox
  if (port === undefined) return undefined
  try {
    const team = await port.team(actor)
    if (team.mode === 'solo') return undefined
    const names = new Map(team.members.map((m) => [m.person_id, m.name]))
    return {
      mode: team.mode,
      me: actor.person_id,
      members: team.members,
      nameOf: (id) => (id === actor.person_id ? undefined : names.get(id)),
    }
  } catch {
    return undefined
  }
}

/** 定过了的那几档（「刚处理」那一块读它们）。 */
const DECIDED_STATES: ApprovalState[] = [
  'approved',
  'approved_edited',
  'rejected',
  'deferred',
  'applying',
  'applied',
  'apply_failed',
]

interface QueuedCard {
  card: DeckCard
  item: ApprovalItem
  /** WP510：不是发给本人的（只在「全部」里，按钮不给）。 */
  others?: boolean
}

async function cardsOfEveryone(
  deps: GatewayDeps,
  actor: WorkstationActor,
  team?: InboxTeamContext,
): Promise<{ cards: QueuedCard[]; tz: number }> {
  const w = deps.workstation
  if (w === undefined) return { cards: [], tz: 0 }
  const positions = await w.positions(actor)
  const can = decidableBy(deps, actor.person_id, actor.workspace_id)
  const now = deps.clock.now()
  const live = (i: { expires_at?: string }): boolean =>
    i.expires_at === undefined || Date.parse(i.expires_at) > Date.parse(now)
  const seen = new Map<string, QueuedCard>()
  const take = (items: readonly ApprovalItem[], position_id: string, others = false): void => {
    for (const item of items) {
      // 定过的（批了 / 不要了 / 稍后）不在队列里：「批了两边一起消失」
      if (seen.has(item.id) || !DECIDABLE_STATES.includes(item.state)) continue
      // 别人的卡（「全部」里只看）不问本人能不能批
      if ((!others && !can(item)) || !live(item)) continue
      const card = projectCard(item, {
        now,
        position_id,
        label: (r) => w.labelFor?.(actor, r) ?? w.label(r),
        ...(deps.executionWiring === undefined ? {} : { wiring: deps.executionWiring }),
      })
      if (card.kind === 'system_alert' || card.kind === 'digest') continue
      if (!isQueueCard(card.kind, card.change_kind)) continue
      // ② / ③：收件人（或认领人）里没有本人的，就是别人的卡（不管从哪条路收进来的）
      const theirs =
        others ||
        (team !== undefined &&
          !item.routing.recipients.some((r) => r.person === actor.person_id) &&
          item.routing.assignee !== actor.person_id)
      seen.set(item.id, theirs ? { card, item, others: true } : { card, item })
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
    if (team !== undefined) {
      /*
       * WP510：② / ③ 里发给本人、却不在本人岗位里的卡（邮箱负责人收的催促卡——负责人不一定做那个岗位），
       * 和同事们队列里的卡（「全部」里只看）。卡的岗位 id 用本人那一条（决定口子认本人的分配）。
       */
      const queue = (person_id: string): Promise<ApprovalItem[]> =>
        deps.approvals
          .queue({ workspace_id: actor.workspace_id, person_id, lane: 'mine' })
          .catch(() => [])
      take(await queue(actor.person_id), host.position_id)
      for (const m of team.members) {
        if (m.person_id === actor.person_id) continue
        take(await queue(m.person_id), host.position_id, true)
      }
    }
  }
  // 同类合并后代表那一张（与岗位页同一个口径：一行 = 牌堆里的一张）；别人的和自己的分开合
  const fold = (rows: QueuedCard[]): QueuedCard[] =>
    foldCards(sortCards(rows.map((x) => x.card))).flatMap((card) => {
      const hit = seen.get(card.id)
      return hit === undefined ? [] : [{ ...hit, card }]
    })
  const all = [...seen.values()]
  return {
    cards: [
      ...fold(all.filter((x) => x.others !== true)),
      ...fold(all.filter((x) => x.others === true)),
    ],
    tz,
  }
}

/** WP510：最近 24 小时里同事们（含本人）定过的卡——「刚处理」。 */
async function handledOf(
  deps: GatewayDeps,
  actor: WorkstationActor,
  team: InboxTeamContext,
  instances: readonly PositionInstance[],
): Promise<InboxHandled[]> {
  const since = Date.parse(deps.clock.now()) - 24 * 3_600_000
  const seen = new Map<string, ApprovalItem>()
  for (const m of team.members) {
    const rows = await deps.approvals
      .queue({
        workspace_id: actor.workspace_id,
        person_id: m.person_id,
        lane: 'mine',
        state: DECIDED_STATES,
      })
      .catch(() => [] as ApprovalItem[])
    for (const i of rows) {
      const d = i.decision
      if (d === undefined || d.by === 'mandate' || d.followed !== undefined) continue
      if (!(Date.parse(d.at) >= since)) continue
      const changeKind = (i.payload as { kind?: unknown } | undefined)?.kind
      if (
        !isQueueCard(
          i.kind as DeckCard['kind'],
          typeof changeKind === 'string' ? changeKind : undefined,
        )
      )
        continue
      seen.set(i.id, i)
    }
  }
  const names = new Map(team.members.map((m) => [m.person_id, m.name]))
  return [...seen.values()]
    .sort((a, b) => Date.parse(b.decision?.at ?? '') - Date.parse(a.decision?.at ?? ''))
    .slice(0, 8)
    .map((i) => {
      const by = String(i.decision?.by ?? '')
      const position = positionOfRole(instances, i.role_id)?.position_id
      return {
        card_id: i.id,
        title: i.title,
        by: { person_id: by, name: names.get(by) ?? '' },
        self: by === actor.person_id,
        action: handledAction(i.decision?.action),
        at: i.decision?.at ?? i.updated_at,
        ...(position === undefined ? {} : { position }),
      }
    })
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
        params: [
          {
            name: 'scope',
            in: 'query',
            required: false,
            description:
              'WP510：② / ③ 里「给我的」（mine，缺省）或「全部」（all）；① 个人里不看这一格',
          },
        ],
        returns:
          '{ items: InboxItem[], counts, positions: InboxPosition[], unassigned, guessed: InboxGuess[], brief, team? }',
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

        // WP510：② / ③ 才有团队那一面（① 个人、没装配：和以前一模一样）
        const team = await inboxTeamOf(deps, actor)
        const scope: InboxScope =
          team !== undefined && c.req.query('scope') === 'all' ? 'all' : 'mine'
        if (team !== undefined) {
          // 懒扫：还没定的催促卡按邮箱负责人改派（负责人不在交给兜底的人）
          try {
            await deps.teamInbox?.sweep?.(actor)
          } catch {
            /* 扫不动不挡收件箱 */
          }
        }
        const { cards, tz } = await cardsOfEveryone(deps, actor, team)
        const person = (id: string): InboxPerson => ({
          person_id: id,
          name: team?.members.find((m) => m.person_id === id)?.name ?? '',
        })
        const routes = new Map<string, Promise<OwnerRoute | undefined>>()
        const routeOf = (account: string): Promise<OwnerRoute | undefined> => {
          const port = deps.teamInbox
          if (port === undefined) return Promise.resolve(undefined)
          let hit = routes.get(account)
          if (hit === undefined) {
            hit = Promise.resolve()
              .then(() => port.ownersOf(actor, account))
              .catch(() => undefined)
            routes.set(account, hit)
          }
          return hit
        }

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
        for (const { card: projected, item, others } of cards) {
          // WP510：别人的卡在「全部」里只看——按钮不给（决定口子也只认收件人本人）
          const card: DeckCard =
            others === true ? { ...projected, available_actions: [] } : projected
          const inst = positionOfRole(instances, card.role_id)
          const thread = threadOfCard(card)
          const guess =
            (thread === undefined ? undefined : guessByThread.get(thread)) ??
            (card.matter_id === undefined ? undefined : guessByMatter.get(card.matter_id))
          const row = cardRow(card, item)
          const recipients = [...new Set(item.routing.recipients.map((r) => r.person))]
          items.push({
            id: `card:${card.id}`,
            type: 'card',
            urgency: inboxUrgencyOfCard(card, now, tz),
            ...row,
            ...(others === true ? { primary: 'open' as const } : {}),
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
            ...(team === undefined
              ? {}
              : { owners: recipients.map(person), mine: others !== true }),
          })
        }
        for (const t of unclaimed) {
          const mail = mailRow(t)
          if (mail === undefined) continue
          const self = mail.suggest?.action === 'self'
          // WP510：信按这只邮箱的负责人分（没指定负责人的照旧谁都看得到）
          const route =
            team === undefined || mail.account === undefined
              ? undefined
              : await routeOf(mail.account)
          const owned = route !== undefined && route.to.length > 0
          items.push({
            id: `mail:${t.thread_id}`,
            type: 'mail',
            urgency: inboxUrgencyOfMail(mail, now, tz),
            tag: self ? 'only_you' : 'unsure',
            primary: self ? 'self' : mail.suggest?.action === 'hand' ? 'hand' : 'open',
            at: mail.last_at,
            mail,
            ...(team === undefined
              ? {}
              : owned
                ? {
                    owners: route.to.map(person),
                    mine: route.to.includes(actor.person_id),
                    ...(route.fallback ? { fallback_from: route.owners.map(person) } : {}),
                  }
                : { mine: true }),
          })
        }
        const everything = sortInbox(items)
        const sorted = team === undefined ? everything : scopeInbox(everything, scope)

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
          ...(team === undefined
            ? {}
            : {
                team: {
                  mode: team.mode,
                  scope,
                  mine: scopeInbox(everything, 'mine').length,
                  all: everything.length,
                  handled: await handledOf(deps, actor, team, instances),
                },
              }),
        }
        return ok(c, view)
      },
    ),
  ]
}

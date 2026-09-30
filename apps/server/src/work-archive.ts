/**
 * WP207：左栏「职责下正在进行的对话 / 任务」、自动归档与找回——服务端实现
 * （路由在 `@agentsws/api` 的 `routes/work-archive.ts`，纯逻辑在 `@agentsws/work` 的 `archive.ts`）。
 *
 * 四条边界：
 * 1. **只看本人看得见的**：参与人里有他，或者是用他名下某条分配开的。别人的事不进他的左栏、
 *    不进他的搜索，也不会因为他打开左栏而被归档。
 * 2. **懒扫，不起定时器**：读左栏时顺手把超过 N 天没动的归档；在跑的运行、等你批的卡不归。
 *    模拟与测试里没人读左栏 → 一件都不会被归档（零漂移）。
 * 3. **找回只读**：`find` 只给候选；恢复是另一条路（一次一件，人点了才走）。
 * 4. **设置与"看过了"存本机**（品牌目录下一个 JSON）：天数是这个品牌的偏好；"看过了"只用来
 *    决定「做完待看」那个小点，不是业务数据。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type {
  ArchivedMatterView,
  RailMatterState,
  RailMatterView,
  WorkActor,
  WorkArchivePort,
  WorkRailView,
} from '@agentsws/api'
import { ApiError } from '@agentsws/api'
import type {
  ArchivedWorkCandidate,
  Clock,
  FindArchivedWorkInput,
  Matter,
  PersonId,
  PositionInstance,
  WorkArchiveSettings,
} from '@agentsws/contracts'
import { DEFAULT_ARCHIVE_IDLE_DAYS } from '@agentsws/contracts'
import {
  RECALL_MAX_LIMIT,
  type RecallDoc,
  rankArchived,
  textMatches,
  type Work,
} from '@agentsws/work'

/** 左栏每条职责下默认列几条（再多就是「更多」）。 */
export const RAIL_DEFAULT_LIMIT = 5
/** 找回 / 搜索时每件事带多少条时间线进正文（够认出是哪件事就行）。 */
const BODY_EVENTS = 40
/** 正文最多多长（字）。 */
const BODY_CHARS = 4000
/** 模型重排时最多给它看几件（关键词命中的 + 最近归档的）。 */
const RERANK_POOL = 24

/** 本机那一份：天数 +「谁什么时候看过哪件事」。 */
interface ArchiveStateFile {
  idle_days: number | null
  seen: Record<PersonId, Record<string, string>>
}

export interface ArchiveStateStore {
  settings(): WorkArchiveSettings
  setSettings(next: WorkArchiveSettings): WorkArchiveSettings
  seenAt(person_id: PersonId, matter_id: string): string | undefined
  markSeen(person_id: PersonId, matter_id: string, at: string): void
}

/** 给了路径就落盘（品牌目录下 `work-archive.json`），没给就是内存档。 */
export function createArchiveStateStore(file?: string): ArchiveStateStore {
  let state: ArchiveStateFile = { idle_days: DEFAULT_ARCHIVE_IDLE_DAYS, seen: {} }
  if (file !== undefined && existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<ArchiveStateFile>
      state = {
        idle_days:
          parsed.idle_days === null || typeof parsed.idle_days === 'number'
            ? parsed.idle_days
            : DEFAULT_ARCHIVE_IDLE_DAYS,
        seen: parsed.seen ?? {},
      }
    } catch {
      // 读坏了就当默认值（它只是偏好，丢了回默认 3 天）
    }
  }
  const save = (): void => {
    if (file === undefined) return
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  }
  return {
    settings: () => ({ idle_days: state.idle_days }),
    setSettings: (next) => {
      state = { ...state, idle_days: next.idle_days }
      save()
      return { idle_days: state.idle_days }
    },
    seenAt: (person_id, matter_id) => state.seen[person_id]?.[matter_id],
    markSeen: (person_id, matter_id, at) => {
      state = {
        ...state,
        seen: { ...state.seen, [person_id]: { ...(state.seen[person_id] ?? {}), [matter_id]: at } },
      }
      save()
    },
  }
}

export interface WorkArchiveOptions {
  clock: Clock
  work: Work
  state: ArchiveStateStore
  /** 本人持有的岗位（左栏按它列）。 */
  positions(person_id: PersonId): Promise<PositionInstance[]>
  /** 本人名下（没撤销的）分配 id——「用他的分配开的事」算他看得见。 */
  assignmentsOf(person_id: PersonId): string[]
  /** 正在跑的运行所在的事项。 */
  runningMatters(): Set<string>
  /** 本人还等着定的卡：事项 id → 张数（没挂事项的卡不在这里——岗位上的数用 `pending_cards`）。 */
  pendingCards(person_id: PersonId): Promise<Map<string, number>>
  /** 工作区里人的展示名（找回时当检索词；一次请求取一回）。 */
  personNames(): Promise<Map<PersonId, string>>
  /** 职责 / 岗位的展示名（找回时当检索词）。 */
  roleName(id: string): string | undefined
  positionName(id: string): string | undefined
  /**
   * 模型重排（⌘K「让 AI 找回」那一路）：给这句话和一小堆候选，回按"像"排好的 id（不像的不回）。
   * 没接模型 / 调失败回 `undefined`，那就按关键词的顺序。随便聊那一路不走它——聊天模型自己就在读候选。
   */
  rerank?(
    actor: WorkActor,
    query: string,
    pool: { id: string; title: string; summary: string; last_activity: string }[],
  ): Promise<string[] | undefined>
}

export interface WorkArchiveAssembly extends WorkArchivePort {
  /** 随便聊的工具用：同 `find`，但不走模型重排。 */
  recall(actor: WorkActor, input: FindArchivedWorkInput): Promise<ArchivedWorkCandidate[]>
  /** 这个人有没有归档的事（随便聊只在有的时候才挂找回工具）。 */
  hasArchived(actor: WorkActor): boolean
}

const words0 = (q: string | undefined): number => (q ?? '').trim().length

const snippetOf = (text: string, words: readonly string[]): string | undefined => {
  const lower = text.toLowerCase()
  for (const w of words) {
    const i = lower.indexOf(w)
    if (i < 0) continue
    const from = Math.max(0, i - 24)
    const line = text.slice(from, i + w.length + 40).replace(/\s+/g, ' ')
    return `${from > 0 ? '…' : ''}${line}${i + w.length + 40 < text.length ? '…' : ''}`
  }
  return undefined
}

export function createWorkArchive(options: WorkArchiveOptions): WorkArchiveAssembly {
  const { work, state, clock } = options

  const visibleTo = (person_id: PersonId): ((m: Matter) => boolean) => {
    const mine = new Set(options.assignmentsOf(person_id))
    return (m) => m.context.participants.includes(person_id) || mine.has(m.position_id ?? '')
  }

  const docOf = (m: Matter, names: Map<PersonId, string>): RecallDoc => {
    const events = work.store.listMatterEvents(m.id, { limit: BODY_EVENTS })
    return {
      matter: m,
      people: m.context.participants
        .map((p) => names.get(p))
        .filter((n): n is string => n !== undefined),
      labels: [
        ...(m.role_id === undefined ? [] : [options.roleName(m.role_id)]),
        ...(m.position_template_id === undefined
          ? []
          : [options.positionName(m.position_template_id)]),
      ].filter((n): n is string => n !== undefined),
      body: events
        .filter(
          (e) => e.kind === 'human_message' || e.kind === 'agent_message' || e.kind === 'note',
        )
        .map((e) => e.text)
        .join('\n')
        .slice(-BODY_CHARS),
    }
  }

  const viewOf = (m: Matter, snippet?: string): ArchivedMatterView => ({
    id: m.id,
    title: m.title,
    summary: m.context.summary,
    status: m.status,
    last_activity: m.context.last_activity,
    ...(m.position_template_id === undefined
      ? {}
      : { position_template_id: m.position_template_id }),
    ...(m.role_id === undefined ? {} : { role_id: m.role_id }),
    ...(m.archived_at === undefined ? {} : { archived_at: m.archived_at }),
    ...(snippet === undefined ? {} : { snippet }),
  })

  /** 懒扫：只扫这个人看得见的；在跑的、有卡等他定的不归。 */
  const sweep = (person_id: PersonId, busyMatters: Map<string, number>): void => {
    const visible = visibleTo(person_id)
    const running = options.runningMatters()
    work.archiveIdle({
      idle_days: state.settings().idle_days,
      busy: (m) => !visible(m) || running.has(m.id) || (busyMatters.get(m.id) ?? 0) > 0,
    })
  }

  /** 最后说话的是 Agent、而且那之后本人没点开看过 → 「做完待看」。 */
  const readyOf = (person_id: PersonId, m: Matter): boolean => {
    const events = work.store.listMatterEvents(m.id, { limit: 12 })
    const last = [...events]
      .reverse()
      .find((e) => e.kind === 'agent_message' || e.kind === 'human_message')
    if (last?.kind !== 'agent_message') return false
    const seen = state.seenAt(person_id, m.id)
    return seen === undefined || Date.parse(seen) < Date.parse(last.at)
  }

  /** 这件事挂在这个岗位的这条职责下吗（职责入口的老事项没有 role_id，按分配认）。 */
  const inDuty = (
    m: Matter,
    position_id: string,
    role_id: string,
    assignment_id: string,
  ): boolean =>
    (m.role_id === role_id || (m.role_id === undefined && m.position_id === assignment_id)) &&
    (m.position_template_id === undefined || m.position_template_id === position_id)

  const archivedOf = (person_id: PersonId): Matter[] =>
    work.listMatters({ archived: true }).filter(visibleTo(person_id))

  const recall = async (
    actor: WorkActor,
    input: FindArchivedWorkInput,
  ): Promise<ArchivedWorkCandidate[]> => {
    const names = await options.personNames()
    const docs = archivedOf(actor.person_id).map((m) => docOf(m, names))
    return rankArchived(docs, {
      query: input.query,
      now: clock.now(),
      tz_offset_minutes: work.tz_offset_minutes,
      ...(input.since === undefined ? {} : { since: input.since }),
      ...(input.until === undefined ? {} : { until: input.until }),
      ...(input.position === undefined ? {} : { position: input.position }),
      ...(input.participant === undefined ? {} : { participant: input.participant }),
      ...(input.limit === undefined ? {} : { limit: input.limit }),
    })
  }

  return {
    async rail(actor, opts): Promise<WorkRailView> {
      const limit = opts.limit ?? RAIL_DEFAULT_LIMIT
      const cards = await options.pendingCards(actor.person_id)
      sweep(actor.person_id, cards)
      const visible = visibleTo(actor.person_id)
      const running = options.runningMatters()
      const open = work.listMatters({ status: ['open', 'waiting'] }).filter(visible)
      const archived = archivedOf(actor.person_id)
      const stateOf = (m: Matter): RailMatterState => {
        if (running.has(m.id)) return 'running'
        if ((cards.get(m.id) ?? 0) > 0) return 'awaiting'
        return readyOf(actor.person_id, m) ? 'ready' : 'idle'
      }
      const positions = await options.positions(actor.person_id)
      return {
        idle_days: state.settings().idle_days,
        positions: positions.map((p) => {
          let ready = 0
          const duties = p.roles.flatMap((r) => {
            const mine = r.my_assignment_id
            if (mine === undefined) return []
            const here = (m: Matter): boolean => inDuty(m, p.position_id, r.role_id, mine)
            const active = open.filter((m) => m.archived_at === undefined && here(m))
            const views: RailMatterView[] = active.map((m) => ({
              id: m.id,
              title: m.title,
              state: stateOf(m),
              last_activity: m.context.last_activity,
              cards: cards.get(m.id) ?? 0,
            }))
            ready += views.filter((v) => v.state === 'ready').length
            return [
              {
                role_id: r.role_id,
                matters: views.slice(0, limit),
                more: Math.max(0, views.length - limit),
                archived: archived.filter(here).length,
              },
            ]
          })
          return { position_id: p.position_id, awaiting: p.pending_cards + ready, duties }
        }),
      }
    },

    async archived(actor, filter) {
      const names =
        words0(filter.q) === 0 ? new Map<PersonId, string>() : await options.personNames()
      const words = (filter.q ?? '')
        .toLowerCase()
        .split(/\s+/)
        .filter((w) => w !== '')
      const out: ArchivedMatterView[] = []
      for (const m of archivedOf(actor.person_id)) {
        if (filter.position_id !== undefined && m.position_template_id !== filter.position_id)
          continue
        if (filter.role_id !== undefined && m.role_id !== filter.role_id) continue
        const at = Date.parse(m.context.last_activity)
        if (filter.from !== undefined && at < Date.parse(filter.from)) continue
        if (filter.to !== undefined && at >= Date.parse(filter.to)) continue
        if (words.length === 0) {
          out.push(viewOf(m))
        } else {
          const doc = docOf(m, names)
          if (!textMatches(filter.q ?? '', doc)) continue
          out.push(viewOf(m, snippetOf(doc.body, words)))
        }
        if (out.length >= (filter.limit ?? 50)) break
      }
      return out
    },

    async search(actor, input) {
      const names = await options.personNames()
      const words = input.q
        .toLowerCase()
        .split(/\s+/)
        .filter((w) => w !== '')
      const out: ArchivedMatterView[] = []
      for (const m of work.listMatters().filter(visibleTo(actor.person_id))) {
        const doc = docOf(m, names)
        if (!textMatches(input.q, doc)) continue
        out.push(viewOf(m, snippetOf(doc.body, words)))
        if (out.length >= (input.limit ?? 20)) break
      }
      return out
    },

    /**
     * ⌘K「让 AI 找回」：关键词先捞（最多 8 个），再把命中的 + 最近归档的凑一小堆给模型重排。
     * 模型只排序、不恢复；它回的 id 不在这一堆里的一律丢掉（不信模型编出来的 id）。
     */
    async find(actor, input) {
      const limit = Math.min(input.limit ?? 5, RECALL_MAX_LIMIT)
      const keyword = await recall(actor, { ...input, limit: RECALL_MAX_LIMIT })
      if (options.rerank === undefined)
        return { candidates: keyword.slice(0, limit), semantic: false }
      const byId = new Map(archivedOf(actor.person_id).map((m) => [m.id, m]))
      const poolIds = [
        ...keyword.map((c) => c.matter_id),
        ...[...byId.keys()].filter((id) => !keyword.some((c) => c.matter_id === id)),
      ].slice(0, RERANK_POOL)
      if (poolIds.length === 0) return { candidates: [], semantic: false }
      const pool = poolIds.flatMap((id) => {
        const m = byId.get(id)
        return m === undefined
          ? []
          : [
              {
                id,
                title: m.title,
                summary: m.context.summary,
                last_activity: m.context.last_activity,
              },
            ]
      })
      let order: string[] | undefined
      try {
        order = await options.rerank(actor, input.query, pool)
      } catch {
        order = undefined
      }
      if (order === undefined) return { candidates: keyword.slice(0, limit), semantic: false }
      const picked = order.filter((id, i) => byId.has(id) && order?.indexOf(id) === i)
      const candidates = picked.slice(0, limit).map((id, i): ArchivedWorkCandidate => {
        const hit = keyword.find((c) => c.matter_id === id)
        const m = byId.get(id) as Matter
        return {
          matter_id: id,
          title: m.title,
          summary: m.context.summary,
          ...(m.position_template_id === undefined
            ? {}
            : { position_template_id: m.position_template_id }),
          ...(m.role_id === undefined ? {} : { role_id: m.role_id }),
          archived_at: m.archived_at ?? m.context.last_activity,
          last_activity: m.context.last_activity,
          // 模型排的顺序就是分：第一名 1，往后递减；关键词的理由照样带上
          score: Math.round((1 - i / Math.max(picked.length, 1) / 2) * 1000) / 1000,
          why: [...(hit?.why ?? []), 'semantic'],
        }
      })
      return { candidates, semantic: true }
    },

    unarchive(actor, id, by) {
      const m = work.getMatter(id)
      // 别人的事与不存在的事回同一句话：不给探测别人事项 id 的口
      if (m === undefined || !visibleTo(actor.person_id)(m))
        throw new ApiError('not_found', '没有这件事（可能已经删了）')
      return { matter: work.unarchive(id, by, actor.person_id) }
    },

    seen(actor, id) {
      const m = work.getMatter(id)
      if (m === undefined || !visibleTo(actor.person_id)(m))
        throw new ApiError('not_found', '没有这件事（可能已经删了）')
      state.markSeen(actor.person_id, id, clock.now())
      return { ok: true as const }
    },

    settings: () => state.settings(),
    setSettings: (_actor, input) => state.setSettings(input),

    recall,
    hasArchived: (actor) => archivedOf(actor.person_id).length > 0,
  }
}

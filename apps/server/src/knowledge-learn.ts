/**
 * WP488（决策 1680 / 1681 / 1682 / 1686）：**客服知识库「学一遍」**——带副作用的那一半。
 *
 * 两种来源，一条路：
 *
 * 1. **过往邮件**：已接邮箱回看 N 个月（默认 12，卡上 / 页上能改）——消息库里已有的 + 按日期回看收件箱与已发
 *    （`MailboxSync.history`：不碰游标、不落库、不分拣、不交岗位）→ 拼「客户问 → 我们人工回」（跳过 AI 发的、
 *    群发 / 通知、没人回的）→ 先聚类后出题（问模型的次数 = 簇数）；
 * 2. **官网 + 售后（帮助中心）网站**：品牌建档时的官网直接复用，售后站在对话里一句话给 / 知识库页填 →
 *    工坊自己的读页那一条路读（只 GET、带工坊 UA、遵 robots；正文太薄的页交内置浏览器渲染一次）→
 *    政策 / FAQ 先读、页数封顶 → 每页问一次模型抽问答；每一页登记成一个 `website` 源，记内容 hash，
 *    **每周复查一次**（`recheck.ts`）：受管辖数值变了 → 派生卡标 stale + 一张「这几条可能过期」卡。
 *
 * 学到的**一律以待确认写进知识库**（`proposed`，带依据：哪几封往来 / 哪一页），然后出**一张**汇总卡
 * （`knowledge_update` + `form: 'knowledge_learned'`）：每条可改范围（公共 / 售前 / 售后）、可去掉；
 * 「采纳」= 这一批生效，「不采纳」= 整批作废（退役留痕）。
 *
 * 跑起来是一件**事项**（岗位里看得见进度，完了汇总卡挂在它的时间线上）；没接邮箱就在这件事里出连接卡（决策 690）。
 * 开跑前算预估花费（簇数 / 页数 × 每次的估算 token × 单价），撞模型网关的月上限就不跑；跑到一半网关冻结就停。
 *
 * 读邮件、读页、问模型、出卡、开事项都由调用方注入（`server.ts` 装配）；这里不碰网络、不看系统时钟。
 */
import type {
  ApprovalBus,
  ApprovalItem,
  Clock,
  CreateApprovalInput,
  FactCard,
  KnowledgeLearnEstimate,
  KnowledgeLearnedItem,
  KnowledgeLearnedPayload,
  KnowledgeLearnJob,
  KnowledgeLearnSource,
  KnowledgeSource,
  KnowledgeStage,
  KnowledgeStalePayload,
  PersonId,
  RoleId,
  WorkspaceId,
} from '@agentsws/contracts'
import {
  DEFAULT_EMAIL_LOOKBACK_MONTHS,
  EMAIL_LOOKBACK_MONTHS_MAX,
  hasCommitment,
  isKnowledgeLearnedPayload,
  isKnowledgeStage,
  isKnowledgeStalePayload,
  KNOWLEDGE_LEARNED_FORM,
  KNOWLEDGE_STALE_FORM,
  stageOfText,
} from '@agentsws/contracts'
import {
  contentHashOf,
  describeFactKeyZh,
  extractFactFingerprint,
  type Knowledge,
} from '@agentsws/knowledge'
import { learnFromHistory, learnFromSite, planHistory, type SiteReader } from '@agentsws/learning'
import {
  EXAMPLE_MAX_CHARS,
  EXAMPLES_PER_CLUSTER,
  type HistoryMail,
  historyPromptText,
  type KnowledgeCandidate,
  MAX_PAGE_TEXT,
  MAX_SITE_PAGES,
  normalizeSiteUrl,
  parseHistorySummary,
  qaPairsFromMail,
} from '@agentsws/support-core'

/** 学出来的问答卡的 `subject.type`。 */
export const LEARNED_SUBJECT_TYPE = 'learned_qa'
/** 汇总卡上最多列几条（再多的在知识库「待确认」里看）。 */
export const LEARNED_CARD_ITEMS = 30
/** 一次学网站最多读几页。 */
export const LEARN_SITE_MAX_PAGES = MAX_SITE_PAGES
/** 复查多久一次（默认每周）。 */
export const SITE_RECHECK_INTERVAL_MS = 7 * 86_400_000

/** 每次问模型预估多少 token（输出）。 */
const OUT_TOKENS = 400
/** 每次历史归纳的输入字数（说明 + 6 个例子各一问一答）。 */
const HISTORY_INPUT_CHARS = 1200 + EXAMPLES_PER_CLUSTER * EXAMPLE_MAX_CHARS * 2
/** 每页的输入字数（说明 + 正文上限）。 */
const SITE_INPUT_CHARS = 1500 + MAX_PAGE_TEXT

export interface LearnActor {
  person_id: PersonId
  workspace_id: WorkspaceId
  assignment_id: string
  role_id: string
}

/** 这个品牌的邮箱那一侧。 */
export interface LearnMail {
  /** 接着的邮箱（小写地址）。 */
  accounts(): string[]
  /** 消息库里已有的信（宿主按日期过滤之前的全量，这里再过滤一遍）。 */
  stored(): Promise<HistoryMail[]>
  /** 按日期回看一只邮箱（收件箱 + 已发）；`supported: false` = 这只收信端不支持。 */
  history(account: string, since: string): Promise<{ records: HistoryMail[]; supported: boolean }>
  /** 工坊自己发出去的 Message-ID（出站台账）。 */
  machineSent(): Promise<Set<string>>
}

/** 问模型（这个品牌的网关、`extraction` 档）。 */
export interface LearnModel {
  complete(prompt: string, run_id: string): Promise<string>
  /** N 次调用的估算花费（网关计价单位）；价目里没有就 `undefined`。 */
  estimate(calls: number, inputChars: number, outputTokens: number): number | undefined
  /** 网关这个月的用量与上限；没设上限回 `undefined`。 */
  budget(): Promise<{ used: number; cap: number; frozen: boolean } | undefined>
}

/** 事项那一侧（开一件、记进度、挂卡）。 */
export interface LearnWork {
  open(actor: LearnActor, title: string): string | undefined
  note(matter_id: string, text: string): void
  attach(matter_id: string, item: ApprovalItem): void
}

export interface KnowledgeLearnDeps {
  clock: Clock
  knowledge: Knowledge
  approvals: ApprovalBus
  newId(prefix: string): string
  mail(ws: WorkspaceId): Promise<LearnMail | undefined>
  model(actor: LearnActor): Promise<LearnModel | undefined>
  /** 读页（工坊自己的读页那一条路）；没有 = 这里读不了网站。 */
  reader(ws: WorkspaceId): Promise<SiteReader | undefined>
  /** 品牌建档时读的官网。 */
  brandSite(ws: WorkspaceId): string | undefined
  work(ws: WorkspaceId): Promise<LearnWork | undefined>
  /** 没接邮箱：在这件事里出一张连接卡（回卡 id）。 */
  askConnect?(
    actor: LearnActor,
    matter_id: string | undefined,
    why: string,
  ): Promise<string | undefined>
  log?(line: string): void
}

export interface LearnInput {
  source: KnowledgeLearnSource
  months?: number
  urls?: readonly string[]
}

const APPROVED = new Set(['approved', 'approved_edited', 'applying', 'applied'])
const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}…` : s)

type RecordApply = (
  id: string,
  state: 'applying' | 'applied' | 'apply_failed',
  apply: ApprovalItem['apply'],
) => Promise<unknown>

export function clampMonths(months: number | undefined): number {
  const m = Math.round(months ?? DEFAULT_EMAIL_LOOKBACK_MONTHS)
  if (!Number.isFinite(m) || m < 1) return DEFAULT_EMAIL_LOOKBACK_MONTHS
  return Math.min(EMAIL_LOOKBACK_MONTHS_MAX, m)
}

/** 回看起点：N 个月前（按 30 天一月算）。 */
export function sinceOf(now: string, months: number): string {
  return new Date(Date.parse(now) - months * 30 * 86_400_000).toISOString()
}

/** 候选 → 一张待确认的问答卡（`Q: … / A: …`，出处带依据）。 */
export function learnedCard(
  c: KnowledgeCandidate,
  ctx: {
    workspace_id: WorkspaceId
    owner: PersonId
    source: KnowledgeLearnSource
    job_id: string
    /** 邮件：这一簇的线程 id；网站：那一页。 */
    refs: readonly string[]
  },
): Omit<FactCard, 'id' | 'status' | 'usage' | 'created_at' | 'updated_at'> {
  const ref = ctx.source === 'website' ? (ctx.refs[0] ?? c.provenance.ref) : c.provenance.ref
  return {
    schema_version: 1,
    workspace_id: ctx.workspace_id,
    layer: c.layer,
    domain: 'company',
    scope: [],
    sensitivity: 'internal',
    subject: { type: LEARNED_SUBJECT_TYPE, id: c.category, key: `learned:${c.key.slice(3)}` },
    statement: `Q: ${c.question}\nA: ${c.statement}`,
    structured: {
      question: c.question,
      answer: c.statement,
      learned_from: ctx.source,
      job_id: ctx.job_id,
      ...(c.hold_reasons.length === 0 ? {} : { hold_reasons: c.hold_reasons }),
    },
    provenance: [
      {
        source: ctx.source === 'website' ? 'web' : 'email',
        ref,
        locator:
          ctx.source === 'website'
            ? '官网 / 售后网站'
            : `过往邮件 ${String(ctx.refs.length)} 段往来`,
        quote: c.provenance.quote ?? c.statement.slice(0, 200),
        at: c.provenance.at,
      },
    ],
    confidence: { value: c.confidence, state: 'unverified' },
    valid: {},
    owner: ctx.owner,
    created_by: { kind: 'agent', id: 'knowledge-learn' },
    stage: c.stage ?? 'both',
    // 内容指纹按答案那一句抽（复查时拿它比源页上的受管辖数值）
    fact_fingerprint: extractFactFingerprint(c.statement),
  }
}

export interface KnowledgeLearner {
  estimate(actor: LearnActor, input: LearnInput): Promise<KnowledgeLearnEstimate>
  /** 开一次（后台跑，马上回）。 */
  start(actor: LearnActor, input: LearnInput): Promise<KnowledgeLearnJob>
  job(id: string): KnowledgeLearnJob | undefined
  jobs(ws: WorkspaceId): KnowledgeLearnJob[]
  /** 汇总卡 / 过期卡被决定了。 */
  onDecided(item: ApprovalItem): Promise<void>
  /** 复查学过的网页（到期的；`force` = 全部）。回开了几张复核。 */
  recheckSites(ws: WorkspaceId, opts?: { force?: boolean; actor?: LearnActor }): Promise<number>
  /** 后台那几次跑完了没有（测试与收尾用）。 */
  settled(): Promise<void>
}

export function isLearnedCard(item: Pick<ApprovalItem, 'kind' | 'payload'>): boolean {
  return item.kind === 'knowledge_update' && isKnowledgeLearnedPayload(item.payload)
}
export function isStaleCard(item: Pick<ApprovalItem, 'kind' | 'payload'>): boolean {
  return item.kind === 'knowledge_update' && isKnowledgeStalePayload(item.payload)
}

/** 这条源是不是「学网站」登记的（ref 是网页、parser 是 html）。 */
const isLearnedSite = (s: KnowledgeSource): boolean =>
  s.kind === 'website' && s.parser === 'html' && s.deleted_at === undefined

export function createKnowledgeLearner(deps: KnowledgeLearnDeps): KnowledgeLearner {
  const { knowledge, clock } = deps
  const jobs = new Map<string, KnowledgeLearnJob>()
  const inflight = new Set<Promise<unknown>>()
  /** 邮件读一次挺贵：同一品牌同一回看月数 10 分钟内的预估 / 开跑共用一份。 */
  const mailCache = new Map<
    string,
    { at: number; mails: HistoryMail[]; machine: Set<string>; ours: Set<string> }
  >()

  const track = <T>(p: Promise<T>): Promise<T> => {
    inflight.add(p)
    void p.finally(() => inflight.delete(p)).catch(() => undefined)
    return p
  }
  const log = (line: string): void => deps.log?.(line)

  const readMail = async (
    ws: WorkspaceId,
    months: number,
  ): Promise<{ mails: HistoryMail[]; machine: Set<string>; ours: Set<string> } | undefined> => {
    const mail = await deps.mail(ws)
    if (mail === undefined) return undefined
    const accounts = mail.accounts().map((a) => a.toLowerCase())
    if (accounts.length === 0) return undefined
    const key = `${ws}|${String(months)}`
    const hit = mailCache.get(key)
    const nowMs = Date.parse(clock.now())
    if (hit !== undefined && nowMs - hit.at < 10 * 60_000) return hit
    const since = sinceOf(clock.now(), months)
    const all: HistoryMail[] = (await mail.stored()).filter((m) => m.date >= since)
    for (const account of accounts) {
      const got = await mail.history(account, since).catch((e: unknown) => {
        log(`[knowledge-learn] 回看 ${account} 没成：${e instanceof Error ? e.message : String(e)}`)
        return { records: [], supported: false }
      })
      all.push(...got.records.filter((m) => m.date >= since))
    }
    const out = { mails: all, machine: await mail.machineSent(), ours: new Set(accounts) }
    mailCache.set(key, { at: nowMs, ...out })
    return out
  }

  const fitsBudget = (
    cost: number | undefined,
    budget: { used: number; cap: number; frozen: boolean } | undefined,
  ): boolean => {
    if (budget === undefined) return true
    if (budget.frozen) return false
    if (budget.cap <= 0) return true
    return budget.used + (cost ?? 0) <= budget.cap
  }

  const sitesOf = (ws: WorkspaceId, urls: readonly string[] | undefined): string[] => {
    const given = (urls ?? []).map((u) => normalizeSiteUrl(u)).filter((u) => u !== undefined)
    if (given.length > 0) return [...new Set(given)].slice(0, 5)
    const brand = deps.brandSite(ws)
    const own = brand === undefined ? undefined : normalizeSiteUrl(brand)
    return own === undefined ? [] : [own]
  }

  const estimate: KnowledgeLearner['estimate'] = async (actor, input) => {
    const model = await deps.model(actor)
    const budgetState =
      model === undefined ? undefined : await model.budget().catch(() => undefined)
    const budget =
      budgetState === undefined || budgetState.cap <= 0
        ? undefined
        : { used: budgetState.used, cap: budgetState.cap }
    if (input.source === 'website') {
      const urls = sitesOf(actor.workspace_id, input.urls)
      const calls = urls.length === 0 ? 0 : LEARN_SITE_MAX_PAGES
      const cost = model?.estimate(calls, SITE_INPUT_CHARS, OUT_TOKENS)
      return {
        source: 'website',
        urls,
        calls,
        ...(cost === undefined ? {} : { cost }),
        ...(budget === undefined ? {} : { budget }),
        fits: fitsBudget(cost, budgetState),
        model: model !== undefined,
      }
    }
    const months = clampMonths(input.months)
    const read = await readMail(actor.workspace_id, months)
    if (read === undefined)
      return {
        source: 'email',
        months,
        calls: 0,
        fits: true,
        connected: false,
        model: model !== undefined,
      }
    const { pairs } = qaPairsFromMail(read.mails, { ours: read.ours, machineSent: read.machine })
    const calls = planHistory(pairs).length
    const cost = model?.estimate(calls, HISTORY_INPUT_CHARS, OUT_TOKENS)
    return {
      source: 'email',
      months,
      pairs: pairs.length,
      calls,
      ...(cost === undefined ? {} : { cost }),
      ...(budget === undefined ? {} : { budget }),
      fits: fitsBudget(cost, budgetState),
      connected: true,
      model: model !== undefined,
    }
  }

  const finish = (job: KnowledgeLearnJob, patch: Partial<KnowledgeLearnJob>): void => {
    Object.assign(job, patch, { finished_at: clock.now() })
  }

  /** 候选 → 待确认的卡 + 汇总卡。 */
  const land = async (
    job: KnowledgeLearnJob,
    actor: LearnActor,
    learned: { candidate: KnowledgeCandidate; refs: string[]; basis: string }[],
    work: LearnWork | undefined,
  ): Promise<void> => {
    const items: KnowledgeLearnedItem[] = []
    const card_ids: string[] = []
    for (const l of learned) {
      const card = await knowledge.store.propose(
        learnedCard(l.candidate, {
          workspace_id: actor.workspace_id,
          owner: actor.person_id,
          source: job.source,
          job_id: job.id,
          refs: l.refs,
        }),
      )
      card_ids.push(card.id)
      items.push({
        card_id: card.id,
        question: clip(l.candidate.question, 160),
        answer: clip(l.candidate.statement, 300),
        stage: card.stage ?? 'both',
        basis: l.basis,
        ...(l.candidate.hold_reasons.length === 0 ? {} : { hold: true }),
        // WP495（1701）：只有答案里真写了承诺的才挂小图标（规则判，不问模型）
        ...(hasCommitment(l.candidate.statement) ? { commitment: true } : {}),
      })
    }
    job.learned = card_ids.length
    if (card_ids.length === 0) return
    const after = `学到 ${String(card_ids.length)} 条，待你确认`
    const payload: KnowledgeLearnedPayload = {
      form: KNOWLEDGE_LEARNED_FORM,
      job_id: job.id,
      source: job.source,
      card_ids,
      items: items.slice(0, LEARNED_CARD_ITEMS),
      before: null,
      after,
    }
    const title =
      job.source === 'email'
        ? `从过往邮件学到 ${String(card_ids.length)} 条`
        : `从网站学到 ${String(card_ids.length)} 条`
    const input: CreateApprovalInput<KnowledgeLearnedPayload> = {
      workspace_id: actor.workspace_id,
      schema_version: 1,
      kind: 'knowledge_update',
      role_id: actor.role_id as RoleId,
      subject: {
        object: { type: 'policy', id: `knowledge_learn:${job.id}` },
        ...(job.matter_id === undefined ? {} : { matter_id: job.matter_id as never }),
      },
      dedupe_key: `${actor.workspace_id}:knowledge_update:knowledge_learn:${job.id}`,
      title,
      // 界面少字：标题说了学到几条，这一句只说点了之后怎样
      summary: '采纳后客服就照这些答；范围能改，不要的去掉。',
      payload,
      evidence: {
        source_events: [],
        provenance: {
          seen: card_ids.slice(0, 20).map((id) => ({ type: 'fact_card' as const, id })),
        },
        diff: { before: null, after, summary: after },
        precheck: { permission_diff: 'ok', semantic_diff: 'ok' },
      },
      proposer: { kind: 'agent', id: 'knowledge-learn' },
      automation: { level_at_creation: 'L1' },
      routing: {
        recipients: [{ person: actor.person_id, via: 'role_holder' }],
        rule: 'role_holder',
        escalation: { after_hours: 72, business_hours: true, chain: ['owner'], escalated_at: [] },
        separation_of_duties: false,
      },
      priority: 'queue',
    }
    const item = await deps.approvals.create(input)
    job.approval_id = item.id
    if (job.matter_id !== undefined) work?.attach(job.matter_id, item)
  }

  const runEmail = async (job: KnowledgeLearnJob, actor: LearnActor): Promise<void> => {
    const work = await deps.work(actor.workspace_id)
    const note = (text: string): void => {
      if (job.matter_id !== undefined) work?.note(job.matter_id, text)
    }
    const months = job.months ?? DEFAULT_EMAIL_LOOKBACK_MONTHS
    const mail = await deps.mail(actor.workspace_id)
    if (mail === undefined || mail.accounts().length === 0) {
      const card = await deps.askConnect?.(
        actor,
        job.matter_id,
        '先接上客服邮箱，才能从过往邮件学。',
      )
      finish(job, {
        state: 'needs_connection',
        note: '还没接客服邮箱',
        ...(card === undefined ? {} : { connect_card_id: card }),
      })
      note('还没接客服邮箱：接上之后再点一次「从过往邮件学」。')
      return
    }
    const model = await deps.model(actor)
    if (model === undefined) {
      finish(job, { state: 'no_model', note: '还没接 AI 模型' })
      note('还没接 AI 模型，学不了。')
      return
    }
    note(`读近 ${String(months)} 个月的往来…`)
    const read = await readMail(actor.workspace_id, months)
    const { pairs, skipped } = qaPairsFromMail(read?.mails ?? [], {
      ours: read?.ours ?? new Set(),
      machineSent: read?.machine ?? new Set(),
    })
    const clusters = planHistory(pairs)
    const cost = model.estimate(clusters.length, HISTORY_INPUT_CHARS, OUT_TOKENS)
    job.estimate = {
      source: 'email',
      months,
      pairs: pairs.length,
      calls: clusters.length,
      ...(cost === undefined ? {} : { cost }),
      fits: true,
      connected: true,
      model: true,
    }
    job.progress = { done: 0, total: clusters.length }
    note(
      `拼出 ${String(pairs.length)} 对「客户问 → 我们答」，分成 ${String(clusters.length)} 类` +
        `（跳过：AI 发的 ${String(skipped.machine_sent)}、群发 / 通知 ${String(skipped.bulk)}、没人回的 ${String(skipped.no_reply)}）。`,
    )
    if (clusters.length === 0) {
      finish(job, { state: 'done', note: '往来太少，还归纳不出口径（同一类至少要 3 段往来）' })
      note('往来太少，这一次没学到。')
      return
    }
    const budget = await model.budget().catch(() => undefined)
    if (!fitsBudget(cost, budget)) {
      finish(job, { state: 'over_budget', note: '这个月的模型用量快到上限了' })
      note('这个月的模型用量快到上限了，这一次先不跑。')
      return
    }
    let i = 0
    const result = await learnFromHistory({
      pairs,
      at: clock.now(),
      onProgress: (done, total) => {
        job.progress = { done, total }
      },
      shouldContinue: async () => {
        const b = await model.budget().catch(() => undefined)
        return b === undefined || !b.frozen
      },
      summarize: async (prompt) => {
        i += 1
        const text = await model
          .complete(historyPromptText(prompt), `kl_${job.id}_${String(i)}`)
          .catch((e: unknown) => {
            log(`[knowledge-learn] 归纳一类没成：${e instanceof Error ? e.message : String(e)}`)
            return undefined
          })
        return text === undefined ? undefined : parseHistorySummary(text)
      },
    })
    const byCategory = new Map(result.clusters.map((c) => [c.category, c]))
    await land(
      job,
      actor,
      result.candidates.map((c) => {
        const cluster = byCategory.get(c.category)
        const refs = cluster?.thread_ids.slice(0, 20) ?? []
        return { candidate: c, refs, basis: `${String(cluster?.size ?? refs.length)} 段往来` }
      }),
      work,
    )
    const stopped = result.skipped.some((s) => s.reason === 'stopped')
    finish(job, {
      state: 'done',
      ...(stopped ? { note: '模型用量到上限，后面几类没学' } : {}),
    })
    note(
      job.learned === 0 ? '这一次没学到能用的口径。' : `学到 ${String(job.learned)} 条，待你确认。`,
    )
  }

  const runSite = async (job: KnowledgeLearnJob, actor: LearnActor): Promise<void> => {
    const work = await deps.work(actor.workspace_id)
    const note = (text: string): void => {
      if (job.matter_id !== undefined) work?.note(job.matter_id, text)
    }
    const urls = job.urls ?? []
    if (urls.length === 0) {
      finish(job, { state: 'failed', note: '没有网址：官网或售后网站给一个' })
      note('没有网址：在知识库页或对话里给一个官网 / 售后网站。')
      return
    }
    const reader = await deps.reader(actor.workspace_id)
    if (reader === undefined) {
      finish(job, { state: 'failed', note: '这里读不了网页' })
      note('这里读不了网页。')
      return
    }
    const model = await deps.model(actor)
    if (model === undefined) {
      finish(job, { state: 'no_model', note: '还没接 AI 模型' })
      note('还没接 AI 模型，学不了。')
      return
    }
    const cost = model.estimate(LEARN_SITE_MAX_PAGES, SITE_INPUT_CHARS, OUT_TOKENS)
    if (!fitsBudget(cost, await model.budget().catch(() => undefined))) {
      finish(job, { state: 'over_budget', note: '这个月的模型用量快到上限了' })
      note('这个月的模型用量快到上限了，这一次先不跑。')
      return
    }
    note(`读 ${urls.join('、')}…`)
    let i = 0
    const result = await learnFromSite({
      urls,
      read: reader,
      at: clock.now(),
      maxPages: LEARN_SITE_MAX_PAGES,
      onProgress: (done, total) => {
        job.progress = { done, total }
      },
      shouldContinue: async () => {
        const b = await model.budget().catch(() => undefined)
        return b === undefined || !b.frozen
      },
      extract: async (prompt) => {
        i += 1
        return model.complete(prompt, `kl_${job.id}_${String(i)}`).catch((e: unknown) => {
          log(`[knowledge-learn] 抽一页没成：${e instanceof Error ? e.message : String(e)}`)
          return undefined
        })
      },
    })
    job.estimate = {
      source: 'website',
      urls,
      calls: result.planned.length,
      ...(cost === undefined ? {} : { cost }),
      fits: true,
      model: true,
    }
    // 每一页登记成一个网页源（记内容 hash，每周复查）
    const now = clock.now()
    for (const page of result.pages) {
      const existing = knowledge.intake
        .sources(actor.workspace_id)
        .find((s) => isLearnedSite(s) && s.ref === page.url)
      const source =
        existing ??
        knowledge.intake.addSource({
          workspace_id: actor.workspace_id,
          kind: 'website',
          ref: page.url,
          parser: 'html',
          acl_inherit: false,
        })
      knowledge.intake.markSynced(source.id, page.candidates.length, contentHashOf(page.text))
    }
    await land(
      job,
      actor,
      result.pages.flatMap((p) =>
        p.candidates.map((c) => ({ candidate: c, refs: [p.url], basis: pathOf(p.url) })),
      ),
      work,
    )
    finish(job, { state: 'done' })
    void now
    note(
      `读了 ${String(result.pages.length)} 页。` +
        (job.learned === 0
          ? '这一次没学到能用的问答。'
          : `学到 ${String(job.learned)} 条，待你确认；以后每周复查一次这几页。`),
    )
  }

  const start: KnowledgeLearner['start'] = async (actor, input) => {
    const id = deps.newId('klj')
    const job: KnowledgeLearnJob = {
      id,
      workspace_id: actor.workspace_id,
      source: input.source,
      state: 'running',
      progress: { done: 0, total: 0 },
      learned: 0,
      started_at: clock.now(),
      ...(input.source === 'email'
        ? { months: clampMonths(input.months) }
        : { urls: sitesOf(actor.workspace_id, input.urls) }),
    }
    jobs.set(id, job)
    const work = await deps.work(actor.workspace_id)
    const title =
      input.source === 'email'
        ? `从过往邮件学（近 ${String(job.months)} 个月）`
        : `从网站学（${(job.urls ?? []).map(hostOf).join('、') || '还没给网址'}）`
    const matter_id = work?.open(actor, title)
    if (matter_id !== undefined) job.matter_id = matter_id
    const run = input.source === 'email' ? runEmail(job, actor) : runSite(job, actor)
    void track(
      run.catch((e: unknown) => {
        const message = e instanceof Error ? e.message : String(e)
        finish(job, { state: 'failed', note: clip(message, 120) })
        if (job.matter_id !== undefined) work?.note(job.matter_id, `没学成：${clip(message, 120)}`)
      }),
    )
    return job
  }

  const markApplied = async (item: ApprovalItem, executor: string): Promise<void> => {
    const record = (deps.approvals as Partial<{ recordApply: RecordApply }>).recordApply
    await record?.call(deps.approvals, item.id, 'applied', {
      attempts: [
        { at: clock.now(), by_executor: executor, idempotency_key: item.id, result: 'ok' as const },
      ],
    })
  }

  const onLearnedDecided = async (item: ApprovalItem): Promise<void> => {
    const by = item.decision?.by
    if (by === undefined || item.state === 'applied') return
    const p = item.payload as KnowledgeLearnedPayload
    const still = p.card_ids.filter((id) => knowledge.store.getUnchecked(id)?.status === 'proposed')
    if (APPROVED.has(item.state)) {
      const edited = item.decision?.edited_payload
      const stages: Record<string, KnowledgeStage> = {}
      const drop = new Set<string>()
      if (isRecord(edited)) {
        if (isRecord(edited.stages))
          for (const [id, s] of Object.entries(edited.stages))
            if (isKnowledgeStage(s)) stages[id] = s
        if (Array.isArray(edited.drop))
          for (const id of edited.drop) if (typeof id === 'string') drop.add(id)
      }
      for (const id of still) {
        if (drop.has(id)) {
          await knowledge.store.retire(id, by)
          continue
        }
        const stage = stages[id]
        if (stage !== undefined) await knowledge.store.patch(id, { stage })
        await knowledge.store.activate(id, by)
      }
      await markApplied(item, 'knowledge-learn')
    } else if (item.state === 'rejected')
      for (const id of still) await knowledge.store.retire(id, by)
  }

  const onStaleDecided = async (item: ApprovalItem): Promise<void> => {
    const by = item.decision?.by
    if (by === undefined || item.state === 'applied') return
    const p = item.payload as KnowledgeStalePayload
    const edited = item.decision?.edited_payload
    const picked = isRecord(edited) ? edited.resolution : undefined
    const relearn = item.state !== 'rejected' && picked === 'relearn'
    const resolution = item.state === 'rejected' || relearn ? 'ignore' : 'unchanged'
    const urls = new Set<string>()
    for (const id of p.recheck_ids) {
      const r = knowledge.recheck.get(id)
      if (r === undefined || r.status !== 'open') continue
      await knowledge.recheck.resolve(id, { resolution, by })
      if (!relearn) continue
      // 重学：旧的那条撤下（留痕），这一页重新读一遍出新的待确认
      if (knowledge.store.getUnchecked(r.card_id)?.status !== 'retired')
        await knowledge.store.retire(r.card_id, by)
      const url = p.items.find((x) => x.recheck_id === id)?.url
      if (url !== undefined) urls.add(url)
    }
    if (item.state === 'rejected') return
    await markApplied(item, 'knowledge-learn')
    if (relearn && urls.size > 0)
      await start(
        {
          person_id: by,
          workspace_id: item.workspace_id,
          assignment_id: p.assignment_id ?? '',
          role_id: item.role_id,
        },
        { source: 'website', urls: [...urls] },
      )
  }

  const recheckSites: KnowledgeLearner['recheckSites'] = async (ws, opts = {}) => {
    const reader = await deps.reader(ws)
    if (reader === undefined) return 0
    const nowMs = Date.parse(clock.now())
    const due = knowledge.intake
      .sources(ws)
      .filter(isLearnedSite)
      .filter(
        (s) =>
          opts.force === true ||
          s.last_synced_at === undefined ||
          nowMs - Date.parse(s.last_synced_at) >= SITE_RECHECK_INTERVAL_MS,
      )
    const opened: { recheck_id: string; card_id: string; url: string; change: string }[] = []
    for (const source of due) {
      const page = await reader.page(source.ref).catch(() => undefined)
      if (page === undefined || page.text.trim() === '') continue
      // 只比这一页自己派生出来的卡（出处 ref 精确等于这一页）
      const cards = knowledge.recheck
        .cardsOfSource(ws, source.ref)
        .filter((c) => c.provenance.some((pv) => pv.ref === source.ref))
      const result = await knowledge.recheck.syncSource({ source, content: page.text, cards })
      knowledge.intake.markSynced(source.id, source.chunks, result.plan.content_hash)
      for (const r of result.rechecks) {
        if (r.approval_item_id !== undefined) continue
        const change = [
          r.before.map(describeFactKeyZh).join('、'),
          r.after.map(describeFactKeyZh).join('、'),
        ]
          .filter((x) => x !== '')
          .join(' → ')
        opened.push({ recheck_id: r.id, card_id: r.card_id, url: source.ref, change })
      }
    }
    if (opened.length === 0) return 0
    const actor = opts.actor
    const owner = actor?.person_id ?? knowledge.store.getUnchecked(opened[0]?.card_id ?? '')?.owner
    if (owner === undefined) return opened.length
    const after = `${String(opened.length)} 条可能过期`
    const payload: KnowledgeStalePayload = {
      form: KNOWLEDGE_STALE_FORM,
      recheck_ids: opened.map((o) => o.recheck_id),
      items: opened.slice(0, LEARNED_CARD_ITEMS).map((o) => ({
        ...o,
        statement: clip(knowledge.store.getUnchecked(o.card_id)?.statement ?? '', 200),
      })),
      ...(actor === undefined ? {} : { assignment_id: actor.assignment_id }),
      before: null,
      after,
    }
    const item = await deps.approvals.create<KnowledgeStalePayload>({
      workspace_id: ws,
      schema_version: 1,
      kind: 'knowledge_update',
      role_id: (actor?.role_id ?? 'dtc.support') as RoleId,
      subject: { object: { type: 'policy', id: `knowledge_stale:${opened[0]?.recheck_id ?? ''}` } },
      dedupe_key: `${ws}:knowledge_update:knowledge_stale:${opened.map((o) => o.recheck_id).join(',')}`,
      title: `网站改了，这 ${String(opened.length)} 条可能过期`,
      summary: '没变就确认；变了就按网站重学这几页。',
      payload,
      evidence: {
        source_events: [],
        provenance: {
          seen: opened.slice(0, 20).map((o) => ({ type: 'fact_card' as const, id: o.card_id })),
        },
        diff: { before: null, after, summary: after },
        precheck: { permission_diff: 'ok', semantic_diff: 'ok' },
      },
      proposer: { kind: 'agent', id: 'knowledge-learn' },
      automation: { level_at_creation: 'L1' },
      routing: {
        recipients: [{ person: owner, via: 'role_holder' }],
        rule: 'role_holder',
        escalation: { after_hours: 72, business_hours: true, chain: ['owner'], escalated_at: [] },
        separation_of_duties: false,
      },
      priority: 'queue',
    })
    for (const o of opened) knowledge.recheck.linkApproval(o.recheck_id, item.id)
    return opened.length
  }

  return {
    estimate,
    start,
    job: (id) => jobs.get(id),
    jobs: (ws) =>
      [...jobs.values()]
        .filter((j) => j.workspace_id === ws)
        .sort((a, b) => (a.started_at < b.started_at ? 1 : -1)),
    async onDecided(item) {
      if (isLearnedCard(item)) await track(onLearnedDecided(item))
      else if (isStaleCard(item)) await track(onStaleDecided(item))
    },
    recheckSites,
    async settled() {
      while (inflight.size > 0) await Promise.allSettled([...inflight])
    },
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

function pathOf(url: string): string {
  try {
    const u = new URL(url)
    return `${u.hostname.replace(/^www\./, '')}${u.pathname === '/' ? '' : u.pathname}`
  } catch {
    return url
  }
}

/**
 * WP488（决策 1682）：回复前先判这封 / 这段是售前还是售后——按顺序看几段字（来信 / 线程 / 查询），
 * 第一段判得出的为准；都判不出就不给（两边都取）。回的是可以直接摊进检索入参的一格。
 */
export function retrievalStage(...texts: readonly (string | undefined)[]): {
  stage?: 'presales' | 'postsales'
} {
  for (const t of texts) {
    if (t === undefined || t.trim() === '') continue
    const stage = stageOfText(t)
    if (stage !== undefined) return { stage }
  }
  return {}
}

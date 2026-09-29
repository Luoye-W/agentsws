/**
 * WP172（docs/84）：B2B 库 `/v1/b2b/*` 的**实现**（网关那一层只做装配与校验）。
 *
 * 接起来的三样东西：`b2b-store.ts` 的本机库、变更账本那道门（`ledger.stage`）、
 * `@agentsws/b2b-core` 的判断（报价谁批、CSV 表头别名）。
 *
 * 四条纪律：
 *
 * 1. **写都经卡**。存草稿不算数；提交 = 出一张改动卡（出卡规矩按职责 yml：`stage_b2b_record` /
 *    `stage_b2b_quote` / `stage_b2b_sample` / `stage_b2b_list_import`，报价在 `HARD_L1`）。
 *    这个文件里**只有** {@link B2bServiceAssembly.apply}（执行器在卡批准之后调）会往九类对象里写。
 * 2. **报价谁批由授权四个数算**（`quoteBreaches` → `quoteApprover`）：授权内业务员自己批，
 *    超了转上级，没有上级转老板。服务进程里还没有"部门负责人"这个概念，所以超了就落老板。
 * 3. **联系方式当场进加密库**：草稿里只有 `email_ref`（key 名）+ 遮过的地址 + 地址哈希。
 * 4. **额度与等级从本次那条分配来**（05 §4），查不到按最严的 L1。
 */
import type {
  B2bActor,
  B2bCsvImportInput,
  B2bDetailView,
  B2bDraftInput,
  B2bDraftView,
  B2bImportView,
  B2bPort,
  B2bRow,
  B2bStagedView,
} from '@agentsws/api'
import { ApiError } from '@agentsws/api'
import { parseCustomerCsv, quoteApprover, quoteBreaches, quoteBreachText } from '@agentsws/b2b-core'
import type {
  ApprovalBus,
  AssignmentId,
  B2bAccount,
  B2bCollection,
  B2bContact,
  B2bDraft,
  B2bInquiry,
  B2bList,
  B2bQuote,
  B2bQuoteVersion,
  B2bSample,
  ChangeKind,
  Clock,
  EffectiveConfig,
  EventEnvelope,
  ExportShipment,
  Mandate,
  PersonId,
  Recipient,
  TradeShow,
  TradeShowLead,
  WorkspaceId,
} from '@agentsws/contracts'
import { DEFAULT_B2B_QUOTE_MANDATE } from '@agentsws/contracts'
import type { B2bDeckData } from '@agentsws/deck'
import type { BackendResult, StageInput, StageOutcome } from '@agentsws/txn'
import { addressHash, type B2bStore } from './b2b-store.js'
import { maskAddress } from './mailbox-actions.js'
import { recipientOf, type ScopeManagerRouter } from './supervisor.js'

/** 每类对象提交时出哪一种卡、走职责 yml 里哪一个动作。 */
export const B2B_ACTION_OF: Readonly<Record<B2bCollection, { kind: ChangeKind; action: string }>> =
  {
    b2b_account: { kind: 'b2b_record', action: 'stage_b2b_record' },
    b2b_contact: { kind: 'b2b_record', action: 'stage_b2b_record' },
    b2b_opportunity: { kind: 'b2b_record', action: 'stage_b2b_record' },
    b2b_quote: { kind: 'b2b_quote', action: 'stage_b2b_quote' },
    b2b_sample: { kind: 'b2b_sample', action: 'stage_b2b_sample' },
    b2b_list: { kind: 'b2b_list_import', action: 'stage_b2b_list_import' },
    trade_show: { kind: 'b2b_record', action: 'stage_b2b_record' },
    trade_show_lead: { kind: 'b2b_record', action: 'stage_b2b_record' },
    export_shipment: { kind: 'b2b_record', action: 'stage_b2b_record' },
  }

/** 执行器认得的那几种卡（其余的原样掉回别的施行路）。 */
const APPLIED_KINDS: ReadonlySet<string> = new Set([
  'b2b_record',
  'b2b_quote',
  'b2b_sample',
  'b2b_list_import',
])

const ID_PREFIX: Readonly<Record<B2bCollection, string>> = {
  b2b_account: 'acc',
  b2b_contact: 'ctc',
  b2b_opportunity: 'opp',
  b2b_quote: 'quo',
  b2b_sample: 'smp',
  b2b_list: 'lst',
  trade_show: 'shw',
  trade_show_lead: 'sld',
  export_shipment: 'shp',
}

/** 加密库里联系方式那一格的字段名（同红人库的 `CONTACT_SECRET_FIELD`）。 */
export const B2B_SECRET_FIELD = 'value'

/** 入参里不许调用方自己填的格（服务端说了算）。 */
const SERVER_FIELDS = [
  'id',
  'workspace_id',
  'created_at',
  'updated_at',
  'email_ref',
  'phone_ref',
  'email_masked',
  'email_key_hash',
  'current_version',
] as const

export interface B2bServiceOptions {
  workspace_id: WorkspaceId
  store: B2bStore
  clock: Clock
  random(): number
  approvals?: ApprovalBus
  ledger: { stage(input: StageInput): Promise<StageOutcome> }
  effectiveConfig(id: AssignmentId): EffectiveConfig
  appendEvent(e: Omit<EventEnvelope, 'id' | 'at'> & { at?: string }): void
  /** 本机加密库（邮箱 / 电话明文只进这里）。没开 = 带邮箱的草稿存不了。 */
  secrets?: { put(id: string, fields: Record<string, string>): unknown }
  owner(): Promise<PersonId | undefined>
  /** 这个人所在部门的负责人（报价超授权先转他）。不给 / 回空 = 没有上级，转老板。 */
  scopeManager?(person_id: PersonId): PersonId | undefined
  /**
   * WP174：`scope_manager` 的卡落到谁（岗位上级 → 老板，`./supervisor.ts`）。
   * 给了就以它为准（`scopeManager` 不再看）；服务进程里装的是这一个。
   */
  routeScopeManager?: ScopeManagerRouter
}

export interface B2bServiceAssembly {
  port: B2bPort
  /**
   * 执行器在卡批准之后调（`server.ts` 的 `backendApply`）。不是 B2B 库的卡回 `undefined`，
   * 调用方掉回原来那条路。
   */
  apply(change: { id: string; kind: string; after?: unknown }): BackendResult | undefined
  /** B2B 面板那十九块里能从库里算出来的那几块（没有的是空数组）。 */
  deckData(now: string): B2bDeckData
}

const num = (v: unknown, fallback: number): number => (typeof v === 'number' ? v : fallback)
const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined

/** 一行记录在响应体里的样子（文件头第 3 条：联系方式只出脱敏那一格）。 */
export function b2bRowView(row: Record<string, unknown>, suppressed?: boolean): B2bRow {
  const { email_ref, phone_ref, email_key_hash, _import, ...rest } = row
  return {
    ...(rest as B2bRow),
    ...(email_ref === undefined && row.email_masked === undefined
      ? {}
      : { has_email: email_ref !== undefined }),
    ...(phone_ref === undefined ? {} : { has_phone: true }),
    ...(suppressed === undefined ? {} : { suppressed }),
  }
}

export function createB2bService(options: B2bServiceOptions): B2bServiceAssembly {
  const { workspace_id, store, clock, ledger } = options

  let seq = 0
  const nextId = (prefix: string): string => {
    seq += 1
    const rand = Math.floor(options.random() * 0xffffffff)
      .toString(36)
      .padStart(7, '0')
    return `${prefix}_${rand}${seq.toString(36)}`
  }

  const emit = (type: string, actor: string, payload: Record<string, unknown>): void => {
    options.appendEvent({
      schema_version: 1,
      workspace_id,
      type,
      actor: { kind: 'person', id: actor as never },
      correlation: { trace_id: `tr_b2b_${clock.now()}` },
      payload,
    })
  }

  /** 额度、等级与 yml 的 route_to（文件头第 4 条）。查不到就按最严的一档办。 */
  const actionOf = (
    assignment_id: AssignmentId,
    action: string,
  ): {
    mandate: Mandate
    level: 'L1' | 'L2' | 'L3'
    route_to: 'role_holder' | 'scope_manager' | 'owner'
  } => {
    try {
      const config = options.effectiveConfig(assignment_id)
      const spec = config.actions.find((a) => a.id === action)
      const route = spec?.route_to
      return {
        mandate: spec?.mandate ?? { caps: {} },
        level: config.automation[action]?.level ?? 'L1',
        route_to: typeof route === 'string' ? route : 'role_holder',
      }
    } catch {
      return { mandate: { caps: {} }, level: 'L1', route_to: 'role_holder' }
    }
  }

  /** 联系人 / 线索是不是在抑制名单上（按存着的地址哈希比）。 */
  const isSuppressedRow = (row: Record<string, unknown>): boolean | undefined => {
    const hash = row.email_key_hash
    if (typeof hash !== 'string') return undefined
    return store.suppressions().some((s) => s.key_hash === hash)
  }

  const view = (collection: B2bCollection, row: Record<string, unknown>): B2bRow =>
    b2bRowView(
      row,
      collection === 'b2b_contact' || collection === 'trade_show_lead'
        ? isSuppressedRow(row)
        : undefined,
    )

  const draftView = (d: B2bDraft): B2bDraftView => ({ ...d, record: view(d.collection, d.record) })

  /** 明文邮箱 / 电话当场进加密库，记录里只留 key 名、遮过的地址与哈希。 */
  const stashContact = (record_id: string, input: B2bDraftInput): Record<string, unknown> => {
    if (input.email === undefined && input.phone === undefined) return {}
    const secrets = options.secrets
    if (secrets === undefined)
      throw new ApiError('invalid_input', '本机加密库没开，存不了邮箱 / 电话（明文不落草稿）。')
    const out: Record<string, unknown> = {}
    if (input.email !== undefined) {
      const ref = `b2b.contact.${record_id}.email`
      secrets.put(ref, { [B2B_SECRET_FIELD]: input.email.trim() })
      out.email_ref = ref
      out.email_masked = maskAddress(input.email)
      out.email_key_hash = addressHash(input.email)
    }
    if (input.phone !== undefined) {
      const ref = `b2b.contact.${record_id}.phone`
      secrets.put(ref, { [B2B_SECRET_FIELD]: input.phone.trim() })
      out.phone_ref = ref
    }
    return out
  }

  /** 报价这一版：金额按行算（折扣之后），版本号 = 现在那一版 + 1。 */
  const quoteVersionOf = (
    actor: B2bActor,
    quote_id: string,
    current: number,
    input: NonNullable<B2bDraftInput['quote_version']>,
  ): B2bQuoteVersion => {
    const gross = input.lines.reduce((n, l) => n + l.qty * l.unit_price_usd, 0)
    const amount = Math.round(gross * (1 - input.discount_pct / 100) * 100) / 100
    return {
      quote_id,
      version: current + 1,
      lines: input.lines.map((l) => ({ ...l })),
      amount_usd: amount,
      margin_pct: input.margin_pct,
      discount_pct: input.discount_pct,
      payment_terms_days: input.payment_terms_days,
      incoterm: input.incoterm,
      valid_until: input.valid_until,
      created_at: clock.now(),
      created_by: actor.person_id,
      // WP182：报价单上的条款（地点、阶梯价、付款方式那一句、这一版改了什么）
      ...(input.incoterm_place === undefined ? {} : { incoterm_place: input.incoterm_place }),
      ...(input.tiers === undefined ? {} : { tiers: input.tiers.map((t) => ({ ...t })) }),
      ...(input.payment_method === undefined ? {} : { payment_method: input.payment_method }),
      ...(input.change_note === undefined ? {} : { change_note: input.change_note }),
    }
  }

  const saveDraft = (
    actor: B2bActor,
    collection: B2bCollection,
    input: B2bDraftInput,
  ): { draft: B2bDraftView } => {
    const now = clock.now()
    const prior = input.draft_id === undefined ? undefined : store.draft(input.draft_id)
    if (input.draft_id !== undefined && (prior === undefined || prior.collection !== collection))
      throw new ApiError('not_found', `没有这份草稿：${input.draft_id}`)
    if (prior !== undefined && prior.status === 'submitted')
      throw new ApiError('conflict', '这份草稿已经提成卡了，等卡批完再改（改就是另起一份）。')
    if (prior !== undefined && prior.status === 'applied')
      throw new ApiError('conflict', '这份草稿已经生效了。要再改请另起一份。')
    const record_id = prior?.record_id ?? input.record_id ?? nextId(ID_PREFIX[collection])
    const existing = store.get<Record<string, unknown>>(collection, record_id)
    if (input.record_id !== undefined && existing === undefined && prior === undefined)
      throw new ApiError('not_found', `库里没有这条记录：${record_id}`)
    const fields: Record<string, unknown> = { ...input.record }
    for (const k of SERVER_FIELDS) delete fields[k]
    const record: Record<string, unknown> = {
      ...(existing ?? {}),
      ...(prior?.record ?? {}),
      ...fields,
      ...stashContact(record_id, input),
      id: record_id,
      workspace_id,
      created_at: (existing?.created_at as string | undefined) ?? now,
      updated_at: now,
    }
    let quote_version: B2bQuoteVersion | undefined = prior?.quote_version
    if (collection === 'b2b_quote') {
      const qv = input.quote_version
      if (qv === undefined && quote_version === undefined)
        throw new ApiError('invalid_input', '报价要带这一版的几个数（quote_version）。')
      const current = num(existing?.current_version, 0)
      if (qv !== undefined) quote_version = quoteVersionOf(actor, record_id, current, qv)
      record.current_version = current + 1
      record.number =
        str(record.number) ??
        `Q-${now.slice(0, 10).replaceAll('-', '')}-${String(store.list('b2b_quote').length + 1).padStart(2, '0')}`
      record.status = 'pending_approval'
    }
    const draft: B2bDraft = {
      id: prior?.id ?? nextId('b2d'),
      workspace_id,
      collection,
      op: existing === undefined ? 'create' : 'update',
      record_id,
      record,
      ...(quote_version === undefined ? {} : { quote_version }),
      status: 'draft',
      created_by: actor.person_id,
      created_at: prior?.created_at ?? now,
      updated_at: now,
    }
    store.saveDraft(draft)
    emit('b2b.draft_saved', actor.person_id, { collection, op: draft.op, draft_id: draft.id })
    return { draft: draftView(draft) }
  }

  /** 草稿 → 改动卡的 `after`（guardrail 认的那几格摆在顶层）。 */
  const afterOf = (d: B2bDraft, extra: Record<string, unknown> = {}): Record<string, unknown> => {
    const base: Record<string, unknown> = {
      collection: d.collection,
      op: d.op,
      draft_id: d.id,
      record: d.record,
      ...extra,
    }
    if (d.collection === 'b2b_quote' && d.quote_version !== undefined) {
      const v = d.quote_version
      return {
        ...base,
        quote_version: v,
        version: v.version,
        amount_usd: v.amount_usd,
        margin_pct: v.margin_pct,
        discount_pct: v.discount_pct,
        payment_terms_days: v.payment_terms_days,
      }
    }
    if (d.collection === 'b2b_sample')
      return { ...base, status: d.record.status, tracking_no: d.record.tracking_no }
    if (d.collection === 'b2b_list') return { ...base, tier: d.record.tier ?? 'own' }
    return base
  }

  const titleOf = (d: B2bDraft): string => {
    const name =
      str(d.record.name) ?? str(d.record.po_number) ?? str(d.record.number) ?? d.record_id
    const verb = d.op === 'create' ? '新建' : '修改'
    switch (d.collection) {
      case 'b2b_quote':
        return `报价 ${String(d.record.number)} V${String(d.quote_version?.version ?? '?')}：${String(d.quote_version?.amount_usd ?? '?')} 美元`
      case 'b2b_list':
        return `导入名单「${name}」`
      case 'b2b_sample':
        return `样品：${name}`
      default:
        return `${verb}${COLLECTION_ZH[d.collection]}：${name}`
    }
  }

  /** 提一张卡（草稿与 CSV 导入共用这一段）。 */
  const stage = async (
    actor: B2bActor,
    d: B2bDraft,
    extra: Record<string, unknown> = {},
  ): Promise<B2bStagedView> => {
    const { kind, action } = B2B_ACTION_OF[d.collection]
    const { mandate, level, route_to } = actionOf(actor.assignment_id, action)
    const after = afterOf(d, extra)
    const existing = store.get<Record<string, unknown>>(d.collection, d.record_id)

    // 谁批：报价按授权四个数算（docs/84 §11.1 第 3 条）；别的动作照 yml 的 route_to
    let approver: 'role_holder' | 'scope_manager' | 'owner' = route_to
    let breaches: string[] = []
    const manager = options.scopeManager?.(actor.person_id)
    if (kind === 'b2b_quote') {
      const caps = mandate.caps as Record<string, unknown>
      breaches = quoteBreaches(after as never, {
        max_amount_usd: num(caps.max_amount_usd, DEFAULT_B2B_QUOTE_MANDATE.max_amount_usd),
        min_margin_pct: num(caps.min_margin_pct, DEFAULT_B2B_QUOTE_MANDATE.min_margin_pct),
        max_discount_pct: num(caps.max_discount_pct, DEFAULT_B2B_QUOTE_MANDATE.max_discount_pct),
        max_payment_terms_days: num(
          caps.max_payment_terms_days,
          DEFAULT_B2B_QUOTE_MANDATE.max_payment_terms_days,
        ),
      })
      // 有路由口：超了就先当「转上级」，真落到谁（上级 / 老板）由路由口说了算
      approver = quoteApprover(
        breaches,
        options.routeScopeManager !== undefined || manager !== undefined,
      )
    }
    const owner = (await options.owner()) ?? actor.person_id
    let recipient: Recipient
    if (approver === 'scope_manager' && options.routeScopeManager !== undefined) {
      recipient = recipientOf(
        await options.routeScopeManager({
          workspace_id,
          role_id: actor.role_id,
          proposer: actor.person_id,
        }),
      )
      approver = recipient.via === 'owner' ? 'owner' : 'scope_manager'
    } else {
      const person: PersonId =
        approver === 'role_holder'
          ? actor.person_id
          : approver === 'scope_manager'
            ? (manager ?? owner)
            : owner
      recipient = { person, via: approver }
    }
    const title = titleOf(d)
    const summary =
      kind === 'b2b_quote'
        ? breaches.length === 0
          ? '在授权内，业务员自己批（报价永远出卡）'
          : `超了授权（${quoteBreachText(breaches)}），转${approver === 'owner' ? '老板' : '上级'}批`
        : d.op === 'create'
          ? '新建一条记录，批了才进 B2B 库'
          : '改一条记录，批了才生效（原样见「改之前」）'
    const run_id = `run_b2b_${nextId('r')}`
    const outcome = await ledger.stage({
      workspace_id,
      role_id: actor.role_id,
      assignment_id: actor.assignment_id,
      run_id,
      change_set_id: `cs_${run_id}`,
      kind,
      target: { type: d.collection, id: d.record_id },
      before:
        kind === 'b2b_quote' && existing !== undefined
          ? { version: existing.current_version }
          : (existing ?? {}),
      after,
      notes: [summary],
      created_by: { kind: 'person', id: actor.person_id },
      mandate,
      level,
      provenance: {
        run_id,
        seen: { [d.collection]: [d.record_id] },
        read_full: [d.record_id],
        recorded_at: clock.now(),
      },
      approval: {
        title,
        summary,
        recipients: [recipient],
        proposer: { kind: 'person', id: actor.person_id, assignment_id: actor.assignment_id },
        rule: approver,
        // 业务员批自己那张（授权内的报价）不算"一人既提又批"：卡是它自己起草、自己点头的日常
        separation_of_duties: false,
        source_events: [],
      },
    })
    const quoteInfo = kind === 'b2b_quote' ? { approver, breaches } : {}
    if (!outcome.ok) {
      store.saveDraft({
        ...d,
        status: 'blocked',
        message: outcome.message,
        updated_at: clock.now(),
      })
      emit('b2b.draft_blocked', actor.person_id, {
        collection: d.collection,
        draft_id: d.id,
        rules: (outcome.guardrail?.hits ?? []).map((h) => h.rule),
      })
      return { staged: false, draft_id: d.id, message: outcome.message, level, ...quoteInfo }
    }
    store.saveDraft({
      ...d,
      status: 'submitted',
      change_id: outcome.change.id,
      approval_item_id: outcome.approval.id,
      // WP182：面板「报价待审」读真落到的那一档，不再按默认授权重算
      ...(kind === 'b2b_quote' ? { approver, breaches } : {}),
      updated_at: clock.now(),
    })
    emit('b2b.draft_submitted', actor.person_id, {
      collection: d.collection,
      kind,
      draft_id: d.id,
      change_id: outcome.change.id,
      approver,
    })
    return {
      staged: true,
      draft_id: d.id,
      change_id: outcome.change.id,
      approval_item_id: outcome.approval.id,
      level: outcome.approval.automation.level_at_creation,
      ...quoteInfo,
    }
  }

  const submitDraft = async (
    actor: B2bActor,
    collection: B2bCollection,
    draft_id: string,
  ): Promise<B2bStagedView> => {
    const d = store.draft(draft_id)
    if (d === undefined || d.collection !== collection)
      throw new ApiError('not_found', `没有这份草稿：${draft_id}`)
    if (d.status === 'submitted' || d.status === 'applied')
      throw new ApiError('conflict', '这份草稿已经提过了。')
    return stage(actor, d)
  }

  /**
   * 导入一张名单（docs/84 §1.2：**导入本身出卡**）。解析用 `b2b-core` 的中英文表头别名；
   * 解析出来的客户与联系人跟着这张卡走，批了才进库。邮箱当场进加密库。
   */
  const importCsv = async (actor: B2bActor, input: B2bCsvImportInput): Promise<B2bImportView> => {
    let rows: ReturnType<typeof parseCustomerCsv>
    try {
      rows = parseCustomerCsv(input.csv)
    } catch (e) {
      const code = e instanceof Error ? e.message : String(e)
      throw new ApiError(
        'invalid_input',
        code === 'CSV_HEADER_REQUIRED'
          ? '表格第一行要是表头（公司 / 邮箱这类列名）。'
          : '表格里至少要有「公司」或「邮箱」其中一列。',
        { details: { code } },
      )
    }
    const now = clock.now()
    const list_id = nextId(ID_PREFIX.b2b_list)
    const source = {
      kind: input.source_kind ?? 'import',
      ...(input.source_url === undefined ? {} : { url: input.source_url }),
      observed_at: now,
      list_id,
    } as const
    const known = store.list<B2bAccount>('b2b_account')
    const accounts = new Map<string, Record<string, unknown>>()
    const contacts: Record<string, unknown>[] = []
    let suppressed = 0
    for (const row of rows) {
      const domain = row.domain?.toLowerCase() ?? row.email?.split('@')[1]
      const key = (domain ?? row.company).toLowerCase()
      const found =
        known.find((a) => domain !== undefined && a.domain?.toLowerCase() === domain) ??
        known.find((a) => a.name.toLowerCase() === row.company.toLowerCase())
      // 库里已有的客户只借它的 id（不跟着这张卡再写一遍，免得盖掉别的卡改过的那一版）
      let account: Record<string, unknown> | undefined =
        accounts.get(key) ?? (found === undefined ? undefined : { id: found.id })
      if (account === undefined) {
        account = {
          id: nextId(ID_PREFIX.b2b_account),
          workspace_id,
          name: row.company,
          ...(row.domain === undefined ? {} : { domain: row.domain.toLowerCase() }),
          ...(row.country === undefined ? {} : { country: row.country.toUpperCase().slice(0, 2) }),
          product_lines: [],
          stage: 'contacted',
          source,
          created_at: now,
          updated_at: now,
        }
        accounts.set(key, account)
      }
      if (row.email === undefined && row.contact_name === undefined) continue
      const contact_id = nextId(ID_PREFIX.b2b_contact)
      if (row.email !== undefined && store.isSuppressed(row.email)) suppressed += 1
      contacts.push({
        id: contact_id,
        workspace_id,
        account_id: account.id,
        name: row.contact_name ?? row.email?.split('@')[0] ?? row.company,
        ...(row.title === undefined ? {} : { title: row.title }),
        ...stashContact(contact_id, {
          record: {},
          ...(row.email === undefined ? {} : { email: row.email }),
          ...(row.phone === undefined ? {} : { phone: row.phone }),
        }),
        source,
        created_at: now,
      })
    }
    const list: B2bList = {
      id: list_id,
      workspace_id,
      name: input.name,
      tier: 'own',
      source,
      contact_count: contacts.length,
      imported_at: now,
    }
    const draft: B2bDraft = {
      id: nextId('b2d'),
      workspace_id,
      collection: 'b2b_list',
      op: 'create',
      record_id: list_id,
      record: { ...list, _import: { accounts: [...accounts.values()], contacts } },
      status: 'draft',
      created_by: actor.person_id,
      created_at: now,
      updated_at: now,
    }
    store.saveDraft(draft)
    const staged = await stage(actor, draft, {
      count: contacts.length,
      accounts: accounts.size,
      contacts_missing_source: 0,
    })
    return { ...staged, list_id, rows: rows.length, suppressed }
  }

  const port: B2bPort = {
    list: (_actor, collection) => ({
      rows: store.list<Record<string, unknown>>(collection).map((r) => view(collection, r)),
      drafts: store
        .drafts({ collection })
        .filter((d) => d.status !== 'applied')
        .map(draftView),
    }),
    get: (_actor, collection, id): B2bDetailView => {
      const row = store.get<Record<string, unknown>>(collection, id)
      if (row === undefined) throw new ApiError('not_found', `库里没有这条记录：${id}`)
      return {
        row: view(collection, row),
        ...(collection === 'b2b_quote' ? { versions: store.quoteVersions(id) } : {}),
      }
    },
    saveDraft,
    submitDraft,
    importCsv,
    inquiries: () => ({ rows: store.inquiries() }),
    suppressions: () => ({ rows: store.suppressions() }),
  }

  /** 执行器在卡批准之后调：把那一份草稿落进库里（文件头第 1 条：九类对象只有这里写）。 */
  const apply = (change: {
    id: string
    kind: string
    after?: unknown
  }): BackendResult | undefined => {
    if (!APPLIED_KINDS.has(change.kind)) return undefined
    const after =
      change.after !== null && typeof change.after === 'object'
        ? (change.after as Record<string, unknown>)
        : undefined
    const collection = after?.collection as B2bCollection | undefined
    const record = after?.record as Record<string, unknown> | undefined
    if (collection === undefined || record === undefined || typeof record.id !== 'string')
      return undefined
    const now = clock.now()
    try {
      const { _import, ...row } = record as { _import?: unknown } & Record<string, unknown>
      if (collection === 'b2b_quote') {
        const v = after?.quote_version as B2bQuoteVersion | undefined
        if (v !== undefined) store.addQuoteVersion(v)
      }
      if (collection === 'b2b_list' && _import !== undefined) {
        const imp = _import as {
          accounts: Record<string, unknown>[]
          contacts: Record<string, unknown>[]
        }
        for (const a of imp.accounts) store.put('b2b_account', a as { id: string })
        for (const c of imp.contacts) {
          store.put('b2b_contact', c as { id: string })
          if (typeof c.email_key_hash === 'string')
            store.indexContactEmail(c.email_key_hash, c.id as string)
        }
      }
      store.put(collection, { ...(row as { id: string }), updated_at: now })
      if (
        (collection === 'b2b_contact' || collection === 'trade_show_lead') &&
        typeof row.email_key_hash === 'string'
      )
        store.indexContactEmail(row.email_key_hash, row.id as string)
      const draft_id = after?.draft_id
      const d = typeof draft_id === 'string' ? store.draft(draft_id) : undefined
      if (d !== undefined) store.saveDraft({ ...d, status: 'applied', updated_at: now })
      emit('b2b.record_applied', 'system', {
        collection,
        kind: change.kind,
        change_id: change.id,
        record_id: row.id,
      })
      return {
        status: 'ok',
        execution_id: `b2b_${change.id}`,
        outcome_ref: { type: collection, id: row.id as string },
      }
    } catch (e) {
      // 报价版本撞号（不可改）之类：确定没写进去，不重试
      return {
        status: 'failed',
        error: { message: e instanceof Error ? e.message : String(e), retryable: false },
      }
    }
  }

  return { port, apply, deckData: (now) => b2bDeckFromStore(store, now) }
}

const COLLECTION_ZH: Readonly<Record<B2bCollection, string>> = {
  b2b_account: '客户',
  b2b_contact: '联系人',
  b2b_opportunity: '商机',
  b2b_quote: '报价',
  b2b_sample: '样品',
  b2b_list: '名单',
  trade_show: '展会',
  trade_show_lead: '展会线索',
  export_shipment: '出运单',
}

const DAY = 86_400_000
const dayOf = (iso: string | undefined): string => (iso ?? '').slice(0, 10)

/**
 * 面板那十九块里**库里算得出来的**那几块（WP171 的骨架在真工作区里第一次有数）。
 *
 * 开发序列（今天待发 / 漏斗）与平台运营（待优化产品 / RFQ）是后面几单的事，这里给空数组 = 空态。
 */
export function b2bDeckFromStore(store: B2bStore, now: string): B2bDeckData {
  const accounts = store.list<B2bAccount>('b2b_account')
  const nameOf = (id: string | undefined, fallback: string): string =>
    accounts.find((a) => a.id === id)?.name ?? fallback
  const inquiries = store.inquiries()
  const open = inquiries.filter((i) => i.status === 'new')
  const sourceOf = (i: B2bInquiry): B2bDeckData['inquiries'][number]['source'] =>
    i.platform !== undefined ? 'marketplace' : i.basis === 'our_thread' ? 'outbound_reply' : 'email'
  const shows = store.list<TradeShow>('trade_show')
  const showName = (id: string): string => shows.find((s) => s.id === id)?.name ?? id
  const shipments = store.list<ExportShipment>('export_shipment')
  const quoteDrafts = store.drafts({ collection: 'b2b_quote', status: 'submitted' })
  return {
    inquiries: open
      .filter((i) => i.platform === undefined)
      .map((i) => ({
        account: nameOf(i.account_id, i.from_domain),
        subject: i.subject,
        source: sourceOf(i),
        received_at: i.received_at,
        ...(i.commitments.length === 0 ? {} : { commitments: i.commitments }),
      })),
    quotes_pending: quoteDrafts.flatMap((d) => {
      const v = d.quote_version
      if (v === undefined) return []
      // WP182：提交时记下了真落到哪一档就用它（按职责 yml 的授权算的、经过上级路由的）
      const breaches = d.breaches ?? quoteBreaches(v as never)
      return [
        {
          number: String(d.record.number ?? d.record_id),
          account: nameOf(d.record.account_id as string | undefined, '—'),
          version: v.version,
          amount_usd: v.amount_usd,
          margin_pct: v.margin_pct,
          approver: d.approver ?? quoteApprover(breaches, false),
          breaches,
        },
      ]
    }),
    samples: store
      .list<B2bSample>('b2b_sample')
      .filter((s) => s.status !== 'feedback')
      .map((s) => ({
        account: nameOf(s.account_id, s.account_id),
        items: s.items.map((i) => `${i.sku} ×${i.qty}`).join('、'),
        status: s.status,
        due: dayOf(s.status === 'to_ship' ? s.ship_by : (s.feedback_by ?? s.ship_by)),
        ...(s.tracking_no === undefined ? {} : { tracking_no: s.tracking_no }),
      })),
    dormant: accounts.flatMap((a) => {
      if (a.last_contact_at === undefined) return []
      const days = Math.floor((Date.parse(now) - Date.parse(a.last_contact_at)) / DAY)
      return days >= 180
        ? [{ account: a.name, last_contact_at: dayOf(a.last_contact_at), days }]
        : []
    }),
    outreach_today: [],
    sequence_funnel: [],
    replies: inquiries
      .filter((i) => i.basis === 'our_thread' && i.status === 'new')
      .map((i) => ({
        account: nameOf(i.account_id, i.from_domain),
        category: '待分',
        received_at: i.received_at,
      })),
    lists: store.list<B2bList>('b2b_list').map((l) => ({
      name: l.name,
      tier: l.tier,
      count: l.contact_count,
      imported_at: dayOf(l.imported_at),
    })),
    shows: shows
      .filter((s) => s.status !== 'done' && s.status !== 'skipped')
      .map((s) => ({
        name: s.name,
        city: s.city,
        starts_on: dayOf(s.starts_on),
        status: SHOW_STATUS_ZH[s.status],
        ...(s.booth === undefined ? {} : { booth: s.booth }),
      })),
    deadlines: shows.flatMap((s) =>
      s.registration_deadline === undefined || s.status !== 'considering'
        ? []
        : [{ show: s.name, what: '报名截止', due: dayOf(s.registration_deadline) }],
    ),
    show_leads: store.list<TradeShowLead>('trade_show_lead').map((l) => ({
      show: showName(l.show_id),
      name: l.name,
      company: l.company,
      intent: l.intent,
      note: l.note,
    })),
    followups: store
      .list<TradeShowLead>('trade_show_lead')
      .filter((l) => l.status === 'new')
      .map((l) => ({
        show: showName(l.show_id),
        company: l.company,
        follow_up_by: dayOf(l.follow_up_by),
        status: l.status,
      })),
    in_production: shipments
      .filter((s) => s.status === 'in_production')
      .map((s) => ({
        po: s.po_number,
        account: nameOf(s.account_id, s.account_id),
        etd: dayOf(s.etd),
        status: '生产中',
      })),
    to_ship: shipments
      .filter((s) => s.status === 'ready' || s.status === 'booked')
      .map((s) => ({
        po: s.po_number,
        account: nameOf(s.account_id, s.account_id),
        etd: dayOf(s.etd),
        booked: s.status === 'booked',
      })),
    docs_to_check: shipments.flatMap((s) =>
      s.docs
        .filter((d) => d.status !== 'sent')
        .map((d) => ({
          po: s.po_number,
          doc: d.kind,
          status: d.status,
          discrepancies: d.discrepancies?.length ?? 0,
        })),
    ),
    balance_due: shipments.flatMap((s) =>
      s.payment.balance_received || s.payment.balance_usd === undefined
        ? []
        : [
            {
              po: s.po_number,
              account: nameOf(s.account_id, s.account_id),
              balance_usd: s.payment.balance_usd,
              due: dayOf(s.payment.lc_presentation_by ?? s.eta),
            },
          ],
    ),
    marketplace_inquiries: open.flatMap((i) =>
      i.platform === undefined
        ? []
        : [
            {
              platform: i.platform,
              buyer: i.from_domain,
              subject: i.subject,
              received_at: i.received_at,
            },
          ],
    ),
    listings_to_improve: [],
    rfqs: [],
  }
}

const SHOW_STATUS_ZH: Readonly<Record<TradeShow['status'], string>> = {
  considering: '考虑中',
  registered: '已报名',
  preparing: '筹备中',
  on_site: '在展会上',
  done: '已结束',
  skipped: '不去了',
}

export type { B2bContact, B2bQuote }

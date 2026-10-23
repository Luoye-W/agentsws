/**
 * WP322（docs/102 §5.4，决策 670）：**FAQ 表导入**——带副作用的那一半（认列、读行、去重、成卡的
 * 纯函数在 `packages/knowledge/src/faq-import.ts`）。
 *
 * 一条路：
 *
 * 1. 知识库收了一份 xlsx / xls / csv（`uploadSource`）→ 后台读一遍：每张表按常见列名认列，
 *    认不出才问 AI；一张问答表都没有就什么都不做（它只是一份普通表格）；
 * 2. 认出来了 → 和库里已有的 FAQ 卡按「问题」比 → 出**一张**「定规矩」卡给传的人
 *    （`policy_change` + `form: 'faq_import'`）：映射、一两行预览、新 / 改 / 没变 / 表里没了各几条。
 *    什么都没变就不出卡；
 * 3. 人点「记下」→ 服务端按卡上的映射**重读原件**，一行一张卡（`proposed`，出处 = 文件 › 表 › 行）：
 *    - ① ② 没有审批流：当场生效（人自己点的，docs/95 §5）；答案变了的新卡顶掉旧卡；
 *    - ③ 有审批流：点的人就是负责人 → 同上；不是 → 卡留在 `proposed`，给负责人出**一张**「改东西」卡
 *      （`knowledge_update` + `form: 'faq_batch'`），通过 = 整批生效，不要 = 整批作废；
 *    「只加新的」= 答案变了的那几条不动；「不用」= 什么都不做。
 * 4. 表里删掉的行**不自动删卡**：卡上一行提示；只有删行、别的都没变时，卡上给「撤下 / 留着」。
 *
 * 读原件、问模型、出卡都由调用方注入（`server.ts` 装配）；这里不碰网络、不看系统时钟。
 */
import type {
  ApprovalBus,
  ApprovalItem,
  Clock,
  CreateApprovalInput,
  FactCard,
  FaqBatchPayload,
  FaqImportOption,
  FaqImportPayload,
  FaqSheetMapping,
  KnowledgeSource,
  KnowledgeStage,
  PersonId,
  RoleId,
  WorkspaceId,
} from '@agentsws/contracts'
import { FAQ_SUBJECT_TYPE } from '@agentsws/contracts'
import {
  type CardRow,
  existingFaqOf,
  extractFaqRows,
  type FaqImportPlan,
  type FaqRow,
  faqCard,
  faqMappingPrompt,
  type Knowledge,
  parseFaqMapping,
  planFaqImport,
  readSpreadsheet,
  rowToCard,
  ruleMapping,
  type SheetFormat,
  type SheetGrid,
} from '@agentsws/knowledge'

export const FAQ_IMPORT_FORM = 'faq_import'
export const FAQ_BATCH_FORM = 'faq_batch'

/** 认表这一步最多读多大的原件（再大就不是一张问答表了；上传那道 64 MB 闸是给别的文档的）。 */
export const FAQ_IMPORT_MAX_BYTES = 8 * 1024 * 1024

/** 谁在导：传文件的那个人（网关身份里的四格）。 */
export interface FaqActor {
  person_id: PersonId
  workspace_id: WorkspaceId
  assignment_id: string
  role_id: string
}

export interface FaqImportDeps {
  clock: Clock
  knowledge: Knowledge
  approvals: ApprovalBus
  /** 按源拿原件字节（拿不到回 `undefined`）。 */
  readSource(source: KnowledgeSource): Promise<Uint8Array | undefined>
  /** ③ 公司模式才有审批流（`hasApprovalFlow(mode)`）。 */
  approvalFlow(workspace_id: WorkspaceId): Promise<boolean>
  /** ③ 时整批卡发给谁（知识的负责人 = 工作区所有者）。 */
  approverOf(workspace_id: WorkspaceId): Promise<PersonId | undefined>
  /**
   * WP488（决策 1700 = B）：整表一次问 AI 每一行归公共 / 售前 / 售后（与入参同序）。
   * 问不成（没接模型 / 出错 / 撞网关上限）回 `undefined`——那就按规则判。
   */
  stages?(
    actor: { workspace_id: WorkspaceId },
    items: readonly string[],
  ): Promise<KnowledgeStage[] | undefined>
  /** AI 认列：给提示词回一段字；没接模型 / 出错回 `undefined`（只按规则认）。 */
  mapper?(actor: FaqActor, prompt: string): Promise<string | undefined>
}

const FORMAT: Readonly<Record<string, SheetFormat>> = { xlsx: 'xlsx', xls: 'xls', csv: 'csv' }

/** 这份源是不是表格（按文件名的扩展名）。 */
export function sheetFormatOf(source: Pick<KnowledgeSource, 'filename'>): SheetFormat | undefined {
  const name = source.filename ?? ''
  const dot = name.lastIndexOf('.')
  return dot < 0 ? undefined : FORMAT[name.slice(dot + 1).toLowerCase()]
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** 这张是不是「按问答导入」那张定规矩卡。 */
export function isFaqImportCard(item: Pick<ApprovalItem, 'kind' | 'payload'>): boolean {
  return (
    item.kind === 'policy_change' && isRecord(item.payload) && item.payload.form === FAQ_IMPORT_FORM
  )
}

/** 这张是不是 ③ 给负责人的那张整批卡。 */
export function isFaqBatchCard(item: Pick<ApprovalItem, 'kind' | 'payload'>): boolean {
  return (
    item.kind === 'knowledge_update' &&
    isRecord(item.payload) &&
    item.payload.form === FAQ_BATCH_FORM
  )
}

/** 库里这个工作区的 FAQ 卡（不过可见性：比对是系统动作，没有"谁看得见"可言）。 */
export function faqCardsOf(knowledge: Knowledge, workspace_id: WorkspaceId): FactCard[] {
  const rows = knowledge.db
    .prepare(
      "SELECT * FROM fact_cards WHERE workspace_id = ? AND subject_type = ? AND status != 'retired' ORDER BY created_at, id",
    )
    .all(workspace_id, FAQ_SUBJECT_TYPE) as CardRow[]
  return rows.map(rowToCard)
}

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}…` : s)

/** 读出来的表 + 认出来的映射（一张问答表都没有就是 `undefined`）。 */
interface Analysis {
  grids: SheetGrid[]
  mappings: FaqSheetMapping[]
}

/** 按映射把每张表的行读出来（工作表顺序）。 */
function rowsOf(analysis: Analysis): { rows: FaqRow[]; skipped: number } {
  const rows: FaqRow[] = []
  let skipped = 0
  for (const m of analysis.mappings) {
    const grid = analysis.grids.find((g) => g.name === m.sheet)
    if (grid === undefined) continue
    const out = extractFaqRows(grid, m)
    rows.push(...out.rows)
    skipped += out.skipped
  }
  return { rows, skipped }
}

/**
 * 人在卡上改过映射（`approve_edited` 带 `edited_payload.sheets`）就用改过的——
 * 但要验：工作表真有、行号在表里、问题与答案各一列且不是同一列。验不过就用卡上原来那份。
 */
function editedSheets(edited: unknown, grids: readonly SheetGrid[]): FaqSheetMapping[] | undefined {
  if (!isRecord(edited) || !Array.isArray(edited.sheets)) return undefined
  const out: FaqSheetMapping[] = []
  for (const raw of edited.sheets) {
    if (!isRecord(raw) || !Array.isArray(raw.columns)) return undefined
    const grid = grids.find((g) => g.name === raw.sheet)
    const header_row = Number(raw.header_row)
    if (grid === undefined || !Number.isInteger(header_row) || header_row < 1) return undefined
    if (header_row > grid.rows.length) return undefined
    const columns = raw.columns.filter(
      (c): c is FaqSheetMapping['columns'][number] =>
        isRecord(c) && typeof c.field === 'string' && Number.isInteger(c.col) && Number(c.col) >= 0,
    )
    const q = columns.filter((c) => c.field === 'question')
    const a = columns.filter((c) => c.field === 'answer')
    if (q.length !== 1 || a.length !== 1 || q[0]?.col === a[0]?.col) return undefined
    out.push({ sheet: grid.name, header_row, columns, rows: 0, by: 'rules' })
  }
  return out.length === 0 ? undefined : out
}

const APPROVED = new Set(['approved', 'approved_edited', 'applying', 'applied'])

type RecordApply = (
  id: string,
  state: 'applying' | 'applied' | 'apply_failed',
  apply: ApprovalItem['apply'],
) => Promise<void>

export interface FaqImporter {
  /** 认一份上传的表；认出来了出卡（回那张卡），没认出 / 没变化回 `undefined`。 */
  detect(
    actor: FaqActor,
    source: KnowledgeSource,
    bytes?: Uint8Array,
  ): Promise<ApprovalItem | undefined>
  /** 上传那条路上用：放到后台认（不拖慢上传），出错吞掉（上传本身已经成了）。 */
  schedule(actor: FaqActor, source: KnowledgeSource, bytes?: Uint8Array): void
  /** 后台那几次认完了没有（测试与收尾用）。 */
  settled(): Promise<void>
  /** 定规矩卡 / 整批卡被决定了。 */
  onDecided(item: ApprovalItem): Promise<void>
}

export function createFaqImporter(deps: FaqImportDeps): FaqImporter {
  const { knowledge, clock } = deps
  const inflight = new Set<Promise<unknown>>()

  const analyse = async (
    actor: FaqActor,
    source: KnowledgeSource,
    bytes: Uint8Array,
  ): Promise<Analysis | undefined> => {
    const format = sheetFormatOf(source)
    if (format === undefined || bytes.length === 0 || bytes.length > FAQ_IMPORT_MAX_BYTES)
      return undefined
    let grids: SheetGrid[]
    try {
      grids = readSpreadsheet(format, bytes)
    } catch {
      return undefined
    }
    const mappings: FaqSheetMapping[] = []
    const unknown: SheetGrid[] = []
    for (const g of grids) {
      const m = ruleMapping(g)
      if (m !== undefined && m.rows > 0) mappings.push(m)
      else if (g.rows.filter((r) => r.some((c) => c.trim() !== '')).length >= 2) unknown.push(g)
    }
    if (unknown.length > 0 && deps.mapper !== undefined) {
      const text = await deps
        .mapper(actor, faqMappingPrompt(unknown.slice(0, 10)))
        .catch(() => undefined)
      if (text !== undefined) mappings.push(...parseFaqMapping(text, unknown))
    }
    const order = (m: FaqSheetMapping) => grids.findIndex((g) => g.name === m.sheet)
    mappings.sort((a, b) => order(a) - order(b))
    return mappings.length === 0 ? undefined : { grids, mappings }
  }

  const planOf = (ws: WorkspaceId, rows: readonly FaqRow[], filename: string): FaqImportPlan =>
    planFaqImport(
      rows,
      faqCardsOf(knowledge, ws).flatMap((c) => {
        const e = existingFaqOf(c)
        return e === undefined ? [] : [e]
      }),
      filename,
    )

  const detect: FaqImporter['detect'] = async (actor, source, given) => {
    if (source.deleted_at !== undefined || sheetFormatOf(source) === undefined) return undefined
    const bytes = given ?? (await deps.readSource(source))
    if (bytes === undefined) return undefined
    const analysis = await analyse(actor, source, bytes)
    if (analysis === undefined) return undefined
    const filename = source.filename ?? source.id
    const { rows, skipped } = rowsOf(analysis)
    const plan = planOf(actor.workspace_id, rows, filename)
    const counts = {
      new: plan.fresh.length,
      changed: plan.changed.length,
      same: plan.same.length,
      removed: plan.removed.length,
      skipped,
    }
    const adds = counts.new + counts.changed
    if (adds === 0 && counts.removed === 0) return undefined
    const flow = await deps.approvalFlow(actor.workspace_id)
    const approver = await deps.approverOf(actor.workspace_id)
    const viaApprover = flow && approver !== undefined && approver !== actor.person_id
    const options: FaqImportPayload['options'] =
      adds === 0
        ? [
            { id: 'retire', label: '撤下' },
            { id: 'skip', label: '留着' },
          ]
        : [
            { id: 'all', label: '记下' },
            ...(counts.changed > 0 && counts.new > 0
              ? [{ id: 'new_only' as FaqImportOption, label: '只加新的' }]
              : []),
            { id: 'skip', label: '不用' },
          ]
    const payload: FaqImportPayload = {
      form: FAQ_IMPORT_FORM,
      source_id: source.id,
      filename,
      sheets: analysis.mappings,
      counts,
      // 预览只给新的；答案变了的那几条在 `changes` 里（问题 + 改前改后），不重复
      preview: plan.fresh
        .slice(0, 2)
        .map((r) => ({ question: clip(r.question, 120), answer: clip(r.answer, 200) })),
      changes: plan.changed.slice(0, 2).map((c) => ({
        question: clip(c.row.question, 120),
        before: clip(c.replaces.answer, 200),
        after: clip(c.row.answer, 200),
      })),
      removed: plan.removed.slice(0, 3).map((e) => clip(e.question, 120)),
      options,
    }
    const title =
      adds === 0
        ? `「${clip(filename, 40)}」里删了 ${counts.removed} 条问答`
        : `「${clip(filename, 40)}」导入 ${adds} 条问答`
    // 界面少字：标题说了导什么，这一句只说点了之后怎样
    const summary =
      adds === 0
        ? '知识库里的还在，没动。'
        : viaApprover
          ? '记下后交负责人批。'
          : '记下后当场生效，知识库里能改、能删。'
    const input: CreateApprovalInput<FaqImportPayload> = {
      workspace_id: actor.workspace_id,
      schema_version: 1,
      kind: 'policy_change',
      role_id: actor.role_id as RoleId,
      subject: { object: { type: 'policy', id: `faq_import:${source.id}` } },
      // 同一份原件同一时刻只挂一张：没定之前再传一次不重复出卡
      dedupe_key: `${actor.workspace_id}:policy_change:faq_import:${source.id}`,
      title,
      summary,
      payload,
      evidence: {
        source_events: [],
        provenance: { seen: [{ type: 'policy', id: `faq_import:${source.id}` }] },
        diff: { before: null, after: title, summary: title },
        precheck: { permission_diff: 'ok', semantic_diff: 'ok' },
      },
      proposer: {
        kind: 'person',
        id: actor.person_id,
        assignment_id: actor.assignment_id as never,
      },
      // 导入本身不改任何东西：改不改由人在卡上点
      automation: { level_at_creation: 'L1' },
      routing: {
        recipients: [{ person: actor.person_id, via: 'role_holder' }],
        rule: 'role_holder',
        escalation: { after_hours: 72, business_hours: true, chain: ['owner'], escalated_at: [] },
        separation_of_duties: false,
      },
      priority: 'queue',
    }
    return deps.approvals.create(input)
  }

  /** 卡上 `conflicts` 里指着已经处理掉的那张的条目去掉（双值并存已经由人定了）。 */
  const dropConflicts = async (id: string, gone: ReadonlySet<string>): Promise<void> => {
    const card = knowledge.store.getUnchecked(id)
    if (card?.conflicts === undefined) return
    const left = card.conflicts.filter((c) => !gone.has(c.with))
    if (left.length !== card.conflicts.length) await knowledge.store.patch(id, { conflicts: left })
  }

  /** 生效：新卡激活；答案变了的旧卡退役（留痕，不删）。 */
  const settle = async (
    card_ids: readonly string[],
    replaces: Readonly<Record<string, string>>,
    by: PersonId,
  ): Promise<number> => {
    let activated = 0
    for (const id of card_ids) {
      const card = knowledge.store.getUnchecked(id)
      if (card === undefined || card.status !== 'proposed') continue
      await knowledge.store.activate(id, by)
      activated += 1
      const old = replaces[id]
      if (old === undefined) continue
      if (knowledge.store.getUnchecked(old)?.status !== 'retired')
        await knowledge.store.retire(old, by)
      await dropConflicts(id, new Set([old]))
    }
    return activated
  }

  /** 作废（③ 负责人点了「不要」）：新卡退役，旧卡上那条冲突记录清掉。 */
  const discard = async (
    card_ids: readonly string[],
    replaces: Readonly<Record<string, string>>,
    by: PersonId,
  ): Promise<void> => {
    for (const id of card_ids) {
      const card = knowledge.store.getUnchecked(id)
      if (card === undefined || card.status !== 'proposed') continue
      await knowledge.store.retire(id, by)
      const old = replaces[id]
      if (old !== undefined) await dropConflicts(old, new Set([id]))
    }
  }

  const markApplied = async (item: ApprovalItem): Promise<void> => {
    const record = (deps.approvals as Partial<{ recordApply: RecordApply }>).recordApply
    await record?.call(deps.approvals, item.id, 'applied', {
      attempts: [
        {
          at: clock.now(),
          by_executor: 'faq-import',
          idempotency_key: item.id,
          result: 'ok' as const,
        },
      ],
    })
  }

  /** ③：给负责人的那张整批「改东西」卡。 */
  const batchCard = async (
    item: ApprovalItem<FaqImportPayload>,
    created: { id: string; row: FaqRow; replaces?: string }[],
    approver: PersonId,
  ): Promise<ApprovalItem> => {
    const p = item.payload
    const replaces: Record<string, string> = {}
    for (const c of created) if (c.replaces !== undefined) replaces[c.id] = c.replaces
    const counts = {
      new: created.length - Object.keys(replaces).length,
      changed: Object.keys(replaces).length,
    }
    const after = [
      counts.new > 0 ? `新 ${counts.new} 条` : '',
      counts.changed > 0 ? `改 ${counts.changed} 条` : '',
    ]
      .filter((x) => x !== '')
      .join(' · ')
    const payload: FaqBatchPayload = {
      form: FAQ_BATCH_FORM,
      source_id: p.source_id,
      filename: p.filename,
      card_ids: created.map((c) => c.id),
      replaces,
      counts,
      preview: created
        .slice(0, 2)
        .map((c) => ({ question: clip(c.row.question, 120), answer: clip(c.row.answer, 200) })),
      before: null,
      after,
    }
    return deps.approvals.create<FaqBatchPayload>({
      workspace_id: item.workspace_id,
      schema_version: 1,
      kind: 'knowledge_update',
      role_id: item.role_id,
      subject: { object: { type: 'policy', id: `faq_import:${p.source_id}` } },
      dedupe_key: `${item.workspace_id}:knowledge_update:faq_batch:${item.id}`,
      title: `「${clip(p.filename, 40)}」里的 ${created.length} 条问答`,
      summary: '通过后生效；答案变了的顶掉旧的。',
      payload,
      evidence: {
        source_events: [],
        provenance: {
          seen: created.slice(0, 20).map((c) => ({ type: 'fact_card' as const, id: c.id })),
        },
        diff: { before: null, after, summary: after },
        precheck: { permission_diff: 'ok', semantic_diff: 'ok' },
      },
      proposer: { kind: 'person', id: item.decision?.by ?? item.proposer.id },
      automation: { level_at_creation: 'L1' },
      routing: {
        recipients: [{ person: approver, via: 'owner' }],
        rule: 'owner',
        escalation: { after_hours: 72, business_hours: true, chain: ['owner'], escalated_at: [] },
        separation_of_duties: false,
      },
      priority: 'queue',
      links: { parent: item.id },
    })
  }

  /** 定规矩卡被点了。 */
  const onImportDecided = async (item: ApprovalItem<FaqImportPayload>): Promise<void> => {
    if (!APPROVED.has(item.state) || item.state === 'applied') return
    const by = item.decision?.by
    if (by === undefined) return
    const edited = item.decision?.edited_payload
    const picked = (item.decision?.selected_option_id ??
      (isRecord(edited) ? edited.selected_option_id : undefined)) as FaqImportOption | undefined
    if (picked === undefined || picked === 'skip') return
    const p = item.payload
    const source = knowledge.intake.getSource(p.source_id)
    if (source === undefined || source.deleted_at !== undefined) return
    const bytes = await deps.readSource(source)
    const format = sheetFormatOf(source)
    if (bytes === undefined || format === undefined) return
    const grids = readSpreadsheet(format, bytes)
    const analysis: Analysis = { grids, mappings: editedSheets(edited, grids) ?? p.sheets }
    const plan = planOf(item.workspace_id, rowsOf(analysis).rows, p.filename)

    if (picked === 'retire') {
      for (const e of plan.removed) await knowledge.store.retire(e.id, by)
      await markApplied(item)
      return
    }
    const approver = await deps.approverOf(item.workspace_id)
    const ctx = {
      workspace_id: item.workspace_id,
      owner: approver ?? by,
      by,
      at: clock.now(),
      source_ref: source.ref,
      filename: p.filename,
    }
    const todo: { row: FaqRow; replaces?: string }[] = [
      ...plan.fresh.map((row) => ({ row })),
      ...(picked === 'new_only'
        ? []
        : plan.changed.map((c) => ({ row: c.row, replaces: c.replaces.id }))),
    ]
    const created: { id: string; row: FaqRow; replaces?: string }[] = []
    // WP488（决策 1700 = B）：整表一次问 AI 每一行归哪一份；问不成按规则
    const stages = await deps
      .stages?.(
        { workspace_id: item.workspace_id },
        todo.map((t) => `Q: ${t.row.question}\nA: ${t.row.answer}`),
      )
      .catch(() => undefined)
    for (const [i, t] of todo.entries()) {
      const card = await knowledge.store.propose(faqCard(t.row, ctx, stages?.[i]))
      created.push({ id: card.id, ...t })
    }
    const flow = await deps.approvalFlow(item.workspace_id)
    if (flow && approver !== undefined && approver !== by && created.length > 0) {
      await batchCard(item, created, approver)
    } else {
      const replaces: Record<string, string> = {}
      for (const c of created) if (c.replaces !== undefined) replaces[c.id] = c.replaces
      await settle(
        created.map((c) => c.id),
        replaces,
        by,
      )
    }
    await markApplied(item)
  }

  /** ③ 负责人点了整批卡。 */
  const onBatchDecided = async (item: ApprovalItem<FaqBatchPayload>): Promise<void> => {
    const by = item.decision?.by
    if (by === undefined || item.state === 'applied') return
    const p = item.payload
    if (APPROVED.has(item.state)) {
      await settle(p.card_ids, p.replaces, by)
      await markApplied(item)
    } else if (item.state === 'rejected') await discard(p.card_ids, p.replaces, by)
  }

  const track = <T>(p: Promise<T>): Promise<T> => {
    inflight.add(p)
    void p.finally(() => inflight.delete(p)).catch(() => undefined)
    return p
  }

  return {
    detect,
    schedule(actor, source, bytes) {
      if (sheetFormatOf(source) === undefined) return
      void track(detect(actor, source, bytes)).catch(() => undefined)
    },
    async settled() {
      while (inflight.size > 0) await Promise.allSettled([...inflight])
    },
    async onDecided(item) {
      if (isFaqImportCard(item))
        await track(onImportDecided(item as ApprovalItem<FaqImportPayload>))
      else if (isFaqBatchCard(item))
        await track(onBatchDecided(item as ApprovalItem<FaqBatchPayload>))
    },
  }
}

/**
 * WP76（58）：把**设计岗位**接进模拟世界。
 *
 * 与 `positions` / `secretary` / `chat` 一样是**惰性**的：场景里没有 `design.*`
 * 事件就一个都不装，原有场景的事件序列与指标一个字节不变。
 *
 * 四条纪律，每条都由**真机制**兑现，不是这条模块自己写的答案：
 *
 * 1. **需求单从别的岗位来，岗位路由挑那条设计职责**。判据一个字都不在这里，
 *    全在 `@agentsws/roles` 的 `routeWithinPosition`（与服务进程、与秘书、
 *    与 `positions.ts` 是同一份）——所以"下了一张要横版 Banner 的单，
 *    它落到独立站设计"这件事，是意图词真判出来的。
 * 2. **brief 是 `design-core` 的纯函数出的**（`draftBrief`）。整理不出来的
 *    那几件事原样进卡面，不编默认值。
 * 3. **入库永远人审**由 guardrail 的 `HARD_L1` 按回来（场景故意报 L3），
 *    而且 `picked_by` 缺了就直接 block——那不是"要不要人批"，是这张卡
 *    本身不该存在。
 * 4. **没有图片模型就明说**（58 §1）。场景里 `image_model: false` 时
 *    一张图都不出，但 brief、尺寸与变体计划照样有——那句话原样进卡面，
 *    不是一句"生成失败"。
 */
import type {
  Mandate,
  ObjectRef,
  PersonId,
  ProvenanceState,
  RoleId,
  RunRequest,
  RunUsage,
} from '@agentsws/contracts'
import { designDutyForSource, designDutySpec } from '@agentsws/contracts'
import type { BrandSystemCard, DraftBriefResult } from '@agentsws/design-core'
import {
  brandSystemMissingCard,
  briefSummaryZh,
  draftBrief,
  planGeneration,
  resolveBrandSystem,
  resolveSpec,
  specNoteZh,
} from '@agentsws/design-core'
import { loadBundledPosition, roleRouteTerms, routeWithinPosition } from '@agentsws/roles'
import { SimulationError } from './errors.js'
import type { World } from './world.js'

/** 设计岗位的模板 id（`packages/roles/positions/design.yml`）。**只有这一处拼它**。 */
const DESIGN_POSITION = 'design'

export interface DesignRequestRecord {
  request_id: string
  /** 谁下的（来源职责）。 */
  from_role_id: RoleId
  /** 岗位路由**真判到**的那条设计职责。拿不准就没有它（不猜）。 */
  routed_to?: RoleId
  /** 路由拿不准（候选分不开）——这时出的是一张选择卡，不是一条 brief。 */
  ambiguous: boolean
  /** 下单那一条 `design_request` 提上去了没有。 */
  request_staged: boolean
  /** brief 出了没有（L3 自动）。 */
  brief_id?: string
  /** brief 整理不出来的那几件事（原样进卡面，**不编默认值**）。 */
  questions: string[]
  /** 用的是哪一份品牌系统、为什么。 */
  brand_note: string
  /** 一份都没有 = 出「先设品牌系统」卡（58 §3 第四张）。 */
  brand_system_missing: boolean
  brief_auto_approved: boolean
  brief_level?: string
}

export interface DesignVariantRecord {
  brief_id: string
  /** 这次真打算出几张（额度截断之后的数）。 */
  n: number
  /** 真出出来几张（没有图片模型时是 0）。 */
  generated: number
  image_model: boolean
  /** 没有图片模型时那句人话（`available` 为真时是空串）。 */
  reason: string
  /** 额度这一侧的话（与 guardrail 判的是同一个数）。 */
  quota_notes: string[]
  staged: boolean
  auto_approved: boolean
  level?: string
  /** 被 guardrail 拦下来的原因（禁忌词命中就是它）。 */
  blocked_reason?: string
  asset_ids: string[]
}

export interface DesignPickRecord {
  asset_id: string
  /** **人**点的那一下（服务端按请求人盖；Agent 填不了）。 */
  picked_by: PersonId
  staged: boolean
  /** 永远为假——`asset_publish` 在 `HARD_L1` 里。 */
  auto_approved: boolean
  level?: string
  blocked_reason?: string
}

export interface DesignLoop {
  /** 别的岗位下一张需求单 → 路由到设计岗 → brief 自动出（L3）。 */
  request(input: {
    who: PersonId
    /** 谁下的（来源职责 id）。 */
    from: RoleId
    title: string
    /** 需求原文（**外部文本**，原样存、原样进 brief 的整理）。 */
    need: string
    specs?: string[]
  }): Promise<DesignRequestRecord>
  /** 出变体（`design_variant`，L2 出卡给人挑）。 */
  variants(input: {
    who: PersonId
    brief_id: string
    n?: number
    /** 这台机器上有没有图片模型。`false` = 只出 brief 与规格，并**明说**。 */
    image_model?: boolean
    level?: 'L1' | 'L2' | 'L3'
  }): Promise<DesignVariantRecord>
  /** 人挑了一张 → 出定稿入库卡（`asset_publish`，**L1 硬顶**）。 */
  pick(input: {
    who: PersonId
    asset_id: string
    /** 故意报高的那一格：`HARD_L1` 会把它按回人审。 */
    level?: 'L1' | 'L2' | 'L3'
    /** 故意不写"谁点的"——guardrail 会直接 block（那张卡本身不该存在）。 */
    without_pick?: boolean
  }): Promise<DesignPickRecord>
  requests: DesignRequestRecord[]
  variantRuns: DesignVariantRecord[]
  picks: DesignPickRecord[]
}

export function installDesign(world: World): DesignLoop {
  const requests: DesignRequestRecord[] = []
  const variantRuns: DesignVariantRecord[] = []
  const picks: DesignPickRecord[] = []

  let seq = 0
  const nextId = (prefix: string): string => {
    seq += 1
    return `${prefix}_${seq}`
  }

  /** 这一轮里出过的 brief 与素材（世界里没有设计库，那是服务进程那一侧的东西）。 */
  const briefs = new Map<string, { result: DraftBriefResult; who: PersonId; role_id: RoleId }>()
  const assets = new Map<string, { brief_id: string; spec_id: string; role_id: RoleId }>()

  const activeOf = (who: PersonId) =>
    world.roles.assignments
      .listByPerson(who, { workspace_id: world.workspace_id })
      .filter((a) => a.revoked_at === undefined)

  const assignmentFor = (who: PersonId, role_id: RoleId) => {
    const found = activeOf(who).find((a) => a.role_id === role_id)
    if (found === undefined)
      throw new SimulationError('invalid_input', `${who} 名下没有 ${role_id} 这条分配`)
    return found
  }

  const actionOf = (assignment_id: string, id: string): { mandate: Mandate; level: string } => {
    const config = world.roles.effectiveConfig(assignment_id)
    return {
      mandate: config.actions.find((a) => a.id === id)?.mandate ?? { caps: {} },
      level: config.automation[id]?.level ?? 'L1',
    }
  }

  /**
   * 一次设计动作 = 一次运行，而且它要**真的记成一条 `RunRecord`**。
   *
   * 不是记账好看：`provenance_respected` 那条不变量拿 `run_id` 回头查"这次运行
   * 到底读过什么"（`invariants.ts` 读的是 `evidence.runs`）。只在 staged change
   * 上挂一份 provenance 而不留运行记录，那条不变量会——正确地——判它违规：
   * 一条查不到出处的 provenance 与没有 provenance 是一回事。
   */
  const recordRun = (
    asg: { id: string; person_id: PersonId; role_id: RoleId },
    run_id: string,
    seen: ObjectRef[],
    summary: string,
  ): ProvenanceState => {
    const provenance: ProvenanceState = {
      run_id,
      seen: seen.reduce<Record<string, string[]>>((acc, ref) => {
        acc[ref.type] = [...new Set([...(acc[ref.type] ?? []), ref.id])]
        return acc
      }, {}),
      // 15 §6：读全了才算数
      read_full: seen.map((r) => `${r.type}:${r.id}`),
      recorded_at: world.clock.now(),
    }
    const at = world.clock.now()
    const request: RunRequest = {
      id: run_id,
      schema_version: 1,
      workspace_id: world.workspace_id,
      kind: 'work_item',
      actor: { person_id: asg.person_id, assignment_id: asg.id, role_id: asg.role_id },
      // 人在工作台上按的那一下就是触发源：没有入站信件，也没有定时器
      trigger: { event_id: `manual_${run_id}`, source: 'manual' },
      context: [],
      grounding: world.effective.grounding,
      // 16 §3：写口只在执行器手里，这次运行拿不到；设计这几步一个工具都不调
      tools: { allow: [], connect_token: '', side_effect_policy: 'executor' },
      skills: [],
      persona: { sections: [] },
      budget: { max_tokens: 60_000, max_tool_calls: 0, max_seconds: 120, max_cost_base: 5 },
      expectations: { outputs: ['staged_change'], must_stage_if_change_requested: true },
      runtime: {
        preset: asg.role_id,
        profile: 'simulation',
        plugins: [],
        model: world.modelRef,
      },
      idempotency_key: `idem_${run_id}`,
    }
    const usage: RunUsage = {
      input_tokens: 0,
      output_tokens: 0,
      cached_tokens: 0,
      tool_calls: 0,
      seconds: 0,
      cost_base: 0,
    }
    world.shopRuns.push({
      request,
      started_at: at,
      finished_at: at,
      status: 'completed',
      events: [],
      result: {
        request_id: run_id,
        status: 'completed',
        outputs: [],
        provenance,
        memory_candidates: [],
        lessons: [],
        usage,
        session_ref: { runtime: 'design-op', session_id: run_id },
        summary,
      },
    })
    return provenance
  }

  /**
   * 品牌系统从 **pack 自带的技能**取（24：公司层技能）。
   *
   * 3 人 pack 里有一张 `brand-system`，15 人 pack 里没有——所以
   * `design/brand-system-missing-card` 那条题不是靠场景开一个开关，
   * 是那家公司真的没设过。
   */
  const brandCards = (): BrandSystemCard[] => {
    const doc = world.pack.skills.find((s) => s.name === 'brand-system')
    return doc === undefined ? [] : [{ name: doc.name, scope: 'org', body: doc.markdown }]
  }

  /** 设计岗位下这个人持有的那几条职责（路由在它们之间挑）。 */
  const designRolesOf = (who: PersonId) => {
    const template = loadBundledPosition(DESIGN_POSITION)
    return activeOf(who).filter((a) => template.roles.some((r) => r.role === a.role_id))
  }

  const stageOne = async (input: {
    assignment_id: string
    role_id: RoleId
    action: string
    kind: 'design_request' | 'design_brief' | 'design_variant' | 'asset_publish'
    target: ObjectRef
    before: unknown
    after: unknown
    notes: string[]
    title: string
    summary: string
    level?: 'L1' | 'L2' | 'L3'
  }) => {
    const run_id = nextId('run_design')
    const { mandate, level } = actionOf(input.assignment_id, input.action)
    const asg = world.roles.assignments.get(input.assignment_id)
    const provenance = recordRun(
      asg ?? { id: input.assignment_id, person_id: world.roleHolder, role_id: input.role_id },
      run_id,
      [input.target],
      input.title,
    )
    return world.txn.ledger.stage({
      workspace_id: world.workspace_id,
      role_id: input.role_id,
      assignment_id: input.assignment_id,
      run_id,
      change_set_id: `cs_${run_id}`,
      kind: input.kind,
      target: input.target,
      before: input.before,
      after: input.after,
      notes: input.notes,
      created_by: { kind: 'agent', id: `agent_${input.role_id}` },
      mandate,
      // 15 §2 hard_ceiling：报 L3 也会被按回人审
      level: (input.level ?? level) as 'L1' | 'L2' | 'L3',
      provenance,
      approval: {
        title: input.title,
        summary: input.summary,
        recipients: [{ person: world.roleHolder, via: 'role_holder' as const }],
        proposer: {
          kind: 'agent' as const,
          id: `agent_${input.role_id}`,
          assignment_id: input.assignment_id,
        },
        rule: 'role_holder' as const,
        separation_of_duties: false,
        source_events: [],
      },
    })
  }

  const request: DesignLoop['request'] = async ({ who, from, title, need, specs }) => {
    const source = assignmentFor(who, from)
    const request_id = nextId('dreq')
    const target: ObjectRef = { type: 'design_request', id: request_id }

    /*
     * ① 下单那一条（`design_request`，L3）。**从来源职责的那条分配提**——
     * 权限、额度、等级全是它的（05 §4 不并集）。
     */
    const staged = await stageOne({
      assignment_id: source.id,
      role_id: source.role_id,
      action: 'request_design',
      kind: 'design_request',
      target,
      before: {},
      after: { title, need, from_role_id: from },
      notes: ['开一件事并按 54 路由到设计岗。'],
      title: `给设计岗下一张单：${title}`,
      summary: need.slice(0, 120),
    })

    /*
     * ② 岗位路由：在**设计岗这个人持有的那几条职责之间**判。
     *
     * 判据一个字都不在这里（`routeWithinPosition`，与服务进程同一份）。
     * 拿不准就不猜——那时候界面上出的是一张选择卡，而不是一条落错地方的单。
     * 先按来源职责查一次（契约的 `designDutyForSource`）：它是"网站运营下的单
     * 归独立站设计"这条对应关系的真源，路由拿不准时按它兜底。
     */
    const held = designRolesOf(who)
    const profiles = held
      .map((a) => {
        const def = world.roles.roles.get(a.role_id)
        return def === undefined
          ? undefined
          : {
              role_id: def.id,
              role_name: def.name.zh,
              terms: roleRouteTerms(def),
              positions: [{ position_id: a.id, person_id: who }],
            }
      })
      .filter((p): p is NonNullable<typeof p> => p !== undefined)
    const verdict = routeWithinPosition(`${title} ${need}`, profiles)
    const fallback = designDutyForSource(from)?.role_id
    const pickedRole = verdict.picked ?? fallback
    const picked = held.find((a) => a.role_id === pickedRole)

    const record: DesignRequestRecord = {
      request_id,
      from_role_id: from,
      ambiguous: verdict.ambiguous && fallback === undefined,
      request_staged: staged.ok,
      questions: [],
      brand_note: '',
      brand_system_missing: false,
      brief_auto_approved: false,
      ...(picked === undefined ? {} : { routed_to: picked.role_id }),
    }
    world.appendEvent('simulation.design_request_routed', {
      request_id,
      from_role_id: from,
      ...(picked === undefined ? {} : { role_id: picked.role_id }),
      ambiguous: record.ambiguous,
      candidates: verdict.candidates.length,
    })
    if (picked === undefined) {
      requests.push(record)
      return record
    }

    /*
     * ③ brief（`design_brief`，**L3 自动**）。整理那一跳是 `design-core` 的
     * 纯函数，这里只给 id、给时间、提卡。
     */
    const duty = designDutySpec(picked.role_id.replace(/^design\./, ''))?.id
    if (duty === undefined) throw new SimulationError('invalid_input', `不是设计职责：${picked.role_id}`)
    const cards = brandCards()
    const result = draftBrief({
      request: {
        id: request_id,
        workspace_id: world.workspace_id,
        duty,
        from_role_id: from,
        title,
        need,
        spec_ids: specs ?? [],
        status: 'queued',
        created_at: world.clock.now(),
      },
      brand_cards: cards,
      id: nextId('dbrief'),
      at: world.clock.now(),
    })
    briefs.set(result.brief.id, { result, who, role_id: picked.role_id })

    const briefTarget: ObjectRef = { type: 'design_brief', id: result.brief.id }
    const briefStaged = await stageOne({
      assignment_id: picked.id,
      role_id: picked.role_id,
      action: 'draft_brief',
      kind: 'design_brief',
      target: briefTarget,
      before: {},
      after: {
        request_id,
        brief_id: result.brief.id,
        spec_ids: result.brief.spec_ids,
        must_avoid: result.brief.must_avoid,
      },
      notes: result.questions.slice(),
      title: `brief：${title}`,
      summary: briefSummaryZh(result),
    })

    record.brief_id = result.brief.id
    record.questions = result.questions.slice()
    record.brand_note = result.brand.note
    record.brand_system_missing = result.brand.system === undefined
    if (briefStaged.ok) {
      record.brief_auto_approved = briefStaged.approval.automation.auto_approved
      record.brief_level = briefStaged.approval.automation.level_at_creation
    }
    world.appendEvent('simulation.design_brief_drafted', {
      request_id,
      brief_id: result.brief.id,
      role_id: picked.role_id,
      questions: result.questions.length,
      // 58 §3 第四张卡：一份品牌系统都没有的时候出它（**不挡路**，但把代价说清楚）
      brand_system_missing: record.brand_system_missing,
      ...(record.brand_system_missing ? { card: brandSystemMissingCard().kind } : {}),
    })
    requests.push(record)
    return record
  }

  const variants: DesignLoop['variants'] = async ({ who, brief_id, n, image_model, level }) => {
    const entry = briefs.get(brief_id)
    if (entry === undefined) throw new SimulationError('not_found', `没有这份 brief：${brief_id}`)
    const asg = assignmentFor(who, entry.role_id)
    const available = image_model !== false
    const brand = resolveBrandSystem(brandCards(), entry.result.brief.duty)
    const plan = planGeneration({
      brief: entry.result.brief,
      brand,
      ...(n === undefined
        ? {}
        : {
            only_plan_item_ids: entry.result.brief.variant_plan
              .slice(0, n)
              .map((item) => item.id),
          }),
    })

    const asset_ids: string[] = []
    if (available) {
      for (const prompt of plan.prompts) {
        const id = nextId('dasset')
        assets.set(id, { brief_id, spec_id: prompt.spec_id, role_id: entry.role_id })
        asset_ids.push(id)
      }
    }

    /** 58 §1：没有图片模型时那句**人话**（不是"生成失败"）。 */
    const reason = available
      ? ''
      : '现在没有接图片模型：默认的 DeepSeek 不出图。brief、尺寸规格和变体计划照样出，只是不出图。'

    const staged = await stageOne({
      assignment_id: asg.id,
      role_id: asg.role_id,
      action: 'generate_variants',
      kind: 'design_variant',
      target: { type: 'design_brief', id: brief_id },
      before: {},
      after: {
        brief_id,
        n: plan.n,
        prompts: plan.prompts.map((one) => one.prompt),
        must_avoid: entry.result.brief.must_avoid,
        ...(available ? {} : { no_image_model_reason: reason }),
      },
      notes: [...plan.quota_notes, ...(available ? [] : [reason])],
      title: `挑一张：${designDutySpec(entry.result.brief.duty)?.zh ?? entry.result.brief.duty}`,
      summary: available ? `一共 ${plan.n} 张。就这张 / 都不行再来。` : reason,
      ...(level === undefined ? {} : { level }),
    })

    const record: DesignVariantRecord = {
      brief_id,
      n: plan.n,
      generated: asset_ids.length,
      image_model: available,
      reason,
      quota_notes: plan.quota_notes.slice(),
      staged: staged.ok,
      auto_approved: staged.ok ? staged.approval.automation.auto_approved : false,
      ...(staged.ok ? { level: staged.approval.automation.level_at_creation } : {}),
      ...(staged.ok ? {} : { blocked_reason: staged.message }),
      asset_ids,
    }
    world.appendEvent('simulation.design_variants_staged', {
      brief_id,
      n: plan.n,
      generated: asset_ids.length,
      image_model: available,
      ...(available ? {} : { reason }),
      staged: staged.ok,
    })
    variantRuns.push(record)
    return record
  }

  const pick: DesignLoop['pick'] = async ({ who, asset_id, level, without_pick }) => {
    const asset = assets.get(asset_id)
    if (asset === undefined) throw new SimulationError('not_found', `没有这张素材：${asset_id}`)
    const asg = assignmentFor(who, asset.role_id)
    const spec = resolveSpec(asset.spec_id)
    const staged = await stageOne({
      assignment_id: asg.id,
      role_id: asg.role_id,
      action: 'stage_asset',
      kind: 'asset_publish',
      target: { type: 'design_asset', id: asset_id },
      before: { status: 'variant' },
      after: {
        asset_id,
        spec_id: asset.spec_id,
        // 04 §6：**人**点的那一下。不写它 guardrail 会直接 block
        ...(without_pick === true ? {} : { picked_by: who, picked_at: world.clock.now() }),
      },
      notes: [
        '入库之后下游（上架 / 发布 / 投放 / 送印）直接拿它去用，所以这一下永远要人点。',
        ...(spec === undefined ? [] : [specNoteZh(spec)]),
      ],
      title: `定稿入库：${spec?.zh ?? asset.spec_id}`,
      summary: '入素材库并回给需求方。',
      ...(level === undefined ? {} : { level }),
    })
    const record: DesignPickRecord = {
      asset_id,
      picked_by: who,
      staged: staged.ok,
      auto_approved: staged.ok ? staged.approval.automation.auto_approved : false,
      ...(staged.ok ? { level: staged.approval.automation.level_at_creation } : {}),
      ...(staged.ok ? {} : { blocked_reason: staged.message }),
    }
    world.appendEvent('simulation.design_asset_picked', {
      asset_id,
      staged: staged.ok,
      auto_approved: record.auto_approved,
      ...(staged.ok ? {} : { reason: staged.message }),
    })
    picks.push(record)
    return record
  }

  return { request, variants, pick, requests, variantRuns, picks }
}

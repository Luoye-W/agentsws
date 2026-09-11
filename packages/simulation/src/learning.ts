/**
 * 学习回路在模拟回路里的那一份（WP29；24 §3、06 §3.4）。
 *
 * 与 `apps/server/src/learning.ts` 的分工和 `routine.ts` 一样：判定都在
 * `@agentsws/learning`，两边只是各自的接线——包不该依赖应用，所以模拟回路
 * 不 import 服务进程，只 import 同一个判定包。**不写第二套判定。**
 *
 * 装不装是场景说了算（`learning.start` 事件）：不装的世界一条 lesson 都不收、
 * 一个技能段都不进 prompt，原有九条场景的 prompt 字节与指标一个不变。
 */
import type { ApprovalItem, Iso8601, PromptSection } from '@agentsws/contracts'
import {
  applyLessonDecision,
  draftProposals,
  extractLessons,
  type FilteredProposal,
  LearningPool,
  type LessonProposalCard,
  type PooledLesson,
  skillPromptSections,
  skillReaderOf,
} from '@agentsws/learning'
import { createSkills, type Skills } from '@agentsws/skills'
import type { World } from './world.js'

/** 与 `apps/server/src/schedule.ts` 同名，报告与事件才对得上。 */
export const LEARNING_HANDLER = 'skills.daily_lessons'

export interface LearningOptions {
  /** 每天几点出「昨天学到的」（本地时区）；缺省 07:30 的那个 7。 */
  proposeHour?: number
  proposeMinute?: number
}

export interface LearningLoop {
  skills: Skills
  pool: LearningPool
  /** 已经建出来的提案卡（按建卡顺序）。 */
  proposals: ApprovalItem[]
  /** 最近一次夜间整理被拦下的那些（场景断言 `rejected_before` 用）。 */
  filtered: FilteredProposal[]
  /** 一张卡被决定之后：抽 lesson 入池 / 技能类卡施行。 */
  onDecided(item: ApprovalItem, input: { selected_option_id?: string }): Promise<void>
  /** 手动跑一次夜间整理（定时任务也调它）。 */
  proposeDaily(now: Iso8601): Promise<{ created: ApprovalItem[]; filtered: FilteredProposal[] }>
  /** 解析后的技能正文 → persona 段（"下次运行用新版"就靠这一步）。 */
  promptSections(): Promise<PromptSection[]>
}

const clean = (s: string): string => s.replace(/\s+/g, ' ').trim()

export function installLearningLoop(world: World, options: LearningOptions = {}): LearningLoop {
  const { clock, workspace_id } = world
  let seq = 0
  const nextId = (): string => {
    seq += 1
    return `les_${String(seq).padStart(4, '0')}`
  }
  const skills = createSkills({ clock, random: world.random })
  const pool = new LearningPool({ clock, nextId })
  const proposals: ApprovalItem[] = []
  const cards = new Map<string, LessonProposalCard>()
  const loop: LearningLoop = {
    skills,
    pool,
    proposals,
    filtered: [],
    onDecided,
    proposeDaily,
    promptSections,
  }

  // pack 自带的技能进公司层：学习回路要有落脚的段落
  for (const doc of world.pack.skills) {
    void skills.registry.putFromMarkdown({
      markdown: doc.markdown,
      tier: 'company',
      owner: world.owner,
      version: '1.0',
      workspace_id,
    })
  }

  async function onDecided(
    item: ApprovalItem,
    input: { selected_option_id?: string },
  ): Promise<void> {
    if (item.kind === 'skill_lesson') {
      await applyProposal(item, input)
      return
    }
    // 晋升卡不产 lesson（它本来就是 lesson 攒出来的）。
    // `knowledge_update` **产**：47 J3 那张"知识过时"卡上人怎么决定（退休它 / 留着当案例），
    // 正是 24 学习回路要吃的信号——"以后碰到这种旧状态该怎么办"。
    if (item.kind === 'skill_promotion') return
    const d = item.decision
    if (d === undefined) return
    if (d.action !== 'reject' && d.action !== 'approve_edited' && d.action !== 'approve') return
    const skill = world.effective.skills.find((s) => s.load === 'always')?.name
    if (skill === undefined) return
    const lessons = extractLessons({
      workspace_id,
      assignment_id: world.assignment.id,
      run_id: item.evidence.run_id ?? `card_${item.id}`,
      at: d.at,
      applies_to: { skill },
      decisions: [
        {
          approval_item_id: item.id,
          action: d.action,
          at: d.at,
          ...(d.reason === undefined ? {} : { reason: d.reason }),
        },
      ],
    })
    for (const lesson of lessons) {
      const pooled = pool.pool(lesson)
      world.appendEvent('lesson.pooled', {
        lesson_id: pooled.id,
        skill: pooled.applies_to.skill,
        signal: pooled.signal,
        hits: pooled.hits,
      })
    }
  }

  async function applyProposal(
    item: ApprovalItem,
    input: { selected_option_id?: string },
  ): Promise<void> {
    const card = cards.get(item.id)
    if (card === undefined) return
    const accepted = item.state === 'approved' || item.state === 'approved_edited'
    const out = await applyLessonDecision(
      {
        proposal: card,
        action: accepted ? 'accept' : 'reject',
        owner: world.roleHolder,
        by: item.decision?.by ?? world.roleHolder,
        at: item.decision?.at ?? clock.now(),
        ...(input.selected_option_id === undefined
          ? {}
          : { selected_option_id: input.selected_option_id }),
        ...(item.decision?.reason === undefined ? {} : { reason: item.decision.reason }),
      },
      { registry: skills.registry, pool },
    )
    world.appendEvent(
      out.status === 'applied' ? 'skill.overlay.changed' : 'lesson.ignored',
      {
        skill: card.skill,
        status: out.status,
        ...(out.blacklisted === undefined ? {} : { blacklisted: out.blacklisted }),
      },
      { subject: { type: 'approval_item', id: item.id } },
    )
  }

  async function proposeDaily(
    now: Iso8601,
  ): Promise<{ created: ApprovalItem[]; filtered: FilteredProposal[] }> {
    const result = draftProposals({
      workspace_id,
      lessons: pool.list({ workspace_id }) as PooledLesson[],
      skills: skillReaderOf(skills.registry),
      now,
      rejectedKeys: pool.rejectedKeys(workspace_id).map((r) => r.semantic_key),
    })
    loop.filtered = result.filtered
    const created: ApprovalItem[] = []
    for (const card of result.proposals) {
      const item = (await world.txn.approvals.create({
        workspace_id,
        schema_version: 1,
        kind: 'skill_lesson',
        role_id: world.role_id,
        subject: { object: { type: 'skill', id: card.skill } },
        dedupe_key: `${workspace_id}:skill_lesson:${card.skill}:${card.section_id}`,
        title: card.title,
        summary: card.summary,
        payload: {
          form: 'skill_lesson',
          skill: card.skill,
          section_id: card.section_id,
          heading: card.heading,
          proposed_text: clean(card.diff.after),
          options: card.options,
          hits: card.hits,
          lessons: card.lessons,
          quotes: card.evidence.quotes,
        },
        evidence: {
          source_events: [],
          diff: card.diff,
          provenance: { seen: [{ type: 'skill', id: card.skill }] },
          precheck: { permission_diff: 'ok' },
        },
        proposer: { kind: 'system', id: 'learning' },
        automation: {
          level_at_creation: 'L1',
          auto_approved: false,
          mandate_check: { within: true, caps_hit: [] },
          sampling: { selected: false },
        },
        routing: {
          recipients: [{ person: world.roleHolder, via: 'role_holder' }],
          rule: 'role_holder',
          escalation: { after_hours: 72, business_hours: true, chain: ['owner'], escalated_at: [] },
          separation_of_duties: false,
        },
        priority: 'queue',
        options: card.options.map((o) => ({ id: o.id, label: o.label })),
      })) as ApprovalItem
      if (item.state === 'blocked') continue
      cards.set(item.id, card)
      for (const id of card.lessons) pool.mark(id, 'proposed', now)
      proposals.push(item)
      created.push(item)
      world.appendEvent(
        'lesson.proposed',
        { skill: card.skill, hits: card.hits },
        { subject: { type: 'approval_item', id: item.id } },
      )
    }
    return { created, filtered: result.filtered }
  }

  async function promptSections(): Promise<PromptSection[]> {
    return skillPromptSections({
      skills: world.effective.skills,
      actor: { person_id: world.assignment.person_id, workspace_id },
      registry: skills.registry,
    })
  }

  // 定时：每天 07:30 出「昨天学到的」（赶在 08:00 那条计划任务之前）
  const routine = world.startRoutine()
  routine.scheduler.register(LEARNING_HANDLER, async (ctx) => {
    const { created, filtered } = await proposeDaily(ctx.at)
    return { cards: created.length, filtered: filtered.length }
  })
  void routine.scheduler.schedule({
    workspace_id,
    owner: world.roleHolder,
    role_id: world.role_id,
    assignment_id: world.assignment.id,
    created_by: 'user',
    misfire_policy: 'run_once_now',
    id: 'sched_learning_daily',
    title: '每天早上把昨天学到的整理成一张卡',
    handler: LEARNING_HANDLER,
    trigger: {
      kind: 'cron',
      expr: `${options.proposeMinute ?? 30} ${options.proposeHour ?? 7} * * *`,
      tz: world.pack.workspace.tz,
    },
  })

  return loop
}

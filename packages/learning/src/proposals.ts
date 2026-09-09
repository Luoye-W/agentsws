/**
 * 次日提案（24 §3 夜间整理、36 §2.2「昨日学到的」卡）。
 *
 * 产出的不是"我已经改好了"，是**一道选择题**：2–3 个候选改法 + "都不要"，
 * 带段级 diff 预览、人的原话、命中次数。不批不生效——夜里 overlay 一个字不动。
 *
 * 三道闸门，顺序固定（先便宜后贵，理由都要能说给人听）：
 * 1. 策略层 → `policy_layer`（24 §3：策略层永不进学习回路，连提议都不给）
 * 2. 被驳回过的语义键 → `rejected_before`（同类经验再出现也不再烦人）
 * 3. 门槛未过 → `below_threshold`（≥ 2 次同类，或置信度 ≥ 0.8）
 */
import type { AssignmentId, Iso8601, RunId, WorkspaceId } from '@agentsws/contracts'
import { POLICY_KEYWORDS } from '@agentsws/skills'
import { keySimilarity, keyTokens } from './semantic.js'
import type { PooledLesson } from './types.js'

/** 置信度门槛：单条够硬就能直接进提案。 */
export const DEFAULT_CONFIDENCE_THRESHOLD = 0.8
/** 命中次数门槛：同一条经验重复出现这么多次就算够硬（哪怕单条置信度不高）。 */
export const DEFAULT_MIN_HITS = 2
/** 一张卡上最多几个候选改法（36 §2.2「可带 2–3 个候选改法」）。 */
export const DEFAULT_MAX_OPTIONS = 3
/** "都不要"那一项的固定 id：工作台与服务端都认它。 */
export const OPTION_NONE = 'none'

export interface SkillSectionView {
  id: string
  heading: string
  body: string
}

/** 技能只读面：提案只需要"这个技能有哪些段、各段正文是什么"。 */
export interface SkillReader {
  sections(skill: string): readonly SkillSectionView[]
}

export interface ProposalOption {
  id: string
  label: string
  op: 'replace' | 'append'
  section_id: string
  body: string
}

export interface LessonProposalCard {
  workspace_id: WorkspaceId
  skill: string
  section_id: string
  heading: string
  semantic_key: string
  assignment_id: AssignmentId
  title: string
  summary: string
  /** 选择题：候选改法 + "都不要"（"都不要" 没有 op） */
  options: (ProposalOption | { id: typeof OPTION_NONE; label: string })[]
  /** 段级 diff 预览（14 §6 语义 diff：空 diff 不建项） */
  diff: { before: string | null; after: string; summary: string }
  evidence: { quotes: string[]; run_ids: RunId[]; approval_item_ids: string[] }
  hits: number
  confidence: number
  lessons: string[]
  created_at: Iso8601
}

export type FilterReason =
  | 'policy_layer'
  | 'rejected_before'
  | 'below_threshold'
  | 'no_target_section'
  | 'empty_diff'

export interface FilteredProposal {
  skill: string
  section_id?: string
  semantic_key: string
  reason: FilterReason
  lessons: string[]
  /** 人话解释（工作台上要能说清"为什么今天没给你这条"） */
  detail: string
}

export interface DraftProposalsInput {
  workspace_id: WorkspaceId
  lessons: readonly PooledLesson[]
  skills: SkillReader
  now: Iso8601
  threshold?: number
  minHits?: number
  maxOptions?: number
  /** 策略层技能名单：这些永不进学习回路 */
  policySkills?: Iterable<string>
  /** 被驳回过的语义键 */
  rejectedKeys?: Iterable<string>
}

export interface DraftProposalsResult {
  proposals: LessonProposalCard[]
  filtered: FilteredProposal[]
}

const trim = (s: string): string => s.replace(/\s+/g, ' ').trim()

/** 段标题命中策略关键词 → 这一段属于策略层（24 §3）。 */
export function isPolicySection(heading: string): boolean {
  const lower = heading.toLowerCase()
  return POLICY_KEYWORDS.some((k) => lower.includes(k.toLowerCase()))
}

/** 一句话摘要：卡片标题上要看得出"改哪一段、加什么"。 */
function titleOf(heading: string, text: string): string {
  const head = trim(text)
  const short = head.length <= 28 ? head : `${head.slice(0, 27)}…`
  return `昨天学到的：给「${heading}」加一条 ${short}`
}

function clusterBySimilarity(items: readonly PooledLesson[]): PooledLesson[][] {
  const clusters: PooledLesson[][] = []
  for (const item of items) {
    const hit = clusters.find((c) => {
      const head = c[0]
      return head !== undefined && keySimilarity(head.text, item.text) > 0.5
    })
    if (hit !== undefined) hit.push(item)
    else clusters.push([item])
  }
  return clusters
}

function representative(cluster: readonly PooledLesson[]): PooledLesson {
  const sorted = [...cluster].sort(
    (a, b) =>
      b.confidence - a.confidence ||
      b.hits - a.hits ||
      a.created_at.localeCompare(b.created_at) ||
      a.id.localeCompare(b.id),
  )
  // cluster 非空由调用方保证
  return sorted[0] as PooledLesson
}

/**
 * 池 → 次日提案。纯函数：不写池、不写 overlay，只读。
 * 状态流转（pooled → proposed）由调用方按返回的 `lessons` 自己做，
 * 这样"生成一遍看看"与"真出卡"是两件事。
 */
export function draftProposals(input: DraftProposalsInput): DraftProposalsResult {
  const threshold = input.threshold ?? DEFAULT_CONFIDENCE_THRESHOLD
  const minHits = input.minHits ?? DEFAULT_MIN_HITS
  const maxOptions = Math.max(1, input.maxOptions ?? DEFAULT_MAX_OPTIONS)
  const policySkills = new Set(input.policySkills ?? [])
  const rejected = new Set(input.rejectedKeys ?? [])

  const candidates = input.lessons.filter(
    (l) => l.workspace_id === input.workspace_id && l.status === 'pooled',
  )
  const groups = new Map<string, PooledLesson[]>()
  for (const l of candidates) {
    const key = `${l.applies_to.skill}::${l.applies_to.section_id ?? ''}`
    const list = groups.get(key) ?? []
    list.push(l)
    groups.set(key, list)
  }

  const proposals: LessonProposalCard[] = []
  const filtered: FilteredProposal[] = []
  const push = (
    cluster: readonly PooledLesson[],
    reason: FilterReason,
    detail: string,
    section_id?: string,
  ): void => {
    const rep = representative(cluster)
    const section = section_id ?? rep.applies_to.section_id
    filtered.push({
      skill: rep.applies_to.skill,
      ...(section === undefined ? {} : { section_id: section }),
      semantic_key: rep.semantic_key,
      reason,
      lessons: cluster.map((l) => l.id),
      detail,
    })
  }

  for (const key of [...groups.keys()].sort()) {
    const group = groups.get(key) ?? []
    for (const cluster of clusterBySimilarity(group)) {
      const rep = representative(cluster)
      const skill = rep.applies_to.skill

      // ① 策略层
      const sections = input.skills.sections(skill)
      const target =
        rep.applies_to.section_id === undefined
          ? bestSection(sections, rep.text)
          : sections.find((s) => s.id === rep.applies_to.section_id)
      if (policySkills.has(skill) || (target !== undefined && isPolicySection(target.heading))) {
        push(cluster, 'policy_layer', '策略层不进学习回路：这一层只有负责人手改（24 §3）')
        continue
      }
      // ② 黑名单
      if (cluster.some((l) => rejected.has(l.semantic_key))) {
        push(cluster, 'rejected_before', '这条你之前驳回过，同类的以后不再提')
        continue
      }
      // ③ 有没有可落的段
      if (target === undefined) {
        push(cluster, 'no_target_section', `技能 ${skill} 还没有可以改的段落`)
        continue
      }
      // ④ 门槛
      const hits = cluster.reduce((n, l) => n + l.hits, 0)
      const confidence = Math.max(...cluster.map((l) => l.confidence))
      if (hits < minHits && confidence < threshold) {
        push(
          cluster,
          'below_threshold',
          `只出现 ${hits} 次、置信度 ${confidence.toFixed(2)}，还不够硬`,
          target.id,
        )
        continue
      }

      const variants: string[] = []
      for (const l of [rep, ...cluster]) {
        const t = trim(l.text)
        if (t !== '' && !variants.includes(t)) variants.push(t)
      }
      const primary = variants[0] ?? ''
      const appended = `${target.body}\n\n${primary}`.trim()
      // 14 §6 语义 diff：空 diff 不建项。这条已经写在段落里了就别再问一遍
      if (primary === '' || trim(target.body).includes(primary)) {
        push(cluster, 'empty_diff', '这条已经在段落里了，改了等于没改', target.id)
        continue
      }

      const options: LessonProposalCard['options'] = [
        {
          id: 'append',
          label: `在「${target.heading}」后面加一句：${primary}`,
          op: 'append',
          section_id: target.id,
          body: primary,
        },
        {
          id: 'replace',
          label: `把「${target.heading}」整段改成这条：${primary}`,
          op: 'replace',
          section_id: target.id,
          body: primary,
        },
      ]
      const alt = variants[1]
      if (alt !== undefined) {
        options.push({
          id: 'append_alt',
          label: `换一种说法加进去：${alt}`,
          op: 'append',
          section_id: target.id,
          body: alt,
        })
      }
      options.length = Math.min(options.length, maxOptions)
      options.push({ id: OPTION_NONE, label: '都不要' })

      proposals.push({
        workspace_id: input.workspace_id,
        skill,
        section_id: target.id,
        heading: target.heading,
        semantic_key: rep.semantic_key,
        assignment_id: rep.assignment_id,
        title: titleOf(target.heading, primary),
        summary: `${hits} 次同类纠正攒出来的一条。采纳就写进你的个人层，不采纳以后不再提。`,
        options,
        diff: {
          before: target.body === '' ? null : target.body,
          after: appended,
          summary: `「${target.heading}」追加一条`,
        },
        evidence: {
          quotes: uniq(cluster.flatMap((l) => l.evidence.map((e) => e.quote))),
          run_ids: uniq(cluster.flatMap((l) => l.runs)),
          approval_item_ids: uniq(
            cluster.flatMap((l) =>
              l.evidence
                .map((e) => e.approval_item_id)
                .filter((x): x is string => x !== undefined && x !== ''),
            ),
          ),
        },
        hits,
        confidence,
        lessons: cluster.map((l) => l.id),
        created_at: input.now,
      })
    }
  }
  return { proposals, filtered }
}

function uniq<T>(list: readonly T[]): T[] {
  return [...new Set(list)]
}

/**
 * 没写段的 lesson 落到哪一段：和标题 + 正文词面重合最多的那一段，都不沾就落最后一段。
 *
 * 刻意用词面重合而不是模型：这一步只是"猜个落点"，人在卡片上看得到段名，
 * 猜错了他会选"都不要"——不值得为它引入一次模型调用与一份不确定性。
 */
export function bestSection(
  sections: readonly SkillSectionView[],
  text: string,
): SkillSectionView | undefined {
  if (sections.length === 0) return undefined
  const wanted = new Set(keyTokens(text))
  let best: { section: SkillSectionView; score: number } | undefined
  for (const s of sections) {
    const pool = new Set([...keyTokens(s.heading), ...keyTokens(s.body)])
    let score = 0
    for (const t of wanted) if (pool.has(t)) score += 1
    // 标题命中比正文命中值钱：段名才是人认段落的方式
    for (const t of keyTokens(s.heading)) if (wanted.has(t)) score += 1
    if (best === undefined || score > best.score) best = { section: s, score }
  }
  return best !== undefined && best.score > 0 ? best.section : sections[sections.length - 1]
}

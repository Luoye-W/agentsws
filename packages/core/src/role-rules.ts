/**
 * WP284（决策 275）：**「以后都这样」落成职责规矩里的一句话**——纯的那一半（放在 core：API 网关、服务进程、模拟世界都依赖它）。
 *
 * 一条路走到底：人在卡上指导、选「以后都这样」→ 出一张策略卡（`policy_change`，
 * 对象 `policy:instruction_<卡 id>`）→ 有人点了通过 → 这一句写进这个品牌里这条职责的规矩 →
 * 之后这条职责的每一次运行，提示词里角色定位后面多一节「这条职责的规矩」。
 *
 * 这里放服务进程与模拟世界**共用**的几样：出卡的形状、认卡、从批了的卡取那一句、
 * 进提示词的那一节、一本内存里的规矩簿（服务端换成落盘的那一份）。三个运行时拿到同一份字节。
 */
import type {
  ApprovalItem,
  CreateApprovalInput,
  PromptSection,
  RoleRule,
} from '@agentsws/contracts'

/** 提示词语言（与 `@agentsws/roles` 的 `PersonaLang` 同形）。 */
export type RoleRuleLang = 'zh' | 'en'

/** 排在职责角色定位（20）后面、回复语言（22）前面。 */
export const ROLE_RULES_ORDER = 21

/** 一句规矩最多多少字（一句话说不清的不是规矩，是手册）。 */
export const MAX_ROLE_RULE_CHARS = 300

/** 策略卡对象 id 的前缀（`policy:instruction_<那张卡的 id>`）。 */
export const INSTRUCTION_RULE_PREFIX = 'instruction_'

const HEAD: Readonly<Record<RoleRuleLang, string>> = {
  zh: '这条职责的规矩（人定过的，一律照做；和下面技能里的写法冲突时，以这里为准）：',
  en: 'Rules for this duty (set by a person — always follow them; where they conflict with the skill text below, these win):',
}

/** 进提示词的那一节。一条都没有就不出（不注一个空节）。 */
export function roleRulesSection(
  rules: readonly Pick<RoleRule, 'text'>[],
  lang: RoleRuleLang = 'zh',
): PromptSection | undefined {
  const lines = rules.map((r) => r.text.trim()).filter((t) => t !== '')
  if (lines.length === 0) return undefined
  return {
    id: 'role_rules',
    name: lang === 'zh' ? '这条职责的规矩' : 'Duty rules',
    order: ROLE_RULES_ORDER,
    text: [HEAD[lang], ...lines.map((t) => `- ${t}`)].join('\n'),
  }
}

/** 策略卡的载荷（与 WP284 之前出的那种同形，只多 `source_title`）。 */
export interface InstructionRulePayload {
  target: 'workspace_policy'
  before: null
  after: { rule: string }
  affected_assignments: string[]
  source_card_id: string
  /** WP284：指导写在哪张卡上（卡标题），规矩那一行「来自…」用。 */
  source_title?: string
  /** WP284：卡面认它用（选项直接是两个按钮）。WP284 之前出的老卡没有。 */
  form?: typeof INSTRUCTION_RULE_FORM
  /** WP284：「记进规矩 / 不用」——与 `policy_change` 的 after / before 同一对 id。 */
  options?: { id: 'after' | 'before'; label: string }[]
  /** WP289（决策 318）：从聊天窗「教 AI」来的——哪条会话（这时 `source_card_id` 是一个合成的来源 id）。 */
  source_session_id?: string
}

/** 卡面认「以后都这样」那张策略卡用的 `payload.form`。 */
export const INSTRUCTION_RULE_FORM = 'instruction_rule'

/**
 * 出「以后都这样」那张策略卡的输入（API 的指导落地与模拟世界共用）。
 *
 * 路由：① ② 收件人是写指导的本人；③ 给了 `approver`（老板）就发给他，与改职责规矩同一条路。
 *
 * WP289（决策 318）：聊天窗「教 AI」选「以后都这样」也出这一张（给 `chat`）：没有来源卡，
 * `item` 由调用方按那条会话合成（id 每次不同、对象是会话的 thread），卡上不挂 `links.parent`。
 */
export function instructionRuleCard(input: {
  workspace_id: string
  person_id: string
  assignment_id: string
  /** 指导写在哪张卡上。 */
  item: Pick<ApprovalItem, 'id' | 'role_id' | 'subject' | 'title'>
  text: string
  /**
   * WP284（docs/95 §5）：③ 有审批流——卡发给批策略变更的那个人（老板），与改职责规矩同一条路；
   * 不给（① ②）= 写指导的本人自己点。
   */
  approver?: string
  /** WP289：从聊天窗来的（哪条会话）。 */
  chat?: { session_id: string }
}): CreateApprovalInput<InstructionRulePayload> {
  const { item, text } = input
  return {
    workspace_id: input.workspace_id,
    schema_version: 1,
    role_id: item.role_id,
    proposer: { kind: 'person', id: input.person_id },
    // 指导产的卡永远 L1：指导本身不改任何东西，改不改由人再批一次
    automation: { level_at_creation: 'L1' },
    routing: {
      recipients: [{ person: input.approver ?? input.person_id, via: 'owner' }],
      rule: 'owner',
      escalation: { after_hours: 48, business_hours: true, chain: ['owner'], escalated_at: [] },
      separation_of_duties: false,
    },
    priority: 'queue',
    ...(input.chat === undefined ? { links: { parent: item.id } } : {}),
    kind: 'policy_change',
    subject: {
      object: { type: 'policy', id: `${INSTRUCTION_RULE_PREFIX}${item.id}` },
      ...(item.subject.matter_id === undefined ? {} : { matter_id: item.subject.matter_id }),
    },
    dedupe_key: `${input.workspace_id}:policy_change:instruction:${item.id}`,
    title: `以后都这样：${text.length > 40 ? `${text.slice(0, 40)}…` : text}`,
    // 界面少字：标题说了是哪一句、按钮说了记到哪，这一句只说之后怎样、去哪儿改
    summary: '之后每次都照做；在职责规矩里能改、能删。',
    payload: {
      form: INSTRUCTION_RULE_FORM,
      options: [
        { id: 'after', label: '记进规矩' },
        { id: 'before', label: '不用' },
      ],
      target: 'workspace_policy',
      before: null,
      after: { rule: text },
      affected_assignments: [input.assignment_id],
      source_card_id: item.id,
      ...(item.title === '' ? {} : { source_title: item.title.slice(0, 60) }),
      ...(input.chat === undefined ? {} : { source_session_id: input.chat.session_id }),
    },
    evidence: {
      source_events: [],
      provenance: { seen: [item.subject.object] },
      precheck: { permission_diff: 'ok', semantic_diff: 'ok' },
    },
  }
}

const asRecord = (v: unknown): Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {}

const ruleIn = (payload: unknown): string | undefined => {
  const rule = asRecord(asRecord(payload).after).rule
  return typeof rule === 'string' && rule.trim() !== '' ? rule.trim() : undefined
}

/** 这张是不是「以后都这样」那张策略卡（WP284 之前出的老卡也认）。 */
export function isInstructionRuleCard(
  item: Pick<ApprovalItem, 'kind' | 'subject' | 'payload'>,
): boolean {
  return (
    item.kind === 'policy_change' &&
    item.subject.object.type === 'policy' &&
    item.subject.object.id.startsWith(INSTRUCTION_RULE_PREFIX) &&
    ruleIn(item.payload) !== undefined
  )
}

const APPROVED = new Set(['approved', 'approved_edited', 'applying', 'applied'])

/**
 * 批了的那一句（没批、选了「维持现状」、不是这种卡 → `undefined`）。
 * 人在卡上改过那一句（`edited_payload.after.rule`）就用改过的。
 */
export function approvedRuleText(item: ApprovalItem): string | undefined {
  if (!isInstructionRuleCard(item) || !APPROVED.has(item.state)) return undefined
  const edited = asRecord(item.decision?.edited_payload)
  const picked = item.decision?.selected_option_id ?? edited.selected_option_id
  if (picked === 'before') return undefined
  const text = ruleIn(edited) ?? ruleIn(item.payload)
  return text?.slice(0, MAX_ROLE_RULE_CHARS)
}

/** 批了的策略卡 → 一条规矩（id 由调用方给：服务端随机、模拟世界按序号）。 */
export function ruleFromCard(item: ApprovalItem, id: string, at: string): RoleRule | undefined {
  const text = approvedRuleText(item)
  const by = item.decision?.by
  if (text === undefined || by === undefined || by === 'mandate') return undefined
  const p = asRecord(item.payload)
  const proposer = item.proposer.kind === 'person' ? item.proposer.id : undefined
  return {
    id,
    workspace_id: item.workspace_id,
    role_id: item.role_id,
    text,
    by,
    ...(proposer === undefined ? {} : { proposed_by: proposer }),
    source_card_id: item.id,
    ...(typeof p.source_title === 'string' && p.source_title !== ''
      ? { source_title: p.source_title }
      : {}),
    ...(item.subject.matter_id === undefined ? {} : { matter_id: item.subject.matter_id }),
    created_at: at,
  }
}

/** 规矩簿的存储口（内存 / 落盘各一份）。 */
export interface RoleRuleBackend {
  all(): RoleRule[]
  put(row: RoleRule): void
  remove(id: string): void
}

export function createMemoryRoleRuleBackend(): RoleRuleBackend {
  const rows = new Map<string, RoleRule>()
  return {
    all: () => [...rows.values()],
    put: (row) => {
      rows.set(row.id, row)
    },
    remove: (id) => {
      rows.delete(id)
    },
  }
}

/** 一本规矩簿：按品牌 + 职责列、按来源卡去重。 */
export interface RoleRuleBook {
  list(workspace_id: string, role_id: string): RoleRule[]
  get(id: string): RoleRule | undefined
  /** 同一张来源卡只落一次（重复决定 / 重启后重放都不多一条）；回落下的那条或已有的那条。 */
  add(rule: RoleRule): { rule: RoleRule; added: boolean }
  put(rule: RoleRule): void
  remove(id: string): RoleRule | undefined
  /** 进提示词的那一节（这个品牌里这条职责的全部规矩，按定下的先后）。 */
  section(workspace_id: string, role_id: string, lang?: RoleRuleLang): PromptSection | undefined
}

export function createRoleRuleBook(
  backend: RoleRuleBackend = createMemoryRoleRuleBackend(),
): RoleRuleBook {
  const list = (workspace_id: string, role_id: string): RoleRule[] =>
    backend
      .all()
      .filter((r) => r.workspace_id === workspace_id && r.role_id === role_id)
      .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id))
  return {
    list,
    get: (id) => backend.all().find((r) => r.id === id),
    add(rule) {
      const same =
        rule.source_card_id === undefined
          ? undefined
          : backend.all().find((r) => r.source_card_id === rule.source_card_id)
      if (same !== undefined) return { rule: same, added: false }
      backend.put(rule)
      return { rule, added: true }
    },
    put: (rule) => {
      backend.put(rule)
    },
    remove(id) {
      const row = backend.all().find((r) => r.id === id)
      if (row !== undefined) backend.remove(id)
      return row
    },
    section: (workspace_id, role_id, lang) => roleRulesSection(list(workspace_id, role_id), lang),
  }
}

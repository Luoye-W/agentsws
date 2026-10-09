/**
 * WP284（决策 275）：**「以后都这样」真落库**——服务进程那一半。
 *
 * 1. **落**：「以后都这样」那张策略卡有人点了通过（选「按提议改」）→ 这一句写进这个品牌里
 *    这条职责的规矩（留定的人、提的人、来源卡）。① ② ③ 都一样；③ 按现有路由批了才落。
 *    同一张卡只落一次。
 * 2. **用**：这条职责之后的每一次运行，提示词里角色定位后面多一节「这条职责的规矩」
 *    （`section`，运行时装配那一跳现取——改了 / 删了下一次运行就是新的）。
 * 3. **改 / 删**：职责规矩卡与右栏角色面板上那一列。① 本人；② 谁都能改，做这条职责的同事
 *    各收一张「知道了 / 撤回」（撤回 = 落回改之前那一句）；③ 只有老板与管理员。
 *
 * 存法与角色定位一样：一个 JSON 文件（`role-rules.json`），很小、很少变、要能被人直接看见。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { RoleRulesActor, RoleRulesPort } from '@agentsws/api'
import { ApiError } from '@agentsws/api'
import type {
  ApprovalItem,
  Clock,
  EventEnvelope,
  OrganizationMode,
  PersonId,
  PromptSection,
  RoleRule,
  RoleRuleView,
} from '@agentsws/contracts'
import {
  createMemoryRoleRuleBackend,
  createRoleRuleBook,
  isInstructionRuleCard,
  MAX_ROLE_RULE_CHARS,
  type RoleRuleBackend,
  type RoleRuleBook,
  ruleFromCard,
} from '@agentsws/core'

/** 落盘的那一份（一个 JSON 数组）。文件坏了当成没有规矩，进程照常起。 */
export function createFileRoleRuleBackend(file: string): RoleRuleBackend {
  const read = (): RoleRule[] => {
    if (!existsSync(file)) return []
    try {
      const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
      return Array.isArray(parsed) ? (parsed as RoleRule[]) : []
    } catch {
      return []
    }
  }
  const write = (rows: RoleRule[]): void => {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, `${JSON.stringify(rows, null, 2)}\n`, 'utf8')
  }
  return {
    all: read,
    put: (row) => {
      write([...read().filter((r) => r.id !== row.id), row])
    },
    remove: (id) => {
      write(read().filter((r) => r.id !== id))
    },
  }
}

/** 有了结论、不会再落成规矩的那几种状态（「不用」也是一次批准，所以批准类也在里面）。 */
const SETTLED = new Set<string>([
  'approved',
  'approved_edited',
  'applying',
  'applied',
  'rejected',
  'withdrawn',
  'expired',
  'superseded',
])

/** 数据目录下规矩簿那个文件。 */
export const roleRulesFileIn = (dbDir: string): string => join(dbDir, 'role-rules.json')

/** 「撤回」要的东西（放在 ② 的通知卡上）：改之前那一句；`null` = 之前没有（不会出现，留着对称）。 */
export interface RoleRuleUndo {
  target: 'role_rule'
  rule_id: string
  before: RoleRule | null
  /** 删的时候一起退役的工具箱目录项（撤回时放回去）；没有 = 不用放。 */
  catalog_note?: unknown
  [key: string]: unknown
}

/** 工具箱里那条「规矩」目录项的 id（指导那一刻记的：`rule:<策略卡 id>`）。 */
export const ruleCatalogId = (rule: Pick<RoleRule, 'source_card_id'>): string | undefined =>
  rule.source_card_id === undefined ? undefined : `rule:${rule.source_card_id}`

export interface RoleRulesOptions {
  clock: Clock
  random: () => number
  backend?: RoleRuleBackend
  appendEvent(e: Omit<EventEnvelope, 'id' | 'at'> & { at?: string }): void
  /** 这个品牌现在是哪种用法（同步；读不到按 ③）。 */
  modeOf(workspace_id: string): OrganizationMode | undefined
  /** 这个人是不是这家的老板 / 管理员（③ 改规矩只认他们）。 */
  managerOf(person_id: PersonId, workspace_id: string): Promise<'owner' | 'admin' | undefined>
  nameOf(person_id: PersonId): Promise<string | undefined>
  /**
   * 删一句时把工具箱里那条「规矩」目录项一起退役（回退役前那一份，撤回时原样放回）。
   * 不给 = 目录不动（老行为）。
   */
  retireCatalog?(workspace_id: string, entry_id: string): unknown
  restoreCatalog?(workspace_id: string, entry_id: string, note: unknown): void
  /** ② 改了 / 删了一句：做这条职责的同事各一张「知道了 / 撤回」。 */
  notifyPeers?(input: {
    workspace_id: string
    by: PersonId
    role_id: string
    before: string | null
    after: string | null
    undo: RoleRuleUndo
  }): Promise<void>
}

export interface RoleRulesAssembly {
  book: RoleRuleBook
  port: RoleRulesPort
  /** 一张卡被决定之后：是「以后都这样」而且批了 → 落一句。别的卡原样放过。 */
  onDecided(item: ApprovalItem): RoleRule | undefined
  /** 进提示词的那一节（运行时装配那一跳现取）。 */
  section(workspace_id: string, role_id: string): PromptSection | undefined
  /** ② 的通知卡选了「撤回」→ 落回改之前那一句。 */
  undo(undo: RoleRuleUndo, by: PersonId): void
}

export function createRoleRules(options: RoleRulesOptions): RoleRulesAssembly {
  const book = createRoleRuleBook(options.backend ?? createMemoryRoleRuleBackend())
  let seq = 0
  const nextId = (): string => {
    seq += 1
    return `rr_${Math.floor(options.random() * 36 ** 8).toString(36)}${seq.toString(36)}`
  }
  const emit = (
    type: string,
    workspace_id: string,
    by: PersonId | 'system',
    rule: Pick<RoleRule, 'id' | 'role_id'>,
    extra: Record<string, unknown> = {},
  ): void => {
    // 规矩那一句是用户写的业务口径：事件里只记 id，不记原文（21 §1 payload 最小）
    options.appendEvent({
      schema_version: 1,
      workspace_id,
      type,
      actor: by === 'system' ? { kind: 'system', id: 'system' } : { kind: 'person', id: by },
      subject: { type: 'role_rule', id: rule.id },
      correlation: { trace_id: `tr_${rule.id}` },
      payload: { rule_id: rule.id, role_id: rule.role_id, ...extra },
    })
  }

  const canEdit = async (actor: RoleRulesActor): Promise<boolean> => {
    const mode = options.modeOf(actor.workspace_id) ?? 'company'
    if (mode !== 'company') return true
    return (await options.managerOf(actor.person_id, actor.workspace_id)) !== undefined
  }

  const viewOf = async (rule: RoleRule, can_edit: boolean): Promise<RoleRuleView> => {
    const by_name = await options.nameOf(rule.by)
    const updated_by_name =
      rule.updated_by === undefined ? undefined : await options.nameOf(rule.updated_by)
    return {
      ...rule,
      ...(by_name === undefined || by_name === '' ? {} : { by_name }),
      ...(updated_by_name === undefined || updated_by_name === '' ? {} : { updated_by_name }),
      can_edit,
    }
  }

  /** 改 / 删之前：在不在、是不是这条职责的、这个人改不改得了。 */
  const mine = async (
    actor: RoleRulesActor,
    role_id: string,
    rule_id: string,
  ): Promise<RoleRule> => {
    const row = book.get(rule_id)
    if (row === undefined || row.workspace_id !== actor.workspace_id || row.role_id !== role_id)
      throw new ApiError('not_found', '没有这一句规矩')
    if (!(await canEdit(actor)))
      throw new ApiError('forbidden', '公司模式下，职责规矩只有老板和管理员改得了')
    return row
  }

  const tellPeers = (
    actor: RoleRulesActor,
    before: RoleRule,
    after: RoleRule | null,
    catalog_note?: unknown,
  ): void => {
    if (options.modeOf(actor.workspace_id) !== 'peers' || options.notifyPeers === undefined) return
    void options
      .notifyPeers({
        workspace_id: actor.workspace_id,
        by: actor.person_id,
        role_id: before.role_id,
        before: before.text,
        after: after?.text ?? null,
        undo: {
          target: 'role_rule',
          rule_id: before.id,
          before,
          ...(catalog_note === undefined ? {} : { catalog_note }),
        },
      })
      .catch(() => undefined)
  }

  const port: RoleRulesPort = {
    async list(actor, role_id) {
      const can = await canEdit(actor)
      return Promise.all(book.list(actor.workspace_id, role_id).map((r) => viewOf(r, can)))
    },
    async update(actor, role_id, rule_id, text) {
      const before = await mine(actor, role_id, rule_id)
      const clean = text.trim()
      if (clean === '' || clean.length > MAX_ROLE_RULE_CHARS)
        throw new ApiError('invalid_input', `一句规矩 1–${MAX_ROLE_RULE_CHARS} 字`)
      const after: RoleRule = {
        ...before,
        text: clean,
        updated_at: options.clock.now(),
        updated_by: actor.person_id,
      }
      book.put(after)
      emit('role_rule.updated', actor.workspace_id, actor.person_id, after)
      tellPeers(actor, before, after)
      return viewOf(after, true)
    },
    async remove(actor, role_id, rule_id) {
      const before = await mine(actor, role_id, rule_id)
      book.remove(rule_id)
      // 工具箱里那条「规矩」一起退役（不然删了规矩，工具箱上还挂着它）
      const entry = ruleCatalogId(before)
      const catalog_note =
        entry === undefined ? undefined : options.retireCatalog?.(actor.workspace_id, entry)
      emit('role_rule.removed', actor.workspace_id, actor.person_id, before, {
        ...(catalog_note === undefined ? {} : { catalog_retired: true }),
      })
      tellPeers(actor, before, null, catalog_note)
      return { removed: true as const }
    },
  }

  return {
    book,
    port,
    onDecided(item) {
      if (!isInstructionRuleCard(item)) return undefined
      const rule = ruleFromCard(item, nextId(), options.clock.now())
      if (rule === undefined) {
        // 选了「不用」/ 被拒 / 过期：指导那一刻记进工具箱的那条「规矩」没落成，一起退役
        if (SETTLED.has(item.state)) options.retireCatalog?.(item.workspace_id, `rule:${item.id}`)
        return undefined
      }
      const out = book.add(rule)
      if (out.added)
        emit('role_rule.added', item.workspace_id, rule.by, out.rule, {
          source_card_id: item.id,
        })
      return out.rule
    },
    section: (workspace_id, role_id) => book.section(workspace_id, role_id),
    undo(undo, by) {
      if (undo.before === null) {
        const gone = book.remove(undo.rule_id)
        if (gone !== undefined)
          emit('role_rule.removed', gone.workspace_id, by, gone, { undo: true })
        return
      }
      book.put(undo.before)
      const entry = ruleCatalogId(undo.before)
      if (entry !== undefined && undo.catalog_note !== undefined && undo.catalog_note !== null)
        options.restoreCatalog?.(undo.before.workspace_id, entry, undo.catalog_note)
      emit('role_rule.restored', undo.before.workspace_id, by, undo.before)
    },
  }
}

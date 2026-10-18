/**
 * WP406（私有 docs/107 §4 / §5 / §7 / §15，Luoye 10-19 定）：**用户端收官方岗位更新**。
 *
 * 只从云上「官方订阅」那几条路取（`/v1/content/official/*`，令牌动作集 `content`）；清单只认
 * `OFFICIAL_CONTENT_SIGNING_PUBLIC_KEYS` 这张表验签、只收 `source: 'official'`。docs/90 的公开通道代码留着，不再查。
 *
 * 1. **订阅**：每次查新先问一次订阅（本机记 7 天：断网 7 天内照常，过了只暂停查新，已有内容不动）。
 *    没关联账号 / 没订阅 → 不出卡；岗位设定里一行小字（云上摘要，关掉 30 天不提）。
 * 2. **收包**：签名、序号、来源、最低版本、每个文件的哈希、每一项的形状（职责 / 岗位内容过 WP404 的白名单、
 *    叠到骨架上再过一遍；规则表每行带 id；知识包读得懂）——**任何一处不过整包拒收**，什么都不写。
 * 3. **出卡**：按品牌、按岗位；一个岗位一周最多一张（一周内后来的并进还没处理的那张，急件单出）；
 *    用户没开的岗位不出；岗位设成「不再更新」的不出；「没撞的自动应用」先把没撞的应用掉，撞了的照样出卡。
 * 4. **应用**：只换最底下那一层（保留上一版一份，docs/90 的 `previous`）；你改的、AI 学的全在上面，原样不动；
 *    撞了的那几处「全部应用」时先保留你的、标出来，第三栏三栏对照里再选（用新版 / 保留我的 / 用 AI 合好的这版）。
 * 5. **退回**：整批退回上一批、单项退回；应用时顺手动过的「你的」（照抄旧版的、选了用新版的）一起还原。
 * 6. **权限**：公司模式只有品牌负责人与这个岗位的负责人能应用 / 退回（`canApplyContentUpdates`，这里判一处）。
 *
 * 职责 / 岗位的内容层只落在**启动品牌**（和公司改角色定位同一层：这台机器上职责定义只有一份）；
 * 技能、规则表、知识包按品牌各管各的。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { ApiError } from '@agentsws/api'
import type {
  ApprovalItem,
  Clock,
  ContentAiMergeInput,
  ContentAiMergeResult,
  ContentAppliedBatch,
  ContentAppliedItem,
  ContentApplyInput,
  ContentChannel,
  ContentClashChoice,
  ContentDigestCardPayload,
  ContentDigestItem,
  ContentDigestMine,
  ContentItem,
  ContentItemDiffView,
  ContentManifest,
  ContentPart,
  ContentPublicKey,
  ContentRollbackInput,
  ContentSubscriptionView,
  ContentTableRow,
  DecideInput,
  EventEnvelope,
  KnownEventType,
  LocalizedText,
  OfficialContentSummary,
  OfficialSubscriptionLocalView,
  PersonaOverride,
  PersonaSubject,
  PersonaText,
  PersonId,
  PositionContent,
  PositionContentUpdatesView,
  PositionUpdatePolicy,
  RoleContent,
  RoleId,
  StorefrontPlatform,
  WorkspaceId,
} from '@agentsws/contracts'
import {
  CONTENT_BATCH_HISTORY_MAX,
  CONTENT_DIGEST_CARD_KIND,
  CONTENT_NUDGE_QUIET_DAYS,
  CONTENT_SUBSCRIPTION_PATH,
  canApplyContentUpdates,
  DEFAULT_POSITION_UPDATE_POLICY,
  isoWeekOf,
  OFFICIAL_CONTENT_PATHS,
  OFFICIAL_SUBSCRIPTION_CACHE_DAYS,
  skillOnPlatform,
} from '@agentsws/contracts'
import { builtinContentTableRows } from '@agentsws/core'
import type { PackFile } from '@agentsws/knowledge'
import {
  applyPersonaSectionOverride,
  bundledContentFiles,
  loadBundledPositionWithContent,
  loadBundledRoleWithContent,
  type RoleDefinitionFull,
} from '@agentsws/roles'
import {
  type AppliedContent,
  BUNDLED_SKILLS_DIR,
  bundledSkillVersion,
  CONTENT_REJECT_TEXT,
  CONTENT_UPDATE_SOURCE,
  ContentPackError,
  ContentStore,
  type ContentUserEdit,
  compareSkillVersions,
  contentItemFitsApp,
  type ItemUserEdit,
  listBundledSkills,
  type MemorySkillRegistry,
  planContentMerge,
  planItemMerge,
  readBundledSkill,
  verifyContentItemFiles,
  verifyContentManifest,
} from '@agentsws/skills'
import type { CloudBytesCallFn } from './cloud.js'
import type { KolCloudCallFn } from './kol-cloud-sync.js'
import {
  applyItemEdits,
  fieldPart,
  nameText,
  type OfficialPayload,
  parseOfficialItem,
  personaParts,
  rowParts,
  sameJson,
} from './official-content-kinds.js'

/** 官方订阅那一份放在内容更新存放处底下的这个子目录（与 docs/90 公开通道的那份分开）。 */
export const OFFICIAL_CONTENT_DIR = 'official'

/** 这一版用户端能落地的官方内容种类。 */
export const OFFICIAL_CONTENT_KINDS: readonly ContentItem['kind'][] = [
  'skill',
  'role_content',
  'position_content',
  'rules',
  'knowledge',
]

// ---------- 宿主给的 ----------

export interface OfficialBrand {
  id: WorkspaceId
  owner_id?: PersonId
}

/** 这个品牌里**开着的**岗位（有人在里面担着职责的）。 */
export interface OfficialPosition {
  id: string
  name: LocalizedText
  roles: readonly string[]
  supervisor_person_id?: PersonId
}

export interface OfficialCloud {
  linked(): boolean
  call: KolCloudCallFn
  callBytes?: CloudBytesCallFn
}

/** 公司改的角色定位那一层（`personas.ts` 的存放处）。 */
export interface OfficialPersonaStore {
  get(subject: PersonaSubject): PersonaOverride | undefined
  put(row: PersonaOverride): void
  remove(subject: PersonaSubject): void
}

export interface OfficialRoleRegistry {
  get(id: RoleId): RoleDefinitionFull | undefined
  register(def: RoleDefinitionFull): void
}

export interface OfficialKnowledgeHost {
  /** 导入一个官方知识包，回导入的事实卡 id（承诺类照规矩落候选）。 */
  import(ws: WorkspaceId, files: readonly PackFile[]): Promise<string[]>
  retire(ws: WorkspaceId, ids: readonly string[]): Promise<void>
}

interface ApprovalsLike {
  create(input: never): Promise<ApprovalItem>
  get(id: string): Promise<ApprovalItem | undefined>
  expireNow?(id: string, reason: string): Promise<ApprovalItem | undefined>
}

export interface OfficialContentOptions {
  /** 存放处（`<数据目录>/content-updates/official`）。 */
  root: string
  appVersion: string
  channel: ContentChannel
  /** 只认这张表（`OFFICIAL_CONTENT_SIGNING_PUBLIC_KEYS`；测试注入现生成的）。 */
  keys: readonly ContentPublicKey[]
  clock: Clock
  registry: MemorySkillRegistry
  bundledDir?: string
  /** 启动品牌：职责 / 岗位的内容层只落在它上面。 */
  bootWorkspace: WorkspaceId
  brands(): Promise<readonly OfficialBrand[]>
  positions(ws: WorkspaceId): readonly OfficialPosition[]
  /** 有没有审批流（公司模式）。 */
  company(ws: WorkspaceId): Promise<boolean>
  isOwner(ws: WorkspaceId, person: PersonId): Promise<boolean>
  platformOf?(ws: WorkspaceId): StorefrontPlatform | undefined
  cloud(ws: WorkspaceId): Promise<OfficialCloud | undefined>
  approvals(): ApprovalsLike | undefined
  appendEvent(e: Omit<EventEnvelope, 'id' | 'at'>): void
  roles?: OfficialRoleRegistry
  personas?: OfficialPersonaStore
  knowledge?: OfficialKnowledgeHost
  /** AI 一句建议（品牌默认模型；没模型回 `undefined`，卡上就不写这句）。 */
  advise?(
    ws: WorkspaceId,
    input: { position: string; items: { title: string; summary: string; mine: string }[] },
  ): Promise<string | undefined>
  /** AI 合一版（三方原文 → 一段；只出不落）。 */
  aiMerge?(
    ws: WorkspaceId,
    input: { label: string; before?: string; after?: string; mine?: string },
  ): Promise<string | undefined>
  /** 关着的原因（没开）：给了就不查。 */
  off?: string
}

export interface OfficialCheckReport {
  state: 'ok' | 'off' | 'error'
  serial?: number
  reason?: string
  text?: string
  /** `<品牌>:<岗位>@<周>` 出 / 并了的卡。 */
  carded: string[]
  /** `<品牌>:<条目>@<版本>` 自动应用了的。 */
  applied: string[]
}

export interface OfficialContent {
  check(): Promise<OfficialCheckReport>
  restore(): Promise<void>
  view(ws: WorkspaceId, position_id: string, person: PersonId): Promise<PositionContentUpdatesView>
  setPolicy(
    ws: WorkspaceId,
    position_id: string,
    person: PersonId,
    policy: PositionUpdatePolicy,
  ): Promise<PositionContentUpdatesView>
  diff(ws: WorkspaceId, position_id: string, item_id: string): ContentItemDiffView
  apply(
    ws: WorkspaceId,
    position_id: string,
    person: PersonId,
    input: ContentApplyInput,
  ): Promise<PositionContentUpdatesView>
  skip(ws: WorkspaceId, position_id: string, person: PersonId): Promise<PositionContentUpdatesView>
  aiMerge(
    ws: WorkspaceId,
    position_id: string,
    person: PersonId,
    input: ContentAiMergeInput,
  ): Promise<ContentAiMergeResult>
  rollback(
    ws: WorkspaceId,
    position_id: string,
    person: PersonId,
    input: ContentRollbackInput,
  ): Promise<PositionContentUpdatesView>
  dismissNudge(
    ws: WorkspaceId,
    position_id: string,
    person: PersonId,
  ): Promise<PositionContentUpdatesView>
  subscription(ws: WorkspaceId): Promise<OfficialSubscriptionLocalView>
  subscribe(ws: WorkspaceId, person: PersonId): Promise<OfficialSubscriptionLocalView>
  /** 官方岗位内容里这个岗位的角色定位（`personas.ts` 当「包里的原文」用；没应用过 = `undefined`）。 */
  positionPersona(position_id: string): PersonaText | undefined
  /** 规则表的覆盖源（官方版 + 你的改动；都没有 = `undefined`，用随软件带的）。 */
  tableRows(ws: WorkspaceId | undefined, table: string): readonly ContentTableRow[] | undefined
  /** 快捷问题 / 示例任务 / 规则表「你的」那一层（以后的编辑界面与测试用）。 */
  setItemEdits(ws: WorkspaceId, target: string, edits: readonly ItemUserEdit[]): void
  itemEdits(ws: WorkspaceId, target: string): readonly ItemUserEdit[]
  wrap<B extends { decide(id: string, by: never, input: DecideInput): Promise<ApprovalItem> }>(
    bus: B,
  ): B
}

/** 随软件带的职责 / 岗位内容（读一次盘就够：安装包里的 yml 不会在进程里变）。 */
let bundledFiles: ReturnType<typeof bundledContentFiles> | undefined

// ---------- 本机状态 ----------

/** 一批应用时顺手动过的「你的」：退回时一起还原。 */
interface UndoSnapshot {
  persona?: { subject: PersonaSubject; row?: PersonaOverride }[]
  item_edits?: { target: string; edits: ItemUserEdit[] }[]
  /** 技能里动过的那几处「你的」（动之前的样子）。 */
  skill_edits?: ContentUserEdit[]
  /** 这一版知识包导入的事实卡（退回时撤下）。 */
  knowledge_ids?: string[]
}

interface StoredBatch {
  batch_id: string
  position_id: string
  applied_at: string
  by: 'auto' | 'person'
  person_id?: PersonId
  items: {
    item_id: string
    version: string
    undo: UndoSnapshot
    /** 应用那一刻这一项拆成的几段 / 几条（应用后第三栏「撞了先保留你的」从这里读）。 */
    parts?: ContentPart[]
  }[]
}

interface StoredCard {
  card_id: string
  week: string
  urgent: boolean
  /** `<条目>@<版本>`。 */
  items: string[]
}

/** 一个品牌的「岗位更新」状态（`workspaces/<品牌>/digest.json`）。 */
interface BrandDigestState {
  policies: Record<string, PositionUpdatePolicy>
  cards: Record<string, StoredCard[]>
  /** 这个岗位最近一张普通卡是哪一周出的（一周最多一张）。 */
  last_card_week: Record<string, string>
  /** 这个岗位这周点过「这次跳过」。 */
  skipped_week: Record<string, string>
  batches: StoredBatch[]
  /** 快捷问题 / 示例任务 / 规则表「你的」那一层：`role:<id>:quick_prompts`、`rules:<表>`。 */
  item_edits: Record<string, ItemUserEdit[]>
  /** 撞了的那几处选过什么（`<条目>@<版本>#<段>`）。 */
  choices: Record<string, ContentClashChoice>
  /** 应用时这一项归哪几个岗位（清单换了也认得出）。 */
  applied_positions: Record<string, string[]>
  /** 知识包导入的事实卡（按条目）。 */
  knowledge_ids: Record<string, string[]>
  /** 没订阅那一行小字关到哪天。 */
  nudge_quiet_until: Record<string, string>
}

const emptyBrand = (): BrandDigestState => ({
  policies: {},
  cards: {},
  last_card_week: {},
  skipped_week: {},
  batches: [],
  item_edits: {},
  choices: {},
  applied_positions: {},
  knowledge_ids: {},
  nudge_quiet_until: {},
})

/** 订阅在本机记的那一份（按品牌：每个品牌拿自己的令牌问，同公司问到的是同一份）。 */
interface SubscriptionCache {
  view?: ContentSubscriptionView
  checked_at?: string
  /** 最近一次问的结果（`reauth` / `unlinked` / `offline` / `missing` = 云上没这条路）。 */
  last?: 'ok' | 'reauth' | 'unlinked' | 'offline' | 'missing'
  summary?: OfficialContentSummary
  summary_at?: string
}

function readJsonFile<T>(path: string, fallback: () => T): T {
  if (!existsSync(path)) return fallback()
  try {
    return { ...fallback(), ...(JSON.parse(readFileSync(path, 'utf8')) as T) }
  } catch {
    return fallback()
  }
}

function writeJsonFile(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${process.pid}`
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`)
  renameSync(tmp, path)
}

const ACTIVE_CARD = new Set([
  'proposed',
  'pending',
  'in_review',
  'deferred',
  'approved',
  'approved_edited',
])
const OWNER_ROLE = 'common.owner'
const TIMEOUT_MS = 30_000
const SUMMARY_TTL_MS = 6 * 60 * 60 * 1000
const DIGEST_OPTIONS = [
  { id: 'apply_all', label: '全部应用' },
  { id: 'skip', label: '这次跳过' },
] as const

const tagOf = (item: Pick<ContentItem, 'id' | 'version'>): string => `${item.id}@${item.version}`
const nameOfId = (id: string): string => id.slice(id.indexOf(':') + 1)
const kindOfId = (id: string): string => id.slice(0, id.indexOf(':'))
const forbidden = (reason: string): ApiError => new ApiError('forbidden', reason)

export function createOfficialContent(options: OfficialContentOptions): OfficialContent {
  const store = new ContentStore(options.root)
  const bundledDir = options.bundledDir ?? BUNDLED_SKILLS_DIR
  const registry = options.registry
  const boot = options.bootWorkspace
  const now = (): string => options.clock.now()
  let seq = 0

  // ---------- 读写 ----------

  const brandPath = (ws: string): string =>
    join(options.root, 'workspaces', encodeURIComponent(ws), 'digest.json')
  const readBrand = (ws: string): BrandDigestState => readJsonFile(brandPath(ws), emptyBrand)
  const writeBrand = (ws: string, st: BrandDigestState): void => {
    writeJsonFile(brandPath(ws), st)
  }
  const subPath = join(options.root, 'subscription.json')
  const readSubs = (): Record<string, SubscriptionCache> =>
    readJsonFile<Record<string, SubscriptionCache>>(subPath, () => ({}))
  const writeSub = (ws: string, patch: SubscriptionCache): SubscriptionCache => {
    const all = readSubs()
    const next = { ...(all[ws] ?? {}), ...patch }
    all[ws] = next
    writeJsonFile(subPath, all)
    return next
  }

  const emit = (ws: string, type: KnownEventType, payload: Record<string, unknown>): void => {
    options.appendEvent({
      schema_version: 1,
      workspace_id: ws as EventEnvelope['workspace_id'],
      type,
      actor: { kind: 'system', id: 'official-content' },
      correlation: { trace_id: `trc_official_${Date.parse(now()).toString(36)}` },
      payload,
    })
  }

  const manifest = (): ContentManifest | undefined => store.readGlobal().manifest
  const itemOf = (id: string): ContentItem | undefined => manifest()?.items.find((i) => i.id === id)

  // ---------- 读一项 ----------

  /** 已经落盘的一项（清单里的或应用过的那一版）读出来；读不出回 `undefined`。 */
  const payloadCache = new Map<string, OfficialPayload>()
  const payloadOf = (
    item: Pick<ContentItem, 'id' | 'kind' | 'name' | 'sha256' | 'files'>,
  ): OfficialPayload | undefined => {
    const hit = payloadCache.get(item.sha256)
    if (hit !== undefined) return hit
    const files = new Map<string, Buffer>()
    for (const f of item.files) {
      const b = store.readBlob(f.sha256)
      if (b === undefined) return undefined
      files.set(f.path, b)
    }
    try {
      const p = parseOfficialItem(item as ContentItem, files)
      payloadCache.set(item.sha256, p)
      return p
    } catch {
      return undefined
    }
  }
  /** 这个品牌这一项现在用的那一版（应用过的官方版）。 */
  const appliedOf = (ws: WorkspaceId, id: string): AppliedContent | undefined =>
    store.readWorkspace(ws).items[id]?.current
  const appliedPayload = (ws: WorkspaceId, id: string): OfficialPayload | undefined => {
    const cur = appliedOf(ws, id)
    return cur === undefined
      ? undefined
      : payloadOf({ id, kind: kindOfId(id) as ContentItem['kind'], name: nameOfId(id), ...cur })
  }

  const bundledRoleContent = (id: string): RoleContent | undefined => {
    bundledFiles ??= bundledContentFiles()
    return bundledFiles.roles.find((r) => r.id === id)?.content
  }
  const bundledPositionContent = (id: string): PositionContent | undefined => {
    bundledFiles ??= bundledContentFiles()
    return bundledFiles.positions.find((p) => p.id === id)?.content
  }

  /** 这一项现在的底版（应用过的官方版，没有就是随软件带的）。 */
  const baseRole = (id: string): RoleContent | undefined => {
    const p = appliedPayload(boot, `role_content:${id}`)
    return p?.kind === 'role_content' ? p.content : bundledRoleContent(id)
  }
  const basePosition = (id: string): PositionContent | undefined => {
    const p = appliedPayload(boot, `position_content:${id}`)
    return p?.kind === 'position_content' ? p.content : bundledPositionContent(id)
  }
  const baseRows = (ws: WorkspaceId, table: string): readonly ContentTableRow[] => {
    const p = appliedPayload(ws, `rules:${table}`)
    return p?.kind === 'rules' ? p.rows : (builtinContentTableRows(table) ?? [])
  }
  const newSkillMarkdown = (item: ContentItem): string | undefined => {
    try {
      return readBundledSkill(item.name, store.ensureTree(item)).markdown
    } catch {
      return undefined
    }
  }

  const itemEditsOf = (ws: WorkspaceId, target: string): ItemUserEdit[] =>
    readBrand(ws).item_edits[target] ?? []
  const personaSubjectOf = (item: Pick<ContentItem, 'kind' | 'name'>): PersonaSubject =>
    ({
      kind: item.kind === 'position_content' ? 'position' : 'role',
      id: item.name,
    }) as PersonaSubject

  // ---------- 这一项落不落、新不新、归哪几个岗位 ----------

  const supported = (item: ContentItem): boolean =>
    OFFICIAL_CONTENT_KINDS.includes(item.kind) && contentItemFitsApp(item, options.appVersion)

  /** 这个品牌收不收这一项（职责 / 岗位内容只落启动品牌、只认随软件带着的那几条；平台专属的只落对的平台）。 */
  const applicable = (ws: WorkspaceId, item: ContentItem): boolean => {
    if (!supported(item)) return false
    if (item.kind === 'role_content')
      return ws === boot && bundledRoleContent(item.name) !== undefined
    if (item.kind === 'position_content')
      return ws === boot && bundledPositionContent(item.name) !== undefined
    const platform = options.platformOf?.(ws)
    if (item.kind === 'skill' && !skillOnPlatform(item.name, platform)) return false
    if (item.platforms === undefined || item.platforms.length === 0) return true
    return platform !== undefined && item.platforms.includes(platform)
  }

  /** 官方这一版和现在用的不一样，而且没被退回过。 */
  const newer = (ws: WorkspaceId, item: ContentItem): boolean => {
    const st = store.readWorkspace(ws).items[item.id]
    if (st?.skipped_version === item.version) return false
    const cur = st?.current
    if (cur !== undefined)
      return cur.sha256 !== item.sha256 && compareSkillVersions(item.version, cur.version) > 0
    if (item.kind === 'skill') {
      if (!listBundledSkills(bundledDir).includes(item.name)) return true
      const bundled = bundledSkillVersion(readBundledSkill(item.name, bundledDir).markdown)
      return compareSkillVersions(item.version, bundled) > 0
    }
    const p = payloadOf(item)
    if (p === undefined) return false
    if (p.kind === 'role_content' || p.kind === 'position_content') {
      const base = (
        p.kind === 'role_content' ? bundledRoleContent(p.id) : bundledPositionContent(p.id)
      ) as Record<string, unknown> | undefined
      const next = p.content as Record<string, unknown>
      return !Object.keys(next).every((k) => sameJson(next[k], base?.[k]))
    }
    if (p.kind === 'rules') return !sameJson(p.rows, builtinContentTableRows(p.table) ?? [])
    return true
  }

  /** 这一项归这个品牌里开着的哪几个岗位（清单写了按清单；没写的职责 / 岗位内容按挂在哪个岗位推）。 */
  const positionsOf = (
    item: Pick<ContentItem, 'kind' | 'name' | 'positions'>,
    enabled: readonly OfficialPosition[],
  ): OfficialPosition[] => {
    if (item.positions !== undefined && item.positions.length > 0)
      return enabled.filter((p) => item.positions?.includes(p.id))
    if (item.kind === 'role_content') return enabled.filter((p) => p.roles.includes(item.name))
    if (item.kind === 'position_content') return enabled.filter((p) => p.id === item.name)
    return []
  }

  // ---------- 技能：你的那几层 ----------

  /** 你的改动（上层记录里替换了基础层的段、overlay 的 op）——与 docs/90 同一份读法。 */
  function skillEdits(
    ws: WorkspaceId,
    name: string,
    baseIds: ReadonlySet<string>,
  ): ContentUserEdit[] {
    const { records, overlays } = registry.listUpperLayers(name, ws)
    const edits: ContentUserEdit[] = []
    for (const rec of records)
      for (const s of rec.sections)
        if (baseIds.has(s.id))
          edits.push({
            tier: rec.tier,
            owner: rec.scope_id ?? (typeof rec.owner === 'string' ? rec.owner : ws),
            source: 'layer',
            op: 'replace',
            section_id: s.id,
            body: s.body,
          })
    for (const o of overlays)
      for (const op of o.ops)
        edits.push({
          tier: o.tier,
          owner: o.owner,
          source: 'overlay',
          op: op.op,
          section_id: op.section_id,
          ...(op.body === undefined ? {} : { body: op.body }),
        })
    return edits
  }

  const skillBaseSections = (ws: WorkspaceId, name: string) =>
    (registry.peek(name, 'package', { workspace_id: ws }) ?? registry.peek(name, 'package'))
      ?.sections ?? []

  function skillPlan(ws: WorkspaceId, item: ContentItem) {
    const before = skillBaseSections(ws, item.name)
    const md = newSkillMarkdown(item)
    const after = md === undefined ? [] : registry.parse(md, before)
    const edits = skillEdits(ws, item.name, new Set(before.map((s) => s.id)))
    return { before, after, edits, plan: planContentMerge(before, after, edits) }
  }

  function skillParts(ws: WorkspaceId, item: ContentItem): ContentPart[] {
    const { before, after, edits, plan } = skillPlan(ws, item)
    const old = new Map(before.map((s) => [s.id, s]))
    const now = new Map(after.map((s) => [s.id, s]))
    const clash = new Set(
      plan.conflicts.filter((c) => c.mine.trim() !== c.base_before.trim()).map((c) => c.section_id),
    )
    const mineOf = new Map(edits.filter((e) => e.body !== undefined).map((e) => [e.section_id, e]))
    const parts: ContentPart[] = []
    for (const s of after) {
      const was = old.get(s.id)
      if (was !== undefined && was.body.trim() === s.body.trim()) continue
      const mine = mineOf.get(s.id)
      parts.push({
        key: `section.${s.id}`,
        label: s.heading === '' ? '开头' : s.heading,
        change: was === undefined ? 'added' : 'changed',
        ...(was === undefined ? {} : { before: was.body }),
        after: s.body,
        ...(mine?.body === undefined ? {} : { edited: true, mine: mine.body }),
        ...(clash.has(s.id) ? { clash: true } : {}),
        mergeable: true,
      })
    }
    for (const s of before)
      if (!now.has(s.id))
        parts.push({
          key: `section.${s.id}`,
          label: s.heading === '' ? '开头' : s.heading,
          change: 'removed',
          before: s.body,
        })
    return parts
  }

  // ---------- 一项拆成几段 / 几条 ----------

  function partsOf(ws: WorkspaceId, item: ContentItem): ContentPart[] {
    if (item.kind === 'skill') return skillParts(ws, item)
    const p = payloadOf(item)
    if (p === undefined) return []
    if (p.kind === 'role_content') {
      const before = baseRole(p.id) ?? {}
      const after = p.content
      const g0 = new Map((before.grounding ?? []).map((g) => [g.name, g]))
      return [
        ...fieldPart('name', '名字', nameText(before.name), nameText(after.name)),
        ...fieldPart('description', '一句话说明', before.description, after.description),
        ...(after.persona === undefined
          ? []
          : personaParts(
              'persona',
              before.persona,
              after.persona,
              options.personas?.get({ kind: 'role', id: p.id as RoleId }),
            )),
        ...(after.quick_prompts === undefined
          ? []
          : rowParts(
              'quick_prompts',
              before.quick_prompts ?? [],
              after.quick_prompts,
              itemEditsOf(boot, `role:${p.id}:quick_prompts`),
            )),
        ...(after.task_examples === undefined
          ? []
          : rowParts(
              'task_examples',
              before.task_examples ?? [],
              after.task_examples,
              itemEditsOf(boot, `role:${p.id}:task_examples`),
            )),
        ...(after.grounding ?? []).flatMap((g) => {
          const was = g0.get(g.name)
          const terms = (x: typeof g | undefined): string | undefined =>
            x === undefined
              ? undefined
              : [...(x.intent_terms ?? []), ...(x.cue_terms ?? [])].join('、')
          return fieldPart(`grounding.${g.name}`, `意图词 · ${g.name}`, terms(was), terms(g))
        }),
      ]
    }
    if (p.kind === 'position_content') {
      const before = basePosition(p.id) ?? {}
      const after = p.content
      const roles = (r: PositionContent['roles']): string | undefined =>
        r === undefined
          ? undefined
          : r.map((x) => (x.default ? x.role : `${x.role}（可选）`)).join('、')
      return [
        ...fieldPart('name', '名字', nameText(before.name), nameText(after.name)),
        ...(after.persona === undefined
          ? []
          : personaParts(
              'persona',
              before.persona,
              after.persona,
              options.personas?.get({ kind: 'position', id: p.id }),
            )),
        ...fieldPart('roles', '挂哪几条职责', roles(before.roles), roles(after.roles)),
      ]
    }
    if (p.kind === 'rules')
      return rowParts('row', baseRows(ws, p.table), p.rows, itemEditsOf(ws, `rules:${p.table}`))
    if (p.kind === 'knowledge') {
      const prev = appliedPayload(ws, item.id)
      const had = new Set(prev?.kind === 'knowledge' ? prev.titles : [])
      return p.titles
        .filter((t) => !had.has(t))
        .map((t, i) => ({ key: `entry.${i}`, label: t, change: 'added' as const, after: t }))
    }
    return []
  }

  /** 这一项上面有没有「你的」（公司改的角色定位、快捷问题 / 规则表的改动、技能上面几层）。 */
  function hasMine(ws: WorkspaceId, item: ContentItem): boolean {
    if (item.kind === 'role_content')
      return (
        options.personas?.get({ kind: 'role', id: item.name as RoleId }) !== undefined ||
        itemEditsOf(boot, `role:${item.name}:quick_prompts`).length > 0 ||
        itemEditsOf(boot, `role:${item.name}:task_examples`).length > 0
      )
    if (item.kind === 'position_content')
      return options.personas?.get({ kind: 'position', id: item.name }) !== undefined
    if (item.kind === 'rules') return itemEditsOf(ws, `rules:${item.name}`).length > 0
    if (item.kind === 'skill') {
      const base = new Set(skillBaseSections(ws, item.name).map((s) => s.id))
      return skillEdits(ws, item.name, base).length > 0
    }
    return false
  }

  /** 卡上每项右边那几个字：撞了 / 你改过、会保留 / 没改过。 */
  const mineOf = (
    ws: WorkspaceId,
    item: ContentItem,
    parts: readonly ContentPart[],
  ): ContentDigestMine =>
    parts.some((x) => x.clash === true)
      ? 'clash'
      : parts.some((x) => x.edited === true) || hasMine(ws, item)
        ? 'kept'
        : 'untouched'

  /** 卡上 / 第三栏的一项。 */
  function digestItemOf(ws: WorkspaceId, item: ContentItem): ContentDigestItem {
    const cur = appliedOf(ws, item.id)
    const bundled =
      item.kind === 'skill' && listBundledSkills(bundledDir).includes(item.name)
        ? bundledSkillVersion(readBundledSkill(item.name, bundledDir).markdown)
        : undefined
    const added =
      cur === undefined &&
      (item.kind === 'skill'
        ? bundled === undefined
        : item.kind === 'knowledge'
          ? true
          : item.kind === 'rules'
            ? builtinContentTableRows(item.name) === undefined
            : false)
    const from = cur?.version ?? bundled
    return {
      item_id: item.id,
      kind: item.kind,
      name: item.name,
      version: item.version,
      ...(from === undefined ? {} : { from_version: from }),
      title: item.title,
      summary: item.summary,
      mine: mineOf(ws, item, partsOf(ws, item)),
      ...(added ? { added: true } : {}),
      ...(item.urgent === true ? { urgent: true } : {}),
    }
  }

  // ---------- 换底版：每一种各自的落法 ----------

  const overriddenRoles = new Set<string>()
  /** 启动品牌：职责定义 = 随软件带的 + 官方内容层 + 快捷问题 / 示例任务「你的」那一层。 */
  function registerRole(id: string): void {
    const roles = options.roles
    if (roles === undefined) return
    const p = appliedPayload(boot, `role_content:${id}`)
    const layer = p?.kind === 'role_content' ? p.content : undefined
    const qp = itemEditsOf(boot, `role:${id}:quick_prompts`)
    const te = itemEditsOf(boot, `role:${id}:task_examples`)
    if (layer === undefined && qp.length === 0 && te.length === 0) {
      if (overriddenRoles.has(id)) {
        roles.register(loadBundledRoleWithContent(id as RoleId, {}))
        overriddenRoles.delete(id)
      }
      return
    }
    const bundled = bundledRoleContent(id)
    const content: RoleContent = { ...(layer ?? {}) }
    if (qp.length > 0)
      content.quick_prompts = applyItemEdits(
        layer?.quick_prompts ?? bundled?.quick_prompts ?? [],
        qp,
      )
    if (te.length > 0)
      content.task_examples = applyItemEdits(
        layer?.task_examples ?? bundled?.task_examples ?? [],
        te,
      )
    // 叠上你的之后过不了骨架那一关（比如超了条数）：先只叠官方那一层，再不行就随软件带的
    for (const c of [content, layer ?? {}]) {
      try {
        roles.register(loadBundledRoleWithContent(id as RoleId, c))
        overriddenRoles.add(id)
        return
      } catch {
        /* 下一个 */
      }
    }
  }

  const positionPersonaCache = new Map<string, PersonaText | undefined>()
  function positionPersona(id: string): PersonaText | undefined {
    if (positionPersonaCache.has(id)) return positionPersonaCache.get(id)
    const p = appliedPayload(boot, `position_content:${id}`)
    let out: PersonaText | undefined
    if (p?.kind === 'position_content' && p.content.persona !== undefined)
      try {
        out = loadBundledPositionWithContent(id, { persona: p.content.persona }).persona
      } catch {
        out = undefined
      }
    positionPersonaCache.set(id, out)
    return out
  }

  const tableCache = new Map<string, readonly ContentTableRow[] | undefined>()
  function tableRows(ws: WorkspaceId | undefined, table: string) {
    const brand = (ws ?? boot) as WorkspaceId
    const key = `${brand}\u0000${table}`
    if (tableCache.has(key)) return tableCache.get(key)
    const p = appliedPayload(brand, `rules:${table}`)
    const edits = itemEditsOf(brand, `rules:${table}`)
    const out =
      p === undefined && edits.length === 0
        ? undefined
        : applyItemEdits(
            (p?.kind === 'rules' ? p.rows : (builtinContentTableRows(table) ?? [])) as {
              id: string
            }[],
            edits,
          )
    tableCache.set(key, out)
    return out
  }

  /** 技能库里这个品牌的基础层换成应用过的那一版（`undefined` = 退回随软件带的）。 */
  async function putSkillBase(ws: WorkspaceId, name: string): Promise<void> {
    const cur = appliedOf(ws, `skill:${name}`)
    if (cur === undefined) {
      registry.drop(name, 'package', { workspace_id: ws })
      return
    }
    const md = readBundledSkill(
      name,
      store.ensureTree({ name, sha256: cur.sha256, files: cur.files }),
    ).markdown
    await registry.putFromMarkdown({
      markdown: md,
      tier: 'package',
      owner: 'package',
      version: cur.version,
      workspace_id: ws,
      source: { package: CONTENT_UPDATE_SOURCE, version: cur.version },
    })
  }

  /** 状态换了之后让它生效（技能库 / 职责定义 / 缓存）。 */
  async function effect(ws: WorkspaceId, id: string): Promise<void> {
    const kind = kindOfId(id)
    const name = nameOfId(id)
    if (kind === 'skill') await putSkillBase(ws, name)
    if (kind === 'role_content' && ws === boot) registerRole(name)
    if (kind === 'position_content') positionPersonaCache.delete(name)
    if (kind === 'rules') tableCache.clear()
  }

  // ---------- 你的那一层：动之前记一笔 ----------

  function touchPersona(undo: UndoSnapshot, subject: PersonaSubject): void {
    if (undo.persona?.some((p) => p.subject.kind === subject.kind && p.subject.id === subject.id))
      return
    const row = options.personas?.get(subject)
    undo.persona = [...(undo.persona ?? []), { subject, ...(row === undefined ? {} : { row }) }]
  }

  function touchEdits(undo: UndoSnapshot, ws: WorkspaceId, target: string): void {
    if (undo.item_edits?.some((e) => e.target === target)) return
    undo.item_edits = [...(undo.item_edits ?? []), { target, edits: itemEditsOf(ws, target) }]
  }

  function setEdits(ws: WorkspaceId, target: string, edits: readonly ItemUserEdit[]): void {
    const st = readBrand(ws)
    if (edits.length === 0) delete st.item_edits[target]
    else st.item_edits[target] = [...edits]
    writeBrand(ws, st)
    tableCache.clear()
  }

  /** 角色定位「你的」那一份里去掉 / 换掉一段（`section` 不给 = 整段那一种）。 */
  function changePersona(
    subject: PersonaSubject,
    section: string | undefined,
    text: string | undefined,
  ): void {
    const personas = options.personas
    const row = personas?.get(subject)
    if (personas === undefined || row === undefined) return
    const packaged =
      subject.kind === 'role'
        ? options.roles?.get(subject.id)?.persona
        : (positionPersona(subject.id) ?? basePosition(subject.id)?.persona)
    if (row.sections === undefined || section === undefined) {
      if (text === undefined) personas.remove(subject)
      else personas.put({ ...row, text, updated_at: now() })
      return
    }
    const zh = { ...(row.sections.zh ?? {}) } as Record<string, string>
    const en = { ...(row.sections.en ?? {}) } as Record<string, string>
    if (text === undefined) {
      delete zh[section]
      delete en[section]
    } else zh[section] = text
    if (Object.keys(zh).length === 0 && Object.keys(en).length === 0) {
      personas.remove(subject)
      return
    }
    const sections = {
      ...(Object.keys(zh).length === 0 ? {} : { zh }),
      ...(Object.keys(en).length === 0 ? {} : { en }),
    }
    const effective = applyPersonaSectionOverride(packaged, { text: row.text, sections })
    personas.put({
      ...row,
      sections,
      ...(effective === undefined ? {} : { text: effective }),
      updated_at: now(),
    })
  }

  /** 技能里你那一处：去掉（露出新版）或换成一段（AI 合好的）。 */
  async function changeSkillEdit(
    ws: WorkspaceId,
    name: string,
    e: ContentUserEdit,
    body: string | undefined,
  ): Promise<void> {
    if (e.source === 'overlay') {
      const o = registry.getOverlay(name, e.tier as never, e.owner)
      if (o === undefined) return
      await registry.setOverlay({
        ...o,
        ops:
          body === undefined
            ? o.ops.filter((op) => op.section_id !== e.section_id)
            : o.ops.map((op) => (op.section_id === e.section_id ? { ...op, body } : op)),
      })
      return
    }
    const rec = registry
      .listUpperLayers(name, ws)
      .records.find((r) => r.tier === e.tier && (r.scope_id ?? r.owner ?? ws) === e.owner)
    if (rec === undefined) return
    await registry.put({
      ...rec,
      sections:
        body === undefined
          ? rec.sections.filter((s) => s.id !== e.section_id)
          : rec.sections.map((s) => (s.id === e.section_id ? { ...s, body } : s)),
    })
  }

  /** 把技能里你那一处还原成动之前的样子（退回用）。 */
  async function restoreSkillEdit(ws: WorkspaceId, name: string, e: ContentUserEdit) {
    if (e.source === 'overlay') {
      const o = registry.getOverlay(name, e.tier as never, e.owner)
      if (o === undefined) return
      const rest = o.ops.filter((op) => op.section_id !== e.section_id)
      await registry.setOverlay({
        ...o,
        ops: [
          ...rest,
          {
            op: e.op,
            section_id: e.section_id,
            ...(e.body === undefined ? {} : { body: e.body }),
          } as never,
        ],
      })
      return
    }
    const rec = registry
      .listUpperLayers(name, ws)
      .records.find((r) => r.tier === e.tier && (r.scope_id ?? r.owner ?? ws) === e.owner)
    if (rec === undefined || e.body === undefined) return
    const base = skillBaseSections(ws, name).find((s) => s.id === e.section_id)
    const has = rec.sections.some((s) => s.id === e.section_id)
    await registry.put({
      ...rec,
      sections: has
        ? rec.sections.map((s) => (s.id === e.section_id ? { ...s, body: e.body ?? s.body } : s))
        : [
            ...rec.sections,
            {
              id: e.section_id,
              heading: base?.heading ?? '',
              body: e.body,
              origin: 'authored',
            },
          ],
    })
  }

  // ---------- 应用 ----------

  /**
   * 换完底版之后理一遍「你的」：只照抄了旧版的（没真改）跟新版走；在旧版后面追加了一句的接到新版后面；
   * 改成和新版一样的不用再留。**真撞了的一处不动**（你的照旧生效，等你在第三栏选）。
   */
  async function reconcile(
    ws: WorkspaceId,
    item: ContentItem,
    before: { role?: RoleContent; position?: PositionContent; rows?: readonly ContentTableRow[] },
    skillBefore: ReturnType<typeof skillPlan> | undefined,
    undo: UndoSnapshot,
  ): Promise<void> {
    const p = payloadOf(item)
    const personaOf = (x: RoleContent | PositionContent | undefined) => x?.persona
    if (p?.kind === 'role_content' || p?.kind === 'position_content') {
      const subject = personaSubjectOf(item)
      const row = options.personas?.get(subject)
      const old = personaOf(p.kind === 'role_content' ? before.role : before.position)
      const next = p.content.persona
      if (row !== undefined && next !== undefined) {
        const parts = personaParts('persona', old, next, row)
        for (const part of parts) {
          if (part.edited !== true || part.clash === true) continue
          touchPersona(undo, subject)
          changePersona(subject, part.key === 'persona' ? undefined : part.key.slice(8), undefined)
        }
      }
    }
    const lists: {
      target: string
      before: readonly { id: string }[]
      after?: readonly { id: string }[]
    }[] = []
    if (p?.kind === 'role_content') {
      lists.push({
        target: `role:${p.id}:quick_prompts`,
        before: before.role?.quick_prompts ?? [],
        ...(p.content.quick_prompts === undefined ? {} : { after: p.content.quick_prompts }),
      })
      lists.push({
        target: `role:${p.id}:task_examples`,
        before: before.role?.task_examples ?? [],
        ...(p.content.task_examples === undefined ? {} : { after: p.content.task_examples }),
      })
    }
    if (p?.kind === 'rules')
      lists.push({ target: `rules:${p.table}`, before: before.rows ?? [], after: p.rows })
    for (const l of lists) {
      const edits = itemEditsOf(ws, l.target)
      if (edits.length === 0 || l.after === undefined) continue
      const plan = planItemMerge(
        l.before.map((r) => ({ id: r.id, value: r })),
        l.after.map((r) => ({ id: r.id, value: r })),
        edits,
      )
      const drop = new Set(
        plan.clean
          .filter((c) => c.resolution === 'same' || c.resolution === 'follow_new')
          .map((c) => c.item_id),
      )
      const rebase = new Map(
        plan.clean.filter((c) => c.resolution === 'rebase').map((c) => [c.item_id, c.value_after]),
      )
      if (drop.size === 0 && rebase.size === 0) continue
      touchEdits(undo, ws, l.target)
      setEdits(
        ws,
        l.target,
        edits
          .filter((e) => !drop.has(e.item_id))
          .map((e) => (rebase.has(e.item_id) ? { ...e, value: rebase.get(e.item_id) } : e)),
      )
    }
    if (item.kind === 'skill' && skillBefore !== undefined)
      for (const c of skillBefore.plan.conflicts)
        if (c.mine.trim() === c.base_before.trim()) {
          undo.skill_edits = [...(undo.skill_edits ?? []), c]
          await changeSkillEdit(ws, item.name, c, undefined)
        }
  }

  /** 撞了的那一处按人选的落：用新版 = 去掉你那一处；用 AI 合好的 = 换成那一版；保留我的 = 不动。 */
  async function choose(
    ws: WorkspaceId,
    item: ContentItem,
    key: string,
    choice: ContentClashChoice,
    text: string | undefined,
    undo: UndoSnapshot,
  ): Promise<void> {
    if (choice === 'keep_mine') return
    if (choice === 'use_ai' && (text === undefined || text.trim() === '')) return
    const body = choice === 'use_new' ? undefined : text
    if (key === 'persona' || key.startsWith('persona.')) {
      const subject = personaSubjectOf(item)
      touchPersona(undo, subject)
      changePersona(subject, key === 'persona' ? undefined : key.slice(8), body)
      return
    }
    const row = /^(quick_prompts|task_examples|row)\.(.+)$/.exec(key)
    if (row !== null) {
      if (choice !== 'use_new') return
      const target = row[1] === 'row' ? `rules:${item.name}` : `role:${item.name}:${row[1] ?? ''}`
      touchEdits(undo, ws, target)
      setEdits(
        ws,
        target,
        itemEditsOf(ws, target).filter((e) => e.item_id !== row[2]),
      )
      return
    }
    if (key.startsWith('section.') && item.kind === 'skill') {
      const sid = key.slice(8)
      const base = new Set(skillBaseSections(ws, item.name).map((s) => s.id))
      for (const e of skillEdits(ws, item.name, base).filter((x) => x.section_id === sid)) {
        undo.skill_edits = [...(undo.skill_edits ?? []), e]
        await changeSkillEdit(ws, item.name, e, body)
      }
    }
  }

  const applying = new Set<string>()

  /** 应用一批（全部应用 / 挑着应用 / 自动应用）。已经应用过的那一项只落撞了那几处的选择。 */
  async function applyItems(
    ws: WorkspaceId,
    position_id: string,
    items: readonly ContentItem[],
    by: 'auto' | 'person',
    person: PersonId | undefined,
    input: ContentApplyInput = {},
  ): Promise<string[]> {
    const lock = `${ws}\u0000${position_id}`
    if (applying.has(lock)) throw new ApiError('conflict', '这个岗位的更新正在应用，稍等一下')
    applying.add(lock)
    const done: string[] = []
    try {
      seq += 1
      const batch: StoredBatch = {
        batch_id: `cb_${Date.parse(now()).toString(36)}_${seq}`,
        position_id,
        applied_at: now(),
        by,
        ...(person === undefined ? {} : { person_id: person }),
        items: [],
      }
      const enabled = options.positions(ws)
      for (const item of items) {
        const cur = appliedOf(ws, item.id)
        const fresh = cur?.sha256 !== item.sha256
        const undo: UndoSnapshot = {}
        let parts: ContentPart[] = []
        if (fresh) {
          if (!newer(ws, item) || !applicable(ws, item)) continue
          const before = {
            ...(item.kind === 'role_content' ? { role: baseRole(item.name) } : {}),
            ...(item.kind === 'position_content' ? { position: basePosition(item.name) } : {}),
            ...(item.kind === 'rules' ? { rows: baseRows(ws, item.name) } : {}),
          } as Parameters<typeof reconcile>[2]
          const skillBefore = item.kind === 'skill' ? skillPlan(ws, item) : undefined
          parts = partsOf(ws, item)
          if (item.kind === 'skill') store.ensureTree(item)
          const prev = store.apply(ws, item.id, {
            version: item.version,
            sha256: item.sha256,
            files: item.files,
            applied_at: now(),
            serial: manifest()?.serial ?? 0,
            by,
            upstream_published_at: item.upstream.published_at,
            title: item.title,
          })
          try {
            await effect(ws, item.id)
            if (item.kind === 'knowledge' && options.knowledge !== undefined) {
              const p = payloadOf(item)
              if (p?.kind === 'knowledge') {
                undo.knowledge_ids = await options.knowledge.import(ws, p.files)
                const st = readBrand(ws)
                st.knowledge_ids[item.id] = undo.knowledge_ids
                writeBrand(ws, st)
              }
            }
          } catch (e) {
            // 落不下去：状态退回原样，什么都没换
            const st = store.readWorkspace(ws)
            st.items[item.id] = { ...(prev === undefined ? {} : { current: prev }) }
            store.writeWorkspace(ws, st)
            await effect(ws, item.id).catch(() => undefined)
            throw e
          }
          await reconcile(ws, item, before, skillBefore, undo)
          const st = readBrand(ws)
          st.applied_positions[item.id] = [
            ...new Set([...positionsOf(item, enabled).map((p) => p.id), position_id]),
          ]
          writeBrand(ws, st)
        }
        // 撞了的那几处：人选过的照选的落
        for (const [k, choice] of Object.entries(input.choices ?? {})) {
          const [id, key] = [k.slice(0, k.indexOf('#')), k.slice(k.indexOf('#') + 1)]
          if (id !== item.id) continue
          const target = fresh ? undo : (latestBatchUndo(ws, item) ?? undo)
          await choose(ws, item, key, choice, input.ai_texts?.[k], target)
          const st = readBrand(ws)
          st.choices[`${tagOf(item)}#${key}`] = choice
          writeBrand(ws, st)
          if (!fresh) persistUndo(ws, item, target)
        }
        if (item.kind === 'role_content') registerRole(item.name)
        if (fresh) {
          batch.items.push({ item_id: item.id, version: item.version, undo, parts })
          done.push(item.id)
        }
      }
      if (batch.items.length > 0) {
        const st = readBrand(ws)
        st.batches = [...st.batches, batch].slice(-CONTENT_BATCH_HISTORY_MAX)
        writeBrand(ws, st)
        emit(ws, 'content_update.digest_applied', {
          position_id,
          item_ids: done,
          by,
        })
      }
      return done
    } finally {
      applying.delete(lock)
    }
  }

  /** 这一项最近那一批的「动之前」（应用之后再改主意也记进那一批，退回时一起还原）。 */
  function latestBatchUndo(ws: WorkspaceId, item: ContentItem): UndoSnapshot | undefined {
    const st = readBrand(ws)
    for (let i = st.batches.length - 1; i >= 0; i -= 1) {
      const hit = st.batches[i]?.items.find(
        (x) => x.item_id === item.id && x.version === item.version,
      )
      if (hit !== undefined) return hit.undo
    }
    return undefined
  }

  function persistUndo(ws: WorkspaceId, item: ContentItem, undo: UndoSnapshot): void {
    const st = readBrand(ws)
    for (let i = st.batches.length - 1; i >= 0; i -= 1) {
      const hit = st.batches[i]?.items.find(
        (x) => x.item_id === item.id && x.version === item.version,
      )
      if (hit !== undefined) {
        hit.undo = undo
        writeBrand(ws, st)
        return
      }
    }
  }

  // ---------- 退回 ----------

  async function rollbackItem(ws: WorkspaceId, item_id: string, undo: UndoSnapshot | undefined) {
    const out = store.rollback(ws, item_id)
    if (out === undefined) throw new ApiError('not_found', '这一项没有应用过，没什么可退回的')
    await effect(ws, item_id)
    const name = nameOfId(item_id)
    for (const p of [...(undo?.persona ?? [])].reverse())
      if (p.row === undefined) options.personas?.remove(p.subject)
      else options.personas?.put(p.row)
    for (const e of undo?.item_edits ?? []) setEdits(ws, e.target, e.edits)
    for (const e of [...(undo?.skill_edits ?? [])].reverse()) await restoreSkillEdit(ws, name, e)
    if (undo?.knowledge_ids !== undefined && undo.knowledge_ids.length > 0)
      await options.knowledge?.retire(ws, undo.knowledge_ids).catch(() => undefined)
    if (kindOfId(item_id) === 'role_content') registerRole(name)
    if (kindOfId(item_id) === 'knowledge') {
      const st = readBrand(ws)
      delete st.knowledge_ids[item_id]
      writeBrand(ws, st)
    }
    return out
  }

  // ---------- 订阅 ----------

  const DAY = 86_400_000
  function localOf(cache: SubscriptionCache | undefined): OfficialSubscriptionLocalView {
    if (cache?.last === 'unlinked') return { state: 'unlinked' }
    const view = cache?.view
    const checked = cache?.checked_at
    const validUntil =
      checked === undefined
        ? undefined
        : new Date(Date.parse(checked) + OFFICIAL_SUBSCRIPTION_CACHE_DAYS * DAY).toISOString()
    const base: OfficialSubscriptionLocalView = {
      state: 'none',
      ...(view === undefined ? {} : { credits_per_month: view.credits_per_month }),
      ...(checked === undefined ? {} : { checked_at: checked }),
      ...(validUntil === undefined ? {} : { valid_until: validUntil }),
      ...(view?.current_cycle_end === undefined
        ? {}
        : { current_cycle_end: view.current_cycle_end }),
      ...(view?.cancel_at_period_end === true ? { cancel_at_period_end: true } : {}),
    }
    if (cache?.last === 'reauth')
      return {
        ...base,
        state: 'reauth',
        note: 'Agents 工坊账号要重新登录一次才能收岗位更新：到「设置 → 账号与积分」登录。',
      }
    if (view === undefined)
      return cache?.last === 'offline'
        ? { ...base, state: 'paused', note: '这会儿问不到云，已有的内容照常用。' }
        : base
    if (cache?.last === 'ok') return { ...base, state: view.usable ? 'active' : 'none' }
    // 问不到云：本机记的 7 天内照常，过了只暂停查新
    if (!view.usable) return base
    return validUntil !== undefined && Date.parse(now()) < Date.parse(validUntil)
      ? { ...base, state: 'cached' }
      : { ...base, state: 'paused', note: '一周多没问到云，先暂停收新的；已经用上的照常。' }
  }

  const usable = (v: OfficialSubscriptionLocalView): boolean =>
    v.state === 'active' || v.state === 'cached'

  async function refreshSubscription(ws: WorkspaceId): Promise<OfficialSubscriptionLocalView> {
    const cloud = await options.cloud(ws).catch(() => undefined)
    if (cloud === undefined || !cloud.linked()) return localOf(writeSub(ws, { last: 'unlinked' }))
    const res = await cloud.call<ContentSubscriptionView>(CONTENT_SUBSCRIPTION_PATH, {
      timeout_ms: TIMEOUT_MS,
    })
    let cache: SubscriptionCache
    if (res.ok && res.data !== undefined)
      cache = writeSub(ws, { view: res.data, checked_at: now(), last: 'ok' })
    else if (
      res.status === 401 ||
      (res.status === 403 && res.details?.required_scope !== undefined)
    )
      cache = writeSub(ws, { last: 'reauth' })
    else if (res.status === 404 || res.status === 501) {
      const all = readSubs()
      const { view: _v, ...rest } = all[ws] ?? {}
      all[ws] = { ...rest, last: 'missing' }
      writeJsonFile(subPath, all)
      cache = all[ws] ?? {}
    } else cache = writeSub(ws, { last: 'offline' })
    emit(ws, 'content_update.subscription_checked', {
      status: res.ok ? (res.data?.status ?? null) : res.status,
    })
    return localOf(cache)
  }

  /** 没订阅时那一行小字要的摘要（不查订阅、只回标题；6 小时取一次）。 */
  async function refreshSummary(ws: WorkspaceId, force = false): Promise<void> {
    const cache = readSubs()[ws]
    if (
      !force &&
      cache?.summary_at !== undefined &&
      Date.parse(now()) - Date.parse(cache.summary_at) < SUMMARY_TTL_MS
    )
      return
    const cloud = await options.cloud(ws).catch(() => undefined)
    if (cloud === undefined || !cloud.linked()) return
    const ids = options.positions(ws).map((p) => p.id)
    if (ids.length === 0) return
    const q = new URLSearchParams({ channel: options.channel, positions: ids.join(',') })
    const res = await cloud.call<OfficialContentSummary>(
      `${OFFICIAL_CONTENT_PATHS.summary}?${q.toString()}`,
      { timeout_ms: TIMEOUT_MS },
    )
    if (res.ok && res.data !== undefined) writeSub(ws, { summary: res.data, summary_at: now() })
  }

  // ---------- 收包 ----------

  class NotSubscribed extends Error {}

  async function fetchRaw(cloud: OfficialCloud, path: string): Promise<Buffer> {
    if (cloud.callBytes === undefined)
      throw new ContentPackError('fetch_failed', '这个版本的云连接不支持取文件')
    const res = await cloud.callBytes<unknown>(path, { raw: true, timeout_ms: TIMEOUT_MS })
    if (res.status === 402) throw new NotSubscribed(res.message ?? 'not subscribed')
    if (!res.ok || res.bytes === undefined)
      throw new ContentPackError('fetch_failed', `${path}：HTTP ${res.status}`)
    return Buffer.from(res.bytes)
  }

  /** 取清单 + 文件，全部验过才落盘；任一条不过整包拒收（这一刻之前什么都没写）。 */
  async function pull(cloud: OfficialCloud): Promise<ContentManifest> {
    const q = `?channel=${options.channel}`
    const [bytes, sig] = await Promise.all([
      fetchRaw(cloud, `${OFFICIAL_CONTENT_PATHS.manifest}${q}`),
      fetchRaw(cloud, `${OFFICIAL_CONTENT_PATHS.signature}${q}`),
    ])
    const global = store.readGlobal()
    const m = verifyContentManifest(bytes, sig.toString('utf8').trim(), {
      keys: options.keys,
      appVersion: options.appVersion,
      channel: options.channel,
      minSerial: global.max_serial,
      allowSame: true,
      source: 'official',
    })
    const wanted = m.items.filter(supported)
    const fresh = new Map<string, Buffer>()
    for (const item of wanted)
      for (const f of item.files) {
        if (store.hasBlob(f.sha256) || fresh.has(f.sha256)) continue
        fresh.set(f.sha256, await fetchRaw(cloud, `${OFFICIAL_CONTENT_PATHS.blobs}${f.sha256}`))
      }
    // 先全部验完（内存里）：哈希、形状、白名单，一个不对就整包拒收
    for (const item of wanted) {
      const files = verifyContentItemFiles(item, (sha) => fresh.get(sha) ?? store.readBlob(sha))
      const p = parseOfficialItem(item, files)
      if (p.kind === 'role_content' && bundledRoleContent(p.id) !== undefined)
        try {
          loadBundledRoleWithContent(p.id as RoleId, p.content)
        } catch (e) {
          throw new ContentPackError('bad_manifest', `${item.id}：${(e as Error).message}`)
        }
      if (p.kind === 'position_content' && bundledPositionContent(p.id) !== undefined)
        try {
          loadBundledPositionWithContent(p.id, p.content)
        } catch (e) {
          throw new ContentPackError('bad_manifest', `${item.id}：${(e as Error).message}`)
        }
    }
    for (const [sha, b] of fresh) store.putBlob(sha, b)
    for (const item of wanted) if (item.kind === 'skill') store.ensureTree(item)
    store.writeGlobal({ max_serial: m.serial, manifest: m, last_checked_at: now() })
    return m
  }

  // ---------- 卡 ----------

  async function recipientsOf(ws: WorkspaceId, pos: OfficialPosition, owner?: PersonId) {
    const out: { person: PersonId; via: 'owner' | 'scope_manager' }[] = []
    if (owner !== undefined) out.push({ person: owner, via: 'owner' })
    if (
      (await options.company(ws).catch(() => false)) &&
      pos.supervisor_person_id !== undefined &&
      pos.supervisor_person_id !== owner
    )
      out.push({ person: pos.supervisor_person_id, via: 'scope_manager' })
    return out
  }

  async function activeCards(ws: WorkspaceId, position_id: string): Promise<StoredCard[]> {
    const approvals = options.approvals()
    const list = readBrand(ws).cards[position_id] ?? []
    if (approvals === undefined) return []
    const out: StoredCard[] = []
    for (const c of list) {
      const card = await approvals.get(c.card_id)
      if (card !== undefined && ACTIVE_CARD.has(card.state) && card.decision === undefined)
        out.push(c)
    }
    return out
  }

  async function dropCard(ws: WorkspaceId, position_id: string, card_id: string, why: string) {
    await options
      .approvals()
      ?.expireNow?.(card_id, why)
      .catch(() => undefined)
    const st = readBrand(ws)
    st.cards[position_id] = (st.cards[position_id] ?? []).filter((c) => c.card_id !== card_id)
    writeBrand(ws, st)
  }

  async function createCard(
    brand: OfficialBrand,
    pos: OfficialPosition,
    items: readonly ContentItem[],
    urgent: boolean,
    serial: number,
  ): Promise<string | undefined> {
    const approvals = options.approvals()
    if (approvals === undefined || items.length === 0) return undefined
    const ws = brand.id
    const week = isoWeekOf(now())
    const rows = items.map((i) => digestItemOf(ws, i))
    const advice = await options
      .advise?.(ws, {
        position: pos.name.zh,
        items: rows.map((r) => ({
          title: r.title.zh,
          summary: r.summary.zh,
          mine: { untouched: '没改过', kept: '你改过，会保留', clash: '撞了' }[r.mine],
        })),
      })
      .catch(() => undefined)
    const payload: ContentDigestCardPayload = {
      form: CONTENT_DIGEST_CARD_KIND,
      workspace_id: ws,
      position_id: pos.id,
      position_name: pos.name,
      week,
      urgent,
      ...(advice === undefined || advice.trim() === '' ? {} : { advice: advice.trim() }),
      items: rows,
      serial,
      options: DIGEST_OPTIONS.map((o) => ({ ...o })),
    }
    const tags = items.map(tagOf).sort()
    seq += 1
    const key = `content_update_digest@${pos.id}@${week}${urgent ? '@urgent' : ''}@${Date.parse(now()).toString(36)}${seq}:${ws}`
    const card = await approvals.create({
      workspace_id: ws,
      schema_version: 1,
      kind: CONTENT_DIGEST_CARD_KIND,
      role_id: OWNER_ROLE,
      subject: { object: { type: 'position', id: pos.id } },
      dedupe_key: key,
      title: `${pos.name.zh} · ${urgent ? '急 · ' : '本周'}更新 · ${rows.length} 项`,
      summary: payload.advice ?? '',
      payload,
      options: DIGEST_OPTIONS.map((o) => ({ ...o })),
      evidence: {
        source_events: [],
        provenance: { seen: items.map((i) => ({ type: 'content_item', id: i.id })) },
        precheck: { permission_diff: 'ok', semantic_diff: 'ok' },
      },
      proposer: { kind: 'agent', id: 'official-content' },
      automation: { level_at_creation: 'L1' },
      routing: {
        recipients: await recipientsOf(ws, pos, brand.owner_id),
        rule: 'owner',
        escalation: { after_hours: 72, business_hours: true, chain: ['owner'], escalated_at: [] },
        separation_of_duties: false,
      },
      priority: urgent ? 'immediate' : 'queue',
      risk_class: 'low',
    } as never)
    const st = readBrand(ws)
    st.cards[pos.id] = [
      ...(st.cards[pos.id] ?? []),
      { card_id: card.id, week, urgent, items: tags },
    ]
    if (!urgent) st.last_card_week[pos.id] = week
    writeBrand(ws, st)
    emit(ws, 'content_update.digest_carded', {
      position_id: pos.id,
      week,
      urgent,
      items: rows.length,
    })
    return card.id
  }

  /**
   * 一个岗位：等着的几项 → 卡。一周最多一张（后来的并进还没处理的那张：撤旧出新、合成一张）；
   * 急件单出；这周跳过 / 这周已经处理过一张的，普通的等下周。
   */
  async function syncCards(
    brand: OfficialBrand,
    pos: OfficialPosition,
    pending: readonly ContentItem[],
    serial: number,
  ): Promise<string[]> {
    const ws = brand.id
    const week = isoWeekOf(now())
    const out: string[] = []
    const open = await activeCards(ws, pos.id)
    const pendingTags = new Set(pending.map(tagOf))
    // 卡上已经没有等着的了（在第三栏应用了 / 退回了）：这张作废
    for (const c of open)
      if (!c.items.some((t) => pendingTags.has(t))) await dropCard(ws, pos.id, c.card_id, '已处理')
    const live = (await activeCards(ws, pos.id)).filter((c) =>
      c.items.some((t) => pendingTags.has(t)),
    )
    const onCard = new Set(live.flatMap((c) => c.items))
    const urgentNew = pending.filter((i) => i.urgent === true && !onCard.has(tagOf(i)))
    if (urgentNew.length > 0) {
      const id = await createCard(brand, pos, urgentNew, true, serial)
      if (id !== undefined) out.push(`${ws}:${pos.id}@${week}!`)
    }
    const normal = pending.filter((i) => i.urgent !== true)
    if (normal.length === 0) return out
    const openNormal = live.find((c) => !c.urgent)
    const st = readBrand(ws)
    if (openNormal !== undefined) {
      if (normal.every((i) => openNormal.items.includes(tagOf(i)))) return out
      // 一周内后来的：并进还没处理的那张（撤掉旧的、出一张合起来的）
      await dropCard(ws, pos.id, openNormal.card_id, '并进新的一张')
    } else if (st.skipped_week[pos.id] === week || st.last_card_week[pos.id] === week) return out
    const id = await createCard(brand, pos, normal, false, serial)
    if (id !== undefined) out.push(`${ws}:${pos.id}@${week}`)
    return out
  }

  /** 一个品牌：等着的几项按岗位分 → 自动应用没撞的（那一档）→ 出 / 并卡。 */
  async function evaluate(brand: OfficialBrand, m: ContentManifest) {
    const ws = brand.id
    const out = { carded: [] as string[], applied: [] as string[] }
    const enabled = options.positions(ws)
    for (const pos of enabled) {
      const policy = readBrand(ws).policies[pos.id] ?? DEFAULT_POSITION_UPDATE_POLICY
      if (policy === 'off') continue
      const pendingOf = (): ContentItem[] =>
        m.items.filter(
          (i) =>
            applicable(ws, i) &&
            newer(ws, i) &&
            positionsOf(i, enabled).some((p) => p.id === pos.id),
        )
      let pending = pendingOf()
      if (policy === 'auto_clean' && pending.length > 0) {
        const clean = pending.filter((i) => digestItemOf(ws, i).mine !== 'clash')
        if (clean.length > 0) {
          const done = await applyItems(ws, pos.id, clean, 'auto', undefined)
          out.applied.push(...done.map((id) => `${ws}:${id}`))
          pending = pendingOf()
        }
      }
      out.carded.push(...(await syncCards(brand, pos, pending, m.serial)))
    }
    return out
  }

  let lastError: { text: string; at: string } | undefined

  async function check(): Promise<OfficialCheckReport> {
    const report: OfficialCheckReport = { state: 'ok', carded: [], applied: [] }
    if (options.off !== undefined) return { ...report, state: 'off', text: options.off }
    const brands = await options.brands()
    const live: { brand: OfficialBrand; sub: OfficialSubscriptionLocalView }[] = []
    for (const brand of brands) {
      const sub = await refreshSubscription(brand.id)
      if (usable(sub)) live.push({ brand, sub })
      else if (sub.state === 'none') await refreshSummary(brand.id).catch(() => undefined)
    }
    if (live.length === 0) return report
    // 问得到云的那一个品牌去取（本机记着的 7 天内断网：不取，照已经收下的那份出卡）
    const puller = live.find((l) => l.sub.state === 'active')
    if (puller !== undefined) {
      const cloud = await options.cloud(puller.brand.id)
      try {
        if (cloud !== undefined) await pull(cloud)
        lastError = undefined
      } catch (e) {
        if (e instanceof NotSubscribed) {
          // 订阅刚到期 / 欠费停了：照实记下，不出卡（已经用上的不动）
          const c = readSubs()[puller.brand.id]
          if (c?.view !== undefined)
            writeSub(puller.brand.id, {
              view: { ...c.view, usable: false },
              checked_at: now(),
              last: 'ok',
            })
          return report
        }
        const err =
          e instanceof ContentPackError ? e : new ContentPackError('fetch_failed', String(e))
        if (err.reason !== 'fetch_failed' && err.reason !== 'old_serial') {
          lastError = { text: CONTENT_REJECT_TEXT[err.reason], at: now() }
          for (const l of live)
            emit(l.brand.id, 'content_update.rejected', {
              reason: err.reason,
              detail: err.detail ?? null,
              source: 'official',
            })
          return {
            ...report,
            state: 'error',
            reason: err.reason,
            text: CONTENT_REJECT_TEXT[err.reason],
          }
        }
        // 没连上：断网不报错，照已经收下的那份
      }
    }
    const m = manifest()
    if (m === undefined) return report
    report.serial = m.serial
    for (const { brand } of live) {
      const r = await evaluate(brand, m)
      report.carded.push(...r.carded)
      report.applied.push(...r.applied)
    }
    return report
  }

  // ---------- 第三栏 ----------

  async function canApply(ws: WorkspaceId, position_id: string, person: PersonId) {
    const pos = options.positions(ws).find((p) => p.id === position_id)
    return canApplyContentUpdates({
      company: await options.company(ws).catch(() => true),
      is_owner: await options.isOwner(ws, person).catch(() => false),
      person_id: person,
      position_supervisor: pos?.supervisor_person_id,
    })
  }

  async function assertCan(ws: WorkspaceId, position_id: string, person: PersonId) {
    const ok = await canApply(ws, position_id, person)
    if (!ok.ok) throw forbidden(ok.reason ?? '有更新，等负责人看')
  }

  /** 这个岗位等着的几项（已经下到本机的都算：退订后已经下下来的也留着能用，C7）。 */
  function pendingFor(ws: WorkspaceId, position_id: string): ContentItem[] {
    const m = manifest()
    if (m === undefined) return []
    if ((readBrand(ws).policies[position_id] ?? DEFAULT_POSITION_UPDATE_POLICY) === 'off') return []
    const enabled = options.positions(ws)
    const here = enabled.some((p) => p.id === position_id)
      ? enabled
      : [...enabled, { id: position_id, name: { zh: position_id, en: position_id }, roles: [] }]
    return m.items.filter(
      (i) =>
        applicable(ws, i) && newer(ws, i) && positionsOf(i, here).some((p) => p.id === position_id),
    )
  }

  /** 清单里有的用清单那一项；清单里已经没了但应用过的，用应用过的那一版拼一项（改主意 / 退回用）。 */
  function itemFor(ws: WorkspaceId, id: string): ContentItem | undefined {
    const cur = appliedOf(ws, id)
    const inManifest = itemOf(id)
    if (inManifest !== undefined && (cur === undefined || cur.sha256 === inManifest.sha256))
      return inManifest
    if (cur === undefined) return inManifest
    return {
      id,
      kind: kindOfId(id) as ContentItem['kind'],
      name: nameOfId(id),
      version: cur.version,
      title: cur.title,
      summary: cur.title,
      upstream: {
        id: 'official',
        repo: 'agentsws-content',
        commit: '',
        published_at: cur.upstream_published_at,
        license: '',
      },
      review: {
        reviewer: '',
        reviewed_at: '',
        license_before: '',
        license_after: '',
        scan_hits: 0,
        scan_rules: [],
        notes_ok: true,
        tests_ok: true,
      },
      files: cur.files,
      sha256: cur.sha256,
    }
  }

  function storedParts(ws: WorkspaceId, item_id: string, version: string): ContentPart[] {
    const st = readBrand(ws)
    for (let i = st.batches.length - 1; i >= 0; i -= 1) {
      const hit = st.batches[i]?.items.find((x) => x.item_id === item_id && x.version === version)
      if (hit !== undefined)
        return (hit.parts ?? []).map((p) => {
          const chosen = st.choices[`${item_id}@${version}#${p.key}`]
          return chosen === undefined ? p : { ...p, chosen }
        })
    }
    return []
  }

  async function view(
    ws: WorkspaceId,
    position_id: string,
    person: PersonId,
  ): Promise<PositionContentUpdatesView> {
    const st = readBrand(ws)
    const cache = readSubs()[ws]
    const sub = cache === undefined ? await refreshSubscription(ws) : localOf(cache)
    const can = await canApply(ws, position_id, person)
    const pending = pendingFor(ws, position_id).map((i) => digestItemOf(ws, i))
    const open = await activeCards(ws, position_id)
    const card = open.find((c) => !c.urgent) ?? open[0]
    const items = store.readWorkspace(ws).items
    const applied: ContentAppliedItem[] = []
    for (const [id, mine] of Object.entries(items)) {
      if (mine.current === undefined) continue
      if (!(st.applied_positions[id] ?? []).includes(position_id)) continue
      const parts = storedParts(ws, id, mine.current.version)
      const kept = parts.filter(
        (p) => p.clash === true && (p.chosen === undefined || p.chosen === 'keep_mine'),
      ).length
      applied.push({
        item_id: id,
        kind: kindOfId(id) as ContentItem['kind'],
        title: mine.current.title,
        version: mine.current.version,
        ...(mine.previous === undefined ? {} : { previous_version: mine.previous.version }),
        applied_at: mine.current.applied_at,
        ...(kept === 0 ? {} : { kept_clashes: kept }),
      })
    }
    applied.sort((a, b) => b.applied_at.localeCompare(a.applied_at))
    const last = [...st.batches].reverse().find((b) => b.position_id === position_id)
    let nudge: PositionContentUpdatesView['nudge']
    if (sub.state === 'none') {
      const quiet = st.nudge_quiet_until[position_id]
      if (quiet === undefined || Date.parse(quiet) <= Date.parse(now())) {
        if (cache?.summary === undefined) await refreshSummary(ws).catch(() => undefined)
        const row = readSubs()[ws]?.summary?.positions.find((p) => p.position_id === position_id)
        if (row !== undefined && row.count > 0)
          nudge = { count: row.count, urgent: row.urgent, titles: row.titles }
      }
    }
    const g = store.readGlobal()
    return {
      position_id,
      policy: st.policies[position_id] ?? DEFAULT_POSITION_UPDATE_POLICY,
      subscription: sub,
      can_apply: can.ok,
      pending,
      ...(card === undefined ? {} : { card_id: card.card_id }),
      ...(st.skipped_week[position_id] === isoWeekOf(now()) ? { skipped_this_week: true } : {}),
      applied,
      ...(last === undefined
        ? {}
        : {
            last_batch: {
              batch_id: last.batch_id,
              applied_at: last.applied_at,
              by: last.by,
              ...(last.person_id === undefined ? {} : { person_id: last.person_id }),
              item_ids: last.items.map((x) => x.item_id),
            } satisfies ContentAppliedBatch,
          }),
      ...(nudge === undefined ? {} : { nudge }),
      ...(g.last_checked_at === undefined ? {} : { last_checked_at: g.last_checked_at }),
      ...(lastError === undefined ? {} : { last_error: lastError.text }),
    }
  }

  function diff(ws: WorkspaceId, _position_id: string, item_id: string): ContentItemDiffView {
    const item = itemFor(ws, item_id)
    if (item === undefined) throw new ApiError('not_found', `没有这一项：${item_id}`)
    const cur = appliedOf(ws, item_id)
    const applied = cur !== undefined && cur.sha256 === item.sha256
    const from = applied
      ? store.readWorkspace(ws).items[item_id]?.previous?.version
      : digestItemOf(ws, item).from_version
    return {
      item_id,
      kind: item.kind,
      title: item.title,
      ...(from === undefined ? {} : { from_version: from }),
      to_version: item.version,
      applied,
      parts: applied ? storedParts(ws, item_id, item.version) : partsOf(ws, item),
    }
  }

  /** 卡上 / 第三栏处理过之后：这个岗位开着的卡作废；没处理完的这周不再出，下周一起带上。 */
  async function settleCards(ws: WorkspaceId, position_id: string, why: string) {
    const left = new Set(pendingFor(ws, position_id).map(tagOf))
    for (const c of await activeCards(ws, position_id))
      await dropCard(ws, position_id, c.card_id, why)
    if (left.size > 0) {
      const st = readBrand(ws)
      st.skipped_week[position_id] = isoWeekOf(now())
      writeBrand(ws, st)
    }
  }

  async function skipInternal(ws: WorkspaceId, position_id: string) {
    const st = readBrand(ws)
    st.skipped_week[position_id] = isoWeekOf(now())
    writeBrand(ws, st)
    emit(ws, 'content_update.digest_skipped', { position_id, week: isoWeekOf(now()) })
  }

  /** 卡批下来：全部应用 / 这次跳过。批的是哪几项就只应用哪几项（卡发出去之后又来了新的，等下一张）。 */
  async function onDigestDecided(out: ApprovalItem, by: PersonId): Promise<void> {
    const p = out.payload as Partial<ContentDigestCardPayload> | undefined
    if (p?.form !== CONTENT_DIGEST_CARD_KIND || p.position_id === undefined) return
    const edited = out.decision?.edited_payload as { selected_option_id?: unknown } | undefined
    const choice =
      out.decision?.selected_option_id ??
      (typeof edited?.selected_option_id === 'string' ? edited.selected_option_id : undefined)
    const ws = out.workspace_id
    if (choice === 'skip') {
      await skipInternal(ws, p.position_id)
      return
    }
    const wanted = new Set((p.items ?? []).map((i) => `${i.item_id}@${i.version}`))
    const items = pendingFor(ws, p.position_id).filter((i) => wanted.has(tagOf(i)))
    await applyItems(ws, p.position_id, items, 'person', by)
  }

  return {
    check,

    async restore() {
      for (const ws of store.workspaces()) {
        const st = store.readWorkspace(ws)
        for (const [id, mine] of Object.entries(st.items)) {
          if (mine.current === undefined) continue
          try {
            await effect(ws as WorkspaceId, id)
          } catch {
            /* 读不出（文件被删了）：这一项照旧用随软件带的那一版 */
          }
        }
      }
      // 只有「你的」那一层（没应用过官方版）的职责也要叠上
      for (const target of Object.keys(readBrand(boot).item_edits)) {
        const m = /^role:(.+):(quick_prompts|task_examples)$/.exec(target)
        if (m?.[1] !== undefined) registerRole(m[1])
      }
    },

    view,

    async setPolicy(ws, position_id, person, policy) {
      await assertCan(ws, position_id, person)
      const st = readBrand(ws)
      st.policies[position_id] = policy
      writeBrand(ws, st)
      if (policy === 'off')
        for (const c of await activeCards(ws, position_id))
          await dropCard(ws, position_id, c.card_id, '这个岗位不再更新')
      return view(ws, position_id, person)
    },

    diff,

    async apply(ws, position_id, person, input) {
      await assertCan(ws, position_id, person)
      const ids = new Set(input.item_ids ?? pendingFor(ws, position_id).map((i) => i.id))
      for (const k of Object.keys(input.choices ?? {})) ids.add(k.slice(0, k.indexOf('#')))
      const items: ContentItem[] = []
      for (const id of ids) {
        const item = itemFor(ws, id)
        if (item === undefined) throw new ApiError('not_found', `没有这一项：${id}`)
        items.push(item)
      }
      await applyItems(ws, position_id, items, 'person', person, input)
      await settleCards(ws, position_id, '在第三栏处理了')
      return view(ws, position_id, person)
    },

    async skip(ws, position_id, person) {
      await assertCan(ws, position_id, person)
      for (const c of await activeCards(ws, position_id))
        await dropCard(ws, position_id, c.card_id, '这次跳过')
      await skipInternal(ws, position_id)
      return view(ws, position_id, person)
    },

    async aiMerge(ws, position_id, person, input) {
      await assertCan(ws, position_id, person)
      const part = diff(ws, position_id, input.item_id).parts.find((p) => p.key === input.part_key)
      if (part === undefined) throw new ApiError('not_found', '没有这一段')
      if (options.aiMerge === undefined) return {}
      const text = await options
        .aiMerge(ws, {
          label: part.label,
          ...(part.before === undefined ? {} : { before: part.before }),
          ...(part.after === undefined ? {} : { after: part.after }),
          ...(part.mine === undefined ? {} : { mine: part.mine }),
        })
        .catch(() => undefined)
      return text === undefined || text.trim() === '' ? {} : { text: text.trim() }
    },

    async rollback(ws, position_id, person, input) {
      await assertCan(ws, position_id, person)
      const st = readBrand(ws)
      if (input.item_id === undefined) {
        const at = st.batches.map((b) => b.position_id).lastIndexOf(position_id)
        const batch = st.batches[at]
        if (batch === undefined) throw new ApiError('not_found', '这个岗位还没应用过更新')
        for (const x of [...batch.items].reverse()) {
          const cur = appliedOf(ws, x.item_id)
          if (cur?.version !== x.version) continue
          await rollbackItem(ws, x.item_id, x.undo)
        }
        const next = readBrand(ws)
        next.batches = next.batches.filter((b) => b.batch_id !== batch.batch_id)
        writeBrand(ws, next)
        emit(ws, 'content_update.batch_rolled_back', {
          position_id,
          batch_id: batch.batch_id,
          item_ids: batch.items.map((x) => x.item_id),
        })
        return view(ws, position_id, person)
      }
      const id = input.item_id
      const cur = appliedOf(ws, id)
      let undo: UndoSnapshot | undefined
      for (let i = st.batches.length - 1; i >= 0 && cur !== undefined; i -= 1) {
        const b = st.batches[i]
        const hit = b?.items.find((x) => x.item_id === id && x.version === cur.version)
        if (b === undefined || hit === undefined) continue
        undo = hit.undo
        b.items = b.items.filter((x) => x !== hit)
        break
      }
      st.batches = st.batches.filter((b) => b.items.length > 0)
      await rollbackItem(ws, id, undo)
      const next = readBrand(ws)
      next.batches = st.batches
      writeBrand(ws, next)
      emit(ws, 'content_update.batch_rolled_back', { position_id, item_ids: [id] })
      return view(ws, position_id, person)
    },

    async dismissNudge(ws, position_id, person) {
      const st = readBrand(ws)
      st.nudge_quiet_until[position_id] = new Date(
        Date.parse(now()) + CONTENT_NUDGE_QUIET_DAYS * DAY,
      ).toISOString()
      writeBrand(ws, st)
      return view(ws, position_id, person)
    },

    async subscription(ws) {
      const cache = readSubs()[ws]
      return cache === undefined ? refreshSubscription(ws) : localOf(cache)
    },

    async subscribe(ws, person) {
      const company = await options.company(ws).catch(() => true)
      if (company && !(await options.isOwner(ws, person).catch(() => false)))
        throw forbidden('订阅要品牌负责人来开')
      const cloud = await options.cloud(ws)
      if (cloud === undefined || !cloud.linked())
        throw new ApiError(
          'forbidden',
          '岗位更新要先关联 Agents 工坊账号（用积分订）：到「设置 → 账号与积分」关联一次。',
          { details: { reason: 'reauth_required' } },
        )
      const res = await cloud.call<ContentSubscriptionView>(CONTENT_SUBSCRIPTION_PATH, {
        method: 'POST',
        timeout_ms: TIMEOUT_MS,
      })
      if (!res.ok || res.data === undefined) {
        if (res.status === 0)
          throw new ApiError('provider_unavailable', '云上暂时联系不上，稍后再试一次。')
        if (res.status === 401 || res.status === 403) {
          writeSub(ws, { last: 'reauth' })
          throw new ApiError('forbidden', localOf(readSubs()[ws]).note ?? '要重新登录一次', {
            details: { reason: 'scope_missing', required_scope: 'content' },
          })
        }
        if (res.status === 501)
          throw new ApiError('not_implemented', res.message ?? '云上还没开通岗位更新，没有扣积分。')
        throw new ApiError('invalid_input', res.message ?? '云上没答应这一次订阅。')
      }
      writeSub(ws, { view: res.data, checked_at: now(), last: 'ok' })
      // 订上了：后台马上查一次（不让人等）
      void check().catch(() => undefined)
      return localOf(readSubs()[ws])
    },

    positionPersona,
    tableRows,

    setItemEdits(ws, target, edits) {
      setEdits(ws, target, edits)
      const m = /^role:(.+):(quick_prompts|task_examples)$/.exec(target)
      if (m?.[1] !== undefined && ws === boot) registerRole(m[1])
    },

    itemEdits: itemEditsOf,

    wrap(bus) {
      return new Proxy(bus, {
        get(target, prop, receiver) {
          if (prop !== 'decide') {
            const value = Reflect.get(target, prop, receiver)
            return typeof value === 'function' ? value.bind(target) : value
          }
          return async (id: string, by: never, input: DecideInput): Promise<ApprovalItem> => {
            const getter = (
              target as unknown as { get?(id: string): Promise<ApprovalItem | undefined> }
            ).get
            const before = await getter?.call(target, id)
            if (
              before?.kind === CONTENT_DIGEST_CARD_KIND &&
              (input.action === 'approve' || input.action === 'approve_edited')
            ) {
              const p = before.payload as Partial<ContentDigestCardPayload> | undefined
              if (p?.position_id !== undefined)
                await assertCan(before.workspace_id, p.position_id, by as PersonId)
            }
            const out = await target.decide(id, by, input)
            if (out.kind !== CONTENT_DIGEST_CARD_KIND) return out
            if (out.state !== 'approved' && out.state !== 'approved_edited') return out
            try {
              await onDigestDecided(out, by as PersonId)
            } catch (e) {
              emit(out.workspace_id, 'content_update.rejected', {
                reason: e instanceof ContentPackError ? e.reason : 'apply_failed',
                detail: e instanceof Error ? e.message : String(e),
                source: 'official',
              })
            }
            return out
          }
        },
      })
    },
  }
}

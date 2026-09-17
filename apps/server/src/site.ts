/**
 * 建站数据面（59 §1 / §2，WP77）：**三张表 + `/v1/site/*` 的实现**。
 *
 * 三类对象（`launch_item` 的那次巡检 / `email_template` / `shop_app`）落在
 * **这个品牌自己的**目录下（WP66 的 `BrandModules`：bootstrap 品牌用原来那个目录，
 * 别的品牌在 `<dbDir>/brands/<workspace_id>/` 下）。形状照 `social.ts` 抄：
 * 一张表一列 json，后端要么 sqlite 要么全内存。
 *
 * 四条纪律：
 *
 * 1. **凭据一格都没有**。`ShopAppRecord.connection_id` 指的是连接页上那一条连接；
 *    取 token 是发出去那一跳的事（同 `social.ts` 的第 1 条）。
 * 2. **写动作永远先出卡**。改模板 → `email_template_edit`、装 App → `app_install`、
 *    跑检查单 → `launch_check`（L3，它什么都不改但照样进队列，14 的老规矩）。
 *    这个文件里**没有一处直接改店里的东西**——那是执行器在卡被批准之后做的事。
 * 3. **判断在纯函数里，事实在这一层**。检查单怎么判是 `@agentsws/site-core` 的事
 *    （同一份事实每次得到同一张清单）；这一层只负责把事实读齐、把结论落库。
 *    读不到的项照 `unknown` 落，**不补一个"缺"**——那两件事在面板上是两种颜色。
 * 4. **结账 / 支付 / 税一个写口都没有**（51 §1 N0 / §3 N2）。检查单说得出它们缺什么，
 *    `fixable_by` 为空就是"建站岗位补不了，请店主自己去后台"。
 */
import { createRequire } from 'node:module'
import { join } from 'node:path'
import type {
  SiteActor,
  SiteAppInstallInput,
  SiteAppRow,
  SiteChecklistView,
  SiteEmailTemplateInput,
  SiteEmailTemplateView,
  SitePort,
  SiteStagedView,
} from '@agentsws/api'
import { ApiError } from '@agentsws/api'
import type {
  ApprovalBus,
  AssignmentId,
  ChangeKind,
  Clock,
  EffectiveConfig,
  EventEnvelope,
  LaunchCheckRun,
  Mandate,
  ObjectRef,
  ProvenanceState,
  ShopAppRecord,
  ShopEmailTemplate,
  WorkspaceId,
} from '@agentsws/contracts'
import type { SiteDeckData } from '@agentsws/deck'
import {
  appInstallAfter,
  appInventory,
  checkEmailTemplate,
  emailTemplateAfter,
  type LaunchCheckFacts,
  launchCheckAfter,
  NOTIFICATION_TYPES,
  notificationType,
  PREVIEW_SAMPLE,
  renderPreview,
  runLaunchChecklist,
  type ThemeSummaryLike,
  themeLanes,
} from '@agentsws/site-core'
import type { StageInput, StageOutcome } from '@agentsws/txn'
import type BetterSqlite3 from 'better-sqlite3'

/** 库里的三张表。名字与对象类型一一对应，不另起别名。 */
export type SiteTable = 'launch_run' | 'email_template' | 'shop_app'

export const SITE_TABLES: readonly SiteTable[] = ['launch_run', 'email_template', 'shop_app']

interface SiteBackend {
  all<T>(table: SiteTable): T[]
  get<T>(table: SiteTable, id: string): T | undefined
  put(table: SiteTable, id: string, row: unknown): void
  close(): void
}

function createMemoryBackend(): SiteBackend {
  const tables = new Map<SiteTable, Map<string, unknown>>()
  const of = (t: SiteTable): Map<string, unknown> => {
    const found = tables.get(t)
    if (found !== undefined) return found
    const fresh = new Map<string, unknown>()
    tables.set(t, fresh)
    return fresh
  }
  return {
    all: <T>(t: SiteTable) => [...of(t).values()].map((r) => structuredClone(r) as T),
    get: <T>(t: SiteTable, id: string) => {
      const row = of(t).get(id)
      return row === undefined ? undefined : (structuredClone(row) as T)
    },
    put: (t, id, row) => {
      of(t).set(id, structuredClone(row))
    },
    close: () => tables.clear(),
  }
}

const SCHEMA = SITE_TABLES.map(
  (t) => `CREATE TABLE IF NOT EXISTS site_${t} (id TEXT PRIMARY KEY, json TEXT NOT NULL);`,
).join('\n')

function createSqliteBackend(dbPath: string): SiteBackend {
  const require = createRequire(import.meta.url)
  const Database = require('better-sqlite3') as typeof BetterSqlite3
  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.exec(SCHEMA)
  return {
    all: <T>(t: SiteTable) =>
      (db.prepare(`SELECT json FROM site_${t} ORDER BY id`).all() as { json: string }[]).map(
        (r) => JSON.parse(r.json) as T,
      ),
    get: <T>(t: SiteTable, id: string) => {
      const row = db.prepare(`SELECT json FROM site_${t} WHERE id = ?`).get(id) as
        | { json: string }
        | undefined
      return row === undefined ? undefined : (JSON.parse(row.json) as T)
    },
    put: (t, id, row) => {
      db.prepare(
        `INSERT INTO site_${t} (id, json) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET json = excluded.json`,
      ).run(id, JSON.stringify(row))
    },
    close: () => {
      db.close()
    },
  }
}

export interface SiteStoreOptions {
  workspace_id: WorkspaceId
  /** 这个品牌的落盘目录（`BrandModules` 给的那一个）。不给就全内存。 */
  dbDir?: string
}

export interface SiteStore {
  readonly workspace_id: WorkspaceId
  /** 历次巡检，最新的在最后。 */
  runs(): LaunchCheckRun[]
  /** 上一次巡检；没跑过就没有。**不现算一份**——那会让"上次什么时候查的"说不清。 */
  lastRun(): LaunchCheckRun | undefined
  templates(): ShopEmailTemplate[]
  template(id: string): ShopEmailTemplate | undefined
  apps(): ShopAppRecord[]
  app(id: string): ShopAppRecord | undefined

  saveRun(row: LaunchCheckRun): void
  saveTemplate(row: ShopEmailTemplate): void
  saveApp(row: ShopAppRecord): void
  close(): void
}

export function createSiteStore(options: SiteStoreOptions): SiteStore {
  const backend =
    options.dbDir === undefined
      ? createMemoryBackend()
      : createSqliteBackend(join(options.dbDir, 'site.sqlite'))

  const runs = (): LaunchCheckRun[] =>
    backend
      .all<LaunchCheckRun>('launch_run')
      .slice()
      .sort((a, b) => Date.parse(a.checked_at) - Date.parse(b.checked_at))

  return {
    workspace_id: options.workspace_id,
    runs,
    lastRun: () => runs().at(-1),
    templates: () => backend.all<ShopEmailTemplate>('email_template'),
    template: (id) => backend.get<ShopEmailTemplate>('email_template', id),
    apps: () => backend.all<ShopAppRecord>('shop_app'),
    app: (id) => backend.get<ShopAppRecord>('shop_app', id),

    saveRun: (row) => backend.put('launch_run', row.id, row),
    saveTemplate: (row) => backend.put('email_template', row.id, row),
    saveApp: (row) => backend.put('shop_app', row.id, row),
    close: () => backend.close(),
  }
}

/* ── 服务（`/v1/site/*` 的实现） ───────────────────────────────────────── */

/**
 * 读店里的事实。**全是只读**——这一层碰不到一个写口。
 *
 * 拿不到的那几格一律留空（`undefined`），检查单那边会照 `unknown` 记：
 * 一次因为令牌过期没读到支付设置的巡检，不该在卡面上写成"这家店没有收款方式"。
 */
export interface SiteFactsPort {
  /** 店铺设置与主题列表；读不到的格子留空，**不编**。 */
  storeFacts(): Promise<LaunchCheckFacts>
  /** `theme list` 的结果（主题副本与预览那一块读它）。读不到就空数组。 */
  themes?(): Promise<ThemeSummaryLike[]>
  /** 这家店的域名 / 标识（只进卡面与巡检记录，不是凭据）。 */
  shop?(): string | undefined
}

export interface SiteServiceOptions {
  workspace_id: WorkspaceId
  store: SiteStore
  clock: Clock
  approvals: ApprovalBus
  /**
   * 15 §5 变更账本的 stage 口（只要这一个——建站这一版不读账本，只往里提）。
   *
   * 与 `social-service.ts` 同一条纪律：要的口子写出来，不整个 `ChangeLedger`
   * 拖进来——多要一个方法就是多一条"这个模块也能撤销别人的变更"的路。
   */
  ledger: { stage(input: StageInput): Promise<StageOutcome> }
  effectiveConfig(id: AssignmentId): EffectiveConfig
  facts: SiteFactsPort
  /** 这家店认为"必须装"的 App id（59 §2：默认空，由品牌自己填）。 */
  requiredApps?: readonly string[]
  /** 连接目录里已经连上的 kind（`reviews` / `email_marketing` …）。 */
  connectedKinds?: () => readonly string[]
  appendEvent(e: Omit<EventEnvelope, 'id' | 'at'> & { at?: string }): void
  random(): number
}

export interface SiteServiceAssembly {
  port: SitePort
  /** 面板那几块要的那份投影（59 §3）。 */
  deckData(): SiteDeckData
}

/** 职责 → 它提这条 kind 时用的动作 id（额度与等级从**本次那条分配**来，05 §4）。 */
const ACTION_OF_KIND: Partial<Record<ChangeKind, string>> = {
  launch_check: 'run_launch_checklist',
  email_template_edit: 'stage_email_template',
  app_install: 'stage_app_install',
  app_config: 'stage_app_config',
  store_setup: 'stage_store_setup',
  theme_install: 'stage_theme_install',
}

export function createSiteService(options: SiteServiceOptions): SiteServiceAssembly {
  const { workspace_id, store, clock, ledger, appendEvent } = options

  let seq = 0
  const nextId = (prefix: string): string => {
    seq += 1
    const rand = Math.floor(options.random() * 0xffffffff)
      .toString(36)
      .padStart(7, '0')
    return `${prefix}_${rand}${seq.toString(36)}`
  }

  const emit = (type: string, actor: string, payload: Record<string, unknown>): void => {
    appendEvent({
      schema_version: 1,
      workspace_id,
      type,
      actor: { kind: 'person', id: actor as never },
      correlation: { trace_id: `tr_site_${clock.now()}` },
      payload,
    })
  }

  /** 额度与等级。查不到就按最严的一档办（同 `social-service.ts`）。 */
  const actionOf = (
    assignment_id: AssignmentId,
    action: string,
  ): { mandate: Mandate; level: 'L1' | 'L2' | 'L3' } => {
    try {
      const config = options.effectiveConfig(assignment_id)
      return {
        mandate: config.actions.find((a) => a.id === action)?.mandate ?? { caps: {} },
        level: config.automation[action]?.level ?? 'L1',
      }
    } catch {
      return { mandate: { caps: {} }, level: 'L1' }
    }
  }

  const provenanceOf = (run_id: string, seen: ObjectRef[]): ProvenanceState => {
    const grouped: Record<string, string[]> = {}
    for (const ref of seen) {
      const list = grouped[ref.type] ?? []
      if (!list.includes(ref.id)) list.push(ref.id)
      grouped[ref.type] = list
    }
    return {
      run_id,
      seen: grouped,
      read_full: [ref_key(seen)].filter((s) => s !== ''),
      recorded_at: clock.now(),
    }
  }

  /** `read_full` 只给第一个目标——改模板的 `before` 就是那段正文（15 §1 改前必读）。 */
  const ref_key = (seen: ObjectRef[]): string => {
    const first = seen[0]
    return first === undefined ? '' : `${first.type}:${first.id}`
  }

  /** 一条 staged change 的共用那一段（提上去 → 翻成视图）。 */
  const stageOne = async (input: {
    actor: SiteActor
    kind: ChangeKind
    target: ObjectRef
    before: unknown
    after: unknown
    notes: string[]
    title: string
    summary: string
    seen: ObjectRef[]
    rule: 'role_holder' | 'scope_manager' | 'owner'
  }): Promise<SiteStagedView> => {
    const run_id = `run_site_${nextId('s')}`
    const action = ACTION_OF_KIND[input.kind] ?? 'stage_store_setup'
    const { mandate, level } = actionOf(input.actor.assignment_id, action)
    const stageInput: StageInput = {
      workspace_id,
      role_id: input.actor.role_id,
      assignment_id: input.actor.assignment_id,
      run_id,
      change_set_id: `cs_${run_id}`,
      kind: input.kind,
      target: input.target,
      before: input.before,
      after: input.after,
      notes: input.notes,
      created_by: { kind: 'person', id: input.actor.person_id },
      mandate,
      level,
      provenance: provenanceOf(run_id, input.seen),
      approval: {
        title: input.title,
        summary: input.summary,
        recipients: [{ person: input.actor.person_id, via: input.rule }],
        proposer: {
          kind: 'person',
          id: input.actor.person_id,
          assignment_id: input.actor.assignment_id,
        },
        rule: input.rule,
        separation_of_duties: false,
        source_events: [],
      },
    }
    const outcome: StageOutcome = await ledger.stage(stageInput)
    if (!outcome.ok) return { staged: false, message: outcome.message, level }
    return {
      staged: true,
      change_id: outcome.change.id,
      approval_item_id: outcome.approval.id,
      level: outcome.approval.automation.level_at_creation,
    }
  }

  /** 库里那份模板；没有就按契约默认（"Shopify 出厂那一份，我们还没碰过"）。 */
  const templateOf = (handle: string): ShopEmailTemplate => {
    const found = store.template(handle)
    if (found !== undefined) return found
    const spec = notificationType(handle)
    return {
      id: handle,
      schema_version: 1,
      workspace_id,
      notification_type: handle,
      name: spec?.name ?? { zh: handle, en: handle },
      subject: '',
      body: '',
      enabled: false,
      missing_variables: [],
      updated_at: clock.now(),
    }
  }

  const allTemplates = (): ShopEmailTemplate[] =>
    NOTIFICATION_TYPES.map((t) => templateOf(t.handle))

  const appRows = (): SiteAppRow[] => {
    const connected = options.connectedKinds?.() ?? []
    const stored = store.apps()
    const rows = appInventory({
      installed: stored
        .filter((a) => a.installed)
        .map((a) => ({
          id: a.id,
          name: a.name,
          ...(a.installed_at === undefined ? {} : { installed_at: a.installed_at }),
          ...(a.scopes === undefined ? {} : { scopes: a.scopes }),
        })),
      connected_kinds: connected,
    })
    return rows.map((r) => {
      const record = stored.find((a) => a.id === r.id)
      return {
        id: r.id,
        schema_version: 1 as const,
        workspace_id,
        name: r.name.zh,
        installed: r.installed,
        known: r.known,
        ...(record?.scopes === undefined ? {} : { scopes: record.scopes }),
        ...(r.directory_kind === undefined ? {} : { directory_kind: r.directory_kind }),
        ...(record?.connection_id === undefined ? {} : { connection_id: record.connection_id }),
        ...(record?.installed_at === undefined ? {} : { installed_at: record.installed_at }),
        updated_at: record?.updated_at ?? clock.now(),
        connectable: r.connectable,
      }
    })
  }

  const port: SitePort = {
    async runChecklist(actor) {
      const facts = await options.facts.storeFacts()
      const at = clock.now()
      const result = runLaunchChecklist(facts, {
        at,
        ...(options.requiredApps === undefined ? {} : { required_apps: options.requiredApps }),
      })
      const shop = options.facts.shop?.()
      const run: LaunchCheckRun = {
        id: nextId('lc'),
        schema_version: 1,
        workspace_id,
        ...(shop === undefined ? {} : { shop }),
        items: result.items.map((i) => ({
          id: i.id,
          title: i.title,
          state: i.state,
          severity: i.severity,
          detail: i.detail,
          fix: i.fix,
          ...(i.fixable_by === undefined ? {} : { fixable_by: i.fixable_by }),
        })),
        blockers: result.blockers,
        warnings: result.warnings,
        ready: result.ready,
        missing_policies: [...result.missing_policies],
        missing_apps: [...result.missing_apps],
        checked_at: at,
      }
      const target: ObjectRef = { type: 'launch_item', id: run.id }
      const staged = await stageOne({
        actor,
        kind: 'launch_check',
        target,
        before: {},
        after: launchCheckAfter(result),
        notes: result.missing.map((i) => `${i.title.zh}：${i.detail.zh}`),
        title: result.ready
          ? '上线检查单：没有拦路的缺项'
          : `上线检查单：${result.blockers} 项会让顾客买不成`,
        summary: result.missing.map((i) => `${i.title.zh}——${i.fix.zh}`).join('\n'),
        seen: [target],
        rule: 'role_holder',
      })
      const saved: LaunchCheckRun = {
        ...run,
        ...(staged.approval_item_id === undefined
          ? {}
          : { approval_item_id: staged.approval_item_id }),
      }
      store.saveRun(saved)
      emit('site.checklist_ran', actor.person_id, {
        run_id: saved.id,
        blockers: saved.blockers,
        warnings: saved.warnings,
        ready: saved.ready,
      })
      return { run: saved, staged }
    },

    lastChecklist() {
      const run = store.lastRun()
      return run === undefined ? {} : { run }
    },

    emailTemplates() {
      return { rows: allTemplates() }
    },

    async draftEmailTemplate(actor, input: SiteEmailTemplateInput) {
      const spec = notificationType(input.notification_type)
      if (spec === undefined)
        throw new ApiError(
          'invalid_input',
          `不认识这种通知邮件：${input.notification_type}。认得的那几种在 GET /v1/site/email-templates 里。`,
        )
      const before = templateOf(input.notification_type)
      const check = checkEmailTemplate(input)
      const preview = renderPreview(input.body, PREVIEW_SAMPLE)
      // 自查没过就**不提上去**：缺变量的稿提上去也会被 guardrail 当场 block，
      // 早点说比让模型反复试便宜（同群发向导那一条）。
      if (!check.ok) {
        return {
          template: { ...before, missing_variables: [...check.missing_variables] },
          problems: [check.message],
          preview,
          staged: { staged: false, message: check.message, level: check.level },
        }
      }
      const target: ObjectRef = { type: 'email_template', id: input.notification_type }
      const staged = await stageOne({
        actor,
        kind: 'email_template_edit',
        target,
        before: { subject: before.subject, body: before.body, enabled: before.enabled },
        after: emailTemplateAfter(input),
        notes: input.enabled
          ? ['启用这一份之后，之后每一个下单的客户收到的都是它']
          : ['草稿——启用那一下另提一张卡'],
        title: `${spec.name.zh}：${input.enabled ? '启用这一份' : '改成这一版（草稿）'}`,
        summary: input.subject,
        seen: [target],
        rule: input.enabled ? 'owner' : 'scope_manager',
      })
      const saved: ShopEmailTemplate = {
        ...before,
        subject: input.subject,
        body: input.body,
        // **库里这一份不当场变成"启用"**：启用是执行器在卡被批准之后做的事。
        enabled: before.enabled,
        missing_variables: [],
        ...(staged.change_id === undefined ? {} : { pending_change_id: staged.change_id }),
        updated_at: clock.now(),
      }
      store.saveTemplate(saved)
      emit('site.email_template_drafted', actor.person_id, {
        notification_type: input.notification_type,
        enabling: input.enabled,
        staged: staged.staged,
      })
      return { template: saved, problems: [], preview, staged }
    },

    apps() {
      return { rows: appRows() }
    },

    async proposeApp(actor, input: SiteAppInstallInput) {
      const target: ObjectRef = { type: 'shop_app', id: input.app_id }
      const before = store.app(input.app_id)
      const staged = await stageOne({
        actor,
        kind: 'app_install',
        target,
        before: { installed: before?.installed ?? false },
        after: appInstallAfter({
          app_id: input.app_id,
          operation: input.operation,
          ...(input.reason === undefined ? {} : { reason: input.reason }),
        }),
        notes:
          input.operation === 'install'
            ? ['装一个 App = 把店里的数据交给另一家公司，多数还按月收钱']
            : ['卸掉一个正在往前台注脚本的 App，店面会当场少一块'],
        title: `${input.operation === 'install' ? '装' : '卸'} ${before?.name ?? input.app_id}`,
        summary: input.reason ?? '',
        seen: [target],
        rule: 'owner',
      })
      emit('site.app_change_proposed', actor.person_id, {
        app_id: input.app_id,
        operation: input.operation,
        staged: staged.staged,
      })
      return staged
    },
  }

  return {
    port,
    deckData: () => siteDeckData(store, { apps: appRows(), templates: allTemplates() }),
  }
}

/* ── 面板投影（59 §3） ────────────────────────────────────────────────── */

/**
 * `SiteStore` → 面板那五块要的那份投影。
 *
 * 放在这里而不是 deck 里：deck 是**纯**的（29 §1，它连库都不认识），
 * 而这一步要把"上一次巡检"与"App 目录"拼起来。deck 拿到的已经是算好的行。
 *
 * 两件事在这一跳定死：
 *
 * 1. **缺项与"没读到"分得开**：`state` 原样端出去，界面按它上两种颜色。
 * 2. **主题那一块的预览链接原样带上**：12 §2「预览链接就是审批材料」——
 *    没有它的副本在面板上要看得出来（发布卡根本提不出去，见 `site-core`）。
 */
export function siteDeckData(
  store: Pick<SiteStore, 'lastRun'>,
  extra: {
    apps: readonly SiteAppRow[]
    templates: readonly ShopEmailTemplate[]
    themes?: readonly ThemeSummaryLike[]
  },
): SiteDeckData {
  const run = store.lastRun()
  const lanes = themeLanes(extra.themes ?? [])
  return {
    checklist: (run?.items ?? []).map((i) => ({
      id: i.id,
      title: i.title.zh,
      state: i.state,
      severity: i.severity,
      detail: i.detail.zh,
      fix: i.fix.zh,
      // 没有人补 = 建站岗位补不了（支付 / 税）。界面上那句"去后台自己点"读它
      fixable: i.fixable_by !== undefined,
    })),
    ...(run?.checked_at === undefined ? {} : { checked_at: run.checked_at }),
    themes: [
      ...(lanes.published === undefined
        ? []
        : [
            {
              theme_id: lanes.published.id,
              name: lanes.published.name,
              role: 'live',
              ...(lanes.published.updated_at === undefined
                ? {}
                : { updated_at: lanes.published.updated_at }),
            },
          ]),
      ...lanes.copies.map((t) => ({
        theme_id: t.id,
        name: t.name,
        role: 'copy',
        ...(t.preview_url === undefined ? {} : { preview_url: t.preview_url }),
        ...(t.updated_at === undefined ? {} : { updated_at: t.updated_at }),
      })),
    ],
    apps: extra.apps.map((a) => ({
      app_id: a.id,
      name: a.name,
      installed: a.installed,
      known: a.known,
      connectable: a.connectable,
    })),
    email_templates: extra.templates.map((t) => ({
      notification_type: t.notification_type,
      name: t.name.zh,
      enabled: t.enabled,
      // 正文一个字都不往面板上端：它是外部文本，而且长（21 §1）
      missing_variables: t.missing_variables.length,
      has_draft: t.pending_change_id !== undefined,
    })),
  }
}

/* ── 事实：经连接器的只读 Action（59 §2） ─────────────────────────────── */

/** 签一张只读令牌能活多久（与活数据源那一份同一个数）。 */
const SITE_TOKEN_TTL_SECONDS = 120
/** 这条只读路用的分配 id（与活数据源同一条纪律：它不是任何一个人的分配）。 */
const SITE_ASSIGNMENT = 'asg_site_readonly'

/** 跑一条只读 Action 要的那一小块连接器面（照 `live-data.ts` 的口子，不多要一格）。 */
export interface SiteConnectLike {
  actions(service: string): Promise<{ id: string; name?: string }[]>
  issueToken(input: {
    assignment_id: string
    kind: 'role-read'
    allowed_actions: string[]
    allowed_connections: string[]
    expires_in_seconds?: number
  }): Promise<{ token: string }>
  execute<T = unknown>(
    action_id: string,
    input: unknown,
    opts: { token: string; connection?: string },
  ): Promise<T>
}

const rec = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : {}
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])

/**
 * 从店铺连接上读一遍检查单要的事实。
 *
 * **每一条各自 try / catch**：一条读不到不该把整次巡检拖垮，那一格留空（`undefined`）
 * 就是"这次没读到"，检查单那边照 `unknown` 记。这正是文件头第 3 条——
 * 一次因为令牌过期没读到支付设置的巡检，不该在卡面上写成"这家店没有收款方式"。
 *
 * **全是读**：这一段里出现的每一个 action id 在
 * `packages/connect-adapter/action-side-effects.yml` 里都标着 `read`。
 */
export function createConnectSiteFacts(options: {
  connect: SiteConnectLike
  /** 现在这家店的那条连接（没有就整次巡检全是 `unknown`）。 */
  connection(): { id: string; service: string } | undefined
  /** 店铺标识（只进巡检记录与卡面，不是凭据）。 */
  shop?(): string | undefined
}): SiteFactsPort {
  const READS = [
    'get_shop',
    'list_menus',
    'list_shop_policies',
    'get_payment_settings',
    'get_tax_settings',
    'list_shipping_zones',
    'list_installed_apps',
    'list_themes',
  ] as const

  const factsOf = async (): Promise<LaunchCheckFacts> => {
    const connection = options.connection()
    if (connection === undefined) return {}
    let available: { id: string }[] = []
    try {
      available = await options.connect.actions(connection.service)
    } catch {
      return {}
    }
    const idOf = (name: string): string | undefined =>
      available.find((a) => a.id === `${connection.service}.${name}` || a.id.endsWith(`.${name}`))
        ?.id
    const allowed = READS.map(idOf).filter((id): id is string => id !== undefined)
    if (allowed.length === 0) return {}
    let token: string
    try {
      token = (
        await options.connect.issueToken({
          assignment_id: SITE_ASSIGNMENT,
          kind: 'role-read',
          allowed_actions: allowed,
          allowed_connections: [connection.id],
          expires_in_seconds: SITE_TOKEN_TTL_SECONDS,
        })
      ).token
    } catch {
      return {}
    }
    /** 一条读不到就回 `undefined`——那一格照"没读到"记，不补一个"缺"。 */
    const run = async (name: string, input: unknown = {}): Promise<unknown> => {
      const id = idOf(name)
      if (id === undefined) return undefined
      try {
        const out = await options.connect.execute(id, input, {
          token,
          connection: connection.id,
        })
        return rec(out).data ?? out
      } catch {
        return undefined
      }
    }

    const out: LaunchCheckFacts = {}
    const shop = await run('get_shop')
    if (shop !== undefined) {
      const s = rec(rec(shop).shop ?? shop)
      const primary = typeof s.primaryDomainUrl === 'string' ? s.primaryDomainUrl : undefined
      const my = typeof s.myshopifyDomain === 'string' ? s.myshopifyDomain : undefined
      out.domain = {
        ...(primary === undefined ? {} : { primary }),
        // 自有域名 = 主域名不是那串 `xxx.myshopify.com`
        custom: primary !== undefined && my !== undefined && !primary.includes(my),
      }
    }
    const payment = await run('get_payment_settings')
    if (payment !== undefined) {
      const p = rec(payment)
      out.payment = {
        providers: arr(p.providers ?? p.enabled_providers).filter(
          (x): x is string => typeof x === 'string',
        ),
        test_mode: p.test_mode === true,
      }
    }
    const tax = await run('get_tax_settings')
    if (tax !== undefined) {
      const t = rec(tax)
      const regions = arr(t.regions).filter((x): x is string => typeof x === 'string')
      out.tax = { configured: regions.length > 0 || t.configured === true, regions }
    }
    const zones = await run('list_shipping_zones')
    if (zones !== undefined) {
      const rows = arr(rec(zones).zones ?? zones)
      out.shipping = {
        zones: rows.length,
        rates: rows.reduce((n: number, z) => n + arr(rec(z).rates).length, 0),
      }
    }
    const policies = await run('list_shop_policies')
    if (policies !== undefined) {
      const rows = arr(rec(policies).policies ?? policies)
      out.policies = {
        present: rows
          .filter((p) => {
            const body = rec(p).body
            return typeof body === 'string' && body.trim() !== ''
          })
          .map((p) => String(rec(p).type ?? rec(p).handle ?? ''))
          .filter((h) => h !== ''),
      }
    }
    const menus = await run('list_menus')
    if (menus !== undefined) {
      const rows = arr(rec(menus).menus ?? menus)
      const itemsOf = (handle: string): number =>
        arr(rec(rows.find((m) => rec(m).handle === handle)).items).length
      out.navigation = {
        main_menu_items: itemsOf('main-menu'),
        footer_menu_items: itemsOf('footer'),
      }
    }
    const apps = await run('list_installed_apps')
    if (apps !== undefined) {
      const rows = arr(rec(apps).apps ?? apps)
      out.apps = {
        installed: rows
          .map((a) => String(rec(a).id ?? rec(a).handle ?? ''))
          .filter((i) => i !== ''),
      }
    }
    const themes = await run('list_themes')
    if (themes !== undefined) {
      const rows = arr(rec(themes).themes ?? themes)
      const live = rows.find((t) => rec(t).role === 'main' || rec(t).role === 'live')
      out.theme =
        live === undefined
          ? {}
          : {
              published: {
                id: String(rec(live).id ?? ''),
                name: String(rec(live).name ?? ''),
              },
            }
    }
    return out
  }

  return {
    storeFacts: factsOf,
    async themes() {
      const connection = options.connection()
      if (connection === undefined) return []
      return []
    },
    shop: () => options.shop?.(),
  }
}

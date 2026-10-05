/**
 * WP219（docs/90 §6）：用户端的**内容更新**——每隔几小时（及启动时）查一次已审内容的清单，
 * 按品牌出卡或自动更新、原子换基础层、保留旧版一份、一键退回、与你的改动三方合并。
 *
 * 只认签名对得上内置公钥的清单（{@link CONTENT_SIGNING_PUBLIC_KEYS}，现在是空的 → 通道关着）；
 * 任一条目哈希不对整包拒收；最低软件版本不满足的不收。不改到程序：内容包里只有技能这类说明文字。
 *
 * 品牌各管各的（WP215 / 52）：设置（自动 / 每次问我）、当前版、保留的上一版、卡、冲突都按品牌存；
 * 只落到启用了这条内容的品牌（Shopify 技能只给建站平台是 Shopify 的品牌，与 WP216 同一口径）。
 */
import type {
  ApprovalItem,
  Clock,
  ContentChannel,
  ContentConflictCardPayload,
  ContentDiffView,
  ContentItem,
  ContentItemStatus,
  ContentManifest,
  ContentPublicKey,
  ContentUpdateCardPayload,
  ContentUpdateMode,
  ContentUpdatesView,
  DecideInput,
  EventEnvelope,
  KnownEventType,
  PersonId,
  StorefrontPlatform,
  WorkspaceId,
} from '@agentsws/contracts'
import { CONTENT_MIRROR_REPO, CONTENT_FEED_BASE as DEFAULT_BASE } from '@agentsws/contracts'
import {
  type AppliedContent,
  BUNDLED_SKILLS_DIR,
  bundledSkillVersion,
  CONTENT_REJECT_TEXT,
  CONTENT_UPDATE_SOURCE,
  ContentPackError,
  type ContentRejectReason,
  ContentStore,
  type ContentUserEdit,
  compareSkillVersions,
  contentConflictKey,
  contentItemFitsApp,
  diffSkillMarkdown,
  listBundledSkills,
  type MemorySkillRegistry,
  planContentMerge,
  readBundledSkill,
  scanContentFiles,
  verifyContentItemFiles,
  verifyContentManifest,
} from '@agentsws/skills'

/** 服务进程的开关：`on` 才查（桌面安装包启动服务时给）；测试、模拟、demo 默认不查。 */
export const CONTENT_UPDATES_ENV = 'AGENTSWS_CONTENT_UPDATES'

/** 本版用户端能落地的条目种类（`role` / `declarative` 格式已定，以后随程序版本支持）。 */
export const SUPPORTED_CONTENT_KINDS: readonly ContentItem['kind'][] = ['skill']

// ---------- 更新源 ----------

export interface ContentFeedSource {
  label: 'primary' | 'mirror'
  manifestUrl: string
  signatureUrl: string
  blobUrl(sha256: string): string
}

/**
 * 主源 = 自有下载站 `<base>/<渠道>/`（`blobs/<sha256>`）；镜像 = GitHub Releases 上的滚动 release
 * `content-<渠道>`（文件名 `blob-<sha256>`，Release 里不能有目录）。主源连不上 / 被拒才试镜像。
 */
export function contentFeedSources(
  channel: ContentChannel,
  base: string = DEFAULT_BASE,
  mirrorRepo: string = CONTENT_MIRROR_REPO,
): ContentFeedSource[] {
  const root = `${base.replace(/\/+$/, '')}/${channel}`
  const gh = `https://github.com/${mirrorRepo}/releases/download/content-${channel}`
  return [
    {
      label: 'primary',
      manifestUrl: `${root}/content-manifest.json`,
      signatureUrl: `${root}/content-manifest.json.sig`,
      blobUrl: (sha) => `${root}/blobs/${sha}`,
    },
    {
      label: 'mirror',
      manifestUrl: `${gh}/content-manifest.json`,
      signatureUrl: `${gh}/content-manifest.json.sig`,
      blobUrl: (sha) => `${gh}/blob-${sha}`,
    },
  ]
}

export type ContentFetch = (
  url: string,
  init?: { signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; arrayBuffer(): Promise<ArrayBuffer> }>

// ---------- 装配 ----------

type AppendEvent = (e: Omit<EventEnvelope, 'id' | 'at'>) => void

interface ApprovalsLike {
  create(input: never): Promise<ApprovalItem>
  get(id: string): Promise<ApprovalItem | undefined>
}

export interface ContentBrand {
  id: WorkspaceId
  owner_id?: PersonId
}

export interface ContentUpdatesOptions {
  /** 存放处（数据目录下 `content-updates/`）。 */
  root: string
  appVersion: string
  channel: ContentChannel
  keys: readonly ContentPublicKey[]
  sources: readonly ContentFeedSource[]
  fetch: ContentFetch
  clock: Clock
  registry: MemorySkillRegistry
  /** 随软件带的技能目录（测试注入）。 */
  bundledDir?: string
  brands: () => Promise<readonly ContentBrand[]>
  /** 品牌的建站平台（档案里每次现取，不缓存）。 */
  platformOf: (ws: WorkspaceId) => StorefrontPlatform | undefined
  /** 晚绑定：审批总线在内容更新之后才包好。 */
  approvals: () => ApprovalsLike | undefined
  appendEvent: AppendEvent
  /** 关着的原因（没开 / 没钥匙）：给了就不查，界面照实说。 */
  off?: string
}

export interface ContentCheckReport {
  state: 'ok' | 'off' | 'error'
  serial?: number
  reason?: ContentRejectReason
  text?: string
  /** 这次新出的卡 / 自动更新了的（`<品牌>:<条目>@<版本>`）。 */
  carded: string[]
  applied: string[]
}

export interface ContentUpdates {
  check(): Promise<ContentCheckReport>
  /** 启动时：把各品牌更新过的基础层装回技能库（软件自带的已追上就丢掉覆盖）。 */
  restore(): Promise<void>
  view(ws: WorkspaceId): ContentUpdatesView
  setMode(ws: WorkspaceId, mode: ContentUpdateMode): ContentUpdatesView
  /** 人点了「更新」（卡上或设置里）。 */
  apply(ws: WorkspaceId, itemId: string, by: 'auto' | 'person'): Promise<ContentUpdatesView>
  rollback(ws: WorkspaceId, itemId: string): Promise<ContentUpdatesView>
  diff(ws: WorkspaceId, itemId: string): ContentDiffView
  /** 审批总线的包装：内容更新卡批了 → 更新；冲突卡选了 → 照选的做。 */
  wrap<B extends { decide(id: string, by: never, input: DecideInput): Promise<ApprovalItem> }>(
    bus: B,
  ): B
}

export class ContentUpdateError extends Error {
  readonly code: 'not_found' | 'conflict'
  constructor(code: ContentUpdateError['code'], message: string) {
    super(message)
    this.name = 'ContentUpdateError'
    this.code = code
  }
}

const OWNER_ROLE = 'common.owner'
const ACTIVE_CARD = new Set([
  'proposed',
  'pending',
  'in_review',
  'deferred',
  'approved',
  'approved_edited',
])
const TIMEOUT_MS = 30_000

export function createContentUpdates(options: ContentUpdatesOptions): ContentUpdates {
  const store = new ContentStore(options.root)
  const bundledDir = options.bundledDir ?? BUNDLED_SKILLS_DIR
  const registry = options.registry
  const now = (): string => options.clock.now()

  const emit = (ws: string, type: KnownEventType, payload: Record<string, unknown>): void => {
    options.appendEvent({
      schema_version: 1,
      workspace_id: ws as EventEnvelope['workspace_id'],
      type,
      actor: { kind: 'system', id: 'content-updates' },
      correlation: { trace_id: `trc_content_${Date.parse(now()).toString(36)}` },
      payload,
    })
  }

  // ---------- 读法 ----------

  const manifest = (): ContentManifest | undefined => store.readGlobal().manifest
  const itemOf = (id: string): ContentItem | undefined => manifest()?.items.find((i) => i.id === id)
  const supported = (item: ContentItem): boolean =>
    SUPPORTED_CONTENT_KINDS.includes(item.kind) && contentItemFitsApp(item, options.appVersion)
  const enabledFor = (item: ContentItem, ws: WorkspaceId): boolean =>
    item.platforms === undefined ||
    item.platforms.length === 0 ||
    item.platforms.includes(options.platformOf(ws) ?? 'shopify')

  /** 随软件带的那一版的版本号（没带这一条就 `undefined`）。 */
  const bundledVersionOf = (item: Pick<ContentItem, 'kind' | 'name'>): string | undefined => {
    if (item.kind !== 'skill' || !listBundledSkills(bundledDir).includes(item.name))
      return undefined
    return bundledSkillVersion(readBundledSkill(item.name, bundledDir).markdown)
  }

  const currentVersionOf = (ws: WorkspaceId, item: ContentItem): string | undefined =>
    store.readWorkspace(ws).items[item.id]?.current?.version ?? bundledVersionOf(item)

  const isNewer = (ws: WorkspaceId, item: ContentItem): boolean => {
    const cur = currentVersionOf(ws, item)
    return cur === undefined || compareSkillVersions(item.version, cur) > 0
  }

  /** 这个品牌现在的基础层正文（更新过的那一版，或随软件带的）。 */
  const baseMarkdown = (
    name: string,
    applied?: Pick<AppliedContent, 'sha256' | 'files'>,
  ): string | undefined => {
    if (applied !== undefined) {
      const dir = store.ensureTree({ name, sha256: applied.sha256, files: applied.files })
      return readBundledSkill(name, dir).markdown
    }
    if (!listBundledSkills(bundledDir).includes(name)) return undefined
    return readBundledSkill(name, bundledDir).markdown
  }

  // ---------- 查清单 ----------

  async function fetchBytes(url: string): Promise<Buffer> {
    let res: Awaited<ReturnType<ContentFetch>>
    try {
      res = await options.fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) })
    } catch (e) {
      throw new ContentPackError(
        'fetch_failed',
        `${url}：${e instanceof Error ? e.message : String(e)}`,
      )
    }
    if (!res.ok) throw new ContentPackError('fetch_failed', `${url}：HTTP ${res.status}`)
    return Buffer.from(await res.arrayBuffer())
  }

  /** 从一个源取清单 + 文件，全部验过才落盘；任一条不过整包拒收。 */
  async function pull(source: ContentFeedSource): Promise<ContentManifest> {
    const [bytes, sig] = await Promise.all([
      fetchBytes(source.manifestUrl),
      fetchBytes(source.signatureUrl),
    ])
    const global = store.readGlobal()
    const m = verifyContentManifest(bytes, sig.toString('utf8'), {
      keys: options.keys,
      appVersion: options.appVersion,
      channel: options.channel,
      minSerial: global.max_serial,
      allowSame: true,
    })
    const fresh = new Map<string, Buffer>()
    for (const item of m.items.filter(supported)) {
      for (const f of item.files) {
        if (store.hasBlob(f.sha256) || fresh.has(f.sha256)) continue
        fresh.set(f.sha256, await fetchBytes(source.blobUrl(f.sha256)))
      }
    }
    // 先全部验完（内存里），一个不对就整包拒收——这一刻之前什么都没写
    for (const item of m.items.filter(supported))
      verifyContentItemFiles(item, (sha) => fresh.get(sha) ?? store.readBlob(sha))
    for (const [sha, b] of fresh) store.putBlob(sha, b)
    for (const item of m.items.filter(supported)) store.ensureTree(item)
    store.writeGlobal({ max_serial: m.serial, manifest: m, last_checked_at: now() })
    return m
  }

  async function check(): Promise<ContentCheckReport> {
    const report: ContentCheckReport = { state: 'ok', carded: [], applied: [] }
    if (options.off !== undefined) return { ...report, state: 'off', text: options.off }
    let m: ContentManifest | undefined
    let failure: ContentPackError | undefined
    for (const source of options.sources) {
      try {
        m = await pull(source)
        break
      } catch (e) {
        const err =
          e instanceof ContentPackError ? e : new ContentPackError('fetch_failed', String(e))
        // 安全类的拒收比「没连上」更要紧：留第一条安全原因
        if (failure === undefined || failure.reason === 'fetch_failed') failure = err
      }
    }
    if (m === undefined) {
      const f = failure ?? new ContentPackError('fetch_failed')
      const g = store.readGlobal()
      store.writeGlobal({
        ...g,
        last_checked_at: now(),
        last_error: { reason: f.reason, text: CONTENT_REJECT_TEXT[f.reason], at: now() },
      })
      if (f.reason !== 'fetch_failed' && f.reason !== 'old_serial')
        for (const b of await options.brands())
          emit(b.id, 'content_update.rejected', { reason: f.reason, detail: f.detail ?? null })
      return { ...report, state: 'error', reason: f.reason, text: CONTENT_REJECT_TEXT[f.reason] }
    }
    report.serial = m.serial
    for (const brand of await options.brands()) {
      const fresh = await evaluate(brand, m)
      report.carded.push(...fresh.carded)
      report.applied.push(...fresh.applied)
      emit(brand.id, 'content_update.checked', {
        serial: m.serial,
        carded: fresh.carded.length,
        applied: fresh.applied.length,
      })
    }
    return report
  }

  /** 一个品牌：哪些条目有它该收的新版 → 自动更新或出卡。 */
  async function evaluate(
    brand: ContentBrand,
    m: ContentManifest,
  ): Promise<{ carded: string[]; applied: string[] }> {
    const out = { carded: [] as string[], applied: [] as string[] }
    const ws = brand.id
    for (const item of m.items) {
      if (!supported(item) || !enabledFor(item, ws) || !isNewer(ws, item)) continue
      const state = store.readWorkspace(ws)
      if (state.items[item.id]?.skipped_version === item.version) continue
      const tag = `${ws}:${item.id}@${item.version}`
      if (state.mode === 'auto' && scanClean(item)) {
        await applyItem(ws, item, 'auto')
        out.applied.push(tag)
        continue
      }
      if (await ensureUpdateCard(brand, item, m.serial)) out.carded.push(tag)
    }
    return out
  }

  /** 审核记录里没有命中、本机重扫也没有命中，才允许自动更新（命中就标红、不自动通过）。 */
  function scanClean(item: ContentItem): boolean {
    if (item.review.scan_hits > 0) return false
    const files = new Map<string, Buffer>()
    for (const f of item.files) {
      const b = store.readBlob(f.sha256)
      if (b !== undefined) files.set(f.path, b)
    }
    return scanContentFiles(files).length === 0
  }

  async function ensureCard(
    ws: WorkspaceId,
    key: string,
    create: (approvals: ApprovalsLike) => Promise<ApprovalItem>,
  ): Promise<boolean> {
    const approvals = options.approvals()
    if (approvals === undefined) return false
    const state = store.readWorkspace(ws)
    const existing = state.cards?.[key]
    if (existing !== undefined) {
      const card = await approvals.get(existing)
      if (card !== undefined && ACTIVE_CARD.has(card.state)) return false
    }
    const card = await create(approvals)
    const next = store.readWorkspace(ws)
    next.cards = { ...(next.cards ?? {}), [key]: card.id }
    store.writeWorkspace(ws, next)
    return true
  }

  function routing(owner: PersonId | undefined) {
    return {
      recipients: owner === undefined ? [] : [{ person: owner, via: 'owner' as const }],
      rule: 'owner',
      escalation: { after_hours: 72, business_hours: true, chain: ['owner'], escalated_at: [] },
      separation_of_duties: false,
    }
  }

  async function ensureUpdateCard(
    brand: ContentBrand,
    item: ContentItem,
    serial: number,
  ): Promise<boolean> {
    const ws = brand.id
    const from = currentVersionOf(ws, item)
    const payload: ContentUpdateCardPayload = {
      form: 'content_update',
      workspace_id: ws,
      item_id: item.id,
      name: item.name,
      title: item.title,
      ...(from === undefined ? {} : { from_version: from }),
      to_version: item.version,
      upstream_published_at: item.upstream.published_at,
      summary: item.summary,
      reviewed: true,
      reviewer: item.review.reviewer,
      serial,
    }
    const key = `${ws}:content_update:${item.id}:${item.version}`
    return ensureCard(ws, key, (approvals) =>
      approvals.create({
        workspace_id: ws,
        schema_version: 1,
        kind: 'content_update',
        role_id: OWNER_ROLE,
        subject: { object: { type: 'content_item', id: item.id } },
        dedupe_key: key,
        title: `${item.title.zh} 有新版 · 官方 ${item.upstream.published_at} 更新 · 已审`,
        summary:
          item.review.scan_hits > 0
            ? `${item.summary.zh}（审核时有 ${item.review.scan_hits} 处要留意，已逐条看过放行，所以不自动更新）`
            : item.summary.zh,
        payload: {
          ...payload,
          before: { 版本: from ?? '—' },
          after: { 版本: item.version },
          ...(item.review.scan_hits > 0 ? { scan_hits: item.review.scan_hits } : {}),
        },
        evidence: {
          source_events: [],
          provenance: { seen: [{ type: 'content_item', id: item.id }] },
          precheck: { permission_diff: 'ok', semantic_diff: 'ok' },
        },
        proposer: { kind: 'agent', id: 'content-updates' },
        automation: { level_at_creation: 'L1' },
        routing: routing(brand.owner_id),
        priority: 'queue',
        risk_class: 'low',
      } as never),
    )
  }

  // ---------- 应用 / 合并 / 退回 ----------

  /** 技能库里这个品牌的基础层换成 `markdown`（`undefined` = 退回随软件带的那一份）。 */
  async function putBase(
    ws: WorkspaceId,
    item: Pick<ContentItem, 'name'>,
    applied?: AppliedContent,
  ) {
    if (applied === undefined) {
      registry.drop(item.name, 'package', { workspace_id: ws })
      return
    }
    const markdown = baseMarkdown(item.name, applied)
    if (markdown === undefined) return
    await registry.putFromMarkdown({
      markdown,
      tier: 'package',
      owner: 'package',
      version: applied.version,
      workspace_id: ws,
      source: { package: CONTENT_UPDATE_SOURCE, version: applied.version },
    })
  }

  /** 你的改动（上层记录里替换了基础层的段、overlay 的 op）。 */
  function editsOf(ws: WorkspaceId, name: string, baseIds: ReadonlySet<string>): ContentUserEdit[] {
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

  async function applyItem(
    ws: WorkspaceId,
    item: ContentItem,
    by: 'auto' | 'person',
  ): Promise<void> {
    const before = registry.peek(item.name, 'package', { workspace_id: ws })
    const next: AppliedContent = {
      version: item.version,
      sha256: item.sha256,
      files: item.files,
      applied_at: now(),
      serial: manifest()?.serial ?? 0,
      by,
      upstream_published_at: item.upstream.published_at,
      title: item.title,
    }
    store.ensureTree(item)
    const prev = store.apply(ws, item.id, next)
    try {
      await putBase(ws, item, next)
    } catch (e) {
      // 技能库装不进去：状态退回原样，什么都没换
      const st = store.readWorkspace(ws)
      st.items[item.id] = { ...(prev === undefined ? {} : { current: prev }) }
      store.writeWorkspace(ws, st)
      throw e
    }
    emit(ws, 'content_update.applied', {
      item_id: item.id,
      version: item.version,
      from: prev?.version ?? null,
      by,
    })
    const after = registry.peek(item.name, 'package', { workspace_id: ws })
    if (before === undefined || after === undefined) return
    await mergeUserEdits(ws, item, before.sections, after.sections)
  }

  async function mergeUserEdits(
    ws: WorkspaceId,
    item: ContentItem,
    before: readonly { id: string; heading: string; body: string }[],
    after: readonly { id: string; heading: string; body: string }[],
  ): Promise<void> {
    const plan = planContentMerge(
      before,
      after,
      editsOf(ws, item.name, new Set(before.map((s) => s.id))),
    )
    const state = store.readWorkspace(ws)
    const open: string[] = []
    for (const c of plan.conflicts) {
      // 上层那一段只是照抄了旧版（没真改）：跟着新版走，不问人
      if (c.source === 'layer' && c.mine.trim() === c.base_before.trim()) {
        await useNew(ws, item.name, c)
        continue
      }
      const key = contentConflictKey(item.id, item.version, c)
      if (state.resolved_conflicts.includes(key)) continue
      open.push(key)
      const owner = (await options.brands()).find((b) => b.id === ws)?.owner_id
      const payload: ContentConflictCardPayload = {
        form: 'content_conflict',
        workspace_id: ws,
        item_id: item.id,
        name: item.name,
        title: item.title,
        version: item.version,
        section_id: c.section_id,
        heading: c.heading,
        tier: c.tier,
        owner: c.owner,
        base_before: c.base_before,
        base_after: c.base_after,
        mine: c.mine,
      }
      await ensureCard(ws, key, (approvals) =>
        approvals.create({
          workspace_id: ws,
          schema_version: 1,
          kind: 'content_conflict',
          role_id: OWNER_ROLE,
          subject: { object: { type: 'content_item', id: item.id } },
          dedupe_key: key,
          title: `${item.title.zh}「${c.heading}」这一段：新版和你的改动不一样`,
          summary: '新版改了这一段，你（或学习回路）也改过。选一个：用新版，还是保留你的。',
          payload,
          options: [
            { id: 'use_new', label: '用新版' },
            { id: 'keep_mine', label: '保留我的' },
          ],
          evidence: {
            source_events: [],
            provenance: { seen: [{ type: 'content_item', id: item.id }] },
            precheck: { permission_diff: 'ok', semantic_diff: 'ok' },
          },
          proposer: { kind: 'agent', id: 'content-updates' },
          automation: { level_at_creation: 'L1' },
          routing: routing(owner),
          priority: 'queue',
          risk_class: 'medium',
        } as never),
      )
      emit(ws, 'content_update.conflict', {
        item_id: item.id,
        version: item.version,
        section_id: c.section_id,
        tier: c.tier,
      })
    }
    const st = store.readWorkspace(ws)
    const cur = st.items[item.id]
    if (cur !== undefined) {
      st.items[item.id] = { ...cur, ...(open.length === 0 ? {} : { open_conflicts: open }) }
      if (open.length === 0) delete st.items[item.id]?.open_conflicts
      store.writeWorkspace(ws, st)
    }
  }

  /** 冲突选了「用新版」：把你那一处改动去掉，新版的这一段露出来。 */
  async function useNew(
    ws: WorkspaceId,
    name: string,
    c: Pick<ContentUserEdit, 'tier' | 'owner' | 'source' | 'section_id'>,
  ): Promise<void> {
    if (c.source === 'overlay') {
      const o = registry.getOverlay(name, c.tier as never, c.owner)
      if (o === undefined) return
      await registry.setOverlay({ ...o, ops: o.ops.filter((op) => op.section_id !== c.section_id) })
      return
    }
    const rec = registry
      .listUpperLayers(name, ws)
      .records.find((r) => r.tier === c.tier && (r.scope_id ?? r.owner ?? ws) === c.owner)
    if (rec === undefined) return
    await registry.put({ ...rec, sections: rec.sections.filter((s) => s.id !== c.section_id) })
  }

  async function resolveConflict(item: ApprovalItem): Promise<void> {
    const p = item.payload as Partial<ContentConflictCardPayload> | undefined
    const choice = item.decision?.selected_option_id
    if (p?.form !== 'content_conflict' || p.item_id === undefined || p.name === undefined) return
    if (choice !== 'use_new' && choice !== 'keep_mine') return
    const ws = item.workspace_id
    const edit = {
      tier: p.tier ?? '',
      owner: p.owner ?? '',
      section_id: p.section_id ?? '',
    }
    const source = registry
      .getOverlay(p.name, edit.tier as never, edit.owner)
      ?.ops.some((op) => op.section_id === edit.section_id)
      ? ('overlay' as const)
      : ('layer' as const)
    if (choice === 'use_new') await useNew(ws, p.name, { ...edit, source })
    const key = contentConflictKey(p.item_id, p.version ?? '', edit)
    const st = store.readWorkspace(ws)
    st.resolved_conflicts = [...new Set([...st.resolved_conflicts, key])]
    const cur = st.items[p.item_id]
    if (cur?.open_conflicts !== undefined) {
      const left = cur.open_conflicts.filter((k) => k !== key)
      if (left.length === 0) delete cur.open_conflicts
      else cur.open_conflicts = left
    }
    store.writeWorkspace(ws, st)
    emit(ws, 'content_update.resolved', { item_id: p.item_id, section_id: edit.section_id, choice })
  }

  // ---------- 视图 ----------

  function view(ws: WorkspaceId): ContentUpdatesView {
    const g = store.readGlobal()
    const st = store.readWorkspace(ws)
    const m = g.manifest
    const items: ContentItemStatus[] = []
    const seen = new Set<string>()
    for (const item of m?.items ?? []) {
      if (!enabledFor(item, ws)) continue
      const mine = st.items[item.id]
      const cur = mine?.current?.version ?? bundledVersionOf(item)
      const newer = cur === undefined || compareSkillVersions(item.version, cur) > 0
      const fits = supported(item)
      if (mine?.current === undefined && !newer) continue
      seen.add(item.id)
      items.push({
        id: item.id,
        name: item.name,
        title: item.title,
        state:
          (mine?.open_conflicts?.length ?? 0) > 0
            ? 'conflict'
            : newer && !fits
              ? 'needs_app_update'
              : newer
                ? 'available'
                : 'current',
        ...(cur === undefined ? {} : { current_version: cur }),
        ...(newer
          ? { available_version: item.version, upstream_published_at: item.upstream.published_at }
          : {}),
        ...(mine?.current === undefined ? {} : { updated_at: mine.current.applied_at }),
        ...(mine?.current === undefined
          ? {}
          : { previous_version: mine.previous?.version ?? bundledVersionOf(item) ?? '' }),
      })
    }
    // 清单里已经没了、但这个品牌更新过的（仍可退回）
    for (const [id, mine] of Object.entries(st.items)) {
      if (seen.has(id) || mine.current === undefined) continue
      const name = id.slice(id.indexOf(':') + 1)
      items.push({
        id,
        name,
        title: mine.current.title,
        state: (mine.open_conflicts?.length ?? 0) > 0 ? 'conflict' : 'current',
        current_version: mine.current.version,
        updated_at: mine.current.applied_at,
        previous_version: mine.previous?.version ?? bundledVersionOf({ kind: 'skill', name }) ?? '',
      })
    }
    const state: ContentUpdatesView['state'] =
      options.off !== undefined
        ? 'off'
        : g.last_error !== undefined
          ? 'error'
          : g.last_checked_at === undefined
            ? 'unknown'
            : 'ok'
    const reason = options.off ?? g.last_error?.text
    return {
      mode: st.mode,
      channel: options.channel,
      state,
      ...(reason === undefined ? {} : { reason }),
      ...(g.last_checked_at === undefined ? {} : { last_checked_at: g.last_checked_at }),
      items,
    }
  }

  return {
    check,

    async restore() {
      for (const ws of store.workspaces()) {
        const st = store.readWorkspace(ws)
        for (const [id, mine] of Object.entries(st.items)) {
          if (mine.current === undefined) continue
          const name = id.slice(id.indexOf(':') + 1)
          const bundled = bundledVersionOf({ kind: 'skill', name })
          // 软件自带的那一版已经追上（或更新）：覆盖不要了
          if (bundled !== undefined && compareSkillVersions(bundled, mine.current.version) >= 0) {
            store.clear(ws, id)
            continue
          }
          try {
            await putBase(ws as WorkspaceId, { name }, mine.current)
          } catch {
            /* 读不出（文件被删了）：这个品牌照旧用随软件带的那一版，下次查清单会再提 */
          }
        }
      }
    },

    view,

    setMode(ws, mode) {
      const st = store.readWorkspace(ws)
      store.writeWorkspace(ws, { ...st, mode })
      return view(ws)
    },

    async apply(ws, itemId, by) {
      if (options.off !== undefined) throw new ContentUpdateError('conflict', options.off)
      const item = itemOf(itemId)
      if (item === undefined) throw new ContentUpdateError('not_found', `没有这条内容：${itemId}`)
      if (!supported(item) || !enabledFor(item, ws) || !isNewer(ws, item))
        throw new ContentUpdateError('conflict', '这条内容现在没有能更新的新版')
      await applyItem(ws, item, by)
      return view(ws)
    },

    async rollback(ws, itemId) {
      const name = itemId.slice(itemId.indexOf(':') + 1)
      const out = store.rollback(ws, itemId)
      if (out === undefined)
        throw new ContentUpdateError('not_found', '这条内容没有更新过，没什么可退回的')
      await putBase(ws, { name }, out.restored)
      emit(ws, 'content_update.rolled_back', {
        item_id: itemId,
        from: out.dropped.version,
        to: out.restored?.version ?? bundledVersionOf({ kind: 'skill', name }) ?? null,
      })
      return view(ws)
    },

    diff(ws, itemId) {
      const st = store.readWorkspace(ws).items[itemId]
      const item = itemOf(itemId)
      const name = itemId.slice(itemId.indexOf(':') + 1)
      // 有新版：现在这一版 → 新版；没有新版但更新过：上一版 → 现在这一版
      if (item !== undefined && isNewer(ws, item)) {
        const from = baseMarkdown(name, st?.current)
        const to = baseMarkdown(name, item)
        if (to === undefined) throw new ContentUpdateError('not_found', `读不到 ${itemId} 的新版`)
        const fromVersion = currentVersionOf(ws, item)
        return {
          item_id: itemId,
          title: item.title,
          ...(fromVersion === undefined ? {} : { from_version: fromVersion }),
          to_version: item.version,
          sections: diffSkillMarkdown(from, to),
        }
      }
      if (st?.current === undefined)
        throw new ContentUpdateError('not_found', '这条内容没有改动可看')
      const prevVersion = st.previous?.version ?? bundledVersionOf({ kind: 'skill', name })
      return {
        item_id: itemId,
        title: st.current.title,
        ...(prevVersion === undefined ? {} : { from_version: prevVersion }),
        to_version: st.current.version,
        sections: diffSkillMarkdown(
          baseMarkdown(name, st.previous),
          baseMarkdown(name, st.current) ?? '',
        ),
      }
    },

    wrap(bus) {
      return new Proxy(bus, {
        get(target, prop, receiver) {
          if (prop !== 'decide') {
            const value = Reflect.get(target, prop, receiver)
            return typeof value === 'function' ? value.bind(target) : value
          }
          return async (id: string, by: never, input: DecideInput): Promise<ApprovalItem> => {
            const out = await target.decide(id, by, input)
            const approved = out.state === 'approved' || out.state === 'approved_edited'
            if (!approved) return out
            try {
              if (out.kind === 'content_update') {
                const p = out.payload as Partial<ContentUpdateCardPayload> | undefined
                const item = p?.item_id === undefined ? undefined : itemOf(p.item_id)
                // 批的是哪一版就只更新哪一版：卡发出去之后清单换了版本，等下一张卡
                if (
                  item !== undefined &&
                  item.version === p?.to_version &&
                  isNewer(out.workspace_id, item)
                )
                  await applyItem(out.workspace_id, item, 'person')
              }
              if (out.kind === 'content_conflict') await resolveConflict(out)
            } catch (e) {
              emit(out.workspace_id, 'content_update.rejected', {
                reason: e instanceof ContentPackError ? e.reason : 'apply_failed',
                detail: e instanceof Error ? e.message : String(e),
              })
            }
            return out
          }
        },
      })
    },
  }
}

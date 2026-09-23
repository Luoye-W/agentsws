/**
 * WP119（68 / 48 §5）：**浏览器插件的本机那一半**。
 *
 * 插件报一批观测过来，这里做三件事，顺序不能反：
 *
 * 1. **先落本机**。找到或新建 `creator` + `platform_account`，把这一刻的粉丝数
 *    与 `observed_at` 写下去。这一步永远发生——云连不上、没登录、令牌过期，
 *    用户按下的那一下也必须留在他自己的电脑上。
 * 2. **再转发**。登录了云账号就把同一批（**过一遍更窄的白名单**）送去公共红人库。
 *    转发失败不回滚第 1 步，也不让整个请求失败——公共库是加分项，不是先决条件。
 * 3. **联系方式单走一条**。明文进本机加密库，库里只留 `value_ref`。
 *    这个文件里没有任何一处把明文放进返回值、日志或事件。
 *
 * Luoye 09-19 定的那一条落在第 2 步：**只要登录了云账号就默认共享，不设勾选项**。
 * 所以这里没有 `if (settings.contribute)` 这种分支——有的只是 `linked()`。
 * 对应的义务是「说清楚」，那一半在插件的隐私页、面板第一行与 `STORE.md` 里。
 *
 * **不经审批卡**：用户在页面上按的那一下就是决定本身（36「只有要人拍板的才是卡」）。
 * 把「我看到了这个人」做成一张待批的卡，等于让用户为自己刚做的动作再点一次同意。
 */

import type {
  ExtensionBioLinkResult,
  ExtensionContactContribution,
  ExtensionContactDispute,
  ExtensionContactLookup,
  ExtensionContactSaveResult,
  ExtensionContentObservation,
  ExtensionContentResult,
  ExtensionContentSaveResult,
  ExtensionCreatorReport,
  ExtensionCreatorSaveResult,
  ExtensionHello,
  ExtensionIngestResult,
  ExtensionIngestRow,
  ExtensionObservation,
  ExtensionPort,
  ExtensionRevealPricing,
  ExtensionSeedSignature,
  ExtensionSetup,
  ExtensionStore,
} from '@agentsws/api'
import { REVEAL_FREE_WINDOW_DAYS } from '@agentsws/api'
import type {
  Clock,
  Creator,
  Iso8601,
  KolChannel,
  PlatformAccount,
  WorkspaceId,
} from '@agentsws/contracts'
import { KOL_LOOKUP_CAPABILITY } from '@agentsws/contracts'
import type {
  KolAccountObservation,
  KolBioLinkObservation,
  KolContent,
  KolContentObservation,
  KolStore,
} from './kol.js'
import { CONTACT_SECRET_FIELD, contactSecretId } from './kol-service.js'
import type { SecretStore } from './secret-store.js'

/**
 * 往公共红人库转发的那一跳。
 *
 * 形状刻意**只有两个方法**：连着没有、送一批。它既不读库、也不花积分——
 * 贡献与奖励照旧免费（49 M4，WP126 口径③保留）；官方侧的浏览 / reveal 计费改造不经插件这条路。
 *
 * WP119c 在它身上**只加**了三个可选方法（reveal / 贡献 / 争议）：完整版面板的
 * 完整版面板的联系方式卡要经本机代理云端公共库。老装配（不给这三个方法）不红——那三条
 * 路回一句「公共库用不了」的人话，本机其余功能照常。
 */
export interface PublicLibraryContributor {
  linked(): boolean
  contribute(rows: readonly PublicObservationRow[]): Promise<{ accepted: number }>
  /** 云端 reveal：明文只在这一次回执里出现，调用方马上写进本机加密库。 */
  reveal?(key: { channel: KolChannel; handle: string }): Promise<
    | { ok: true; email: string; source?: string; at?: string; credits: number }
    | {
        ok: false
        reason: 'insufficient_credits' | 'not_found' | 'not_linked' | 'upstream_error'
        message: string
      }
  >
  /** 贡献一条联系方式（云端收；回执里说清是新的还是库里已有）。 */
  contributeContact?(
    key: {
      channel: KolChannel
      handle: string
    },
    input: { value: string; source_url?: string },
  ): Promise<
    | { ok: true; action: 'new' | 'noop'; rewarded: boolean; message?: string }
    | { ok: false; reason: 'not_linked' | 'upstream_error'; message: string }
  >
  /**
   * WP129：内容观测进公共库（云端 `POST /v1/data/kol/content-observations`）。
   * 可选方法：老装配不实现就是"内容只落本机"，与 WP119c 之前一样。
   * 回的 `accepted` 是**送进去了几条**（云那边桶内重复也算送进去了——它刷新了数字）。
   */
  contributeContent?(rows: readonly PublicContentRow[]): Promise<{ accepted: number }>
  /** 标记一条联系方式是错的（免费；云端只记不裁）。 */
  disputeContact?(
    key: {
      channel: KolChannel
      handle: string
    },
    input: { value?: string; reason?: string },
  ): Promise<{ ok: boolean; message: string }>
}

/**
 * 送去公共库的一行。**比插件报上来的那条还窄**。
 *
 * 少掉的几格是故意的：`bio` 是红人自己写的文案（可能有版权、也可能是私人信息），
 * `avatar_url` 与 `page_url` 里带平台的一次性参数。公共库要的是
 * 「谁、在哪条渠道、有多少粉、什么时候看到的」，别的一概不要。
 */
export interface PublicObservationRow {
  channel: KolChannel
  handle: string
  /** 页面上原样那串。**不送解析出来的数** —— 解析错一条就污染所有人的库。 */
  followers_text?: string | undefined
  followers?: number | undefined
  /**
   * WP130：近 30 天发布数 / 互动率。**本机有值就送、没有就不送**——插件在页面上
   * 看不到这两个数，云端对插件来源这两格可缺（缺的行不进 k-匿名基准）。
   */
  posts_30d?: number | undefined
  engagement_rate?: number | undefined
  observed_at: string
  /** 公开的商务邮箱与它的来源页（用户显式收下过才有）。 */
  contact?: { value: string; source?: string | undefined } | undefined
}

/**
 * 送去公共库的一条内容（WP129）。**比插件报上来的那条窄**。
 *
 * 少掉的几格是故意的：`url` / `source_url` / `thumbnail_url` 带平台的一次性参数
 * （分享 id、签名封面），`author.name` 与粉丝数走红人那条路；**评论文本本来就
 * 进不了内容观测**（schema 红线），这里也没有它的位置。用户自己的备注、活动、
 * 存入状态一概不出本机。
 */
export interface PublicContentRow {
  channel: KolChannel
  /** 作者 handle（归一过）。认不出 handle 的内容不送——公共库只认 handle。 */
  handle: string
  external_id: string
  content_type: 'video' | 'post' | 'reel'
  title?: string | undefined
  published_at?: string | undefined
  duration_seconds?: number | undefined
  orientation?: 'landscape' | 'portrait' | undefined
  views?: number | undefined
  likes?: number | undefined
  comments?: number | undefined
  shares?: number | undefined
  paid_promotion?: boolean | undefined
  shoppable?: boolean | undefined
  observed_at: string
}

export interface ExtensionServiceOptions {
  workspace_id: WorkspaceId
  workspaceName: () => string
  store: ExtensionStore
  kol: KolStore
  /** 这个品牌那一段加密库。联系方式明文只经过它。 */
  secrets: SecretStore
  clock: Clock
  random(): number
  /** 不给 = 这台机器没关联云账号，一条都不往外送。 */
  publicLibrary?: PublicLibraryContributor | undefined
  serverVersion: string
  /**
   * WP119c：工作台基址（hello 的 `workbench_url`）。装配在端口那一侧才知道
   * 绑了哪个端口，所以这里是个函数。不给就不出这一格。
   */
  workbenchUrl?: () => string | undefined
  /**
   * WP119c：看一次邮箱的积分价（`pricing.json` 的 `data.kol.lookup`）。
   * 价目是数据不是代码，所以这里只要一个取数的函数。
   */
  revealPriceCredits?: () => number
}

/** 把 handle 归一成一个能当键用的东西（`@Foo` 与 `foo` 是同一个人）。 */
export function normalizeHandle(handle: string): string {
  return handle.trim().replace(/^@+/, '').toLowerCase()
}

/** 渠道 + handle → 主页地址（库里只存渠道与 handle，链接是拼出来的）。 */
function urlOf(channel: KolChannel, handle: string): string {
  const bare = normalizeHandle(handle)
  switch (channel) {
    case 'youtube':
      return `https://www.youtube.com/@${bare}`
    case 'instagram':
      return `https://www.instagram.com/${bare}`
    case 'tiktok':
      return `https://www.tiktok.com/@${bare}`
    case 'facebook':
      return `https://www.facebook.com/${bare}`
    default:
      return `https://x.com/${bare}`
  }
}

export function createExtensionService(options: ExtensionServiceOptions): ExtensionPort {
  let seq = 0
  const nextId = (prefix: string): string => {
    seq += 1
    const rand = Math.floor(options.random() * 0xffffffff)
      .toString(36)
      .padStart(7, '0')
    return `${prefix}_${rand}${seq.toString(36)}`
  }

  /** 找到「这条渠道上的这个人」：handle 与平台的稳定 id（`UC…`）都认。 */
  function findAccount(channel: KolChannel, key: string): PlatformAccount | undefined {
    const bare = normalizeHandle(key)
    return options.kol
      .accounts({ channel })
      .find(
        (a) =>
          normalizeHandle(a.handle) === bare ||
          (a.external_id !== undefined && a.external_id !== '' && a.external_id === key),
      )
  }

  /** WP130：一次观测的来源那几格（`ExtensionObservation` / 显式存入都可能带）。 */
  type ListSource = {
    source?: 'channel_page' | 'content_page' | 'search_results' | 'manual_save' | undefined
    source_page?: 'search' | 'watch_related' | 'hashtag' | undefined
    source_query?: string | undefined
    relevance_score?: number | undefined
  }

  /**
   * 找到或新建「这条渠道上的这个 handle」。
   *
   * 找的时候按**归一化的 handle**比：`@Foo` / `foo` / `@foo` 是同一个人，
   * 不归一就会在库里堆出三条一样的记录，而用户完全不知道为什么。
   *
   * WP119c：每次 upsert 都顺手**追加一行粉丝快照**（`account_observation`，只追不
   * 删）——粉丝趋势与 snapshot_count 从它算；在那之前库里只有「最后一次看到的
   * 数」，趋势无从谈起。
   */
  function upsert(
    one: {
      channel: KolChannel
      handle: string
      external_id?: string | undefined
      display_name?: string | undefined
      url?: string | undefined
      avatar_url?: string | undefined
      followers?: number | undefined
      followers_text?: string | undefined
      country?: string | undefined
      observed_at: string
    } & ListSource,
  ): { creator: Creator; account: PlatformAccount } {
    const key = normalizeHandle(one.handle)
    const existing = options.kol
      .accounts({ channel: one.channel })
      .find((a) => normalizeHandle(a.handle) === key)

    if (existing !== undefined) {
      const creator =
        options.kol.creator(existing.creator_id) ??
        ({
          id: existing.creator_id,
          display_name: one.display_name ?? one.handle,
          merged_from: [],
        } as Creator)
      // 名字**只在原来那个空着的时候**补——用户可能在工作台里改过显示名，
      // 页面上抓来的那个不该把它盖掉。
      if (creator.display_name === '' && one.display_name !== undefined) {
        options.kol.saveCreator({ ...creator, display_name: one.display_name })
      }
      const account: PlatformAccount = {
        ...existing,
        ...(one.external_id === undefined ? {} : { external_id: one.external_id }),
        ...(one.followers === undefined ? {} : { followers: one.followers }),
        ...(one.country === undefined ? {} : { region: one.country }),
        observed_at: one.observed_at,
      }
      options.kol.saveAccount(account)
      saveSnapshot(account, creator.id, one)
      return { creator, account }
    }

    const creator: Creator = {
      id: nextId('cr'),
      display_name: one.display_name ?? one.handle,
      merged_from: [],
    }
    options.kol.saveCreator(creator)
    const account: PlatformAccount = {
      id: nextId('pa'),
      creator_id: creator.id,
      channel: one.channel,
      handle: one.handle,
      url: one.url ?? urlOf(one.channel, one.handle),
      ...(one.external_id === undefined ? {} : { external_id: one.external_id }),
      ...(one.followers === undefined ? {} : { followers: one.followers }),
      ...(one.country === undefined ? {} : { region: one.country }),
      observed_at: one.observed_at,
    }
    options.kol.saveAccount(account)
    saveSnapshot(account, creator.id, one)
    return { creator, account }
  }

  /** 一条粉丝快照。 followers 没看到也记一行——"这一刻看过他"本身就是一个观测点。 */
  function saveSnapshot(
    account: PlatformAccount,
    creator_id: string,
    one: {
      followers?: number | undefined
      followers_text?: string | undefined
      observed_at: string
    } & ListSource,
  ): void {
    const row: KolAccountObservation = {
      id: nextId('ao'),
      account_id: account.id,
      creator_id,
      channel: account.channel,
      handle: account.handle,
      ...(one.followers === undefined ? {} : { followers: one.followers }),
      ...(one.followers_text === undefined ? {} : { followers_text: one.followers_text }),
      observed_at: one.observed_at,
      // WP130：这一刻是从哪儿看到的（列表页那三格只在批量采集时有）。只记本机，不出去。
      ...(one.source === undefined ? {} : { source: one.source }),
      ...(one.source_page === undefined ? {} : { source_page: one.source_page }),
      ...(one.source_query === undefined ? {} : { source_query: one.source_query }),
      ...(one.relevance_score === undefined ? {} : { relevance_score: one.relevance_score }),
    }
    options.kol.saveAccountObservation(row)
  }

  /**
   * 收下一个联系方式。**明文进加密库，库里只留 key 名。**
   *
   * 加密库没开时不降级成明文——存不了就不存，并在回执里说一句。
   * 「先存着回头再加密」这种做法比不存危险得多。
   */
  function saveContact(creator_id: string, one: ExtensionObservation): string | undefined {
    if (one.contact === undefined) return undefined
    return storeContact(creator_id, one.contact)
  }

  /**
   * 收下一个联系方式（显式存入共用）：**明文进加密库，库里只留 key 名。**
   *
   * 加密库没开时不降级成明文——存不了就不存，并在回执里说一句。
   * 「先存着回头再加密」这种做法比不存危险得多。
   */
  function storeContact(
    creator_id: string,
    contact: { kind: 'email' | 'dm' | 'phone' | 'form'; value: string; source?: string },
  ): string | undefined {
    if (contact.kind === 'phone') return '这一版只收邮箱 / 私信 / 合作表单三种'
    const already = options.kol.contacts(creator_id)
    if (already.length > 0) return undefined
    if (!options.secrets.available) return '这台机器的加密库没开，联系方式没存下来'
    const id = nextId('cc')
    options.secrets.put(contactSecretId(id), { [CONTACT_SECRET_FIELD]: contact.value })
    options.kol.saveContact({
      id,
      creator_id,
      kind: contact.kind,
      value_ref: contactSecretId(id),
      source: contact.source ?? 'extension',
    })
    return undefined
  }

  /** 粉丝趋势：最近 30 天里最早与最近两个快照的差。快照不足两个 = null。 */
  function followerTrend(
    account_id: string,
  ): { days: number; delta: number; percent: number } | null {
    const now = Date.parse(options.clock.now())
    const window = options.kol
      .accountObservations({ account_id })
      .filter(
        (o): o is KolAccountObservation & { followers: number } =>
          o.followers !== undefined &&
          Date.parse(o.observed_at) >= now - REVEAL_FREE_WINDOW_DAYS * 86_400_000,
      )
    const first = window[0]
    const last = window.at(-1)
    if (first === undefined || last === undefined || first.id === last.id) return null
    const days = Math.max(
      1,
      Math.round((Date.parse(last.observed_at) - Date.parse(first.observed_at)) / 86_400_000),
    )
    const delta = last.followers - first.followers
    const percent = first.followers > 0 ? Math.round((delta / first.followers) * 1000) / 10 : 0
    return { days, delta, percent }
  }

  /** 短主题词：汉字串取 2–8 字，拉丁词取 2–20 字符。最多 8 个，不重复。 */
  function keywordsFrom(texts: readonly (string | undefined)[]): string[] {
    const seen = new Set<string>()
    const re = /[\p{Script=Han}]{2,8}|[A-Za-z0-9][A-Za-z0-9'-]{1,19}/gu
    for (const text of texts) {
      if (text === undefined || text === '') continue
      for (const match of text.matchAll(re)) {
        if (seen.size >= 8) return [...seen]
        seen.add(match[0].toLowerCase())
      }
    }
    return [...seen]
  }

  /** 云端没连上 / 云那三跳没装配时，贡献与争议的统一去向（一句话，不抛）。 */
  const notLinkedContribution = (): ExtensionContactContribution => ({
    status: 'unavailable',
    message:
      '还没关联 agentsws 云账号，公共红人库用不了。这条联系方式只存在你自己的电脑上（本机红人池照收）。',
  })

  const revealPrice = (): number => options.revealPriceCredits?.() ?? 0

  /**
   * WP129：一条内容观测转发去公共库。规则与红人观测同一条：**登录了就送、没登录
   * 一个字节都不出这台电脑**，没有第二个开关。先落本机、再转发；转发失败不回滚、
   * 不让请求失败——回执里如实报 0。
   */
  async function forwardContent(
    input: ExtensionContentObservation,
    handle: string | undefined,
  ): Promise<number> {
    const cloud = options.publicLibrary
    if (cloud?.contributeContent === undefined || !cloud.linked()) return 0
    const bare = handle === undefined ? '' : normalizeHandle(handle)
    /*
     * 认不出 handle 就不送：公共库以 handle 为键。本机库里可能存着拿 YouTube 频道 id
     * （`UC` + 22 位）顶替的 handle（存入时页面上没 handle），那不是 handle，也不送——
     * 送上去就会在公共库里凭空多出一个叫 `uc…` 的人。
     */
    if (bare === '' || (input.channel === 'youtube' && /^uc[a-z0-9_-]{22}$/.test(bare))) return 0
    const row: PublicContentRow = {
      channel: input.channel,
      handle: bare,
      external_id: input.content_external_id,
      content_type: input.content_type,
      ...(input.title.trim() === '' ? {} : { title: input.title.trim() }),
      // 页面上抓来的发布时间可能是「3 天前」这种话——不是时间戳就不送（云那边会整批拒）
      ...(input.published_at === undefined || Number.isNaN(Date.parse(input.published_at))
        ? {}
        : { published_at: input.published_at }),
      ...(input.duration_seconds === undefined ? {} : { duration_seconds: input.duration_seconds }),
      ...(input.orientation === undefined ? {} : { orientation: input.orientation }),
      ...(input.stats.views === undefined ? {} : { views: input.stats.views }),
      ...(input.stats.likes === undefined ? {} : { likes: input.stats.likes }),
      ...(input.stats.comments === undefined ? {} : { comments: input.stats.comments }),
      ...(input.stats.shares === undefined ? {} : { shares: input.stats.shares }),
      ...(input.paid_promotion === undefined ? {} : { paid_promotion: input.paid_promotion }),
      ...(input.shoppable === undefined ? {} : { shoppable: input.shoppable }),
      observed_at: input.captured_at,
    }
    try {
      return (await cloud.contributeContent([row])).accepted > 0 ? 1 : 0
    } catch {
      return 0
    }
  }

  return {
    store: options.store,

    hello: (): ExtensionHello => {
      const linked = options.publicLibrary?.linked() === true
      const workbench = options.workbenchUrl?.()
      return {
        workspace_id: options.workspace_id,
        workspace_name: options.workspaceName(),
        cloud_linked: linked,
        // 登录了就共享，**没有第二个开关**（Luoye 09-19）。
        shares_to_public_library: linked,
        scopes: ['kol.observe', 'kol.capture', 'kol.read'],
        server_version: options.serverVersion,
        ...(workbench === undefined ? {} : { workbench_url: workbench }),
      }
    },

    ingest: async (session, input): Promise<ExtensionIngestResult> => {
      const rows: ExtensionIngestRow[] = []
      const forwardable: PublicObservationRow[] = []

      for (const one of input.observations) {
        if (normalizeHandle(one.handle) === '') {
          rows.push({ handle: one.handle, status: 'invalid', reason: '没有 handle' })
          continue
        }
        const before = options.kol
          .accounts({ channel: one.channel })
          .some((a) => normalizeHandle(a.handle) === normalizeHandle(one.handle))
        const { creator, account } = upsert(one)
        const contactNote = saveContact(creator.id, one)
        rows.push({
          handle: one.handle,
          // 本来就有 = `deduped`。**它不是失败**：库里那条的数字已经被这一次刷新了。
          status: before ? 'deduped' : 'ok',
          creator_id: creator.id,
          ...(contactNote === undefined ? {} : { reason: contactNote }),
        })
        /*
         * WP130：云端收不下的行不送，回执里的「共享了几条」才是真话——
         * ① 公共库以 handle 为键：认不出 handle（只有 YouTube 频道 id `UC…`）不送
         *    （与 WP129 内容观测同一条规矩）；
         * ② 公共库的卡要粉丝数：列表页批量采集只有页面原文（`followers_text`），
         *    本机不替它解析，于是这种行只进本机、不上云。
         */
        const bare = normalizeHandle(one.handle)
        if (one.channel === 'youtube' && /^uc[a-z0-9_-]{22}$/.test(bare)) continue
        if (one.followers === undefined) continue
        forwardable.push({
          channel: one.channel,
          handle: one.handle,
          ...(one.followers_text === undefined ? {} : { followers_text: one.followers_text }),
          ...(one.followers === undefined ? {} : { followers: one.followers }),
          ...(account.engagement_rate === undefined
            ? {}
            : { engagement_rate: account.engagement_rate }),
          observed_at: one.observed_at,
          ...(one.contact === undefined || one.contact.kind !== 'email'
            ? {}
            : {
                contact: {
                  value: one.contact.value,
                  ...(one.contact.source === undefined ? {} : { source: one.contact.source }),
                },
              }),
        })
      }

      // 没登录 = 一条都不出这台电脑。这是 `linked()` 唯一的用处。
      const cloud = options.publicLibrary
      if (cloud === undefined || !cloud.linked() || forwardable.length === 0) {
        void session
        return { rows, forwarded_to_public_library: 0 }
      }
      try {
        const out = await cloud.contribute(forwardable)
        return { rows, forwarded_to_public_library: out.accepted }
      } catch {
        // 云那一跳挂了不影响本机那一半：数据已经在用户自己的电脑上了。
        // 回执里如实报 0，插件卡片上就不会说"共享了几条"。
        return { rows, forwarded_to_public_library: 0 }
      }
    },

    /* ── WP119c：完整版面板要的那一批。每一条都先落本机，云是加分项 ─────── */

    setup: (session): ExtensionSetup => {
      void session
      const accounts = options.kol.accounts()
      const creators = new Map(options.kol.creators().map((c) => [c.id, c]))
      const poolCreators = accounts.slice(0, 100).map((a) => ({
        creator_id: a.creator_id,
        display_name: creators.get(a.creator_id)?.display_name ?? a.handle,
        channel: a.channel,
        handle: a.handle,
        ...(a.followers === undefined ? {} : { followers: a.followers }),
      }))
      // 活动来自合作记录上的 campaign_id（去重；没有合作就是空清单——不编活动）。
      const campaigns = new Map<
        string,
        { id: string; brand_id: string; name: string; created_at?: Iso8601 }
      >()
      for (const collab of options.kol.collaborations()) {
        if (collab.campaign_id === undefined || campaigns.has(collab.campaign_id)) continue
        campaigns.set(collab.campaign_id, {
          id: collab.campaign_id,
          brand_id: options.workspace_id,
          name: collab.campaign_id,
          ...(collab.agreed_at === undefined ? {} : { created_at: collab.agreed_at }),
        })
      }
      return {
        // 本机单机档：一个品牌就是一个组织、一个工作区（52 O1 的形状，如实端出去）。
        organizations: [{ id: options.workspace_id, name: options.workspaceName() }],
        workspaces: [
          {
            id: options.workspace_id,
            organization_id: options.workspace_id,
            name: options.workspaceName(),
          },
        ],
        brands: [
          {
            id: options.workspace_id,
            organization_id: options.workspace_id,
            workspace_id: options.workspace_id,
            name: options.workspaceName(),
          },
        ],
        campaigns: [...campaigns.values()],
        creator_pool: { total: accounts.length, creators: poolCreators },
      }
    },

    saveCreator: (session, input): ExtensionCreatorSaveResult => {
      void session
      const existingBefore = findAccount(input.channel, input.handle)
      const { creator } = upsert(input)
      // 页面上看到的商务邮箱：存入是一次显式动作，明文当场进加密库（同观测那条路）。
      if (input.contact !== undefined) storeContact(creator.id, input.contact)
      return {
        status: existingBefore === undefined ? 'ok' : 'deduped',
        creator_id: creator.id,
        ...(input.campaign_id === undefined ? {} : { campaign_id: input.campaign_id }),
      }
    },

    creatorReport: (session, key): ExtensionCreatorReport | undefined => {
      void session
      const account = findAccount(key.channel, key.handle)
      if (account === undefined) return undefined
      const creator = options.kol.creator(account.creator_id)
      const snapshots = options.kol.accountObservations({ account_id: account.id })
      const emailRow = options.kol.contacts(account.creator_id).find((c) => c.kind === 'email')
      let email: string | undefined
      if (emailRow !== undefined && options.secrets.available) {
        email = options.secrets.get(emailRow.value_ref)?.[CONTACT_SECRET_FIELD]
      }
      return {
        creator: {
          channel: account.channel,
          handle: account.handle,
          ...(account.external_id === undefined ? {} : { external_id: account.external_id }),
          ...(creator === undefined ? {} : { display_name: creator.display_name }),
          latest_captured_at: account.observed_at,
        },
        report: {
          followers: account.followers ?? null,
          avg_views: null,
          video_count: null,
          follower_trend: followerTrend(account.id),
          snapshot_count: snapshots.length,
        },
        tenant_pool: {
          saved: true,
          ...(email === undefined ? { email: null } : { email }),
          last_updated_at: account.observed_at,
        },
      }
    },

    revealPricing: (session): ExtensionRevealPricing => {
      void session
      return {
        capability: KOL_LOOKUP_CAPABILITY,
        credits_per_reveal: revealPrice(),
        free_window_days: REVEAL_FREE_WINDOW_DAYS,
        note: '看一次公共库里的商务邮箱的积分价（查看不扣分，真取才扣）。本机已有的邮箱再也不会扣——已经是你自己的了。',
      }
    },

    contactLookup: async (session, key): Promise<ExtensionContactLookup> => {
      void session
      const account = findAccount(key.channel, key.handle)
      // 1) 本机已有的邮箱：直接给，0 积分。它已经是你自己的了——比「30 天窗口」
      //    更持久，也更诚实：窗口说的是云端的重看，本机存下就是永久拥有。
      if (account !== undefined) {
        const emailRow = options.kol.contacts(account.creator_id).find((c) => c.kind === 'email')
        if (emailRow !== undefined && options.secrets.available) {
          const value = options.secrets.get(emailRow.value_ref)?.[CONTACT_SECRET_FIELD]
          if (value !== undefined)
            return {
              status: 'found',
              contact: {
                value,
                source: emailRow.source,
                ...(emailRow.verified_at === undefined
                  ? {}
                  : { confirmed_at: emailRow.verified_at }),
              },
              credits_charged: 0,
            }
        }
      }
      // 2) 本机没有：代理云端 reveal（计费在云端那侧；余额不足给人话）。
      const cloud = options.publicLibrary
      if (cloud?.reveal !== undefined) {
        const out = await cloud.reveal({
          channel: key.channel,
          handle: account?.handle ?? normalizeHandle(key.handle),
        })
        if (out.ok) {
          // 取到了就存进本机：加密库收明文，红人库只留 key 名（同观测那条路）。
          if (options.secrets.available) {
            let creatorId = account?.creator_id
            if (creatorId === undefined) {
              creatorId = upsert({
                channel: key.channel,
                handle: normalizeHandle(key.handle),
                observed_at: options.clock.now(),
              }).creator.id
            }
            const id = nextId('cc')
            const value_ref = contactSecretId(id)
            options.secrets.put(value_ref, { [CONTACT_SECRET_FIELD]: out.email })
            options.kol.saveContact({
              id,
              creator_id: creatorId,
              kind: 'email',
              value_ref,
              source: out.source ?? 'public_library',
              ...(out.at === undefined ? {} : { verified_at: out.at }),
            })
          }
          return {
            status: 'found',
            contact: {
              value: out.email,
              ...(out.source === undefined ? {} : { source: out.source }),
            },
            credits_charged: out.credits,
          }
        }
        if (out.reason === 'insufficient_credits')
          return {
            status: 'payment_required',
            reason: 'insufficient_credits',
            credits_required: revealPrice(),
            message: `积分不够了（看一次邮箱要 ${revealPrice()} 积分）。去工作台「设置 → 账号与积分」充值后再试。`,
          }
        return { status: 'none', message: out.message }
      }
      return {
        status: 'none',
        message: options.publicLibrary?.linked()
          ? '公共红人库里还没有这个人的联系方式。没有取到就不收钱。'
          : '本机红人池里没有这个人的联系方式，也还没关联 agentsws 云账号，所以公共库进不去。没连也能用：手动填一个就好。',
      }
    },

    contactContribute: async (session, key, input): Promise<ExtensionContactContribution> => {
      void session
      const cloud = options.publicLibrary
      if (cloud?.contributeContact === undefined || !cloud.linked()) return notLinkedContribution()
      const out = await cloud.contributeContact(
        { channel: key.channel, handle: key.handle },
        {
          value: input.value,
          ...(input.source_url === undefined ? {} : { source_url: input.source_url }),
        },
      )
      if (!out.ok) return { status: 'unavailable', message: out.message }
      return {
        status: 'recorded',
        action: out.action,
        rewarded: out.rewarded,
        ...(out.message === undefined ? {} : { message: out.message }),
      }
    },

    contactDispute: async (session, key, input): Promise<ExtensionContactDispute> => {
      void session
      const cloud = options.publicLibrary
      if (cloud?.disputeContact === undefined || !cloud.linked())
        return {
          status: 'noop',
          message: '还没关联云账号，争议没有地方记。本机的这条不受影响。',
        }
      const out = await cloud.disputeContact(
        { channel: key.channel, handle: key.handle },
        {
          ...(input.value === undefined ? {} : { value: input.value }),
          ...(input.reason === undefined ? {} : { reason: input.reason }),
        },
      )
      return { status: out.ok ? 'recorded' : 'noop', message: out.message }
    },

    saveContact: (session, input): ExtensionContactSaveResult => {
      void session
      const { creator } = upsert({
        channel: input.channel,
        handle: input.handle,
        ...(input.external_id === undefined ? {} : { external_id: input.external_id }),
        ...(input.display_name === undefined ? {} : { display_name: input.display_name }),
        observed_at: input.observed_at ?? options.clock.now(),
      })
      if (input.contact_kind === 'phone')
        return {
          status: 'not_stored',
          creator_id: creator.id,
          reason: '这一版只收邮箱 / 私信 / 合作表单三种',
        }
      if (!options.secrets.available)
        return {
          status: 'not_stored',
          creator_id: creator.id,
          reason: '这台机器的加密库没开，联系方式没存下来',
        }
      // 同类已有：幂等——更新值等于重新收下一次，回执照旧说 ok。
      const existing = options.kol.contacts(creator.id).find((c) => c.kind === input.contact_kind)
      if (existing !== undefined) {
        options.secrets.put(existing.value_ref, { [CONTACT_SECRET_FIELD]: input.contact_value })
        return { status: 'ok', contact_id: existing.id, creator_id: creator.id }
      }
      const id = nextId('cc')
      const value_ref = contactSecretId(id)
      options.secrets.put(value_ref, { [CONTACT_SECRET_FIELD]: input.contact_value })
      options.kol.saveContact({
        id,
        creator_id: creator.id,
        kind: input.contact_kind,
        value_ref,
        source: input.source ?? 'extension',
      })
      return { status: 'ok', contact_id: id, creator_id: creator.id }
    },

    contentObservation: async (session, input): Promise<ExtensionContentResult> => {
      void session
      const author =
        findAccount(input.channel, input.author.external_id) ??
        (input.author.handle === undefined
          ? undefined
          : findAccount(input.channel, input.author.handle))
      const creatorId = author?.creator_id
      // 幂等：同一条内容同一天只记一行。
      const day = input.captured_at.slice(0, 10)
      const same = options.kol
        .contentObservations({
          channel: input.channel,
          content_external_id: input.content_external_id,
        })
        .find((o) => o.observed_at.slice(0, 10) === day)
      /*
       * WP129：本机去重了**照样转发**——云那边按同一个键（渠道 + 内容 id + UTC 日）
       * 幂等，重复送只刷新数字、不多记一行也不算奖励；而"上次没送成（云连不上）"
       * 的那一条，这一次就补上了。本机不另记"送没送过"。
       */
      const authorHandle = author?.handle ?? input.author.handle
      if (same !== undefined)
        return {
          status: 'deduped',
          content_id: same.id,
          forwarded_to_public_library: await forwardContent(input, authorHandle),
        }
      const id = nextId('co')
      const row: KolContentObservation = {
        id,
        ...(creatorId === undefined ? {} : { creator_id: creatorId }),
        channel: input.channel,
        handle: author?.handle ?? normalizeHandle(input.author.handle ?? input.author.external_id),
        content_external_id: input.content_external_id,
        content_type: input.content_type,
        ...(input.title === '' ? {} : { title: input.title }),
        ...(input.url === undefined ? {} : { url: input.url }),
        ...(input.stats.views === undefined ? {} : { views: input.stats.views }),
        ...(input.stats.likes === undefined ? {} : { likes: input.stats.likes }),
        ...(input.stats.comments === undefined ? {} : { comments_count: input.stats.comments }),
        ...(input.stats.shares === undefined ? {} : { shares: input.stats.shares }),
        ...(input.duration_seconds === undefined
          ? {}
          : { duration_seconds: input.duration_seconds }),
        ...(input.published_at === undefined ? {} : { published_at: input.published_at }),
        ...(input.paid_promotion === undefined ? {} : { paid_promotion: input.paid_promotion }),
        ...(input.shoppable === undefined ? {} : { shoppable: input.shoppable }),
        observed_at: input.captured_at,
      }
      options.kol.saveContentObservation(row)
      return {
        status: 'ok',
        content_id: id,
        forwarded_to_public_library: await forwardContent(input, authorHandle),
      }
    },

    contentSave: (session, input): ExtensionContentSaveResult => {
      void session
      const author =
        findAccount(input.channel, input.author.external_id) ??
        (input.author.handle === undefined
          ? undefined
          : findAccount(input.channel, input.author.handle))
      let creatorId = author?.creator_id
      if (creatorId === undefined) {
        creatorId = upsert({
          channel: input.channel,
          handle: input.author.handle ?? input.author.external_id,
          external_id: input.author.external_id,
          ...(input.author.name === undefined ? {} : { display_name: input.author.name }),
          ...(input.author.followers === undefined ? {} : { followers: input.author.followers }),
          observed_at: input.captured_at,
        }).creator.id
      }
      const existing = options.kol
        .contents()
        .find(
          (c) => c.channel === input.channel && c.content_external_id === input.content_external_id,
        )
      // 已采评论：**只有这一条路**进库；最多保 200 条（按点赞数留最响的）。
      const comments = [...(input.captured_comments ?? [])]
        .sort((a, b) => (b.like_count ?? 0) - (a.like_count ?? 0))
        .slice(0, 200)
      const row: KolContent = {
        id: existing?.id ?? nextId('ct'),
        creator_id: creatorId,
        channel: input.channel,
        handle: author?.handle ?? normalizeHandle(input.author.handle ?? input.author.external_id),
        content_external_id: input.content_external_id,
        content_type: input.content_type,
        title: input.title,
        ...(input.url === undefined ? {} : { url: input.url }),
        ...(input.thumbnail_url === undefined ? {} : { thumbnail_url: input.thumbnail_url }),
        ...(input.published_at === undefined ? {} : { published_at: input.published_at }),
        ...(input.stats.views === undefined ? {} : { views: input.stats.views }),
        ...(input.stats.likes === undefined ? {} : { likes: input.stats.likes }),
        ...(input.stats.comments === undefined ? {} : { comments_count: input.stats.comments }),
        ...(input.stats.shares === undefined ? {} : { shares: input.stats.shares }),
        ...(input.orientation === undefined ? {} : { orientation: input.orientation }),
        ...(input.duration_seconds === undefined
          ? {}
          : { duration_seconds: input.duration_seconds }),
        ...(input.campaign_id === undefined ? {} : { campaign_id: input.campaign_id }),
        captured_at: input.captured_at,
        ...(comments.length === 0 ? {} : { comments }),
      }
      options.kol.saveContent(row)
      return {
        status: existing === undefined ? 'ok' : 'deduped',
        content_id: row.id,
        creator_id: creatorId,
        ...(comments.length === 0 ? {} : { comments_stored: comments.length }),
      }
    },

    bioLinkObservation: (session, input): ExtensionBioLinkResult => {
      void session
      const existing = options.kol
        .bioLinks()
        .find((b) => b.platform === input.platform && b.slug === input.slug)
      const row: KolBioLinkObservation = {
        id: existing?.id ?? nextId('bl'),
        platform: input.platform,
        slug: input.slug,
        source_url: input.source_url,
        links: input.links,
        social_links: input.social_links,
        emails: input.emails,
        ...(input.bio === undefined ? {} : { bio: input.bio }),
        ...(input.display_name === undefined ? {} : { display_name: input.display_name }),
        ...(input.avatar_url === undefined ? {} : { avatar_url: input.avatar_url }),
        captured_at: input.captured_at,
        observed_at: options.clock.now(),
      }
      options.kol.saveBioLink(row)
      // 附加对上几个红人：本机库里还没有「谁的简介指向这个 slug」的记录，
      // 这一版如实回 0——页面本身已经存档，不是失败（旧插件的同一句话）。
      return { status: existing === undefined ? 'ok' : 'deduped', attached_creators: 0 }
    },

    seedSignature: (session, key): ExtensionSeedSignature | undefined => {
      void session
      const account = findAccount(key.channel, key.handle)
      if (account === undefined) return undefined
      const creator = options.kol.creator(account.creator_id)
      const titles = options.kol
        .contents()
        .filter((c) => c.creator_id === account.creator_id)
        .map((c) => c.title)
      return {
        platform: key.channel,
        external_id: account.external_id ?? account.handle,
        topic_keywords: keywordsFrom([account.category, creator?.display_name, ...titles]),
      }
    },
  }
}

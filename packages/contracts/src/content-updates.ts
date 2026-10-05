/**
 * WP219（docs/90）：**第三方内容的更新通道**——随软件带的第三方技能等声明式内容，
 * 上游更新后由我们审过、签名，发到内容更新通道，不等软件发版。
 *
 * Luoye 10-05 定的原则：**进到用户电脑里的第三方内容，要么我们审过，要么用户自己点头。**
 *
 * | 谁装的 | 谁探测 | 谁审 | 怎么到用户手里 |
 * |---|---|---|---|
 * | 第一类：随软件带的（本单实现） | 我们的每周上游例程 | Fable 照 docs/42 | 签名的内容包 → 用户端出卡（或「已审的自动更新」） |
 * | 第二类：用户自己装的（只写规范） | 用户端 | 用户本人 | 用户端出卡写清改了什么与风险，点头才更新 |
 *
 * 这一份只放**格式与常量**：清单长什么样、签名怎么认、卡的 payload、设置项与视图。
 * 校验 / 存储 / 合并在 `@agentsws/skills`（`content-pack.ts` 等），编排在服务进程。
 */
import type { Iso8601, WorkspaceId } from './common.js'
import type { StorefrontPlatform } from './identity.js'

// ---------- 常量 ----------

/** 清单格式（版本号只增：读不懂的大版本整包拒收）。 */
export const CONTENT_MANIFEST_SCHEMA = 'agentsws.content-manifest/1'
/** 清单文件名；签名是同名加 `.sig`（对清单**原始字节**的 ed25519 签名，base64）。 */
export const CONTENT_MANIFEST_FILE = 'content-manifest.json'
export const CONTENT_SIGNATURE_FILE = 'content-manifest.json.sig'
/**
 * 发版流水线里放签名私钥的 GitHub Actions secret **名字**（值由 Luoye 填，仓库里永远只有名字）。
 * 私钥只在流水线里用；用户端只认内置的公钥（{@link CONTENT_SIGNING_PUBLIC_KEYS}）。
 */
export const CONTENT_SIGNING_KEY_SECRET = 'CONTENT_SIGNING_KEY'

/** 内容更新的渠道：与软件更新同样按目录分（`stable/`、`beta/`）。 */
export const CONTENT_CHANNELS = ['stable', 'beta'] as const
export type ContentChannel = (typeof CONTENT_CHANNELS)[number]

/** 主源：自有下载站（与 WP218 同一个 R2 桶 `agentsws-downloads`，`content/` 前缀）。 */
export const CONTENT_FEED_BASE = 'https://dl.agentsws.com/content'
/** 镜像：GitHub Releases 上每个渠道一条滚动的 release（tag `content-<渠道>`）。 */
export const CONTENT_MIRROR_REPO = 'Luoye-W/agentsws'

/**
 * 内置的验签公钥（ed25519，32 字节原始公钥的 base64）。
 *
 * **现在是空的**：Luoye 用 `node scripts/content-keygen.mjs` 生成一对，私钥进 GitHub secret
 * `CONTENT_SIGNING_KEY`，公钥填进这里（`key_id` = 公钥 sha256 的前 16 个十六进制字符）。
 * 空表 = 用户端不接受任何内容包（更新通道关着，界面照实说），这是 fail-closed。
 * 换钥：先把新公钥**加**进来随一个软件版本发出去，等大多数人升上来再用新私钥签，最后删旧的。
 */
export const CONTENT_SIGNING_PUBLIC_KEYS: readonly ContentPublicKey[] = []

export interface ContentPublicKey {
  key_id: string
  /** 32 字节原始公钥，base64。 */
  public_key: string
}

/** 条目种类。`skill` 本单实现；`role` / `declarative` 格式先定、客户端以后随程序版本支持。 */
export const CONTENT_ITEM_KINDS = ['skill', 'role', 'declarative'] as const
export type ContentItemKind = (typeof CONTENT_ITEM_KINDS)[number]

/**
 * **内容与程序的分界线**（docs/90 §5）：内容包里只许出现这些后缀（或这几个固定文件名）。
 * 脚本、可执行文件、`package.json`、任何代码一律不许——改到程序本身的跟软件版本走。
 */
export const CONTENT_FILE_EXTENSIONS: readonly string[] = ['.md', '.json', '.txt', '.yml', '.yaml']
export const CONTENT_FILE_BASENAMES: readonly string[] = ['LICENSE', 'NOTICE', 'COPYING']
/** 单个文件 / 单个条目的上限（字节）：声明式内容不该有这么大，超了就是包打错了。 */
export const CONTENT_MAX_FILE_BYTES = 1_048_576
export const CONTENT_MAX_ITEM_BYTES = 4_194_304

/** 用户端查清单的间隔（毫秒）：每 6 小时一次，另加启动时一次。 */
export const CONTENT_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000

// ---------- 清单 ----------

export interface ContentFileEntry {
  /** 相对条目目录的路径（`/` 分隔、不许 `..`、不许绝对路径）。 */
  path: string
  sha256: string
  size: number
}

/** 这一版从哪个上游哪个提交来。 */
export interface ContentUpstreamRef {
  /** `upstreams.yml` 里的 id。 */
  id: string
  repo: string
  tag?: string
  commit: string
  /** 官方发布 / 提交的日期（卡上写「官方某日更新」）。 */
  published_at: string
  license: string
}

/** 审核记录摘要（docs/42 §5「内容更新」那一步的结论）。 */
export interface ContentReviewSummary {
  reviewer: string
  reviewed_at: string
  /** 许可证前后（不变才能原样分发）。 */
  license_before: string
  license_after: string
  /** 可疑指令扫描：命中条数与规则 id；命中的每一条都要有审核人写的放行理由。 */
  scan_hits: number
  scan_rules: string[]
  /** 我们的旁注（`AGENTSWS.md` 等）仍对得上。 */
  notes_ok: boolean
  /** 测试与模拟全过。 */
  tests_ok: boolean
  /** 提案（diff + 许可证对比 + 扫描结果）在仓库里的路径。 */
  proposal?: string
}

export interface LocalizedText {
  zh: string
  en: string
}

export interface ContentItem {
  /** `<kind>:<name>`，例如 `skill:shopify`。 */
  id: string
  kind: ContentItemKind
  /** 技能名 / 职责 id。 */
  name: string
  version: string
  title: LocalizedText
  /** 一句改了什么（卡上那一行）。 */
  summary: LocalizedText
  upstream: ContentUpstreamRef
  review: ContentReviewSummary
  /** 只落到建站平台是这几个的品牌；不写 = 所有品牌（与 WP216 PLATFORM_KITS 同一口径）。 */
  platforms?: StorefrontPlatform[]
  /** 这一条要求的最低软件版本（不满足：这一条跳过，提示先更新软件）。 */
  min_app_version?: string
  files: ContentFileEntry[]
  /** 条目摘要：按路径排序的 `path\tsha256\n` 拼起来的 sha256。 */
  sha256: string
}

export interface ContentManifest {
  schema: typeof CONTENT_MANIFEST_SCHEMA
  channel: ContentChannel
  /** 只增的序号：用户端记住见过的最大值，比它小的包一律当旧包（防回放）。 */
  serial: number
  created_at: Iso8601
  /** 整包要求的最低软件版本（不满足：整包不收）。 */
  min_app_version: string
  /** 用哪把钥签的（对 {@link CONTENT_SIGNING_PUBLIC_KEYS}）。 */
  key_id: string
  items: ContentItem[]
}

// ---------- 用户端：设置、状态、视图 ----------

/** 设置 → 通用「已审的内容更新」：自动 / 每次问我（默认）。按品牌各存一份。 */
export type ContentUpdateMode = 'auto' | 'ask'
export const DEFAULT_CONTENT_UPDATE_MODE: ContentUpdateMode = 'ask'

export interface ContentUpdateSettings {
  mode: ContentUpdateMode
}

/** 一个条目在这个品牌上的样子。 */
export type ContentItemState =
  /** 用的是随软件带的那一版或已更新的最新版。 */
  | 'current'
  /** 有新版，等人点（或自动更新排着）。 */
  | 'available'
  /** 更新了，但有段落与你的改动冲突，等你选。 */
  | 'conflict'
  /** 这一条要更新的软件版本才收得下。 */
  | 'needs_app_update'

export interface ContentItemStatus {
  id: string
  name: string
  title: LocalizedText
  state: ContentItemState
  /** 现在用的版本（没更新过就是随软件带的那一版）。 */
  current_version?: string
  /** 有新版时的版本号。 */
  available_version?: string
  /** 能退回去的那一版（保留一份）。 */
  previous_version?: string
  /** 上次更新的时间。 */
  updated_at?: Iso8601
  /** 新版的官方发布日期。 */
  upstream_published_at?: string
}

/** 通道整体的状态（图标）：通 / 关着 / 出错。 */
export type ContentChannelState = 'ok' | 'off' | 'error' | 'unknown'

export interface ContentUpdatesView {
  mode: ContentUpdateMode
  channel: ContentChannel
  state: ContentChannelState
  /** 关着 / 出错时的一句人话。 */
  reason?: string
  last_checked_at?: Iso8601
  /** 只列这个品牌启用了的条目里，更新过或有新版的那些。 */
  items: ContentItemStatus[]
}

// ---------- 卡 ----------

/** 一段的改动（「查看改动」里按段列）。 */
export interface ContentSectionChange {
  heading: string
  change: 'added' | 'changed' | 'removed'
  before?: string
  after?: string
}

/** `content_update` 卡的 payload：「X 有新版 · 官方某日更新 · 已审」。 */
export interface ContentUpdateCardPayload {
  form: 'content_update'
  workspace_id: WorkspaceId
  item_id: string
  name: string
  title: LocalizedText
  from_version?: string
  to_version: string
  upstream_published_at: string
  summary: LocalizedText
  /** 永远是 true：没审过的进不了通道。卡上写「已审」就是读这一格。 */
  reviewed: true
  reviewer: string
  serial: number
}

/** `content_conflict` 卡的 payload：新版改了你也改过的段，二选一。 */
export interface ContentConflictCardPayload {
  form: 'content_conflict'
  workspace_id: WorkspaceId
  item_id: string
  name: string
  title: LocalizedText
  version: string
  section_id: string
  heading: string
  /** 你的改动在哪一层（公司 / 岗位 / 职责 / 个人…）、谁的。 */
  tier: string
  owner: string
  base_before: string
  base_after: string
  mine: string
}

/** 冲突卡的两个选项 id。 */
export const CONTENT_CONFLICT_OPTIONS = ['use_new', 'keep_mine'] as const
export type ContentConflictChoice = (typeof CONTENT_CONFLICT_OPTIONS)[number]

/** 「查看改动」/「看对比」的视图。 */
export interface ContentDiffView {
  item_id: string
  title: LocalizedText
  from_version?: string
  to_version: string
  sections: ContentSectionChange[]
}

// ---------- 第二类（用户自己装的）：只留接口，等技能市场 ----------

/**
 * 第二类的来源描述（docs/90 §8）：用户从技能市场 / 网址装的。v1 不实现，只把形状定下来：
 * 用户端自己探测上游、出卡写清改了什么与风险提示，用户点头才更新，可锁版本、可退回。
 */
export interface UserInstalledContentSource {
  kind: 'market' | 'url'
  /** 市场条目 id 或网址。 */
  ref: string
  /** 用户锁的版本（锁了就不再探测新版）。 */
  pinned_version?: string
}

/** 版本号 → 渠道：带预发布标签（`-beta.3`）的是 beta。与 WP218 `channelOf` 同一口径。 */
export function contentChannelOf(appVersion: string): ContentChannel {
  return appVersion.replace(/^v/, '').includes('-') ? 'beta' : 'stable'
}

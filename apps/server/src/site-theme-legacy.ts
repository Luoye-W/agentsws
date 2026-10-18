/**
 * WP301（决策 399 = A）：**旧的自带主题**（agentsws-theme，v0.9.x / v0.10 起底的工作目录）怎么办。
 *
 * 那套主题已改闭源、工坊不再用也不再分发；建站岗位改在店里复制一份 Shopify 官方的 Horizon 来做。已经起过底的
 * 工作目录（例如 Windows 上 Rovella 那一份）：
 *
 * - **不删、不自动迁**：工具回话里照实说一句「这份是旧的自带主题，工坊已改用 Horizon」；
 * - 下一次起底（`theme_init_from_base`）在 Horizon 上新起一份时，旧目录整份挪去
 *   `<数据目录>/theme-work/<品牌>/legacy/<店>-agentsws-theme-v<版本>-<时间>/` 原样留着；店里推过的预览也不动；
 * - 旧目录上不再改、不再推（写文件 / 推预览都回那一句）；
 * - WP296 的升级卡不再出；以前出过、还没定的那张被点了，只记一句「作废了」，什么都不升。
 *
 * WP311（决策 480，高级主题 v0.11.0 上架后）：这种目录第一次起底 / 说「换主题」也照 WP304 出**选主题卡**
 * （高级主题一行 + 店里已装的主题），不再直接复制 Horizon；选了哪份都先起一份新的未发布主题，线上不动、旧目录照旧挪开留着。
 */
import type { ApprovalItem } from '@agentsws/contracts'

/** WP296 升级卡上的 `upstream_id`（认旧卡用）。 */
export const LEGACY_THEME_UPSTREAM_ID = 'agentsws-theme'

/** 这是不是 WP296 出过的那张「升级到 vX（会跑迁移）」卡。 */
export const isThemeUpgradeCard = (item: Pick<ApprovalItem, 'kind' | 'payload'>): boolean =>
  item.kind === 'upstream_upgrade' &&
  item.payload !== null &&
  typeof item.payload === 'object' &&
  (item.payload as Record<string, unknown>).upstream_id === LEGACY_THEME_UPSTREAM_ID

/**
 * 工具回话里带给模型的那一句（这份工作目录是旧的自带主题）。
 * WP311（决策 480）：起底不再直接复制 Horizon——没说用哪套就先出选主题卡（高级主题一行 + 店里已装的主题）。
 */
export const legacyThemeNotice = (version: string | undefined): string =>
  `这份主题工作目录是旧的自带主题（agentsws-theme${version === undefined ? '' : ` v${version}`}），工坊已改用 Shopify 官方的 Horizon（也可以换成我们的高级主题）。` +
  '照实跟人说一句，然后先用 theme_init_from_base 新起一份再做（人没说用哪套就不给 source：会先出一张选主题卡，高级主题排第一，店里已装的免费主题也能选）；' +
  '旧的那份原样留着（不删、不迁、不再改），店里以前推过的预览也不动。'

/** 旧目录上写文件 / 推预览时回的那一句。 */
export const legacyThemeRefusal = (version: string | undefined): string =>
  `${legacyThemeNotice(version)}这一步没做。`

/**
 * 新起一份、把旧目录挪开之后，事项时间线上记的那一句。WP311：新的那一份不一定是 Horizon——
 * 选主题卡上选的店里任意一份免费主题（`from` 是它的名字），或我们的高级主题（`premium`）。
 */
export const legacyMovedNote = (
  version: string | undefined,
  copyName: string,
  from?: { name?: string; premium?: boolean },
): string =>
  `旧的自带主题（agentsws-theme${version === undefined ? '' : ` v${version}`}）那份工作目录原样留着（挪到一边了，没删、没迁）；` +
  (from?.premium === true
    ? `这次装的是我们的高级主题（未发布「${copyName}」），之后都在它上面做。`
    : `这次在店里复制了一份${from?.name === undefined || from.name === '' || /horizon/i.test(from.name) ? ' Shopify 官方 Horizon' : `「${from.name}」`}（未发布「${copyName}」），之后都在它上面做。`)

/** WP296 的旧升级卡被点了之后记的那一句。 */
export const LEGACY_UPGRADE_CARD_VOID =
  '这张升级卡作废了：工坊已改用 Shopify 官方 Horizon，不再升级旧的自带主题（agentsws-theme）。旧的那份工作目录原样留着；接着做时先选主题、新起一份。'

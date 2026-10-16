/**
 * WP356（决策 923）：设置弹窗与地址的对应——哪些地址算「打开设置」、打开到哪一节哪一项。
 *
 * 设置不再是切走主区的整页：地址落在下面这些路径时，主区照旧画**原来那一页**（背景），
 * 设置面板盖在上面。老地址一个不废（`/settings?tab=…`、`/settings/credits|billing|apikeys`
 * 插件深链、`/connections?service=…`、`/im-channels#site-chat`、`/org?tab=…`），都映射到面板里的一节；
 * 新地址是 `/settings/<节>#<项>`。
 *
 * 纯函数、不碰 React，单测直接测。
 */

/** 面板左侧的五组（团队组只在同事互联 / 公司模式出）。 */
export type SettingsGroupId = 'you' | 'ai' | 'brand' | 'device' | 'team'

export const SETTINGS_SECTIONS = [
  // 个人
  'general',
  'account',
  'mode',
  'notifications',
  'memory',
  'privacy',
  'shortcuts',
  // AI
  'models',
  'web',
  'runs',
  // 品牌（随当前品牌）
  'profile',
  'design',
  'positions',
  'connections',
  'channels',
  'data-apis',
  'toolbox',
  'brands',
  // 这台电脑
  'desktop',
  'background',
  'extension',
  'scenes',
  'plugins',
  'diagnostics',
  // 团队
  'people',
  'invite',
  'ranges',
  'merge',
  'usage',
  'collab',
  'inprogress',
] as const

export type SettingsSectionId = (typeof SETTINGS_SECTIONS)[number]

export interface SettingsTarget {
  section: SettingsSectionId
  /** 要滚到并高亮的那一项（没有 = 停在这一节顶上）。 */
  item?: string
}

const SECTION_SET = new Set<string>(SETTINGS_SECTIONS)

export function isSettingsSection(id: string): id is SettingsSectionId {
  return SECTION_SET.has(id)
}

/** 面板里的地址：`/settings/<节>`，带项时 `#<项>`。 */
export function settingsHref(section: SettingsSectionId, item?: string): string {
  return item === undefined ? `/settings/${section}` : `/settings/${section}#${item}`
}

/** WP119c 插件深链的三条（docs/76 §10）：都落在「账号与积分」的积分那一项。 */
const PLUGIN_DEEP_LINKS = new Set(['credits', 'billing', 'apikeys'])

/** 老设置页 `?tab=` → 面板一节（WP272 `?tab=account`、老 `?tab=credits`、`?tab=models`、`?tab=plugins`）。 */
const SETTINGS_TABS: Record<string, SettingsTarget> = {
  general: { section: 'general' },
  account: { section: 'account' },
  credits: { section: 'account', item: 'credits' },
  plugins: { section: 'plugins' },
  models: { section: 'models' },
}

/** 老设置页上的锚点 → 面板一项（WP169 `#company`、WP210 `#diagnostics`）。 */
const SETTINGS_HASHES: Record<string, SettingsTarget> = {
  company: { section: 'profile', item: 'brand-profile' },
  diagnostics: { section: 'diagnostics', item: 'diagnostics' },
}

/** 老「岗位与品牌 / 团队 / 公司」页的 `?tab=` → 面板一节。 */
const ORG_TABS: Record<string, SettingsSectionId> = {
  brands: 'brands',
  positions: 'positions',
  toolbox: 'toolbox',
  members: 'people',
  colleagues: 'people',
  invite: 'invite',
  ranges: 'ranges',
  join: 'merge',
  inprogress: 'inprogress',
}

/** 地址 → 设置目标；不是设置地址就回 `null`（主区照常路由）。 */
export function settingsTargetOf(loc: {
  pathname: string
  search: string
  hash: string
}): SettingsTarget | null {
  const path = loc.pathname.replace(/\/+$/, '') || '/'
  const params = new URLSearchParams(loc.search)
  const hash = decodeURIComponent(loc.hash.replace(/^#/, ''))
  const withItem = (t: SettingsTarget): SettingsTarget =>
    t.item === undefined && hash !== '' ? { ...t, item: hash } : t

  if (path === '/settings') {
    if (hash !== '' && SETTINGS_HASHES[hash] !== undefined) return SETTINGS_HASHES[hash]
    const tab = params.get('tab')
    const byTab = tab === null ? undefined : SETTINGS_TABS[tab]
    return withItem(byTab ?? { section: 'general' })
  }
  if (path.startsWith('/settings/')) {
    const rest = path.slice('/settings/'.length)
    if (PLUGIN_DEEP_LINKS.has(rest)) return { section: 'account', item: 'credits' }
    return withItem({ section: isSettingsSection(rest) ? rest : 'general' })
  }
  if (path === '/connections') {
    if (hash === 'data-backend') return { section: 'privacy', item: 'data-backend' }
    return withItem({ section: 'connections' })
  }
  if (path === '/im-channels') return withItem({ section: 'channels' })
  if (path === '/org') {
    const tab = params.get('tab')
    return withItem({ section: (tab === null ? undefined : ORG_TABS[tab]) ?? 'positions' })
  }
  return null
}

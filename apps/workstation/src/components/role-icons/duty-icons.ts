/**
 * WP213：**职责 → 图标**对照表（Luoye 09-30：岗位 yml 只加一个 `icon` 字段，职责用对照表）。
 *
 * 两类（docs/36 §8.3）：
 *
 * - **渠道类**：所在岗位的图标 + 右下角平台角标。`badge` 是官网 favicon 的 provider id
 *   （`assets/brand/MANIFEST.json` 里那一家，或它的别名），图从仓库里来，运行时不联网。
 * - **非渠道类**：专门画的一枚（`glyph` = 自己的 role id）。
 * - **同一个岗位里不许出现两枚一样的**：建站四条全是 Shopify、Facebook 主页 / 群组同一张 Facebook，
 *   所以它们各画一枚专门的再挂角标（`test/role-icons.test.tsx` 逐岗位核）。
 *
 * 和 `glyphs.ts` 一样**不 import 任何东西**（预览页生成脚本直接读）。职责 yml 里加了一条而这里
 * 没配，测试当场红（它是当场去读 `packages/roles/roles` 的，不是抄一份清单）。
 */

export interface DutyIconSpec {
  /** `GLYPHS` 里的 id：岗位模板 id 或职责自己的 role id。 */
  glyph: string
  /** 右下角平台角标：官网 favicon 的 provider id。 */
  badge?: string
}

export const DUTY_ICONS: Record<string, DutyIconSpec> = {
  // ── 客服 ─────────────────────────────────────────────────────────────
  'dtc.support': { glyph: 'dtc.support' },
  'dtc.live-chat': { glyph: 'dtc.live-chat' },
  'amz.support': { glyph: 'customer-care', badge: 'amazon' },
  'dtc.community-support': { glyph: 'dtc.community-support' },
  // ── 网站运营 ─────────────────────────────────────────────────────────
  'dtc.store': { glyph: 'dtc.store' },
  'dtc.content': { glyph: 'dtc.content' },
  'dtc.email-marketing': { glyph: 'dtc.email-marketing' },
  'dtc.fulfillment': { glyph: 'dtc.fulfillment' },
  // ── 红人营销 ─────────────────────────────────────────────────────────
  'kol.youtube': { glyph: 'kol-marketing', badge: 'youtube_data' },
  'kol.instagram': { glyph: 'kol-marketing', badge: 'instagram_graph' },
  'kol.tiktok': { glyph: 'kol-marketing', badge: 'tiktok_research' },
  'kol.facebook': { glyph: 'kol-marketing', badge: 'facebook_graph' },
  'kol.x': { glyph: 'kol-marketing', badge: 'x_api' },
  // ── 社媒运营 ─────────────────────────────────────────────────────────
  'social.facebook': { glyph: 'social.facebook', badge: 'facebook_graph' },
  'social.instagram': { glyph: 'social-media', badge: 'instagram_graph' },
  'social.threads': { glyph: 'social-media', badge: 'threads_api' },
  'social.linkedin': { glyph: 'social-media', badge: 'linkedin_api' },
  'social.tiktok': { glyph: 'social-media', badge: 'tiktok_research' },
  'social.youtube': { glyph: 'social-media', badge: 'youtube_data' },
  'social.x': { glyph: 'social-media', badge: 'x_api' },
  'social.reddit': { glyph: 'social-media', badge: 'reddit' },
  'social.discord': { glyph: 'social-media', badge: 'discord_bot' },
  'social.telegram-group': { glyph: 'social-media', badge: 'telegram_bot' },
  'social.whatsapp': { glyph: 'social-media', badge: 'whatsapp_business' },
  'social.facebook-group': { glyph: 'social.facebook-group', badge: 'facebook_graph' },
  // 老的「Meta 社媒运营」（WP191 拆成 FB 主页 + IG），老分配还读得进来
  'social.meta': { glyph: 'social-media', badge: 'meta_ads' },
  // ── 投放 ─────────────────────────────────────────────────────────────
  'ads.meta': { glyph: 'ads', badge: 'meta_marketing' },
  'ads.google': { glyph: 'ads', badge: 'google_ads' },
  'ads.x': { glyph: 'ads', badge: 'x_ads' },
  'ads.tiktok': { glyph: 'ads', badge: 'tiktok_ads' },
  // ── 建站：四条都是 Shopify，各画一枚再挂角标 ─────────────────────────
  'site.shopify-build': { glyph: 'site.shopify-build', badge: 'shopify_admin' },
  'site.shopify-theme': { glyph: 'site.shopify-theme', badge: 'shopify_admin' },
  'site.shopify-email': { glyph: 'site.shopify-email', badge: 'shopify_admin' },
  'site.shopify-apps': { glyph: 'site.shopify-apps', badge: 'shopify_admin' },
  // ── 设计 ─────────────────────────────────────────────────────────────
  'design.dtc': { glyph: 'design.dtc' },
  'design.amazon': { glyph: 'design', badge: 'amazon' },
  'design.social': { glyph: 'design.social' },
  'design.ads': { glyph: 'design.ads' },
  'design.exhibition': { glyph: 'design.exhibition' },
  // ── 公共关系 ─────────────────────────────────────────────────────────
  'pr.press': { glyph: 'pr.press' },
  'pr.reddit': { glyph: 'pr', badge: 'reddit' },
  'pr.forums': { glyph: 'pr.forums' },
  'pr.monitoring': { glyph: 'pr.monitoring' },
  // ── B2B ──────────────────────────────────────────────────────────────
  'b2b.sales': { glyph: 'b2b.sales' },
  'b2b.outbound': { glyph: 'b2b.outbound' },
  'b2b.exhibition': { glyph: 'b2b.exhibition' },
  'b2b.fulfillment': { glyph: 'b2b.fulfillment' },
  'b2b.marketplace': { glyph: 'b2b.marketplace' },
  // ── 工作区底座 ───────────────────────────────────────────────────────
  'common.owner': { glyph: 'common.owner' },
  'common.member': { glyph: 'common.member' },
  // 负责人岗位的种子里带着它（`org.ts`）；yml 不在本包里，定义在 demo 与老工作区里
  'dtc.analytics': { glyph: 'dtc.analytics' },
}

/**
 * 没有 `icon` 字段的岗位（负责人 / 普通成员是 `org.ts` 种出来的，没有 yml；老服务进程也不带）
 * 按模板 id 认。用户自己建的岗位两样都没有，组件再按它的职责推一枚，推不出来落 `generic`。
 */
export const POSITION_GLYPH_BY_ID: Record<string, string> = {
  owner: 'owner',
  member: 'member',
  'customer-care': 'customer-care',
  'web-ops': 'web-ops',
  'kol-marketing': 'kol-marketing',
  'social-media': 'social-media',
  ads: 'ads',
  site: 'site',
  design: 'design',
  pr: 'pr',
  b2b: 'b2b',
  'dtc-ops': 'dtc-ops',
}

/**
 * 移植自 agentsws-extension `src/lib/public-contacts.ts` @ 57fca9c（WP490，私有插件外壳；不是 KOLAgents 旧插件代码）。
 *
 * 红人**主页上公开写着的**联系方式（`public_contacts`，决策 1661 补）：先是页面上的邮箱，再是主页外链
 * （含 link-in-bio 展开出来的去处），过一遍 `sanitizePublicContacts`，最多 10 条。
 *
 * 私有插件那一份里 `sanitizePublicContacts` 是**逐字抄自**开源仓 `packages/contracts/src/kol-public.ts`；
 * 这里直接用契约那一份（同一份规矩，不再抄第二遍）。下面两样（外链分「网站 / 别的平台主页」的域名表、
 * 快照 → 一串联系方式）逐字照搬。
 */
import { type PublicContactLink, sanitizePublicContacts } from '@agentsws/contracts'

/** 这些域名上的外链算「别的平台主页」，其余算网站（同参考插件 to-observation.ts）。 */
const SOCIAL_HOSTS = [
  'youtube.com',
  'youtu.be',
  'instagram.com',
  'tiktok.com',
  'x.com',
  'twitter.com',
  'facebook.com',
  'threads.net',
  'twitch.tv',
  'linkedin.com',
  'pinterest.com',
  'snapchat.com',
  'reddit.com',
  'discord.gg',
  'discord.com',
  'weibo.com',
  'xiaohongshu.com',
  'bilibili.com',
  'douyin.com',
]

/** 一条外链 → 一条公开联系方式（`mailto:` 算邮箱；认不出的不报）。还没筛，筛在 {@link publicContactsOfProfile}。 */
export function publicContactOfLink(href: string, label?: string): PublicContactLink | undefined {
  const withLabel = (one: PublicContactLink): PublicContactLink =>
    label === undefined || label.trim() === '' ? one : { ...one, label }
  if (/^mailto:/i.test(href)) return withLabel({ kind: 'email', value: href })
  let host: string
  try {
    host = new URL(href).hostname.toLowerCase().replace(/^www\./, '')
  } catch {
    return undefined
  }
  const social = SOCIAL_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))
  return withLabel({ kind: social ? 'social' : 'website', value: href })
}

/**
 * 主页快照里公开写着的那几条：先是页面上的邮箱，再是主页外链（含用户点开过的 link-in-bio 展开出来的去处），
 * 过一遍 `sanitizePublicContacts`，最多 10 条。
 *
 * 邮箱算哪一种：YouTube「关于」里用户点「查看电子邮件地址」才露出来的那个是**商务入口**
 * （页面上就写着 For business inquiries）→ `business`；Instagram / TikTok 是简介里写着的 → `email`。
 *
 * 只读传进来的这几格——私信、搜索词、列表来源、用户自己的东西根本不在入参里。
 */
export function publicContactsOfProfile(profile: {
  platform: string
  businessEmail?: string | undefined
  links: readonly { url: string; title?: string | undefined }[]
}): PublicContactLink[] {
  const raw: PublicContactLink[] = []
  if (profile.businessEmail !== undefined && profile.businessEmail !== '')
    raw.push({
      kind: profile.platform === 'youtube' ? 'business' : 'email',
      value: profile.businessEmail,
    })
  for (const link of profile.links) {
    const one = publicContactOfLink(link.url, link.title)
    if (one !== undefined) raw.push(one)
  }
  return sanitizePublicContacts(raw)
}

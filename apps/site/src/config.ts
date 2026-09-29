/**
 * 官网的几处常量：换域名、换链接、填公司全称只改这一个文件。
 */

/** 官网自己的根地址（canonical、sitemap、OG 都用它）。 */
export const SITE_URL = 'https://agentsws.com'

/**
 * 云端（私有仓）：登录、网页版账号页（余额 / 充值 / 用量，WP198）都在这里。
 * 官网上的「登录 / 账号 / 充值」**只是链接**，跳过去；官网本身一行账号代码都没有。
 */
export const CLOUD_URL = 'https://cloud.agentsws.com'

/** 账号页的三个入口（WP198 已上线的路径）。 */
export const ACCOUNT_PATHS = {
  login: '/account/login',
  account: '/account',
  topup: '/account/topup',
} as const

export type AccountPage = keyof typeof ACCOUNT_PATHS

/** 账号页链接：英文站带 `?lang=en`，账号页据此出英文。 */
export function accountUrl(page: AccountPage, lang: 'zh' | 'en'): string {
  return `${CLOUD_URL}${ACCOUNT_PATHS[page]}${lang === 'en' ? '?lang=en' : ''}`
}

/** 公开价目（WP165）：构建时取一次，取不到用仓库里的样例并标「以控制台为准」。 */
export const PRICING_URL = `${CLOUD_URL}/v1/pricing`

export const GITHUB_URL = 'https://github.com/Luoye-W/agentsws'
export const GITHUB_ISSUES_URL = `${GITHUB_URL}/issues`
export const GITHUB_RELEASES_URL = `${GITHUB_URL}/releases`
export const SECURITY_URL = `${GITHUB_URL}/security/advisories/new`
export const TRADEMARK_URL = `${GITHUB_URL}/blob/main/TRADEMARK.md`
export const ARCHITECTURE_URL = `${GITHUB_URL}/blob/main/docs/ARCHITECTURE.md`
export const CONTRIBUTING_URL = `${GITHUB_URL}/blob/main/CONTRIBUTING.md`

/**
 * 运营主体公司全称与联系邮箱：**待 Luoye 提供**。没填之前条款页上照原样显示占位，
 * 一眼看得出还没填（上线前必须换掉，`test/legal.test.ts` 在 `SITE_RELEASE=1` 时会拦）。
 */
export const OPERATOR_LEGAL_NAME = '{{OPERATOR_LEGAL_NAME}}'
export const CONTACT_EMAIL = '{{CONTACT_EMAIL}}'

/** 条款三页的生效日期（改条款就改这里）。 */
export const LEGAL_EFFECTIVE_DATE = '2026-10-01'

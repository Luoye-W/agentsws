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

/**
 * 账号页的入口（WP198 已上线的路径）。WP347：加「注册」——云端注册页是 `/account/signup`
 * （登录页上「注册新账号」就链到它；`/account/register` 不是注册页，会先跳登录）。
 */
export const ACCOUNT_PATHS = {
  login: '/account/login',
  signup: '/account/signup',
  account: '/account',
  topup: '/account/topup',
} as const

export type AccountPage = keyof typeof ACCOUNT_PATHS

/** 账号页链接：英文站带 `?lang=en`，账号页据此出英文。 */
export function accountUrl(page: AccountPage, lang: 'zh' | 'en'): string {
  return `${CLOUD_URL}${ACCOUNT_PATHS[page]}${lang === 'en' ? '?lang=en' : ''}`
}

/**
 * WP218：下载清单。发版流水线（release.yml）每次发版把它更新到自有下载站根目录；
 * 官网构建时取一次（取不到用仓库里的 `src/data/downloads.json`），下载页与首页「下载」按钮都读它。
 */
export const DOWNLOADS_URL = 'https://dl.agentsws.com/downloads.json'

/**
 * WP477（决策 1609 / 1611）：官网与软件共用的 GA4 媒体资源的衡量 ID（本来就公开在页面里）。
 * 只在正式域名上加载 gtag（`GA4_HOSTS`）：本机预览、构建、测试一个统计请求都不发。
 */
export const GA4_MEASUREMENT_ID = 'G-P4LBL51H3P'
export const GA4_HOSTS: readonly string[] = ['agentsws.com', 'www.agentsws.com']

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
 * 运营主体公司全称（Luoye 09-29 提供）与联系邮箱（Luoye 10-15 改为 contact@，不再用 support@）。英文页也用中文全称——那是注册名，
 * 没有登记过的英文名就不自己译一个。
 */
export const OPERATOR_LEGAL_NAME = '深圳市卢耶科技有限公司'
export const CONTACT_EMAIL = 'contact@agentsws.com'

/**
 * 首页「四级台阶」第三级提到的两款前作（WP227，Luoye 10-05 #4）：名字点了去它们的官网，新窗口打开。
 */
export const SISTER_SITES: Readonly<Record<string, string>> = {
  KOLAgents: 'https://kolagents.com',
  KefuAgents: 'https://kefuagents.com',
}

/**
 * 条款三页的生效日期（改条款就改这里）。
 * WP344：先写成占位，**上线当天由 Fable 填成部署那天的日期**（YYYY-MM-DD）；
 * 没填之前页面上照原样显示 `{{EFFECTIVE_DATE}}`，`pnpm -F @agentsws/site launch:check` 也会拦下。
 */
export const LEGAL_EFFECTIVE_DATE = '2026-10-15'

/**
 * WP477：单独改过的那一页用自己的日期（隐私政策 10-23 补了官网统计、软件匿名使用数据、反馈保存期）。
 * **发布那天要是不是这一天，由主会话改成发布当天。** 没列的页照用 `LEGAL_EFFECTIVE_DATE`。
 */
export const LEGAL_PAGE_DATES: Readonly<Partial<Record<'terms' | 'privacy' | 'refund', string>>> = {
  privacy: '2026-10-23',
}

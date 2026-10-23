/**
 * 官网文案**全在 `src/i18n/` 这一处**：每个文件一页（或一块），中英两份并排，形状一样。
 * 换首屏标题、换「为什么」总括句只改 `home.ts` 里一行；候选都在 docs/87 §3.1。
 *
 * 写法：标题里 `*字*` 画成品牌绿的强调；每屏 = 眉题 + 标题 + 一句副标题 + 一个可见物（docs/87 §3）。
 */
export type Lang = 'zh' | 'en'

export const LANGS: readonly Lang[] = ['zh', 'en']

const zh = {
  htmlLang: 'zh-CN',
  ogLocale: 'zh_CN',
  brand: 'Agents 工坊',
  tagline: '专为跨境电商 / 出海卖家打造的开源 AI Agents。',
  skip: '跳到正文',
  nav: {
    roles: '岗位',
    pricing: '价格',
    docs: '文档',
    blog: '笔记',
    changelog: '更新',
    github: 'GitHub',
    githubStar: '在 GitHub 上点 Star',
    login: '登录',
    signup: '注册',
    download: '下载',
    theme: '切换明暗',
    menu: '菜单',
    langSwitch: 'EN',
    langSwitchLabel: 'English',
    home: 'Agents 工坊 首页',
  },
  announce: {
    badge: '内测中',
    text: 'v0.2.1-beta.11：收件箱、日历与待办合成一页，网站运营多了 SEO 与 GEO。',
    link: '看更新',
  },
  footer: {
    product: '产品',
    resources: '资源',
    legal: '条款',
    roles: '岗位',
    pricing: '价格',
    download: '下载',
    extension: '浏览器插件',
    docs: '教程',
    changelog: '更新日志',
    github: 'GitHub',
    architecture: '架构',
    contributing: '参与贡献',
    security: '报告安全问题',
    login: '登录',
    signup: '注册',
    topup: '积分与充值',
    terms: '用户条款',
    privacy: '隐私政策',
    refund: '退款政策',
    trademark: '商标政策',
    bottom: '© 2026 Agents 工坊 · 代码 Apache-2.0 · 名称与标志见商标政策',
    operator: '运营方',
    contact: '联系我们',
  },
}

export type Common = typeof zh

const en: Common = {
  htmlLang: 'en',
  ogLocale: 'en_US',
  brand: 'Agents Workshop',
  tagline: 'Open-source AI agents built for cross-border e-commerce sellers.',
  skip: 'Skip to content',
  nav: {
    roles: 'Roles',
    pricing: 'Pricing',
    docs: 'Docs',
    blog: 'Notes',
    changelog: 'Changelog',
    github: 'GitHub',
    githubStar: 'Star us on GitHub',
    login: 'Sign in',
    signup: 'Sign up',
    download: 'Download',
    theme: 'Toggle light / dark',
    menu: 'Menu',
    langSwitch: '中文',
    langSwitchLabel: '中文',
    home: 'Agents Workshop home',
  },
  announce: {
    badge: 'Beta',
    text: 'v0.2.1-beta.11: one inbox, calendar and to-dos on one page, and SEO & GEO for Web Operations.',
    link: "See what's new",
  },
  footer: {
    product: 'Product',
    resources: 'Resources',
    legal: 'Legal',
    roles: 'Roles',
    pricing: 'Pricing',
    download: 'Download',
    extension: 'Browser extension',
    docs: 'Guides',
    changelog: 'Changelog',
    github: 'GitHub',
    architecture: 'Architecture',
    contributing: 'Contributing',
    security: 'Report a security issue',
    login: 'Sign in',
    signup: 'Sign up',
    topup: 'Credits & top-up',
    terms: 'Terms of Service',
    privacy: 'Privacy Policy',
    refund: 'Refund Policy',
    trademark: 'Trademark Policy',
    bottom: '© 2026 Agents Workshop · Code under Apache-2.0 · Name and logo: see Trademark Policy',
    operator: 'Operated by',
    contact: 'Contact',
  },
}

export const COMMON: Record<Lang, Common> = { zh, en }

/** 同一页在另一种语言下的地址（`/pricing/` ↔ `/en/pricing/`）。 */
export function localePath(path: string, lang: Lang): string {
  const bare = path.replace(/^\/en(?=\/|$)/u, '') || '/'
  return lang === 'en' ? (bare === '/' ? '/en/' : `/en${bare}`) : bare
}

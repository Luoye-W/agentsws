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
  tagline: '给出海小团队的开源 AI 同事。',
  skip: '跳到正文',
  nav: {
    roles: '岗位',
    pricing: '价格',
    docs: '文档',
    changelog: '更新',
    github: 'GitHub',
    login: '登录',
    download: '下载',
    theme: '切换明暗',
    menu: '菜单',
    langSwitch: 'EN',
    langSwitchLabel: 'English',
    home: 'Agents 工坊 首页',
  },
  announce: {
    badge: '内测中',
    text: 'B2B 外贸岗上线：询盘自动分级，报价超授权转负责人批。',
    link: '看更新',
  },
  footer: {
    product: '产品',
    resources: '资源',
    openSource: '开源',
    account: '账号与条款',
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
    topup: '积分与充值',
    terms: '用户条款',
    privacy: '隐私政策',
    refund: '退款政策',
    trademark: '商标政策',
    bottom: '© 2026 Agents 工坊 · 代码 Apache-2.0 · 名称与标志见商标政策',
  },
}

export type Common = typeof zh

const en: Common = {
  htmlLang: 'en',
  ogLocale: 'en_US',
  brand: 'Agents Workshop',
  tagline: 'An open-source AI team for small cross-border businesses.',
  skip: 'Skip to content',
  nav: {
    roles: 'Roles',
    pricing: 'Pricing',
    docs: 'Docs',
    changelog: 'Changelog',
    github: 'GitHub',
    login: 'Sign in',
    download: 'Download',
    theme: 'Toggle light / dark',
    menu: 'Menu',
    langSwitch: '中文',
    langSwitchLabel: '中文',
    home: 'Agents Workshop home',
  },
  announce: {
    badge: 'Beta',
    text: 'New B2B role: inquiries graded automatically, over-limit quotes go to the lead.',
    link: "See what's new",
  },
  footer: {
    product: 'Product',
    resources: 'Resources',
    openSource: 'Open source',
    account: 'Account & legal',
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
    topup: 'Credits & top-up',
    terms: 'Terms of Service',
    privacy: 'Privacy Policy',
    refund: 'Refund Policy',
    trademark: 'Trademark Policy',
    bottom: '© 2026 Agents Workshop · Code under Apache-2.0 · Name and logo: see Trademark Policy',
  },
}

export const COMMON: Record<Lang, Common> = { zh, en }

/** 同一页在另一种语言下的地址（`/pricing/` ↔ `/en/pricing/`）。 */
export function localePath(path: string, lang: Lang): string {
  const bare = path.replace(/^\/en(?=\/|$)/u, '') || '/'
  return lang === 'en' ? (bare === '/' ? '/en/' : `/en${bare}`) : bare
}

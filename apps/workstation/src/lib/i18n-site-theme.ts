/**
 * WP253：建站岗位「AI 改主题」那一行引导 + 时间线上的「打开预览」。单独一张表，免得与别的单在 `i18n.ts` 里撞行。
 * 界面少字（Luoye）：一句话 + 一个按钮，长一点的进问号。
 */
export const SITE_THEME_ZH: Record<string, string> = {
  'site_theme.need.install_cli': '让 AI 改网站，要先装 Shopify CLI',
  'site_theme.need.node': '让 AI 改网站，要先装 Shopify CLI',
  'site_theme.need.login': '让 AI 改网站，还差登录 Shopify',
  'site_theme.need.store': '让 AI 改网站，还差店铺地址',
  'site_theme.hint':
    'AI 只在一份「未发布」的主题副本上改，改好给你预览链接；换成线上主题要你在卡上点头。全程不用开终端。',
  'site_theme.install': '一键安装',
  'site_theme.login': '登录 Shopify',
  'site_theme.store.placeholder': 'your-store.myshopify.com',
  'site_theme.store.save': '保存',
  'site_theme.store.connect': '或者去连接店铺',
  'site_theme.store.invalid': '店铺地址看不懂，填 xxx.myshopify.com，或把后台地址栏那一串粘进来',
  // WP258：登录后自动找店
  'site_theme.need.pick': '让 AI 改网站，选一下是哪家店',
  'site_theme.need.none': '这个 Shopify 账号下没有店铺',
  'site_theme.pick.label': '改哪家店',
  'site_theme.pick.placeholder': '选一家店',
  'site_theme.pick.manual': '都不是？手动填',
  'site_theme.none.relogin': '换个账号登录',
  'site_theme.none.open': '去 Shopify 开店',
  'site_theme.retry': '再找一次',
  // WP267（决策 164）：只有一家但不是官网那家
  'site_theme.need.mismatch': '官网那家店（{site}）不在这个账号下，要换个账号登录吗',
  'site_theme.mismatch.relogin': '换个账号',
  'site_theme.mismatch.use': '就用这家（{store}）',
  'matter.preview.open': '打开预览',
}

export const SITE_THEME_EN: Record<string, string> = {
  'site_theme.need.install_cli': 'To let AI edit your site, install the Shopify CLI first',
  'site_theme.need.node': 'To let AI edit your site, install the Shopify CLI first',
  'site_theme.need.login': 'To let AI edit your site, sign in to Shopify',
  'site_theme.need.store': 'To let AI edit your site, tell us your store address',
  'site_theme.hint':
    'AI only edits an unpublished copy of your theme and sends you a preview link. Going live always needs your approval on a card. No terminal needed.',
  'site_theme.install': 'Install',
  'site_theme.login': 'Sign in to Shopify',
  'site_theme.store.placeholder': 'your-store.myshopify.com',
  'site_theme.store.save': 'Save',
  'site_theme.store.connect': 'or connect the store',
  'site_theme.store.invalid': 'Use xxx.myshopify.com, or paste the admin address bar',
  'site_theme.need.pick': 'To let AI edit your site, pick your store',
  'site_theme.need.none': 'This Shopify account has no stores',
  'site_theme.pick.label': 'Store to edit',
  'site_theme.pick.placeholder': 'Pick a store',
  'site_theme.pick.manual': 'Not listed? Type it in',
  'site_theme.none.relogin': 'Sign in with another account',
  'site_theme.none.open': 'Open a Shopify store',
  'site_theme.retry': 'Look again',
  'site_theme.need.mismatch':
    'Your website’s store ({site}) isn’t under this account — sign in with another one?',
  'site_theme.mismatch.relogin': 'Switch account',
  'site_theme.mismatch.use': 'Use this one ({store})',
  'matter.preview.open': 'Open preview',
}

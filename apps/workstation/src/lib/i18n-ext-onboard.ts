/**
 * WP360（决策 947）：需要插件的岗位「装好浏览器插件」那张引导卡的词条（中英各一份；在 `i18n.ts` 的 `TABLES` 并进去）。
 * 界面少字：一个标题 + 一句为什么（按用途拼）+ 装 / 配对 + 配上之后还差的那一步 + 稍后。
 */
export const EXT_ONBOARD_ZH: Record<string, string> = {
  'extonboard.title': '先装好浏览器插件',
  'extonboard.why': '这个岗位要靠它{what}。',
  'extonboard.line': '先装好浏览器插件，这个岗位要靠它{what}',
  'extonboard.install': '装插件',
  'extonboard.collapse': '收起',
  'extonboard.use.reddit': '读 Reddit、把批过的回复填进页面',
  'extonboard.use.kol': '在 YouTube / Instagram / TikTok 上收红人',
  'extonboard.use.google_ads': '在 Google 广告后台执行批过的改动',
  'extonboard.use.meta_ads': '在 Meta 广告后台执行批过的改动',
  'extonboard.use.social': '到点打开你登录着的发帖页、你点发布',
  'extonboard.pair': '装好后点插件图标，填配对码',
  'extonboard.next.title': '插件配上了，还差一步',
  'extonboard.next.title.ego': '还差一步',
  'extonboard.step.reddit': '在插件里点「连接 Reddit」，并在这个 Chrome 登录品牌号',
  'extonboard.step.google_ads': '在插件里连上 Google 广告后台',
  'extonboard.step.meta_ads': '在插件里连上 Meta 广告后台',
  'extonboard.step.hint': '点浏览器右上角的拼图图标 → Agents 工坊助手 → 设置',
  'extonboard.plan': '下一步：{name}',
  'extonboard.later': '稍后',
  'extonboard.settings': '插件设置',
  'extonboard.later.hint': '今天先不提醒，明天再出来',
  'extonboard.onboarding.later': '稍后再装',
  'extonboard.onboarding.later.line': '可以先完成设置，回头在岗位页顶上那张卡里装。',
  'extonboard.paired': '插件已配上',
  // WP409（内测 10-18 #4）：配对成功后工坊这边的明确反馈
  'extonboard.paired.with': '插件已连上 · {who}',
  'extonboard.paired.line': '插件已连上',
  'extonboard.paired.hint': '在这个浏览器里配上的；插件图标右下角的绿勾也说明连着',
}

export const EXT_ONBOARD_EN: Record<string, string> = {
  'extonboard.title': 'Install the browser extension first',
  'extonboard.why': 'This position needs it to {what}.',
  'extonboard.line': 'Install the browser extension first; this position needs it to {what}',
  'extonboard.install': 'Install',
  'extonboard.collapse': 'Hide',
  'extonboard.use.reddit': 'read Reddit and fill approved replies into the page',
  'extonboard.use.kol': 'save creators from YouTube / Instagram / TikTok',
  'extonboard.use.google_ads': 'carry out approved changes in Google Ads',
  'extonboard.use.meta_ads': 'carry out approved changes in Meta Ads',
  'extonboard.use.social': 'open your signed-in post composer on time so you click Post',
  'extonboard.pair': 'Once installed, click the extension icon and enter this pairing code',
  'extonboard.next.title': 'Extension paired — one more step',
  'extonboard.next.title.ego': 'One more step',
  'extonboard.step.reddit':
    'In the extension, click “Connect Reddit” and sign in to the brand account in this Chrome',
  'extonboard.step.google_ads': 'Connect Google Ads in the extension',
  'extonboard.step.meta_ads': 'Connect Meta Ads in the extension',
  'extonboard.step.hint': 'Puzzle icon (top right of the browser) → Agents Workshop → Settings',
  'extonboard.plan': 'Next: {name}',
  'extonboard.later': 'Later',
  'extonboard.settings': 'Extension settings',
  'extonboard.later.hint': 'No reminder today; it comes back tomorrow',
  'extonboard.onboarding.later': 'Install later',
  'extonboard.onboarding.later.line':
    'You can finish setup now and install it from the card at the top of the position page.',
  'extonboard.paired': 'Extension paired',
  'extonboard.paired.with': 'Extension connected · {who}',
  'extonboard.paired.line': 'Extension connected',
  'extonboard.paired.hint':
    'Paired in this browser; the green check on the extension icon means it is connected',
}

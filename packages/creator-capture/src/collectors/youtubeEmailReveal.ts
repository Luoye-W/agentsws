/** 移植自 agentsws-extension `src/contents/utils/youtubeEmailReveal.ts` @ 57fca9c（源自 KOLAgents 旧插件 d25b877）。决策 1739 A：只搬采集器与指标算法；开源仓这一份只改 import 路径（与注释里点名私有插件 / 模板的几个词），本体逐字不动。 */
/**
 * WP490（决策 1710 = C）：YouTube「查看电子邮件地址」→ 过完人机验证后**弹出来的那个**邮箱。
 *
 * 新写的（不是移植件）。为什么不直接用移植来的 `readRevealedYouTubeEmail`：那一个是给面板
 * **显示**和**手动收下**用的，读法宽（任何对话框里有 email 字样就取第一个邮箱）——显示错了用户
 * 看得见、不点收下就不出门；而这里读到的会**自动**随观测报上去，所以要窄得多：
 *
 * 1. 只看**对话框**（`tp-yt-paper-dialog` / `yt-dialog-view-model`），并且它不在页头、账号菜单、
 *    下拉菜单里，也不是「关于」那个对话框本身（「关于」里的邮箱走快照，不在这里重复读）；
 * 2. 对话框要**自报是商务邮箱那一个**（For business inquiries / View email address / 电子邮件地址…），
 *    而且不带任何账号菜单的字样（Sign out / Switch account / Google Account / 退出 / 切换账号…）；
 * 3. 对话框里只能有**一个**邮箱——两个以上说明不是那个弹窗，宁可不报；
 * 4. 页头 / 账号菜单 / 账号切换器里出现过的邮箱（= 登录用户自己的）**一律不报**，哪怕它出现在弹窗里。
 *
 * 读不到、拿不准就回 `undefined`：漏报只是少一条，错报是把用户自己的邮箱送进公共库。
 */

const EMAIL_IN_TEXT = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g

/** 候选：YouTube 的两种对话框外壳。 */
const DIALOG_SELECTOR = 'tp-yt-paper-dialog, yt-dialog-view-model'

/** 「关于」对话框本身（它的邮箱走快照的 businessEmail）。 */
const ABOUT_SELECTOR = 'ytd-about-channel-renderer, ytd-channel-about-metadata-renderer'

/** 登录用户自己的地盘：页头、账号菜单、账号切换器、下拉菜单。 */
const ACCOUNT_AREA_SELECTOR = [
  'ytd-masthead',
  '#masthead-container',
  '#masthead',
  'ytd-topbar-menu-button-renderer',
  'ytd-active-account-header-renderer',
  'ytd-multi-page-menu-renderer',
  'ytd-account-item-renderer',
  'ytd-account-item-section-renderer',
  'ytd-account-section-list-renderer',
  'ytd-google-account-header-renderer',
  'tp-yt-iron-dropdown',
  'ytd-menu-popup-renderer',
  '#account-name',
  '#email',
].join(', ')

/** 弹窗自报身份：商务邮箱那一个。 */
const REVEAL_PHRASE =
  /(business inquiries|business enquiries|for business|view email address|email address|查看电子邮件地址|查看電子郵件地址|商务合作|商务咨询|商業洽詢|業務洽詢|电子邮件地址|電子郵件地址)/i

/** 账号菜单 / 账号验证的字样：带了就不是那个弹窗。 */
const ACCOUNT_PHRASE =
  /(sign out|sign in|switch account|google account|your channel|verify it'?s you|退出|登录|登入|切换账号|切換帳戶|切换帐号|google 帐号|google 账号|google 帳戶|你的频道|您的頻道|验证您的身份|驗證您的身分)/i

function textOf(el: Element): string {
  // jsdom 没有 innerText；textContent 在真浏览器里也够用（只做匹配，不显示）。
  return (el as HTMLElement).innerText || el.textContent || ''
}

function emailsIn(text: string): string[] {
  return [...new Set((text.match(EMAIL_IN_TEXT) ?? []).map((e) => e.toLowerCase()))]
}

function isHidden(el: Element): boolean {
  return (
    el.hasAttribute('hidden') ||
    el.getAttribute('aria-hidden') === 'true' ||
    (el as HTMLElement).style?.display === 'none'
  )
}

/** 登录用户自己的邮箱（页头 / 账号菜单里出现过的）。 */
function ownEmails(root: ParentNode): Set<string> {
  const own = new Set<string>()
  for (const area of Array.from(root.querySelectorAll(ACCOUNT_AREA_SELECTOR))) {
    for (const email of emailsIn(textOf(area))) own.add(email)
    // 头像按钮、账号行常把邮箱放在属性里而不是文字里
    for (const el of [area, ...Array.from(area.querySelectorAll('[aria-label], [title]'))]) {
      for (const attr of ['aria-label', 'title']) {
        for (const email of emailsIn(el.getAttribute(attr) ?? '')) own.add(email)
      }
    }
  }
  return own
}

/**
 * 过完人机验证后弹出来的那个商务邮箱；拿不准就 `undefined`。
 * `root` 只给测试换文档用；面板里就是 `document`。
 */
export function readVerifiedBusinessEmail(root: ParentNode = document): string | undefined {
  const own = ownEmails(root)
  const found = new Set<string>()
  for (const dialog of Array.from(root.querySelectorAll(DIALOG_SELECTOR))) {
    if (isHidden(dialog)) continue
    if (dialog.closest(ACCOUNT_AREA_SELECTOR) !== null) continue
    if (dialog.querySelector(ACCOUNT_AREA_SELECTOR) !== null) continue
    if (dialog.closest(ABOUT_SELECTOR) !== null || dialog.querySelector(ABOUT_SELECTOR) !== null)
      continue
    const text = textOf(dialog)
    if (!REVEAL_PHRASE.test(text) || ACCOUNT_PHRASE.test(text)) continue
    const emails = emailsIn(text)
    if (emails.length !== 1) continue
    const email = emails[0] as string
    if (own.has(email)) continue
    found.add(email)
  }
  // 两个对话框各说一个不同的邮箱：拿不准是哪个，不报。
  return found.size === 1 ? [...found][0] : undefined
}

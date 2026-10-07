/**
 * WP246：连接页「取数路线」那一块的词条（中英各一份）。
 *
 * 单独一个文件、在 `i18n.ts` 的 `TABLES` 那一行并进去（同 `i18n-library.ts`）。
 * 少字（36 §7）：每行一个平台、每级一个状态图标，原因与怎么修进图标的提示；只有安全那句常显。
 */
export const READ_ROUTES_ZH: Record<string, string> = {
  'read_routes.title': '取数路线',
  'read_routes.hint':
    '每个平台按顺序试：首选不通自动换备选。图标是每一级通不通，停在上面看原因和怎么修。「重新体检」会真去连一下。',
  'read_routes.recheck': '重新体检',
  'read_routes.checked_at': '体检于 {time}',
  'read_routes.active': '在用',
  'read_routes.none_active': '都不通',
  'read_routes.platform.reddit': 'Reddit',
  'read_routes.platform.youtube': 'YouTube 字幕',
  'read_routes.platform.web': '网页转文字',
  'read_routes.level.workshop': '接口中台',
  'read_routes.level.browser_readonly': '读号浏览器',
  'read_routes.level.page_captions': '视频页字幕',
  'read_routes.level.local_extract': '本机抽正文',
  'read_routes.level.third_party_reader': '第三方转文字',
  'read_routes.state.off': '关着',
  'read_routes.state.pending': '还没接',
  'read_routes.fix': '怎么修：{fix}',
  'read_routes.last_ok': '上次：取到了',
  'read_routes.last_fail': '上次没成：{message}',
  'read_routes.login': '登录读号',
  'read_routes.login.open': '窗口开着…',
  'read_routes.login.safety': '用一个普通号登录，别用版主号 / 品牌官方号',
  'read_routes.login.safety_hint':
    '读号只用来读：我们不碰密码、不读 cookie 内容，只看页面上显示的用户名。认出是品牌登记的号（官方 / 版主）会拦下。发帖、回帖永远走品牌号 + 你批。',
  'read_routes.account.logged_in': '已登录：u/{name}',
  'read_routes.account.logging_in': '在打开的窗口里登录，登好后关掉它',
  'read_routes.third_party': '第三方转文字',
  'read_routes.third_party_hint':
    '本机抽不出正文（靠脚本现画的页面）时，转给 Jina Reader。开了之后这些网页的网址会发给对方的服务器。默认关。',
}

export const READ_ROUTES_EN: Record<string, string> = {
  'read_routes.title': 'Read routes',
  'read_routes.hint':
    'Each platform is tried in order: if the first level is down, the next one takes over. Hover an icon for the reason and the fix. "Re-check" actually connects.',
  'read_routes.recheck': 'Re-check',
  'read_routes.checked_at': 'Checked {time}',
  'read_routes.active': 'In use',
  'read_routes.none_active': 'All down',
  'read_routes.platform.reddit': 'Reddit',
  'read_routes.platform.youtube': 'YouTube captions',
  'read_routes.platform.web': 'Web page to text',
  'read_routes.level.workshop': 'Data hub',
  'read_routes.level.browser_readonly': 'Reader-account browser',
  'read_routes.level.page_captions': 'Video page captions',
  'read_routes.level.local_extract': 'Local extraction',
  'read_routes.level.third_party_reader': 'Third-party reader',
  'read_routes.state.off': 'Off',
  'read_routes.state.pending': 'Not connected yet',
  'read_routes.fix': 'Fix: {fix}',
  'read_routes.last_ok': 'Last time: fetched',
  'read_routes.last_fail': 'Last time failed: {message}',
  'read_routes.login': 'Log in reader account',
  'read_routes.login.open': 'Window open…',
  'read_routes.login.safety': 'Use an ordinary account — not a moderator or brand account',
  'read_routes.login.safety_hint':
    'The reader account is only used to read. We never touch the password or read cookies; we only read the username shown on the page. Brand-registered accounts (official / moderator) are refused. Posting and replying always use the brand account with your approval.',
  'read_routes.account.logged_in': 'Logged in: u/{name}',
  'read_routes.account.logging_in': 'Log in in the window that opened, then close it',
  'read_routes.third_party': 'Third-party reader',
  'read_routes.third_party_hint':
    'When a page cannot be extracted locally (script-rendered pages), send it to Jina Reader. When on, those page URLs go to their servers. Off by default.',
}

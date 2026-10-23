/**
 * WP483（决策 1658–1661）：「推荐装 ego」卡、岗位上「发之前让我看一眼」、Reddit 卡走 ego 时的几句（中英各一份）。
 *
 * 界面少字：卡上一句 + 按钮，步骤进问号与教程「安装和注册 ego」。
 */
export const EGO_ZH: Record<string, string> = {
  'ego.recommend.title': '推荐装 ego',
  'ego.recommend.why': '装了以后 AI 发帖、回帖、找红人更稳。',
  'ego.recommend.hint.mac':
    '打开下载页会自动给 Mac 版。下载后拖进「应用程序」，打开一次，按首次引导走完（导不导入 Chrome 都行）。我们不碰你的账号密码。',
  'ego.recommend.hint.win':
    '打开下载页会给 Windows 测试版。安装时 Windows 拦了就点「更多信息 → 仍要运行」；装好打开一次、走完首次引导。工坊照常双击打开就行，不要「以管理员身份运行」。',
  'ego.recommend.download': '去下载',
  'ego.recommend.recheck': '装好了，再看一次',
  'ego.recommend.later': '先不装，用插件',
  'ego.ready': 'ego 已就绪 · {version}',
  'ego.ready.hint':
    '第一次用：在 ego 里打开 facebook.com 等网站，弹「显示通知」时点「阻止」；要发帖的网站在 ego 里登录好。',
  'ego.recommended': '推荐',
  'ego.default': '没选过，默认用 ego',
  // 岗位设置：发之前让我看一眼
  'ego.review.label': '发之前让我看一眼',
  'ego.review.hint':
    '默认关：批了的帖子 / 回帖，工坊在 ego 里填好就直接发出去并记下。打开后只填好，留着页面等你自己点发送。',
  // Reddit 卡走 ego 时
  'redditw.send.ego': '批准并发出',
  'redditw.send.ego.hint':
    '批了之后工坊在 ego 里填好、点发送、读回链接，记进发出记录。岗位开了「发之前让我看一眼」就只填好，你自己点。ego 发不成会自动交给浏览器插件。',
  'redditw.sent.ego': '已批，工坊在 ego 里发出去',
}

export const EGO_EN: Record<string, string> = {
  'ego.recommend.title': 'Install ego (recommended)',
  'ego.recommend.why': 'With it, AI posts, replies and finds creators more reliably.',
  'ego.recommend.hint.mac':
    'The download page gives you the Mac build. Drag it into Applications, open it once and finish the first-run steps (importing Chrome is optional). We never touch your passwords.',
  'ego.recommend.hint.win':
    'The download page gives you the Windows beta. If Windows blocks the installer, click “More info → Run anyway”; then open it once and finish the first-run steps. Open the app normally, not “Run as administrator”.',
  'ego.recommend.download': 'Download',
  'ego.recommend.recheck': 'Installed, check again',
  'ego.recommend.later': 'Not now, use the extension',
  'ego.ready': 'ego is ready · {version}',
  'ego.ready.hint':
    'First time: open sites like facebook.com in ego and click “Block” when it asks to show notifications; sign in to the sites you post on inside ego.',
  'ego.recommended': 'Recommended',
  'ego.default': 'Not chosen yet, using ego by default',
  'ego.review.label': 'Let me check before it sends',
  'ego.review.hint':
    'Off by default: approved posts and replies are filled in ego and sent right away, then logged. Turn it on to only fill them in and leave the page for you to send.',
  'redditw.send.ego': 'Approve and send',
  'redditw.send.ego.hint':
    'Once approved, the app fills it in ego, clicks send, reads the link back and logs it. If this position has “Let me check before it sends” on, it only fills it in. If ego can’t send it, it goes to the browser extension.',
  'redditw.sent.ego': 'Approved: the app is sending it in ego',
}

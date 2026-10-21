/**
 * WP437（Luoye 10-21）：三栏口径与两种对话框的词条（中英各一份）。
 * 单独一个文件、在 `i18n.ts` 的 `TABLES` 并进去（同 `i18n-topbar.ts` 的做法）。
 */
export const LAYOUT_ZH: Record<string, string> = {
  // 看板自动隐藏时顶栏那颗小图标
  'rail.board.peek': '看一眼看板（窗口窄，看板先收着）',
  'rail.panel.report_compose': '做一份报表',
  // 首页的简易对话框
  'home.composer.placeholder': '有什么要我做的？',
  'home.composer.label': '问助理一句，或交代一件事',
  'home.composer.attach': '附资料（拖进来也行）',
  'home.composer.send': '发送（Enter）',
}

export const LAYOUT_EN: Record<string, string> = {
  'rail.board.peek': 'Peek at the board (window is narrow, so it is tucked away)',
  'rail.panel.report_compose': 'New report',
  'home.composer.placeholder': 'What can I do for you?',
  'home.composer.label': 'Ask the assistant, or hand it a task',
  'home.composer.attach': 'Attach files (drag works too)',
  'home.composer.send': 'Send (Enter)',
}

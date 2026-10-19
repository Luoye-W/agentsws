/**
 * WP431（Luoye 10-19，照 Claude 桌面版）：顶栏标题下拉、左上角两颗图标、搜索弹窗的词条（中英各一份）。
 * 单独一个文件、在 `i18n.ts` 的 `TABLES` 并进去（同 `i18n-position.ts` 的做法）。
 */
export const TOPBAR_ZH: Record<string, string> = {
  // 顶栏标题下拉
  'topbar.menu.position': '「{name}」的操作',
  'topbar.menu.duty': '「{name}」的操作',
  'topbar.position.rename': '改名…',
  'topbar.position.settings': '岗位设置',
  'topbar.position.duties': '职责',
  'topbar.duty.about': '职责设置',
  'topbar.duty.back': '回到岗位「{name}」',
  'topbar.duty.switch': '换一条职责',
  'topbar.matter.rename': '改名',
  'topbar.settings.close': '回到工作',
  // 左上角
  'topbar.sidebar.collapse': '收起左栏',
  'topbar.sidebar.expand': '展开左栏',
  'topbar.search': '搜索',
  // 搜索弹窗
  'search.placeholder': '搜索事项、对话、岗位、设置…',
  'search.recent': '最近',
  'search.open': '打开',
  'search.close': '关闭',
  'ago.now': '刚刚',
  'ago.m': '{n} 分钟',
  'ago.h': '{n} 小时',
  'ago.d': '{n} 天',
  'rail.tier.label': '看哪一层',
}

export const TOPBAR_EN: Record<string, string> = {
  'topbar.menu.position': 'Actions for {name}',
  'topbar.menu.duty': 'Actions for {name}',
  'topbar.position.rename': 'Rename…',
  'topbar.position.settings': 'Position settings',
  'topbar.position.duties': 'Duties',
  'topbar.duty.about': 'Duty settings',
  'topbar.duty.back': 'Back to {name}',
  'topbar.duty.switch': 'Switch duty',
  'topbar.matter.rename': 'Rename',
  'topbar.settings.close': 'Back to work',
  'topbar.sidebar.collapse': 'Collapse sidebar',
  'topbar.sidebar.expand': 'Expand sidebar',
  'topbar.search': 'Search',
  'search.placeholder': 'Search tasks, chats, positions, settings…',
  'search.recent': 'Recent',
  'search.open': 'Open',
  'search.close': 'Close',
  'ago.now': 'now',
  'ago.m': '{n}m',
  'ago.h': '{n}h',
  'ago.d': '{n}d',
  'rail.tier.label': 'Layer',
}

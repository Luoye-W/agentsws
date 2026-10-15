/**
 * WP342（决策 853）：外壳整理的词条——账号菜单（余额 / 两组入口 / 场景）与输入框里的 AI 钮。
 *
 * 单独一个文件、在 `i18n.ts` 的 `TABLES` 并进去（同 `i18n-position.ts` 的做法）。界面少字：
 * 长说明进教程，短的进 tooltip（`*.tip`）。
 */
export const SHELL_ZH: Record<string, string> = {
  // 账号菜单
  'account.balance': '积分',
  'account.balance.tip': '工坊账号里还剩多少积分',
  'account.balance.low': '余额不多了',
  'account.topup': '充值',
  'account.group.work': '工作内容',
  'account.group.settings': '设置',
  'account.scenes.tip': '切到 DeepSeek 的其他场景',

  // 输入框里的 AI 钮
  'model.pick.workshop': '工坊',
  'model.pick.aria': '这次用的 AI：{name}',
  'model.pick.tip': '这次用 {name}（只改这一件，不改默认）',
  'model.pick.default': '设为默认',
  'model.pick.default.tip': '以后新开的事都先用它',
  'model.pick.is_default': '默认',
  'model.pick.none': '还没接 AI',
  'model.pick.none.tip': '接一个 AI 再交活',
}

export const SHELL_EN: Record<string, string> = {
  'account.balance': 'Credits',
  'account.balance.tip': 'Credits left on your Workshop account',
  'account.balance.low': 'Running low',
  'account.topup': 'Top up',
  'account.group.work': 'Work',
  'account.group.settings': 'Settings',
  'account.scenes.tip': 'Switch to another DeepSeek scene',

  'model.pick.workshop': 'Workshop',
  'model.pick.aria': 'AI for this one: {name}',
  'model.pick.tip': 'Using {name} here (this one only, default unchanged)',
  'model.pick.default': 'Make default',
  'model.pick.default.tip': 'New work starts with it from now on',
  'model.pick.is_default': 'Default',
  'model.pick.none': 'No AI yet',
  'model.pick.none.tip': 'Connect an AI before handing work over',
}

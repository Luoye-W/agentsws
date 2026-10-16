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
  // WP362：学 Proma 的样子——搜索、按来源分组、每行右边是消耗速率 / 订阅额度 / 用你自己的 key
  'model.pick.search': '搜索模型…',
  'model.pick.empty': '没有对得上的模型',
  'model.pick.group.workshop': 'Agents 工坊（积分）',
  'model.pick.group.subscription': 'ChatGPT 订阅',
  'model.pick.balance': '余额 {n} 积分',
  'model.pick.member_left': '本月还剩 {n} 积分',
  'model.pick.price.free': '限免',
  'model.pick.price.subscription': '订阅额度',
  'model.pick.price.own_key': '用你自己的 key',
  'model.pick.rate.note':
    '消耗速率以 DeepSeek v4 Pro 官方原价为 1x，按后台长期统计换算；实际消耗以用量记录为准。',
  'model.pick.rate.fallback': '这份价目里没有 DeepSeek v4 Pro，这里按 {model} 算 1x。',
  'model.pick.rate.stats': '按后台长期统计',
  'model.pick.rate.list_price': '按官方原价折算',
  'model.pick.source_model': '{source} · {model}',
  'model.pick.vision': '看图',
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
  'model.pick.search': 'Search models…',
  'model.pick.empty': 'No matching model',
  'model.pick.group.workshop': 'Agents Workshop (credits)',
  'model.pick.group.subscription': 'ChatGPT subscription',
  'model.pick.balance': '{n} credits left',
  'model.pick.member_left': '{n} credits left this month',
  'model.pick.price.free': 'Free',
  'model.pick.price.subscription': 'Subscription',
  'model.pick.price.own_key': 'Your own key',
  'model.pick.rate.note':
    'Rates are relative to DeepSeek v4 Pro at list price (1x), from long-run usage stats; your usage log is what counts.',
  'model.pick.rate.fallback':
    'DeepSeek v4 Pro is not in this price list, so {model} counts as 1x here.',
  'model.pick.rate.stats': 'From long-run usage stats',
  'model.pick.rate.list_price': 'From list prices',
  'model.pick.source_model': '{source} · {model}',
  'model.pick.vision': 'Images',
}

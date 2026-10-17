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
    '消耗速率按 token 算：这个模型常见的用法下，花的积分是 DeepSeek v4 Pro 的几倍（v4 Pro = 1x）；折扣是我们的价比这家官方标价。实际消耗以用量记录为准。',
  'model.pick.rate.fallback': '这份价目里没有 DeepSeek v4 Pro，这里按 {model} 算 1x。',
  'model.pick.rate.stats': '按近 30 天真实用量的 token 构成',
  'model.pick.rate.list_price': '按典型 token 构成（输入 3 : 输出 1）',
  // WP363 / WP364（决策 958）：倍率旁边的折扣小标签（「8 折」）悬停说明：我们的价 ÷ 这家官方标价
  'model.pick.discount.tip': '按 token 算，我们的价是这家官方标价的 {pct}%；实际消耗以用量记录为准',
  'model.pick.source_model': '{source} · {model}',
  'model.pick.vision': '看图',
  // WP370：思考程度三档 + 能力小标（只画图标，悬停出这一句）
  'model.pick.thinking': '思考',
  'model.pick.thinking.tip': '想得越深越慢、越费额度。换模型会回到「标准」。',
  'model.pick.thinking.fast': '快',
  'model.pick.thinking.standard': '标准',
  'model.pick.thinking.deep': '深想',
  'model.pick.cap.web': '自带联网搜索',
  'model.pick.cap.long': '长上下文（约 {k}K）',
  // WP370：设置里自定义接口——还要在 AI 钮里列哪些
  'models.picker.title': '也在 AI 钮里显示',
  'models.picker.tip':
    '主模型总在。勾上的这几个，输入框的 AI 钮里也能直接选。拉不到清单就手填，一行一个。',
  'models.picker.search': '搜索清单…',
  'models.picker.manual': '手填模型名，一行一个',
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
    "Rates are per token: what we charge for this model in typical use, relative to what we charge for DeepSeek v4 Pro (1x). Discounts compare our price with the maker's list price. Your usage log is what counts.",
  'model.pick.rate.fallback':
    'DeepSeek v4 Pro is not in this price list, so {model} counts as 1x here.',
  'model.pick.rate.stats': 'Token mix from the last 30 days of real usage',
  'model.pick.rate.list_price': 'Typical token mix (input 3 : output 1)',
  'model.pick.discount.tip':
    "Per token, our price is {pct}% of the maker's list price; your usage log is what counts",
  'model.pick.source_model': '{source} · {model}',
  'model.pick.vision': 'Images',
  'model.pick.thinking': 'Thinking',
  'model.pick.thinking.tip':
    'Deeper is slower and uses more quota. Switching models goes back to Standard.',
  'model.pick.thinking.fast': 'Fast',
  'model.pick.thinking.standard': 'Standard',
  'model.pick.thinking.deep': 'Deep',
  'model.pick.cap.web': 'Built-in web search',
  'model.pick.cap.long': 'Long context (about {k}K)',
  'models.picker.title': 'Also show in the AI button',
  'models.picker.tip':
    'The main model is always there. Ticked models can be picked right from the AI button. No list? Type names, one per line.',
  'models.picker.search': 'Search the list…',
  'models.picker.manual': 'Type model names, one per line',
}

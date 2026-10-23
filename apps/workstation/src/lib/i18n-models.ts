/**
 * WP426（Luoye 10-19）：设置 → 模型 整页重做的词——三块（正在用 / 加一个 / 价目与用量）、
 * 已配那一行的状态标签、积分快用完的提醒。在 `i18n.ts` 的 `TABLES` 里排在 `SETTINGS_*` 后面并进去
 * （同名的老词条以这里为准）。
 *
 * 少字（docs/36 §7）：卡面只留名字 + 一句；为什么、怎么来的进问号。
 */
export const MODELS_ZH: Record<string, string> = {
  // ── 三块
  'models.in_use': '正在用',
  'models.in_use.hint':
    '已经接上的 AI 都在这里。岗位干活用「默认模型」那一个；输入框里的 AI 钮可以临时换。',
  'models.empty': '还一个都没配。从下面挑一种接上。',
  'models.add.hint': '登录账号最省事；手上已经有 API key 的，填进来就行。',
  'models.add.login': '登录账号 / 订阅',
  'models.add.key': 'API key',
  'models.add.collapse': '收起',
  'models.costs': '价目与用量',
  'models.costs.hint': '内置价目表、今天花了多少、预算上限。',
  'models.default_model': '默认模型',
  'models.default_model.hint': '岗位干活默认用它。输入框里的 AI 钮可以临时换一个。',
  'models.by_purpose': '按用途分别选',
  'models.default_badge': '默认',
  'models.fallback': '自己的用不了时用工坊积分',
  // WP430：自己配的不止一个时，按这个顺序接（可拖动）
  'models.ai_source.order': '自己的按这个顺序接',

  // ── 「加一个」里的名字与一句话（同一家的「登录」与「填 key」分在两组）
  'models.add.login.deepseek': 'DeepSeek 账号',
  'models.add.login.deepseek.line': '用 DeepSeek 账号登录，不用建 key。',
  'models.add.login.openai': 'ChatGPT 订阅',
  'models.add.login.openai.line': '已经在付 Plus / Pro，就不用再买 API 额度。',
  'models.add.login.anthropic': 'Claude 订阅',
  'models.add.login.anthropic.line': '用 Claude Pro / Max 订阅登录。',
  'models.add.login.agentsws-cloud': 'Agents 工坊积分',
  'models.add.login.agentsws-cloud.line': '不填 key，关联工坊账号后按积分扣。',
  'models.add.key.deepseek': 'DeepSeek 官方',
  'models.add.key.deepseek.line': '去开放平台建一把 key，按量付费。',
  'models.add.key.openai': 'OpenAI',
  'models.add.key.openai.line': '填 OpenAI 的 API key，按量付费。',
  'models.add.key.anthropic': 'Anthropic',
  'models.add.key.anthropic.line': '填 Anthropic 的 API key，按量付费。',

  // ── 已配那一行的状态标签（原来是三个带减号的小图标）
  'models.status.testing': '测试中',
  'models.status.untested': '还没测',
  'models.status.ok_vision': '能用 · 能看图',
  'models.status.ok_no_vision': '能用 · 看不了图',
  'models.status.ok': '能用',
  'models.status.no_connect': '连不上',
  'models.status.no_text': '回不了话',
  'models.status.failed': '没通',
  'models.subscription.signed_in.short': '已登录',
  'models.image.none_short': '生图还没配，在下面选一条。',
  // ── 输入框 AI 钮：能力小标只标例外（几个字 + 悬停一句）
  'model.pick.cap.web.short': '自带联网',
  'model.pick.cap.long.short': '长上下文',
  'model.pick.cap.no_vision.short': '不能看图',
  'free_chat.model.no_vision': '这个模型看不了图（读图片、看手册这类事要换一个能看图的）。',

  // ── WP479（决策 1625）：每个已连接来源勾哪些模型（选择器只列勾上的）
  'models.enable.toggle': '模型 {on}/{all}',
  'models.enable.toggle.hint': '勾上的才出现在模型选择里。有新模型会在铃铛里提醒。',
  'models.enable.latest': '全选最新',
  'models.enable.latest.hint': '每个系列勾上最新那一版（已经勾的不动）。',
  'models.enable.search': '搜模型…',
  'models.enable.new': '新',
  'models.enable.locked.default': '默认 / 按用途在用，取消不了。先在下面换掉默认。',
  'models.enable.locked.main': '这条连接的主模型，取消不了。',
  'models.enable.in_use': '在用',
  'models.enable.in_use.hint': '有事项选着它。取消勾选后那件事改用默认模型。',
  'models.enable.saving': '保存中…',

  // ── 积分快用完（原来写死「余额低于 50」，注册才送 5 积分，一进来就红）
  'credits.low': '积分快用完了：大约还够 {n} 轮对话',
  'credits.low.hint': '按便宜档一轮对话约 {per} 积分估算；少于 {min} 轮时提醒。',
}

export const MODELS_EN: Record<string, string> = {
  'models.in_use': 'In use',
  'models.in_use.hint':
    'Every AI you have connected. Positions use the default model; the AI button in the composer can switch for one message.',
  'models.empty': 'Nothing connected yet. Pick one below.',
  'models.add.hint': 'Signing in is easiest; if you already have an API key, paste it in.',
  'models.add.login': 'Sign in / subscription',
  'models.add.key': 'API key',
  'models.add.collapse': 'Close',
  'models.costs': 'Prices & usage',
  'models.costs.hint': 'Built-in price list, what was spent today, budget caps.',
  'models.default_model': 'Default model',
  'models.default_model.hint':
    'Positions use it by default. The AI button in the composer can switch for one message.',
  'models.by_purpose': 'Per task',
  'models.default_badge': 'Default',
  'models.fallback': 'Use workshop credits when yours fail',
  'models.ai_source.order': 'Yours, in this order',

  'models.add.login.deepseek': 'DeepSeek account',
  'models.add.login.deepseek.line': 'Sign in with DeepSeek; no key needed.',
  'models.add.login.openai': 'ChatGPT subscription',
  'models.add.login.openai.line': 'Already paying for Plus / Pro? No API credit needed.',
  'models.add.login.anthropic': 'Claude subscription',
  'models.add.login.anthropic.line': 'Sign in with Claude Pro / Max.',
  'models.add.login.agentsws-cloud': 'Workshop credits',
  'models.add.login.agentsws-cloud.line': 'No key; link your workshop account and pay in credits.',
  'models.add.key.deepseek': 'DeepSeek',
  'models.add.key.deepseek.line': 'Create a key on the open platform; pay per use.',
  'models.add.key.openai': 'OpenAI',
  'models.add.key.openai.line': 'OpenAI API key; pay per use.',
  'models.add.key.anthropic': 'Anthropic',
  'models.add.key.anthropic.line': 'Anthropic API key; pay per use.',

  'models.status.testing': 'Testing',
  'models.status.untested': 'Not tested',
  'models.status.ok_vision': 'Works · sees images',
  'models.status.ok_no_vision': 'Works · no images',
  'models.status.ok': 'Works',
  'models.status.no_connect': 'Can’t connect',
  'models.status.no_text': 'No reply',
  'models.status.failed': 'Failed',
  'models.subscription.signed_in.short': 'Signed in',
  'models.image.none_short': 'Image generation is not set up; pick one below.',
  'model.pick.cap.web.short': 'Web',
  'model.pick.cap.long.short': 'Long context',
  'model.pick.cap.no_vision.short': 'No images',
  'free_chat.model.no_vision': 'This model cannot see images.',

  'models.enable.toggle': 'Models {on}/{all}',
  'models.enable.toggle.hint':
    'Only checked models show up in model pickers. New models are announced in the bell.',
  'models.enable.latest': 'Select latest',
  'models.enable.latest.hint':
    'Check the newest version in each series (keeps what is already checked).',
  'models.enable.search': 'Search models…',
  'models.enable.new': 'New',
  'models.enable.locked.default': 'Used as default / for a purpose. Change the default first.',
  'models.enable.locked.main': 'Main model of this connection; always on.',
  'models.enable.in_use': 'In use',
  'models.enable.in_use.hint':
    'A task has picked it. Unchecking makes that task use the default model.',
  'models.enable.saving': 'Saving…',

  'credits.low': 'Credits running low: about {n} more chats',
  'credits.low.hint':
    'Estimated at about {per} credits per cheap-tier chat; warns below {min} chats.',
}

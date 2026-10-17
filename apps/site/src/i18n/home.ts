/**
 * 首页文案（docs/87 §3，中英）。首屏标题与「为什么」总括句 Luoye 09-29 暂定，候选在 docs/87 §3.1。
 * WP344（10-15）：正文按 10-15 已合进 main 的能力重写——只写真做到的；不点名客户，也不点名数据商。
 */
import type { Lang } from './common.js'

const zh = {
  // WP347（Luoye 10-15，决策 883）：定位「专为跨境电商 / 出海卖家打造的 AI Agents」进 meta 与首屏
  meta: {
    title: 'Agents 工坊 · 专为跨境电商 / 出海卖家打造的 AI Agents',
    description:
      '专为跨境电商 / 出海卖家打造的 AI Agents：客服、红人、Reddit、广告、建站、B2B 按岗位配齐，不只会聊，还能动手。一键连上各平台，要拍板的出卡给你。个人、团队、整个公司都能用。开源免费，用积分按量付费。',
  },
  hero: {
    pill: '开源 · Apache-2.0 · 跑在你自己的电脑上',
    title: ['面板会吃灰。', '这队 *AI 同事*，', '天天上班。'],
    position: '专为跨境电商 / 出海卖家打造的 AI Agents。',
    lede: '客服、红人、Reddit、广告、建站、B2B……按岗位配齐，要拍板的才找你。',
    // WP347：按访客系统直接给安装包（site.ts 换按钮）；认不出、手机、Intel Mac 照旧去下载页
    download: '免费下载',
    dlAny: 'Mac / Windows',
    dlMac: ['下载 Mac 版', 'M 系列芯片'],
    dlWin: ['下载 Windows 版', '64 位'],
    dlMore: ['其他版本', '浏览器插件'],
    macFirstOpen: '第一次打开若提示无法验证开发者：系统设置 → 隐私与安全性 → 仍要打开',
    // WP225（WP218 决定 ⑤）：Windows 访客点了直接下安装包，旁边一行首次打开提示（只在 Windows 上露出来）
    // WP227 合一份：文案用 WP227 那句（Luoye 10-05 #⑤ 原话「第一次打开点『更多信息 → 仍要运行』」）
    winFirstOpen: '第一次打开若被拦，点「更多信息 → 仍要运行」',
    github: '在 GitHub 上看',
    checks: ['Mac / Windows', '一键连上各平台', '按量付费 · 自带 key 免费'],
    frameBar: '127.0.0.1 · 今天',
    shotAlt: '工作台：左栏是岗位，中间是等你定的卡',
    card: {
      chip: '客服 · 回信',
      due: '剩 1 天',
      evidence: '证据 6',
      title: '回复 Anna：退货申请 #1001',
      quote:
        'Hi Anna, your order #1001 is still inside our 30-day window — here’s your prepaid return label…',
      send: '发送',
      edit: '改一下',
      drop: '不发',
    },
  },
  why: {
    eyebrow: '为什么是 Agents 工坊',
    title: ['从给人用的工具，', '到替公司干活的队伍。'],
    sub: '这四级台阶，我们自己一级一级走过。',
    steps: [
      { h: '自己搓的面板', p: '好看，两周后吃灰。数据摆着，活还得人干。' },
      { h: '给人用的小工具', p: '查红人资料快了一点，可还是人在一行行点。' },
      {
        h: '围绕 AI 打造的 Agent',
        p: 'KOLAgents、KefuAgents 把一件事从头干到尾，只管一个人的一摊。',
      },
      {
        h: 'Agents 工坊',
        p: '站到公司层面：一队 Agents 按规矩分工、交接，要紧的事汇成一张卡给你批。',
      },
    ],
    s1: { board: '我的看板 ✦', kpi: ['订单', '销售额', '转化'], stale: '上次打开：14 天前' },
    s2: {
      search: 'outdoor gear',
      cols: ['红人', '粉丝', '邮箱'],
      row: '第 37 / 200 行',
      csv: '导出 CSV',
    },
    s3: {
      working: '在干活',
      nodes: [
        ['找红人', '23 位入选'],
        ['起草', '首封开发信'],
        ['回信', '2 位回复'],
      ],
      learn: '越干越会',
      note: '记下：@desknoor 先要样品，再谈价。',
    },
    s4: {
      split: '一变一队',
      roles: [
        ['客服', '询盘转给 B2B'],
        ['红人营销', '开发信 8 封'],
        ['B2B 外贸', '报价超了授权'],
      ],
      handoff: '交接',
      decide: '待你拍板',
      quote: '报价 Q-02',
      amount: '18,414 USD',
      approve: '批准',
    },
  },
  roles: {
    eyebrow: '按岗位开工',
    title: '缺几个人，就上几个岗位。',
    sub: '勾几个岗位就上岗。每个岗位各管一摊，各有自己的记忆。',
    more: '岗位不够用？自己建一个。',
    moreLink: '看每个岗位管什么 →',
    newBadge: '新',
  },
  // WP347：三种用法，按 docs/95 里真做到的写（WP271 / 275–278 / 284）
  modes: {
    eyebrow: '三种用法',
    title: '一个人用，团队用，整个公司也能用。',
    sub: '默认一个人用。有人管人的那一套，只在公司模式里出现。',
    items: [
      {
        key: 'solo',
        tag: '个人 · 默认',
        h: '一个人，管几个品牌',
        p: '装上就用，岗位都归你。要对外的事，你点头才算。',
      },
      {
        key: 'team',
        tag: '团队',
        h: '同事互联，平起平坐',
        p: '各管各的岗位，谁也不批谁。活能交给同事，对方接下才算；你的代理替你答同事、约时间。',
      },
      {
        key: 'company',
        tag: '整个公司',
        h: '老板开启，有人管人',
        p: '一个余额，给每人设每月上限和能看的店铺；要紧的事按上下级审批。',
      },
    ],
    grow: '从一个人用起，往上升级；数据跟着走，不用重装。',
  },
  how: {
    eyebrow: '怎么干活',
    title: '几句话交代，它自己配好。',
    sub: '不用学后台，不用画流程。缺什么，它在对话里问你。',
    items: [
      {
        icon: 'plug',
        h: '一键连上各平台',
        p: 'Shopify、Amazon、Google / Meta 广告、Reddit……借你浏览器里已登录的账号，或点一下授权。不用申请开发者应用。',
      },
      {
        icon: 'puzzle',
        h: '缺什么，就地补',
        p: '少个连接、少个设置，对话里弹一张卡；补完接着做。',
      },
      { icon: 'chart', h: '回答就是图表', p: '问数据，直接回图表、表格、数字卡。' },
      {
        icon: 'chat',
        h: '说一句，配起来',
        p: '周报、记到你自己的表格，这类需求说给它听就行，不用等我们出新功能。',
      },
      { icon: 'clock', h: '定时上班', p: '每天巡查、每周出报告，到点就干。' },
      { icon: 'check', h: '办完留账', p: '发出去的每一条都在本机留记录，谁批的都查得到。' },
    ],
    shotAlt: '岗位页：交给它一件事，下面是这个岗位的卡和进度',
    frameBar: '127.0.0.1 · 岗位',
  },
  cards: {
    eyebrow: '出卡审批',
    title: 'AI 只提议。点头的，永远是你。',
    sub: '要发出去、要花钱、要改东西的，一律先变成一张卡。',
    steps: [
      ['交给它一件事', '一句话，交给某个岗位'],
      ['岗位自己去办', '查订单、翻政策、起草'],
      ['出一张卡', '带理由和出处'],
      ['你点头', '发送、改一下，或不发'],
      ['办完留账', '谁批的、改了什么，都查得到'],
    ],
    deck: [
      {
        chip: '客服 · 回信',
        tone: 'info',
        due: '剩 1 天',
        title: '回复 Anna：退货申请 #1001',
        body: '订单在 30 天退货窗口内，附上退货标签。引用：退换货政策 §2',
        actions: ['发送', '改一下', '不发'],
      },
      {
        chip: '社媒 · Reddit 回帖',
        tone: 'good',
        due: 'FAQ 2',
        title: '回复帖子：充电宝能带上飞机吗？',
        body: '20000mAh 约 74Wh，低于 100Wh 的限制。批了以后，插件把草稿填进 Reddit，你点发送。',
        actions: ['批准', '改一下', '不发'],
      },
      {
        chip: '投放 · Google 广告',
        tone: 'info',
        due: '先预览',
        title: '换掉 3 条点击率最低的标题',
        body: '上传表已生成。插件先传到后台预览，你确认了才提交。',
        actions: ['批准', '改一下', '驳回'],
      },
    ],
    never: '退款、补发、改价、发布，永远人审。采纳率再高，也不自动放行。',
  },
  local: {
    eyebrow: '本地优先',
    title: ['你的生意，', '留在你的电脑上。'],
    sub: '客户、订单、话术都存在本机。要上云，得你点头。',
    promises: [
      { icon: 'laptop', h: '双击就装', p: 'Mac、Windows 都有。不用 Docker，不用命令行。' },
      {
        icon: 'key',
        h: '钥匙在你手里',
        p: '密码不经 AI、不进日志。',
        hint: '店铺、邮箱的密码只在原生表单里填，存在本机加密库；模型看不到，日志里也没有。',
      },
      {
        icon: 'cloud',
        h: '上云你说了算',
        p: '只传必要的，能导出、能删。',
        hint: '开了云端服务或跑长程任务时才上云：只传需要的那部分，加密存放，随时导出、随时删除。',
      },
      { icon: 'pause', h: '模型断了就停', p: 'AI 连不上时整条线冻结，不瞎发。' },
    ],
  },
  free: {
    eyebrow: '别处收费，这里免费',
    title: '付费墙后面的东西，都在开源版里。',
    sub: '不按席位，不按连接数，没有企业版。',
    head: ['你要的', '别处常见的收法', 'Agents 工坊'],
    rows: [
      ['客服 AI', '按席位月付', '免费，用你自己的 key'],
      ['连店铺、邮箱、社媒', '按连接数收费', '免费，账号是你自己的'],
      ['浏览器插件（红人、Reddit、广告）', '按条、按次', '免费'],
      ['审批流、带权限的知识库', '企业版才有', '免费'],
      ['多店铺、多品牌', '加钱升级', '免费'],
    ],
    fine: '「别处」指市面上常见的收费方式，不特指某一家；以各家官方信息为准。',
  },
  base: {
    // WP347：突出「从底层出发，跳出只能对话、不能动手」
    eyebrow: '基于 DeepSeek Harness',
    title: ['从底层出发：', '不只会聊，*还能动手*。'],
    sub: '别的 AI 只会陪你聊。工坊从 Harness 底层接起：查订单、回邮件、发帖、改广告，动手干活；要紧的先问你。',
    stackLabel: '分层示意：从下到上是官方底座、按公司重组的五层、岗位队伍',
    team: '岗位队伍',
    teamChips: ['客服', '红人营销', '社媒运营', '网站运营', '投放', 'B2B', '……'],
    rebuilt: '按公司重组',
    layers: [
      ['审批', '要发出去、要花钱的，先出卡给你批，办完留账。'],
      ['记忆', '每个岗位、每条职责各记各的。'],
      ['权限', '谁能动什么，按岗位授权。'],
      ['工具', '官方工具加我们的连接器，每条职责只拿到它声明过的。'],
      ['运行时', '每个岗位按自己的职责跑；模型断了，整条线就停。'],
    ],
    harness: ['DeepSeek Harness', '官方底座。我们按官方的方式扩展，不改它的内核。'],
    updTitle: '官方更新',
    updTitle2: '我们跟着用上',
    timeline: [
      ['2026-09-24', '官方场景', '在工坊里一键切到 DeepSeek Harness 官方场景。'],
      ['2026-09-29', '官方网页搜索', '岗位查资料，用官方的搜索和抓网页。'],
      ['2026-09-29', '官方自动化任务', '定时要做的活，交给官方的自动化。'],
      ['2026-10-10', '跟上 0.2.1 alpha', '官方一出新版就评估，测试和模拟回路全绿才升。'],
    ],
    oss: ['开源 Apache-2.0。', '代码全部公开，可以 fork，没有付费墙。'],
    star: 'Star on GitHub',
    arch: '读架构',
    term: ['每次提交，先让一家虚拟公司跑一遍', '六条底线全过 · 合并门禁：通过'],
  },
  credits: {
    eyebrow: '价格',
    // WP347：点明按量付费
    title: '按量付费，不按席位，不包月。',
    sub: '开源版全功能免费，自带 key 不花钱；用工坊的积分，用多少扣多少。',
    open: {
      tag: '开源版',
      price: '¥0',
      unit: '永久',
      items: ['全部岗位、全部功能', '自带模型 key，直连，不经我们', '多店铺、多品牌、审批、知识库'],
      cta: '免费下载',
    },
    paid: {
      tag: 'Agents 工坊（用积分）',
      price: '1 积分 = ¥1',
      unit: '按用量',
      items: ['不填 key、不用去各家注册', '注册送 10 积分', '充值的积分永不过期'],
      cta: '看价格',
    },
  },
  log: {
    eyebrow: '公开地做',
    title: '每一步，都摊开给你看。',
    sub: '需求来自社群，进度写在仓库里。',
    all: '全部更新 →',
  },
  faq: {
    title: '常见问题',
    items: [
      [
        '真的免费吗？图什么？',
        '开源版全功能免费，没有付费墙。积分是给想省事的人：不想自己去各家开账号、填 key，就用我们的。',
      ],
      [
        '我的数据会传上去吗？',
        '默认全在你电脑上。只有你开了云端服务、或者用积分调模型时，才把那一次需要的内容发出去。',
      ],
      ['AI 会不会自己乱发、乱退款？', '不会。对外发送、退款、改价都先出卡，你点了才办。'],
      [
        '要会写代码吗？',
        '不用。双击安装，接上 AI，贴上你的官网就能开工。连平台借你浏览器里的登录，不用申请开发者应用、不开终端。',
      ],
      [
        '能连哪些平台？',
        'Shopify、邮箱、Amazon、Reddit、Google / Meta 广告、TikTok、YouTube、WhatsApp、飞书、钉钉等。用到哪个还没连，它会在对话里请你连上。',
      ],
      [
        '和 DeepSeek Harness 是什么关系？',
        '它是底座。Agents 工坊是它的一个发行版：按官方的方式扩展，不改它的核心。',
      ],
    ],
  },
  final: {
    title: '先交给它一件小事。',
    sub: '装上，接一个 AI，把今天最烦的那封邮件交给客服岗。',
    docs: '看教程',
  },
}

export type HomeCopy = typeof zh

const en: HomeCopy = {
  meta: {
    title: 'Agents Workshop · AI agents built for cross-border e-commerce sellers',
    description:
      'AI agents built for cross-border e-commerce sellers: support, creators, Reddit, ads, site building and B2B, organised by role. They don’t just chat; they do the work. Connect your platforms in one click; anything that needs your call becomes a card. For one person, a team or a whole company. Open source and free; pay as you go with credits.',
  },
  hero: {
    pill: 'Open source · Apache-2.0 · Runs on your own computer',
    title: ['Dashboards gather dust.', 'This *AI team*', 'shows up every day.'],
    position: 'AI agents built for cross-border e-commerce sellers.',
    lede: 'Support, creators, Reddit, ads, site building, B2B: a full set of roles that only come to you when it’s your call.',
    download: 'Download free',
    dlAny: 'Mac / Windows',
    dlMac: ['Download for Mac', 'Apple silicon (M-series)'],
    dlWin: ['Download for Windows', '64-bit'],
    dlMore: ['Other versions', 'Browser extension'],
    macFirstOpen:
      'If macOS can’t verify the developer: System Settings → Privacy & Security → Open Anyway',
    winFirstOpen: 'If Windows blocks it the first time, click “More info → Run anyway”',
    github: 'View on GitHub',
    checks: [
      'Mac & Windows',
      'Connect your platforms in one click',
      'Pay as you go · free with your own key',
    ],
    frameBar: '127.0.0.1 · Today',
    shotAlt: 'The Workshop: roles on the left, cards waiting for your call in the middle',
    card: {
      chip: 'Support · Reply',
      due: '1 day left',
      evidence: '6 sources',
      title: 'Reply to Anna: return request #1001',
      quote:
        'Hi Anna, your order #1001 is still inside our 30-day window — here’s your prepaid return label…',
      send: 'Send',
      edit: 'Edit',
      drop: 'Drop',
    },
  },
  why: {
    eyebrow: 'Why Agents Workshop',
    title: ['From tools people use', 'to a team that works for your company.'],
    sub: 'We climbed every one of these steps ourselves.',
    steps: [
      {
        h: 'A dashboard you vibe-coded',
        p: 'Looks great, gathers dust in two weeks. The data sits there; people still do the work.',
      },
      {
        h: 'Tools built for people',
        p: 'Looking up creators gets faster, but you are still clicking row by row.',
      },
      {
        h: 'Agents built around AI',
        p: "KOLAgents and KefuAgents take one job from start to finish, for one person's lane.",
      },
      {
        h: 'Agents Workshop',
        p: 'Company level: a team of agents splits the work and hands it off by your rules; what matters lands on one card for you to approve.',
      },
    ],
    s1: {
      board: 'My dashboard ✦',
      kpi: ['Orders', 'Revenue', 'Conversion'],
      stale: 'Last opened: 14 days ago',
    },
    s2: {
      search: 'outdoor gear',
      cols: ['Creator', 'Followers', 'Email'],
      row: 'Row 37 / 200',
      csv: 'Export CSV',
    },
    s3: {
      working: 'working',
      nodes: [
        ['Find', '23 shortlisted'],
        ['Draft', 'First pitch'],
        ['Reply', '2 replied'],
      ],
      learn: 'Gets better with use',
      note: 'Noted: @desknoor wants a sample first, then talks price.',
    },
    s4: {
      split: 'One becomes a team',
      roles: [
        ['Support', 'Inquiry to B2B'],
        ['Influencers', '8 pitches'],
        ['B2B', 'Quote over limit'],
      ],
      handoff: 'Handoff',
      decide: 'Your call',
      quote: 'Quote Q-02',
      amount: '18,414 USD',
      approve: 'Approve',
    },
  },
  roles: {
    eyebrow: 'Hire by role',
    title: 'Short on people? Add a role.',
    sub: 'Pick the roles you need. Each one owns its lane and keeps its own memory.',
    more: 'Need something else? Create your own role.',
    moreLink: 'See what each role does →',
    newBadge: 'New',
  },
  modes: {
    eyebrow: 'Three ways to use it',
    title: 'For one person, a team, or the whole company.',
    sub: 'It starts as yours alone. Managers and sign-offs only appear in company mode.',
    items: [
      {
        key: 'solo',
        tag: 'Solo · default',
        h: 'Just you, several brands',
        p: 'Install and go; every role is yours. Nothing goes out until you approve it.',
      },
      {
        key: 'team',
        tag: 'Team',
        h: 'Colleagues, side by side',
        p: 'Everyone runs their own roles and nobody signs off on anybody. Hand work to a colleague; it’s theirs once they accept. Your assistant answers colleagues and books time for you.',
      },
      {
        key: 'company',
        tag: 'Whole company',
        h: 'The owner turns it on',
        p: 'One balance, a monthly cap and store access for each member; what matters goes up the chain for approval.',
      },
    ],
    grow: 'Start on your own and move up when you need to. Your data comes along; nothing to reinstall.',
  },
  how: {
    eyebrow: 'How it works',
    title: 'Tell it in a few sentences. It sets itself up.',
    sub: 'No admin panels to learn, no workflows to draw. If something’s missing, it asks you in the chat.',
    items: [
      {
        icon: 'plug',
        h: 'Connect your platforms in one click',
        p: 'Shopify, Amazon, Google / Meta Ads, Reddit…: through the accounts already signed in to in your browser, or one click to authorize. No developer apps to apply for.',
      },
      {
        icon: 'puzzle',
        h: 'Fills gaps on the spot',
        p: 'Missing a connection or a setting? A card pops up in the chat; fill it in and the work carries on.',
      },
      {
        icon: 'chart',
        h: 'Answers come as charts',
        p: 'Ask about your numbers and get charts, tables and stat cards back.',
      },
      {
        icon: 'chat',
        h: 'Say it, and it’s set up',
        p: 'A weekly report, logging to your own spreadsheet: just tell it. No waiting for us to ship a feature.',
      },
      {
        icon: 'clock',
        h: 'Shows up on schedule',
        p: 'Daily checks and weekly reports, right on time.',
      },
      {
        icon: 'check',
        h: 'Everything on record',
        p: 'Every message sent is logged on your computer, along with who approved it.',
      },
    ],
    shotAlt: 'A role page: hand it a task; below are this role’s cards and progress',
    frameBar: '127.0.0.1 · Role',
  },
  cards: {
    eyebrow: 'Cards, not surprises',
    title: 'AI proposes. You decide. Always.',
    sub: 'Anything that goes out, costs money or changes something becomes a card first.',
    steps: [
      ['Hand it a task', 'One sentence, to one role'],
      ['The role does the work', 'Checks orders, policies, drafts'],
      ['It hands you a card', 'With reasons and sources'],
      ['You decide', 'Send, edit, or drop'],
      ["It's done — and logged", 'Who approved what, all on record'],
    ],
    deck: [
      {
        chip: 'Support · Reply',
        tone: 'info',
        due: '1 day left',
        title: 'Reply to Anna: return request #1001',
        body: 'Order is inside the 30-day return window; return label attached. Cites: Returns policy §2',
        actions: ['Send', 'Edit', 'Drop'],
      },
      {
        chip: 'Social · Reddit reply',
        tone: 'good',
        due: '2 FAQs',
        title: 'Reply: can I take this power bank on a plane?',
        body: '20,000 mAh is about 74 Wh, under the 100 Wh limit. Once approved, the extension fills the draft into Reddit and you hit send.',
        actions: ['Approve', 'Edit', 'Drop'],
      },
      {
        chip: 'Ads · Google Ads',
        tone: 'info',
        due: 'Preview first',
        title: 'Replace the 3 lowest-CTR headlines',
        body: 'Upload sheet ready. The extension uploads it for a preview in Google Ads; nothing is submitted until you confirm.',
        actions: ['Approve', 'Edit', 'Reject'],
      },
    ],
    never:
      'Refunds, reships, price changes and publishing are always human-approved. No approval rate unlocks autopilot.',
  },
  local: {
    eyebrow: 'Local first',
    title: ['Your business stays', 'on your computer.'],
    sub: 'Customers, orders and playbooks live on your machine. Nothing goes to the cloud unless you turn it on.',
    promises: [
      {
        icon: 'laptop',
        h: 'Double-click to install',
        p: 'Mac and Windows. No Docker, no command line.',
      },
      {
        icon: 'key',
        h: 'Your keys stay yours',
        p: 'Never seen by the AI, never logged.',
        hint: 'Store and mailbox passwords are entered in a native form and kept in an encrypted vault on this computer. The model never sees them, and they never reach a log.',
      },
      {
        icon: 'cloud',
        h: 'Cloud is opt-in',
        p: 'Only what’s needed; export or delete anytime.',
        hint: 'Data only goes to the cloud when you turn on a cloud service or run a long task there: just the part that’s needed, encrypted, exportable and deletable at any time.',
      },
      {
        icon: 'pause',
        h: 'Model down? Everything stops',
        p: 'No half-baked sends when the AI can’t be reached.',
      },
    ],
  },
  free: {
    eyebrow: 'Paid elsewhere, free here',
    title: 'Everything behind other people’s paywalls is in the open-source edition.',
    sub: 'No per-seat pricing. No per-connection pricing. No enterprise tier.',
    head: ['What you need', 'Common pricing elsewhere', 'Agents Workshop'],
    rows: [
      ['Support AI', 'Per seat, per month', 'Free, with your own key'],
      ['Connect store, email, social', 'Per connection', 'Free, your own accounts'],
      ['Browser extension (creators, Reddit, ads)', 'Per record, per call', 'Free'],
      ['Approvals, permissioned knowledge base', 'Enterprise tier only', 'Free'],
      ['Multiple stores and brands', 'Paid upgrade', 'Free'],
    ],
    fine: '"Elsewhere" describes common pricing models, not any specific company. Check each vendor’s official pricing.',
  },
  base: {
    eyebrow: 'Built on DeepSeek Harness',
    title: ['Built from the ground up:', 'it doesn’t just chat, it *does the work*.'],
    sub: 'Most AI only keeps you company in a chat box. The Workshop is wired in from the Harness up: it checks orders, answers email, posts and edits ads, and asks you first when it matters.',
    stackLabel:
      'Layer diagram, bottom up: the official base, five layers rebuilt for a company, your team of roles',
    team: 'Your team',
    teamChips: ['Care', 'Creators', 'Social', 'Web ops', 'Ads', 'B2B', '…'],
    rebuilt: 'Rebuilt for a company',
    layers: [
      ['Approvals', 'Anything that goes out or costs money becomes a card for you, and is logged.'],
      ['Memory', 'Every role and duty keeps its own.'],
      ['Permissions', 'Who can touch what follows the role.'],
      ['Tools', 'Official tools plus our connectors; each duty only gets what it declares.'],
      ['Runtime', 'Each role runs its own duties; if the model goes down, the whole line stops.'],
    ],
    harness: [
      'DeepSeek Harness',
      'The official base. We extend it the official way and leave its core alone.',
    ],
    updTitle: 'Upstream ships',
    updTitle2: 'we adopt',
    timeline: [
      ['2026-09-24', 'Official scenes', 'Switch to DeepSeek Harness official scenes in one click.'],
      [
        '2026-09-29',
        'Official web search',
        'Roles look things up with the official search and fetcher.',
      ],
      ['2026-09-29', 'Official automations', 'Recurring work runs on the official automations.'],
      [
        '2026-10-10',
        'Tracking 0.2.1 alpha',
        'Every new release is evaluated; we upgrade only when tests and the simulation loop pass.',
      ],
    ],
    oss: ['Apache-2.0.', 'All code public. Fork it. No paywall.'],
    star: 'Star on GitHub',
    arch: 'Read the architecture',
    term: [
      'Every commit runs a simulated company first',
      'All six invariants pass · merge gate: green',
    ],
  },
  credits: {
    eyebrow: 'Pricing',
    title: 'Pay as you go. No seats, no subscription.',
    sub: 'The open-source edition is free and complete, and your own key costs nothing. With Workshop credits you pay only for what you use.',
    open: {
      tag: 'Open source',
      price: '¥0',
      unit: 'forever',
      items: [
        'Every role, every feature',
        'Bring your own model key, direct — never through us',
        'Multiple stores and brands, approvals, knowledge base',
      ],
      cta: 'Download free',
    },
    paid: {
      tag: 'Agents Workshop credits',
      price: '1 credit = ¥1',
      unit: 'pay as you go',
      items: [
        'No API keys, no sign-ups elsewhere',
        '10 free credits when you sign up',
        'Purchased credits never expire',
      ],
      cta: 'See pricing',
    },
  },
  log: {
    eyebrow: 'Built in public',
    title: 'Every step, out in the open.',
    sub: 'Requests come from the community; progress lives in the repo.',
    all: 'All updates →',
  },
  faq: {
    title: 'Questions',
    items: [
      [
        'Is it really free? What’s the catch?',
        'The open-source edition is complete and free, with no paywall. Credits are for people who want it easy: no accounts to open elsewhere, no keys to paste.',
      ],
      [
        'Does my data leave my computer?',
        'By default, everything stays on your computer. Only when you turn on a cloud service, or use credits to call a model, does the content needed for that one request go out.',
      ],
      [
        'Can the AI send or refund on its own?',
        'No. Sending anything out, refunds and price changes all become cards first. Nothing happens until you click.',
      ],
      [
        'Do I need to code?',
        'No. Double-click to install, connect an AI, paste your website and you’re working. Platforms connect through your browser logins — no developer apps, no terminal.',
      ],
      [
        'What can it connect to?',
        'Shopify, email, Amazon, Reddit, Google and Meta Ads, TikTok, YouTube, WhatsApp, Feishu, DingTalk and more. If a task needs one you haven’t connected, it asks you in the chat.',
      ],
      [
        'How does it relate to DeepSeek Harness?',
        'Harness is the base. Agents Workshop is a distribution of it: extended the official way, core untouched.',
      ],
    ],
  },
  final: {
    title: 'Start with one small task.',
    sub: 'Install it, connect an AI, and hand today’s most annoying email to Support.',
    docs: 'Read the guides',
  },
}

export const HOME: Record<Lang, HomeCopy> = { zh, en }

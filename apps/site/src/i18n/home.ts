/**
 * 首页文案（docs/87 §3，中英）。
 * WP344（10-15）：正文按 10-15 已合进 main 的能力重写——只写真做到的；不点名客户，也不点名数据商。
 * 10-23 按界面优化定稿后的样子重排（私有 docs/117）：首屏改讲「主动式 AI Agents 团队」；
 * 页面压短——截图收进「一天怎么过」滑动，功能按组点开，接 AI 与上网各成一段，本地优先 / 三种用法 / 别处收费合成一段。
 * 以后加新功能：只在 `how.groups` 对应那组加一行，不加新段。
 */
import type { Lang } from './common.js'

const zh = {
  // WP347（Luoye 10-15，决策 883）：定位「专为跨境电商 / 出海卖家打造的 AI Agents」进 meta 与首屏
  meta: {
    title: 'Agents 工坊 · 专为跨境电商 / 出海卖家打造的 AI Agents，主动干活的团队',
    description:
      '专为跨境电商 / 出海卖家打造的 AI Agents：一支主动式 AI Agents 团队。客服、红人、Reddit、广告、建站、B2B 按岗位配齐，每天自己巡查、起草、跟进，要你拍板的才排进收件箱。DeepSeek 账号、ChatGPT 订阅直接登录。开源免费，Mac / Windows。',
  },
  hero: {
    pill: '开源 · Apache-2.0 · 跑在你自己的电脑上',
    // 10-23 Luoye：首屏讲「主动式 AI Agents 团队」，换掉「面板会吃灰」那句
    title: ['一支*主动式*', 'AI Agents 团队，', '自己找活干。'],
    position: '专为跨境电商 / 出海卖家打造的 AI Agents。',
    lede: '客服、红人、Reddit、广告、建站、B2B 按岗位配齐。每天自己巡查、起草、跟进，要你拍板的才排进收件箱。',
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
    checks: ['Mac / Windows', '一键连上各平台', 'DeepSeek 账号、ChatGPT 订阅直接登录'],
    frameBar: '首页',
    shotAlt: '工作台首页：今天几件等你定、几件待办，下面是关键数字和各岗位',
    card: {
      chip: '客服 · 回信',
      due: '剩 1 天',
      evidence: '证据 6',
      title: '回复 Anna：退货申请 #1001',
      quote:
        'Hi Anna, your order #1001 is still inside our 30-day window — here’s your prepaid return label…',
      send: '发送',
      edit: '修改',
      drop: '不发',
    },
  },
  // 10-23：截图收成一组滑动（不自动播放），第一张是收件箱
  tour: {
    eyebrow: '一天怎么过',
    title: '要你定的，都在收件箱排好队。',
    sub: '打开工坊先看收件箱，再看今天的待办。岗位在后面干活，有事才叫你。',
    prev: '上一张',
    next: '下一张',
    slides: [
      {
        key: 'inbox',
        tab: '收件箱',
        alt: '收件箱：所有等你定的排成一条队，右边打开一封「对方还没回」的催一下草稿',
        p: '所有岗位等你批的卡、只能你定的信，排成一条队。扫列表，或者一张一张过，按键盘就行。批错了能撤回。',
      },
      {
        key: 'calendar',
        tab: '日历与待办',
        alt: '日历周视图：AI 给三件没排期的待办找了空档，用虚线标出来等你采用',
        p: '说「周五下午拍样品」就记好了。没排日子的，AI 按你的作息排进空档，你点「采用」才算。',
      },
      {
        key: 'role',
        tab: '岗位',
        alt: '客服岗位页：上面是一张要你定的策略卡，右边一列是对话、报表、计划和连接',
        p: '每个岗位一页：上面是要你处理的，右边一列是对话、报表、计划和连接，底下直接交代事。',
      },
      {
        key: 'answer',
        tab: '回答就是图表',
        alt: '网站运营岗位：问「这周店里卖得怎么样」，回来数字卡、条形图和表格',
        p: '问「这周店里卖得怎么样」，回来数字卡、条形图和表格。读不到的数照实说差什么。',
      },
      {
        key: 'home',
        tab: '首页',
        alt: '工作台首页：问候、收件箱与待办一行、关键数字、各岗位',
        p: '今天几件等你定、几件待办，昨天卖了多少，各岗位在干什么。底下一个框，有事直接说。',
      },
    ],
  },
  roles: {
    eyebrow: '按岗位开工',
    title: '缺几个人，就上几个岗位。',
    sub: '勾几个岗位就上岗。每个岗位各管一摊，各有自己的记忆。',
    more: '岗位不够用？自己建一个。',
    moreLink: '看每个岗位管什么 →',
    newBadge: '新',
  },
  // 10-23：原来六格 + 一张大图，改成按组点开（新功能只往组里加一行）
  how: {
    eyebrow: '怎么干活',
    title: '几句话交代，它自己配好。',
    sub: '不用学后台，不用画流程。点一行看说明。',
    guide: '看教程 →',
    groups: [
      {
        key: 'setup',
        label: '连接与设置',
        items: [
          {
            h: '一键连上各平台',
            p: '借你浏览器里的登录，不用申请开发者应用',
            more: 'Shopify、Amazon、Google / Meta 广告、Reddit……借你浏览器里已登录的账号，或者点一下授权。不开终端，不填开发者密钥。',
            help: 'conn-shopify',
          },
          {
            h: '缺什么，就地补',
            p: '少个连接、少个设置，对话里弹一张卡',
            more: '在卡上补完，接着往下做，不用跑去设置页找。',
            help: '',
          },
          {
            h: '说一句，配起来',
            p: '周报、记到你自己的表格',
            more: '这类需求说给它听就行，它自己配好，不用等我们出新功能。',
            help: '',
          },
        ],
      },
      {
        key: 'mail',
        label: '收信与回复',
        items: [
          {
            h: '收信规则一句话建',
            p: '先拿过去 30 天的信试一遍',
            more: '比如「结算通知打标签、记到表里、别烦我」。试跑的结果给你看，你点「建」才生效。',
            help: 'conn-email',
          },
          {
            h: '没回的信，它记着',
            p: '3 个工作日没回，出一张「催一下」',
            more: '催的草稿写好了；对方说过哪天答复，就按那天算。对方一回信，这张卡自己撤掉。',
            help: '',
          },
          {
            h: 'Reddit 回帖在插件里填好',
            p: '发送你自己点',
            more: '草稿进浏览器插件「等你发」，点「填入」就在你开着的帖子里填好。你自己发的，插件也会记下来。',
            help: 'browser-extension',
          },
        ],
      },
      {
        key: 'plan',
        label: '日程',
        items: [
          {
            h: 'AI 排空档',
            p: '按你的作息排，你点「采用」才算',
            more: '上下班时间、周末、直播前后留多久、避开午饭，在「我的作息」里设一次。上周没做完的自动挪进本周。',
            help: '',
          },
          {
            h: '定时上班',
            p: '每天巡查、每周出报告',
            more: '到点就干。周报默认周一下午出，想换时间跟它说一声。',
            help: '',
          },
        ],
      },
      {
        key: 'data',
        label: '数据与搜索',
        items: [
          {
            h: '回答就是图表',
            p: '问数据，回来数字卡、图和表',
            more: '报表先给三句结论，再给一排数和趋势图。读不到的数照实写差哪个连接。',
            help: '',
          },
          {
            h: 'SEO 与 GEO 技术体检',
            p: '每周一查一遍',
            more: '收录、规范网址、跳转与死链、站点地图、hreflang、结构化数据、速度。要改的直接交给建站岗位。',
            help: 'site-health',
          },
          {
            h: 'AI 怎么说你的品类',
            p: 'ChatGPT、Perplexity 提没提你',
            more: '把 AI 说错的名称、价格、卖点列成清单。改了以后到期自动复查，前后对比。',
            help: 'ai-answer-tracking',
          },
        ],
      },
      {
        key: 'calm',
        label: '省心',
        items: [
          {
            h: '告警进铃铛',
            p: '紧急的标红、排最上',
            more: '点一下直接跳到对应的岗位或事项。',
            help: '',
          },
          {
            h: '左下角「反馈」',
            p: '能附截图，回复进铃铛',
            more: '没登录也能发。诊断信息先脱敏，你看过再发。',
            help: '',
          },
          {
            h: '办完留账',
            p: '谁批的、改了什么，都查得到',
            more: '发出去的每一条都在本机留记录。',
            help: 'sent-log',
          },
        ],
      },
    ],
  },
  cards: {
    eyebrow: '出卡审批',
    title: 'AI 只提议。点头的，永远是你。',
    sub: '要发出去、要花钱、要改东西的，一律先变成一张卡。',
    steps: [
      ['交给它一件事', '一句话，交给某个岗位'],
      ['岗位自己去办', '查订单、翻政策、起草'],
      ['出一张卡，进收件箱', '带理由和出处'],
      ['你点头', '发送、修改，或不发'],
      ['办完留账', '谁批的、改了什么，都查得到'],
    ],
    deck: [
      {
        chip: '客服 · 回信',
        tone: 'info',
        due: '剩 1 天',
        title: '回复 Anna：退货申请 #1001',
        body: '订单在 30 天退货窗口内，附上退货标签。引用：退换货政策 §2',
        actions: ['发送', '修改', '不发'],
      },
      {
        chip: '社媒 · Reddit 回帖',
        tone: 'good',
        due: 'FAQ 2',
        title: '回复帖子：充电宝能带上飞机吗？',
        body: '20000mAh 约 74Wh，低于 100Wh 的限制。草稿进浏览器插件，在你开着的帖子里填好，发送你自己点。',
        actions: ['填入', '修改', '不发'],
      },
      {
        chip: '投放 · Google 广告',
        tone: 'info',
        due: '先预览',
        title: '换掉 3 条点击率最低的标题',
        body: '上传表已生成。插件先传到后台预览，你确认了才提交。',
        actions: ['批准', '修改', '驳回'],
      },
    ],
    never: '退款、补发、改价、发布，永远人审。采纳率再高，也不自动放行。',
  },
  // 10-23 Luoye：讲清楚能用自己已有的 DeepSeek 账号、ChatGPT 订阅、API；积分只说和 DeepSeek 官方同价（替原「价格」段）
  ai: {
    eyebrow: '接上 AI',
    title: 'DeepSeek 账号、ChatGPT 订阅，直接登录就能用。',
    sub: '已经在用的，不用再买一份。',
    options: [
      {
        h: 'DeepSeek 账号登录',
        p: '用你自己的 DeepSeek 账号，按你账号里的余额扣',
        help: 'model-deepseek',
        own: true,
      },
      {
        h: 'ChatGPT 订阅',
        p: '用你已经付了的 ChatGPT 订阅',
        help: 'model-openai',
        own: true,
      },
      {
        h: '你自己的 API key',
        p: 'DeepSeek、OpenAI、Anthropic、Google、百炼……直连，不经过我们',
        help: 'model-openai-compatible',
        own: true,
      },
      {
        h: '工坊积分',
        p: '和 DeepSeek 官方同价，不用去各家注册',
        help: 'agentsws-credits',
        own: false,
      },
    ],
    frameBar: '初始化设置 · 接上 AI',
    shotAlt:
      '初始化设置第一步「接上 AI」：用工坊的接口、用自己的模型接口、DeepSeek 官方、ChatGPT 订阅',
    price: {
      summary: '开源版免费，积分按量扣',
      p: '开源版全功能免费，没有付费墙。积分 1 积分 = ¥1，注册送 5 积分，充值的积分永不过期。跨网连同事的团队通道按人数月付；本机和同一局域网里互联不收费。',
      link: '看完整价目 →',
    },
  },
  // 10-23 Luoye：很多海外网站 DeepSeek 自带的搜索检索不到，所以做了自己的搜索；浏览器三种方案
  web: {
    eyebrow: '上网与浏览器',
    title: '海外的内容，搜得到，也打得开。',
    sub: '很多海外网站的内容，DeepSeek 自带的搜索检索不到，出海品牌要重点看的那些站尤其如此。所以工坊做了自己的一套：搜索走我们自己的数据接口，查得到 Google / Bing 的海外结果；要登录、要点按钮的页面，交给浏览器去开。',
    guide: '看教程 →',
    items: [
      {
        h: '自研浏览器插件',
        p: 'Reddit 发帖、红人数据收集，用你已登录的账号',
        more: 'Agents 工坊助手是我们自己的 Chrome 插件。Reddit 回帖在你开着的帖子里就地填好，发送你自己点；红人主页一键进库。',
        help: 'browser-extension',
      },
      {
        h: '腾讯开源 BrowserSkill',
        p: '用你日常的 Chrome / Edge 做自动化操作',
        more: 'AI 在单独的窗口里操作，你登录过的网站直接能看；要动你已经开着的标签，先问你。本机小程序一键装好，版本和校验码都钉死。',
        help: 'browser',
      },
      {
        h: '适配 ego lite',
        p: '专为 AI 自动化设计的浏览器',
        more: '装了 ego lite，就能在设置里选它当 AI 的浏览器，运行记录里看得到每一段操作。',
        help: 'browser',
      },
    ],
  },
  // 10-23：本地优先 + 三种用法 + 别处收费合成一段；后两样收进点开
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
        p: '只传必要的；匿名使用记录可关。',
        hint: '开了云端服务或跑长程任务时才上云：只传需要的那部分，加密存放，随时导出、随时删除。另外会发匿名的使用记录，不带店铺、客户、订单的任何内容；设置 → 数据与隐私里一键关。',
      },
      { icon: 'pause', h: '模型断了就停', p: 'AI 连不上时整条线冻结，不瞎发。' },
    ],
    usage: [
      '匿名使用记录发什么',
      '用了哪个功能、点了哪个按钮，不带店铺、客户、订单的任何内容。测试期间默认开，设置 → 数据与隐私里一键关。',
    ],
  },
  // WP347：三种用法，按 docs/95 里真做到的写（WP271 / 275–278 / 284）；10-23 起收进「本地优先」那段点开
  modes: {
    summary: '一个人、团队、整个公司都能用',
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
        p: '各管各的岗位，谁也不批谁。活能交给同事，对方接下才算；你的助理替你答同事、约时间。不在一个网络里的同事，开团队通道连上（按人数月付）。',
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
  free: {
    summary: '付费墙后面的东西，都在开源版里',
    sub: '自己用不按席位，不按连接数，没有企业版。',
    head: ['你要的', '别处常见的收法', 'Agents 工坊'],
    rows: [
      ['客服 AI', '按席位月付', '免费，用你自己的 key'],
      ['连店铺、邮箱、社媒', '按连接数收费', '免费，账号是你自己的'],
      ['浏览器插件（红人、Reddit、广告）', '按条、按次', '免费'],
      ['审批流、带权限的知识库', '企业版才有', '免费'],
      ['多店铺、多品牌', '加钱升级', '免费'],
    ],
    fine: '「别处」指市面上常见的收费方式，不特指某一家；以各家官方信息为准。跨网连同事的团队通道走我们的服务器，按人数月付；本机和同一局域网里互联不收费。',
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
      [
        '2026-10-19',
        '版本号跟官方',
        '工坊的版本号跟着 DeepSeek Harness 走：官方 0.2.1，我们也是 0.2.1。',
      ],
    ],
    oss: ['开源 Apache-2.0。', '代码全部公开，可以 fork，没有付费墙。'],
    star: 'Star on GitHub',
    arch: '读架构',
    term: ['每次提交，先让一家虚拟公司跑一遍', '六条底线全过 · 合并门禁：通过'],
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
        '开源版全功能免费，没有付费墙。积分是给想省事的人：不想自己去各家开账号、填 key，就用我们的，价格和 DeepSeek 官方一样。',
      ],
      [
        '能用我自己的 DeepSeek、ChatGPT 吗？',
        '能。DeepSeek 账号、ChatGPT 订阅直接登录，或者填你自己的 API key，直连各家、不经过我们。',
      ],
      [
        '我的数据会传上去吗？',
        '默认全在你电脑上。只有你开了云端服务、或者用积分调模型时，才把那一次需要的内容发出去。测试期间还会发匿名的使用记录，不带生意内容，设置里能关。',
      ],
      [
        '每天要盯几个地方？',
        '一个收件箱。所有岗位要你定的都排在那里，一张一张过就行。自己的待办在「日历与待办」。',
      ],
      ['AI 会不会自己乱发、乱退款？', '不会。对外发送、退款、改价都先出卡，你点了才办。'],
      [
        '用着有问题找谁？',
        '点左下角「反馈」，能附截图，我们的回复会出现在铃铛里。也可以在 GitHub 开 issue。',
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
    title:
      'Agents Workshop · AI agents built for cross-border e-commerce sellers, a team that works on its own',
    description:
      'AI agents built for cross-border e-commerce sellers: a proactive team of AI agents. Support, creators, Reddit, ads, site building and B2B, organised by role. They check in every day, draft and follow up on their own; only what needs your call lands in your inbox. Sign in with your DeepSeek account or ChatGPT plan. Open source and free, for Mac and Windows.',
  },
  hero: {
    pill: 'Open source · Apache-2.0 · Runs on your own computer',
    title: ['A *proactive*', 'AI agent team', 'that finds the work.'],
    position: 'AI agents built for cross-border e-commerce sellers.',
    lede: 'Support, creators, Reddit, ads, site building and B2B, organised by role. They check in every day, draft and follow up on their own; only what needs your call lands in your inbox.',
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
      'Sign in with your DeepSeek account or ChatGPT plan',
    ],
    frameBar: 'Home',
    shotAlt: 'The Workshop home: what’s waiting for you today, key numbers, and every role',
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
  tour: {
    eyebrow: 'A day with it',
    title: 'Everything that needs you, in one inbox.',
    sub: 'Open the Workshop, go through the inbox, then today’s to-dos. The roles work in the background and only call you when it matters.',
    prev: 'Previous',
    next: 'Next',
    slides: [
      {
        key: 'inbox',
        tab: 'Inbox',
        alt: 'The inbox: everything waiting for you in one queue, with a follow-up draft open on the right',
        p: 'Cards from every role and the emails only you can decide on, in one queue. Scan the list or go one at a time from the keyboard. Approved the wrong one? Undo it.',
      },
      {
        key: 'calendar',
        tab: 'Calendar & to-dos',
        alt: 'Week view: the AI found free slots for three unscheduled to-dos, shown as dashed blocks waiting for you to accept',
        p: 'Type “shoot product samples Friday afternoon” and it’s on the list. For anything without a date, the AI finds a slot around your working hours; nothing moves until you accept.',
      },
      {
        key: 'role',
        tab: 'Roles',
        alt: 'The Customer Care page: a policy card waiting for you on top, chats, reports, plans and connections in a column on the right',
        p: 'Each role has a page: what needs you on top, chats, reports, plans and connections on the right, and a box at the bottom to hand it work.',
      },
      {
        key: 'answer',
        tab: 'Answers as charts',
        alt: 'Web Ops: asked “how did the store do this week”, it answers with stat cards, a bar chart and a table',
        p: 'Ask “how did the store do this week” and get stat cards, a bar chart and a table. If a number can’t be read, it says what’s missing.',
      },
      {
        key: 'home',
        tab: 'Home',
        alt: 'The Workshop home: greeting, inbox and to-do line, key numbers, every role',
        p: 'How many things wait for you, today’s to-dos, yesterday’s sales, and what each role is doing. One box at the bottom for anything else.',
      },
    ],
  },
  roles: {
    eyebrow: 'Hire by role',
    title: 'Short on people? Add a role.',
    sub: 'Pick the roles you need. Each one owns its lane and keeps its own memory.',
    more: 'Need something else? Create your own role.',
    moreLink: 'See what each role does →',
    newBadge: 'New',
  },
  how: {
    eyebrow: 'How it works',
    title: 'Tell it in a few sentences. It sets itself up.',
    sub: 'No admin panels to learn, no workflows to draw. Click a line for details.',
    guide: 'Read the guide →',
    groups: [
      {
        key: 'setup',
        label: 'Connect & set up',
        items: [
          {
            h: 'Connect your platforms in one click',
            p: 'Uses your browser logins; no developer apps',
            more: 'Shopify, Amazon, Google / Meta Ads, Reddit…: through the accounts already signed in to in your browser, or one click to authorize. No terminal, no developer keys.',
            help: 'conn-shopify',
          },
          {
            h: 'Fills gaps on the spot',
            p: 'Missing a connection or setting? A card pops up in the chat',
            more: 'Fill it in on the card and the work carries on. No hunting through settings.',
            help: '',
          },
          {
            h: 'Say it, and it’s set up',
            p: 'A weekly report, logging to your own spreadsheet',
            more: 'Tell it what you want and it configures itself. No waiting for us to ship a feature.',
            help: '',
          },
        ],
      },
      {
        key: 'mail',
        label: 'Email & replies',
        items: [
          {
            h: 'Inbox rules in one sentence',
            p: 'Tried on the last 30 days of mail first',
            more: 'Say “tag payout notices, log them to the sheet, don’t bother me”. You see the trial run and the rule only goes live when you click Create.',
            help: 'conn-email',
          },
          {
            h: 'It remembers who hasn’t replied',
            p: 'No reply in 3 working days? A follow-up card',
            more: 'The nudge is already drafted. If they named a date, it waits until then. Once they reply, the card disappears.',
            help: '',
          },
          {
            h: 'Reddit replies filled in by the extension',
            p: 'You press send',
            more: 'Drafts go to the browser extension. Click Fill and it fills the reply into the thread you already have open. Replies you post yourself are logged too.',
            help: 'browser-extension',
          },
        ],
      },
      {
        key: 'plan',
        label: 'Schedule',
        items: [
          {
            h: 'AI finds free slots',
            p: 'Around your hours; nothing moves until you accept',
            more: 'Set your working hours, weekends, buffers around live streams and lunch once. Unfinished to-dos from last week roll into this week.',
            help: '',
          },
          {
            h: 'Shows up on schedule',
            p: 'Daily checks, weekly reports',
            more: 'Right on time. The weekly report lands Monday afternoon by default; tell it if you want another time.',
            help: '',
          },
        ],
      },
      {
        key: 'data',
        label: 'Data & search',
        items: [
          {
            h: 'Answers come as charts',
            p: 'Stat cards, charts and tables',
            more: 'Reports open with three lines of conclusions, then the numbers and a trend chart. Numbers it can’t read are marked with the missing connection.',
            help: '',
          },
          {
            h: 'Weekly SEO & GEO health check',
            p: 'Every Monday',
            more: 'Indexing, canonicals, redirects and broken links, sitemaps, hreflang, structured data and speed. Fixes go straight to the Site Building role.',
            help: 'site-health',
          },
          {
            h: 'What AI says about your category',
            p: 'Do ChatGPT and Perplexity mention you?',
            more: 'Wrong names, prices and selling points go on a list. After a fix it re-checks on a set date and compares before and after.',
            help: 'ai-answer-tracking',
          },
        ],
      },
      {
        key: 'calm',
        label: 'Peace of mind',
        items: [
          {
            h: 'Alerts in the bell',
            p: 'Urgent ones in red, at the top',
            more: 'One click takes you to the role or task it’s about.',
            help: '',
          },
          {
            h: 'Feedback, bottom left',
            p: 'Attach a screenshot; replies arrive in the bell',
            more: 'Works without signing in. Diagnostics are scrubbed first, and you see them before they’re sent.',
            help: '',
          },
          {
            h: 'Everything on record',
            p: 'Who approved what, and what changed',
            more: 'Every message sent is logged on your computer.',
            help: 'sent-log',
          },
        ],
      },
    ],
  },
  cards: {
    eyebrow: 'Cards, not surprises',
    title: 'AI proposes. You decide. Always.',
    sub: 'Anything that goes out, costs money or changes something becomes a card first.',
    steps: [
      ['Hand it a task', 'One sentence, to one role'],
      ['The role does the work', 'Checks orders, policies, drafts'],
      ['A card lands in your inbox', 'With reasons and sources'],
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
        body: '20,000 mAh is about 74 Wh, under the 100 Wh limit. The draft goes to the browser extension, which fills it into the thread you have open; you press send.',
        actions: ['Fill', 'Edit', 'Drop'],
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
  ai: {
    eyebrow: 'Connect an AI',
    title: 'Sign in with your DeepSeek account or ChatGPT plan.',
    sub: 'Already paying for one? Use it. No second subscription.',
    options: [
      {
        h: 'DeepSeek account',
        p: 'Sign in with your own DeepSeek account; usage comes out of its balance',
        help: 'model-deepseek',
        own: true,
      },
      {
        h: 'ChatGPT plan',
        p: 'Use the ChatGPT subscription you already pay for',
        help: 'model-openai',
        own: true,
      },
      {
        h: 'Your own API key',
        p: 'DeepSeek, OpenAI, Anthropic, Google, Bailian…: direct, never through us',
        help: 'model-openai-compatible',
        own: true,
      },
      {
        h: 'Workshop credits',
        p: 'Same price as DeepSeek’s official rates, no sign-ups elsewhere',
        help: 'agentsws-credits',
        own: false,
      },
    ],
    frameBar: 'Setup · Connect an AI',
    shotAlt:
      'First setup step, Connect an AI: Workshop API, your own model API, DeepSeek official, ChatGPT plan',
    price: {
      summary: 'Open source is free; credits are pay as you go',
      p: 'The open-source edition is complete and free, with no paywall. 1 credit = ¥1, 5 free credits when you sign up, and purchased credits never expire. The team channel for colleagues on other networks is billed monthly by headcount; connecting on the same computer or local network is free.',
      link: 'Full pricing →',
    },
  },
  web: {
    eyebrow: 'Web & browsers',
    title: 'Overseas content: found, and opened.',
    sub: 'A lot of overseas sites can’t be reached through DeepSeek’s built-in search, including many of the ones that matter most to brands selling abroad. So the Workshop has its own: search runs through our own data service and returns Google / Bing results from overseas; pages that need a login or a click are opened in a browser.',
    guide: 'Read the guide →',
    items: [
      {
        h: 'Our own browser extension',
        p: 'Reddit posting and creator research, with your own logins',
        more: 'Agents Workshop Assistant is our own Chrome extension. It fills Reddit replies into the thread you have open, and you press send; creator profiles go into your list in one click.',
        help: 'browser-extension',
      },
      {
        h: 'Tencent’s open-source BrowserSkill',
        p: 'Automation in the Chrome or Edge you use every day',
        more: 'The AI works in a separate window and can see the sites you’re signed in to; it asks before touching tabs you already have open. A small local helper installs in one click, pinned to a fixed version and checksum.',
        help: 'browser',
      },
      {
        h: 'Tuned for ego lite',
        p: 'A browser built for AI automation',
        more: 'If you have ego lite installed, pick it as the AI’s browser in Settings; every step it runs shows up in the run log.',
        help: 'browser',
      },
    ],
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
        p: 'Only what’s needed; anonymous usage stats can be turned off.',
        hint: 'Data only goes to the cloud when you turn on a cloud service or run a long task there: just the part that’s needed, encrypted, exportable and deletable at any time. Anonymous usage stats are also sent, with nothing about your store, customers or orders; turn them off in Settings → Data & privacy.',
      },
      {
        icon: 'pause',
        h: 'Model down? Everything stops',
        p: 'No half-baked sends when the AI can’t be reached.',
      },
    ],
    usage: [
      'What do the anonymous usage stats include?',
      'Which features were used and which buttons were clicked, with nothing about your store, customers or orders. On by default during the beta; one switch in Settings → Data & privacy turns them off.',
    ],
  },
  modes: {
    summary: 'For one person, a team, or the whole company',
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
        p: 'Everyone runs their own roles and nobody signs off on anybody. Hand work to a colleague; it’s theirs once they accept. Your assistant answers colleagues and books time for you. Colleagues on another network connect through the team channel, billed by headcount.',
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
  free: {
    summary: 'Everything behind other people’s paywalls is in the open-source edition',
    sub: 'No per-seat pricing for your own use. No per-connection pricing. No enterprise tier.',
    head: ['What you need', 'Common pricing elsewhere', 'Agents Workshop'],
    rows: [
      ['Support AI', 'Per seat, per month', 'Free, with your own key'],
      ['Connect store, email, social', 'Per connection', 'Free, your own accounts'],
      ['Browser extension (creators, Reddit, ads)', 'Per record, per call', 'Free'],
      ['Approvals, permissioned knowledge base', 'Enterprise tier only', 'Free'],
      ['Multiple stores and brands', 'Paid upgrade', 'Free'],
    ],
    fine: '"Elsewhere" describes common pricing models, not any specific company. Check each vendor’s official pricing. The team channel for colleagues on other networks runs through our servers and is billed monthly by headcount; same computer or local network is free.',
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
      [
        '2026-10-19',
        'Same version as upstream',
        'Our version number follows DeepSeek Harness: upstream is on 0.2.1, so are we.',
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
        'The open-source edition is complete and free, with no paywall. Credits are for people who want it easy: no accounts to open elsewhere, no keys to paste, at the same price as DeepSeek’s official rates.',
      ],
      [
        'Can I use my own DeepSeek or ChatGPT?',
        'Yes. Sign in with your DeepSeek account or ChatGPT plan, or paste your own API key; it connects directly, never through us.',
      ],
      [
        'Does my data leave my computer?',
        'By default, everything stays on your computer. Only when you turn on a cloud service, or use credits to call a model, does the content needed for that one request go out. During the beta it also sends anonymous usage stats with no business content; you can turn them off in Settings.',
      ],
      [
        'How many places do I need to check each day?',
        'One inbox. Everything any role needs from you waits there; go through it one card at a time. Your own to-dos live in Calendar & to-dos.',
      ],
      [
        'Can the AI send or refund on its own?',
        'No. Sending anything out, refunds and price changes all become cards first. Nothing happens until you click.',
      ],
      [
        'Who do I ask when something’s wrong?',
        'Click Feedback in the bottom-left corner and attach a screenshot; our reply shows up in the bell. You can also open an issue on GitHub.',
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

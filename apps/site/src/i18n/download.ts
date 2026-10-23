/**
 * 下载页文案。版本、链接、sha256、大小全从 `src/data/downloads.json` 读，这里不写。
 */
import type { Lang } from './common.js'

const zh = {
  meta: {
    title: '下载 · Agents 工坊',
    description:
      '下载 Agents 工坊桌面版（macOS / Windows）与浏览器插件。双击就装，不用 Node、Docker、数据库。',
  },
  eyebrow: '下载',
  title: '下载 Agents 工坊',
  sub: '双击就装。不用 Node，不用 Docker，不用数据库。',
  primary: {
    'mac-arm64': '下载 macOS 版（M 系列芯片）',
    'win-x64': '下载 Windows 版',
  },
  /** WP326：认出是 Intel Mac 时首屏按钮下面那一句。 */
  intelMac: '目前只支持 M 系列芯片的 Mac',
  soon: '即将提供',
  soonHint: '安装包的下载地址还没定，内测期间先从 GitHub 获取或从源码跑。',
  beta: '内测版',
  changelog: '更新日志',
  others: '其他版本 ↓',
  frameBar: '初始化设置 · 接上 AI',
  shotAlt:
    '初始化设置第一步「接上 AI」：用工坊的接口、用自己的模型接口、DeepSeek 官方、ChatGPT 订阅',
  osTitle: '选你的电脑',
  os: {
    'mac-arm64': { h: 'macOS · M 系列芯片', p: 'M1 及以后', btn: '下载 .dmg' },
    'win-x64': { h: 'Windows · x64', p: '64 位 Windows', btn: '下载 .exe' },
  },
  firstOpen: {
    mac: '第一次打开：隐私与安全性 → 仍要打开',
    macHint:
      '还没做苹果公证，第一次双击系统会说「无法验证开发者」。点「完成」，打开「系统设置 → 隐私与安全性」，往下找到 agentsws 点「仍要打开」，以后就不再问。',
    win: '蓝框提示：更多信息 → 仍要运行',
    winHint: '还没买代码签名证书，Windows 会先拦一下；文件本身没问题。签名做完这一步就没了。',
  },
  macNote: {
    h: 'Mac 第一次打开',
    why: '我们还在办苹果开发者签名和公证，办好之前第一次打开要你点一下放行，只需一次。',
    steps: [
      '双击 .dmg，把 agentsws 拖进「应用程序」，再双击打开。',
      '系统提示「无法验证开发者」时，点「完成」。',
      '打开「系统设置 → 隐私与安全性」，往下找到 agentsws，点「仍要打开」。',
    ],
    old: '0.2.0-beta.8 及更早的版本可能提示「已损坏，请移到垃圾箱」：重新下载上面的最新版即可。',
    more: '图文步骤',
  },
  sha: '校验值（SHA-256）',
  size: '大小',
  safe: '升级前自动备份。升级没成功，数据一个字节都不动。',
  next: {
    eyebrow: '装好之后',
    title: '四步开工，十分钟左右。',
    steps: [
      ['接上 AI', 'DeepSeek 账号、ChatGPT 订阅、自己的 key，或积分'],
      ['你的生意', '贴官网，自动填好品牌档案'],
      ['选岗位', '勾几个，职责自动配好'],
      ['连接与开工', '连店铺和邮箱，交第一件事'],
    ],
    stuck: '卡在哪一步？',
    docs: '看教程 →',
  },
  more: {
    title: '还有这些',
    ext: {
      h: '浏览器插件 · Agents 工坊助手',
      p: '红人一键进库；Reddit、Google / Meta 广告借你已登录的账号干活。只连你这台电脑。',
      btn: '下载插件包（.zip）',
      how: '怎么装',
    },
    dev: {
      h: '开发者 · 从源码跑',
      p: 'Node 22 + pnpm。不用任何账号，先跑一家虚拟公司看看。',
    },
    linux: 'Linux 暂时没有安装包，可以用源码跑。',
  },
}

export type DownloadCopy = typeof zh

const en: DownloadCopy = {
  meta: {
    title: 'Download · Agents Workshop',
    description:
      'Download Agents Workshop for macOS and Windows, plus the browser extension. Double-click to install — no Node, no Docker, no database.',
  },
  eyebrow: 'Download',
  title: 'Download Agents Workshop',
  sub: 'Double-click to install. No Node, no Docker, no database.',
  primary: {
    'mac-arm64': 'Download for macOS · Apple silicon (M-series)',
    'win-x64': 'Download for Windows',
  },
  intelMac: 'Only Macs with Apple silicon (M-series) are supported for now',
  soon: 'Coming soon',
  soonHint:
    'The download location isn’t set yet. During the beta, get builds from GitHub or run from source.',
  beta: 'beta',
  changelog: 'Changelog',
  others: 'Other versions ↓',
  frameBar: 'Setup · Connect an AI',
  shotAlt:
    'First setup step, Connect an AI: Workshop API, your own model API, DeepSeek official, ChatGPT plan',
  osTitle: 'Pick your computer',
  os: {
    'mac-arm64': {
      h: 'macOS · Apple silicon (M-series)',
      p: 'M1 and later',
      btn: 'Download .dmg',
    },
    'win-x64': { h: 'Windows · x64', p: '64-bit Windows', btn: 'Download .exe' },
  },
  firstOpen: {
    mac: 'First launch: Privacy & Security → Open Anyway',
    macHint:
      'The app isn’t notarized by Apple yet, so the first double-click says macOS can’t verify the developer. Click Done, open System Settings → Privacy & Security, scroll to agentsws and click Open Anyway. It won’t ask again.',
    win: 'Blue warning: More info → Run anyway',
    winHint:
      'We haven’t bought a code-signing certificate yet, so Windows asks first. The file itself is fine; this step goes away once it’s signed.',
  },
  macNote: {
    h: 'Opening on a Mac the first time',
    why: 'We’re still getting Apple’s developer signing and notarization done. Until then, macOS asks you to allow the app once.',
    steps: [
      'Open the .dmg, drag agentsws into Applications, then double-click it.',
      'When macOS says it can’t verify the developer, click Done.',
      'Open System Settings → Privacy & Security, scroll to agentsws and click Open Anyway.',
    ],
    old: '0.2.0-beta.8 and earlier may say the app “is damaged”: just download the latest build above.',
    more: 'Step-by-step guide',
  },
  sha: 'Checksum (SHA-256)',
  size: 'Size',
  safe: 'Every upgrade backs up first. If an upgrade fails, not a byte of your data is touched.',
  next: {
    eyebrow: 'After installing',
    title: 'Four steps, about ten minutes.',
    steps: [
      ['Connect an AI', 'Your DeepSeek account, ChatGPT plan, own key, or credits'],
      ['Your business', 'Paste your website; the brand profile fills itself'],
      ['Pick roles', 'Tick a few; duties are set up for you'],
      ['Connect and start', 'Link your store and email, hand over the first task'],
    ],
    stuck: 'Stuck somewhere?',
    docs: 'Read the guides →',
  },
  more: {
    title: 'Also available',
    ext: {
      h: 'Browser extension · Agents Workshop assistant',
      p: 'Save creators in one click; work in Reddit and Google / Meta Ads through the accounts you’re signed in to. Talks only to this computer.',
      btn: 'Download the extension (.zip)',
      how: 'How to install',
    },
    dev: {
      h: 'Developers · run from source',
      p: 'Node 22 + pnpm. No account needed — run a simulated company first.',
    },
    linux: 'No Linux installer yet — run from source.',
  },
}

export const DOWNLOAD: Record<Lang, DownloadCopy> = { zh, en }

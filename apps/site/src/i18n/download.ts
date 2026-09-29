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
    'mac-arm64': '下载 macOS 版（Apple 芯片）',
    'mac-x64': '下载 macOS 版（Intel）',
    'win-x64': '下载 Windows 版',
  },
  soon: '即将提供',
  soonHint: '安装包的下载地址还没定，内测期间先从 GitHub 获取或从源码跑。',
  beta: '内测版',
  changelog: '更新日志',
  others: '其他版本 ↓',
  frameBar: '初始化设置 · 选岗位',
  shotAlt: '初始化设置第三步：勾选要上岗的岗位',
  osTitle: '选你的电脑',
  os: {
    'mac-arm64': { h: 'macOS · Apple 芯片', p: 'M 系列芯片', btn: '下载 .dmg' },
    'mac-x64': { h: 'macOS · Intel', p: 'Intel 处理器', btn: '下载 .dmg' },
    'win-x64': { h: 'Windows · x64', p: '64 位 Windows', btn: '下载 .exe' },
  },
  firstOpen: {
    mac: '第一次打开：右键 → 打开',
    macHint:
      '我们还没做苹果签名，直接双击会被系统拦下。右键点图标选「打开」，再点一次「打开」就好。',
    win: '蓝框提示：更多信息 → 仍要运行',
    winHint: '还没买代码签名证书，Windows 会先拦一下；文件本身没问题。签名做完这一步就没了。',
  },
  sha: '校验值（SHA-256）',
  size: '大小',
  safe: '升级前自动备份。升级没成功，数据一个字节都不动。',
  next: {
    eyebrow: '装好之后',
    title: '四步开工，十分钟左右。',
    steps: [
      ['接上 AI', '用自己的 key，或用积分'],
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
      h: '浏览器插件 · 红人助手',
      p: '在 YouTube、Instagram、TikTok 主页上点一下，红人就进你的库。只连你这台电脑。',
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
    'mac-arm64': 'Download for macOS (Apple silicon)',
    'mac-x64': 'Download for macOS (Intel)',
    'win-x64': 'Download for Windows',
  },
  soon: 'Coming soon',
  soonHint:
    'The download location isn’t set yet. During the beta, get builds from GitHub or run from source.',
  beta: 'beta',
  changelog: 'Changelog',
  others: 'Other versions ↓',
  frameBar: 'Setup · Pick your roles',
  shotAlt: 'Setup, step three: tick the roles you want to start with',
  osTitle: 'Pick your computer',
  os: {
    'mac-arm64': { h: 'macOS · Apple silicon', p: 'M-series chips', btn: 'Download .dmg' },
    'mac-x64': { h: 'macOS · Intel', p: 'Intel processors', btn: 'Download .dmg' },
    'win-x64': { h: 'Windows · x64', p: '64-bit Windows', btn: 'Download .exe' },
  },
  firstOpen: {
    mac: 'First launch: right-click → Open',
    macHint:
      'The app isn’t notarized by Apple yet, so a double-click gets blocked. Right-click the icon, choose Open, then Open again.',
    win: 'Blue warning: More info → Run anyway',
    winHint:
      'We haven’t bought a code-signing certificate yet, so Windows asks first. The file itself is fine; this step goes away once it’s signed.',
  },
  sha: 'Checksum (SHA-256)',
  size: 'Size',
  safe: 'Every upgrade backs up first. If an upgrade fails, not a byte of your data is touched.',
  next: {
    eyebrow: 'After installing',
    title: 'Four steps, about ten minutes.',
    steps: [
      ['Connect an AI', 'Your own key, or credits'],
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
      h: 'Browser extension · Creator helper',
      p: 'One click on a YouTube, Instagram or TikTok profile and the creator lands in your list. Talks only to this computer.',
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

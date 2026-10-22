/**
 * WP413：侧边栏用的几个小图标（内联 SVG，`currentColor`；不引图标库——插件包要小、不远程加载任何东西）。
 * 形状照工作台用的 lucide 那几个画（勾 / 钟 / 叹号 / 叉 / 外链 / 齿轮 / 收件箱 / 笔 / 提示 / 箭头）；笔画 1.75（WP456 §2.6 第 12 条）。
 */
type P = { className?: string }

const Svg = (props: P & { children: React.ReactNode }): React.ReactNode => (
  <svg
    className={props.className ?? 'ws-ico'}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.75"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    {props.children}
  </svg>
)

export const IconCheck = (p: P): React.ReactNode => (
  <Svg {...p}>
    <path d="M20 6 9 17l-5-5" />
  </Svg>
)

export const IconClock = (p: P): React.ReactNode => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3 2" />
  </Svg>
)

export const IconAlert = (p: P): React.ReactNode => (
  <Svg {...p}>
    <path d="M12 3 2 20h20L12 3z" />
    <path d="M12 10v4M12 17h.01" />
  </Svg>
)

export const IconX = (p: P): React.ReactNode => (
  <Svg {...p}>
    <path d="M18 6 6 18M6 6l12 12" />
  </Svg>
)

export const IconMinus = (p: P): React.ReactNode => (
  <Svg {...p}>
    <path d="M6 12h12" />
  </Svg>
)

export const IconExternal = (p: P): React.ReactNode => (
  <Svg {...p}>
    <path d="M14 4h6v6M20 4l-9 9" />
    <path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
  </Svg>
)

export const IconGear = (p: P): React.ReactNode => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
  </Svg>
)

export const IconInbox = (p: P): React.ReactNode => (
  <Svg {...p}>
    <path d="M22 12h-6l-2 3h-4l-2-3H2" />
    <path d="M5.5 5.1 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.5-6.9A2 2 0 0 0 16.7 4H7.3a2 2 0 0 0-1.8 1.1z" />
  </Svg>
)

export const IconPen = (p: P): React.ReactNode => (
  <Svg {...p}>
    <path d="M12 20h9" />
    <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" />
  </Svg>
)

/** WP456-T7：一行提醒里的「提示」图标。 */
export const IconInfo = (p: P): React.ReactNode => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 16v-4M12 8h.01" />
  </Svg>
)

/** WP456-T7：整行可点时右边那个「›」。 */
export const IconRight = (p: P): React.ReactNode => (
  <Svg {...p}>
    <path d="m9 18 6-6-6-6" />
  </Svg>
)

/** WP456-T7：展开的那一张卡头右边的「⌄」（点了收起）。 */
export const IconUp = (p: P): React.ReactNode => (
  <Svg {...p}>
    <path d="m18 15-6-6-6 6" />
  </Svg>
)

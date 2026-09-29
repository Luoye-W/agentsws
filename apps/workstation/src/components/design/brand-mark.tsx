/**
 * 母品牌「出海Agents工坊」的标记 —— **一个组件、四种姿态**（WP112）。
 *
 * 几何与颜色的真源是母品牌规范（见 `brand-mark.geometry.ts` 抬头），这里只负责把
 * 它画出来、并按规范动起来。**纯内联 SVG + CSS keyframes**：零新依赖，
 * 没有 mp4 / gif / lottie，动效关掉之后剩下的就是那张静态标记。
 *
 * 四种姿态各代表一件事，全站不混用（docs/36 §12 写着哪种用在哪）：
 *
 * | motion | 说的是 | 用在哪 |
 * |---|---|---|
 * | `none` | 就是这个牌子 | 小图标（单色）、桌面托盘、README |
 * | `assemble` | 这套东西正在起来 | 冷启动首屏、初始化设置第一屏 |
 * | `breathe` | **Agent 正在替你干活** | 对话线程、岗位卡运行点、正在进行 |
 * | `split` | 一个活做通了，复制成一队 | 设置完成屏、新岗位上岗回执 |
 * | `idle` | 这个牌子是活的（WP195） | 左栏顶部、登录页、账号卡、随便聊空态 |
 *
 * `idle` 待机是 WP195 加的第五种（Luoye 09-29「静态的 logo 其实不好看」）：给一直挂在
 * 屏幕上的标记用，一轮 ≥ 6 秒、大部分时间一动不动、只动 transform，三个候选
 * （`idleStyle` = 波 / 流光 / 眨眼）。单色那一档不挂待机；页面不在前台时暂停；
 * `playOnHover` 让鼠标移上去时播一次一变一队再回原姿态。
 *
 * 三条硬规矩，全部来自规范：
 *
 * 1. **静态一条 `userSpaceOnUse` 渐变铺满整个标记，方块把它切开**（§1.2）；
 *    **动效每块自己一条 `objectBoundingBox` 渐变**（§3.0）——块飞出去的时候
 *    渐变要跟着块走，固定在坐标系上会闪。
 * 2. **小于 28px 一律退单色**（§1.3）：再小方块间的缝会并起来，渐变只剩一团糊。
 *    单色走 `currentColor`，颜色由摆它的地方说了算。
 * 3. **`prefers-reduced-motion: reduce` 时一律静态**：一个 animation 类都不挂。
 *    设置里「界面动效」选了「开」或「关」时以那一项为准（`motion-pref.ts`）。
 *
 * SVG 里对 `<rect>` 做 transform 必须写 `transform-box: fill-box` +
 * `transform-origin: center`（§4.1 坑 1），这两句在 `index.css` 的基类里。
 */
import {
  type CSSProperties,
  type ReactNode,
  useEffect,
  useId,
  useState,
  useSyncExternalStore,
} from 'react'
import {
  ALL_BLOCKS,
  ASSEMBLE_DELAYS_MS,
  BLOCK_RADIUS,
  BLOCK_SIZE,
  BLOCKS,
  BREATHE_PHASE_MS,
  DEFAULT_IDLE_STYLE,
  GRADIENT_AXIS,
  IDLE_BAND_CLASS,
  IDLE_CLASS,
  IDLE_SHEEN,
  IDLE_START_MS,
  IDLE_WAVE_DELAYS_MS,
  IDLE_WAVE_SHEEN,
  IDLE_WAVE_SHEEN_DELAYS_MS,
  type IdleStyle,
  MARK_BOX,
  MIN_GRADIENT_PX,
  MOTION_CLASS,
  motionStopVars,
  PAUSED_CLASS,
  SPLIT_FIRST_DELAY_MS,
  SPLIT_OFFSETS,
  SPLIT_STEP_MS,
  SPLIT_TOTAL_MS,
  STATIC_STOP_VARS,
  STOPS_ON_DARK,
  VIEW_BOX,
} from './brand-mark.geometry'
import { useMotionPref } from './motion-pref'

/** 亮带颜色（明暗两套定义在 `index.css` 的 `:root` / `.dark`）。 */
const SHEEN_COLOR = 'var(--ws-brand-sheen)'

export type BrandMarkVariant = 'gradient' | 'mono'
export type BrandMarkMotion = 'none' | 'assemble' | 'breathe' | 'split' | 'idle'
export type BrandMarkIdleStyle = IdleStyle

const REDUCE_QUERY = '(prefers-reduced-motion: reduce)'

function subscribe(onChange: () => void): () => void {
  const mql = globalThis.matchMedia?.(REDUCE_QUERY)
  if (mql === undefined) return () => undefined
  mql.addEventListener('change', onChange)
  return () => {
    mql.removeEventListener('change', onChange)
  }
}

/**
 * 系统里"少一点动效"那个开关。
 *
 * 读不到（jsdom / 老浏览器）按"没开"算——默认播动效，而不是默认一动不动：
 * 这个开关是**人明确表达过**的偏好，读不到不等于表达过。
 */
export function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => globalThis.matchMedia?.(REDUCE_QUERY).matches ?? false,
    () => false,
  )
}

/**
 * 这一刻标记该不该动：设置里「界面动效」选了开 / 关就听它的，「跟随系统」（默认）就看
 * 系统的「少一点动效」。
 */
export function useMotionAllowed(): boolean {
  const reduce = usePrefersReducedMotion()
  const pref = useMotionPref()
  if (pref === 'on') return true
  if (pref === 'off') return false
  return !reduce
}

function subscribeVisibility(onChange: () => void): () => void {
  const doc = globalThis.document
  if (doc === undefined) return () => undefined
  doc.addEventListener('visibilitychange', onChange)
  return () => {
    doc.removeEventListener('visibilitychange', onChange)
  }
}

/** 页面在不在前台。切走了（别的标签页、窗口最小化）动画就该停，省电。 */
export function usePageHidden(): boolean {
  return useSyncExternalStore(
    subscribeVisibility,
    () => globalThis.document?.hidden ?? false,
    () => false,
  )
}

/** 一块：位置、圆角、以及这一姿态给它的类名与延迟。 */
function Blk({
  x,
  y,
  fill,
  className,
  style,
}: {
  x: number
  y: number
  fill: string
  className?: string
  style?: CSSProperties
}): ReactNode {
  return (
    <rect
      x={x}
      y={y}
      width={BLOCK_SIZE}
      height={BLOCK_SIZE}
      rx={BLOCK_RADIUS}
      fill={fill}
      {...(className === undefined ? {} : { className })}
      {...(style === undefined ? {} : { style })}
    />
  )
}

export function BrandMark({
  size = 28,
  variant = 'gradient',
  motion = 'none',
  idleStyle = DEFAULT_IDLE_STYLE,
  playOnHover = false,
  className,
  label,
}: {
  /** 边长（px）。标记本身就是 65×65 的方外框，所以宽高相等。 */
  size?: number
  variant?: BrandMarkVariant
  motion?: BrandMarkMotion
  /** `motion="idle"` 时用哪一个候选（默认 `DEFAULT_IDLE_STYLE`）。 */
  idleStyle?: BrandMarkIdleStyle
  /** 鼠标移上去播一次一变一队（1.25s），播完回 `motion` 那一姿态。 */
  playOnHover?: boolean
  className?: string
  /**
   * 给了就是有意义的图形（`role="img"` + `<title>`）；不给就是装饰
   * （`aria-hidden`）——旁边已经有字的时候读屏再念一遍只是噪音。
   */
  label?: string
}): ReactNode {
  const uid = useId()
  const allowed = useMotionAllowed()
  const hidden = usePageHidden()
  const [hovering, setHovering] = useState(false)
  useEffect(() => {
    if (!hovering) return
    const id = setTimeout(() => {
      setHovering(false)
    }, SPLIT_TOTAL_MS)
    return () => {
      clearTimeout(id)
    }
  }, [hovering])
  // 规范 §1.3：小于 28px 一律退单色，无论调用方写的是 gradient 还是什么
  const mono = variant === 'mono' || size < MIN_GRADIENT_PX
  // 待机只给渐变那一档（MIN_IDLE_PX = MIN_GRADIENT_PX）：单色的小标记一动就是抖
  const wanted: BrandMarkMotion = hovering ? 'split' : motion === 'idle' && mono ? 'none' : motion
  const active: BrandMarkMotion = allowed ? wanted : 'none'
  const moving = active !== 'none'
  const sheen = active === 'idle' && idleStyle === 'sheen'
  // 波 + 流光：每块一个会抬起的 <g>（块 + 它自己那份亮带），延迟由亮带的位置算出来
  const waveSheen = active === 'idle' && idleStyle === 'wave-sheen' && !mono
  // 流光时方块自己不动，照静态那条规矩用一条整体渐变；其余动效每块自己一条（§3.0）
  const perBlock = moving && !sheen

  const staticId = `${uid}-mark`
  const blockId = (i: number): string => `${uid}-b${i}`

  // 静态：一条 userSpaceOnUse 渐变铺满整个标记（§1.2）
  const staticGradient = (
    <linearGradient
      id={staticId}
      gradientUnits="userSpaceOnUse"
      x1={GRADIENT_AXIS.x1}
      y1={GRADIENT_AXIS.y1}
      x2={GRADIENT_AXIS.x2}
      y2={GRADIENT_AXIS.y2}
    >
      {STOPS_ON_DARK.map((s, i) => (
        <stop
          key={s.offset}
          offset={`${s.offset * 100}%`}
          stopColor={`var(${STATIC_STOP_VARS[i]})`}
        />
      ))}
    </linearGradient>
  )

  // 动效：每块自己一条 objectBoundingBox 渐变，从块的左下到右上（§3.0）
  const motionGradients = ALL_BLOCKS.map((_, i) => {
    const v = motionStopVars(i)
    return (
      <linearGradient key={blockId(i)} id={blockId(i)} x1="0" y1="1" x2="1" y2="0">
        <stop offset="0%" stopColor={`var(${v.from})`} />
        <stop offset="100%" stopColor={`var(${v.to})`} />
      </linearGradient>
    )
  })

  const fillOf = (i: number): string =>
    mono ? 'currentColor' : `url(#${perBlock ? blockId(i) : staticId})`

  /** 第 i 块（0–4 是随从，5 是领头）在这一姿态下的类名与内联延迟。 */
  const poseOf = (i: number): { className?: string; style?: CSSProperties } => {
    if (!moving) return {}
    const lead = i === BLOCKS.length
    if (active === 'idle') {
      if (idleStyle === 'blink') return lead ? { className: IDLE_CLASS.blink } : {}
      if (idleStyle === 'sheen') return {}
      if (idleStyle === 'wave-sheen') return {} // 类挂在外面那个 <g> 上，见下面 body
      // 波：沿渐变方向错开，全体再往后推 IDLE_START_MS——一挂上就动像在抢注意力
      return {
        className: IDLE_CLASS.wave,
        style: { animationDelay: `${IDLE_START_MS + (IDLE_WAVE_DELAYS_MS[i] ?? 0)}ms` },
      }
    }
    if (active === 'assemble') {
      return lead
        ? { className: MOTION_CLASS.assemble.lead }
        : {
            className: MOTION_CLASS.assemble.block,
            style: { animationDelay: `${ASSEMBLE_DELAYS_MS[i] ?? 0}ms` },
          }
    }
    if (active === 'breathe') {
      // 负延迟：六块一上来就已经错开在各自的相位上，不会先齐刷刷停一下再依次起步
      return {
        className: MOTION_CLASS.breathe.block,
        style: { animationDelay: `-${i * BREATHE_PHASE_MS}ms` },
      }
    }
    // 一变一队：领头先出现，其余五块**从领头的位置**分出去（§3.3）
    if (lead) return { className: MOTION_CLASS.split.lead }
    const off = SPLIT_OFFSETS[i]
    return {
      className: MOTION_CLASS.split.block,
      style: {
        animationDelay: `${SPLIT_FIRST_DELAY_MS + i * SPLIT_STEP_MS}ms`,
        '--ws-bm-dx': `${off?.dx ?? 0}px`,
        '--ws-bm-dy': `${off?.dy ?? 0}px`,
      } as CSSProperties,
    }
  }

  // 流光：一层亮带，被六块裁出来，只动它的位置（标记本身一个像素的颜色都不改）。
  // 颜色走 `--ws-brand-sheen`、力度走亮带那层的 opacity（`--ws-brand-sheen-strength`）：
  // 深底纯白原样，浅底极淡的品牌青、力度减半（WP200，不然扫过时块会短暂发白）。
  const sheenId = `${uid}-sheen`
  const clipId = `${uid}-clip`
  const band = waveSheen ? IDLE_WAVE_SHEEN : IDLE_SHEEN
  const half = band.bandWidth / 2
  const bandGradient = (
    <linearGradient id={sheenId} x1="0" y1="1" x2="1" y2="0">
      <stop offset={`${(0.5 - half) * 100}%`} stopColor={SHEEN_COLOR} stopOpacity={0} />
      <stop offset="50%" stopColor={SHEEN_COLOR} stopOpacity={band.peakOpacity} />
      <stop offset={`${(0.5 + half) * 100}%`} stopColor={SHEEN_COLOR} stopOpacity={0} />
    </linearGradient>
  )
  const waveSheenDefs = waveSheen ? (
    <>
      {bandGradient}
      {ALL_BLOCKS.map((b, i) => (
        <clipPath key={`${b.x}-${b.y}`} id={`${clipId}${i}`}>
          <Blk x={b.x} y={b.y} fill="#000" />
        </clipPath>
      ))}
    </>
  ) : null
  const sheenDefs = sheen ? (
    <>
      {bandGradient}
      <clipPath id={clipId}>
        {ALL_BLOCKS.map((b) => (
          <Blk key={`${b.x}-${b.y}`} x={b.x} y={b.y} fill="#000" />
        ))}
      </clipPath>
    </>
  ) : null

  const body = (
    <>
      {mono ? null : (
        <defs>
          {perBlock ? motionGradients : staticGradient}
          {sheenDefs}
          {waveSheenDefs}
        </defs>
      )}
      {ALL_BLOCKS.map((b, i) =>
        waveSheen ? (
          <g
            key={`${b.x}-${b.y}`}
            className={IDLE_CLASS['wave-sheen']}
            style={{
              animationDelay: `${IDLE_START_MS + (IDLE_WAVE_SHEEN_DELAYS_MS[i] ?? 0)}ms`,
            }}
          >
            <Blk x={b.x} y={b.y} fill={fillOf(i)} />
            <g clipPath={`url(#${clipId}${i})`}>
              <rect
                x={MARK_BOX.x}
                y={MARK_BOX.y}
                width={MARK_BOX.width}
                height={MARK_BOX.height}
                fill={`url(#${sheenId})`}
                className={IDLE_BAND_CLASS}
              />
            </g>
          </g>
        ) : (
          <Blk key={`${b.x}-${b.y}`} x={b.x} y={b.y} fill={fillOf(i)} {...poseOf(i)} />
        ),
      )}
      {sheen && !mono ? (
        <g clipPath={`url(#${clipId})`} data-testid="brand-mark-sheen">
          <rect
            x={MARK_BOX.x}
            y={MARK_BOX.y}
            width={MARK_BOX.width}
            height={MARK_BOX.height}
            fill={`url(#${sheenId})`}
            className={IDLE_CLASS.sheen}
          />
        </g>
      ) : null}
    </>
  )
  const classes = [className, moving && hidden ? PAUSED_CLASS : undefined]
    .filter((c) => c !== undefined && c !== '')
    .join(' ')
  const shared = {
    xmlns: 'http://www.w3.org/2000/svg',
    viewBox: VIEW_BOX,
    width: size,
    height: size,
    fill: 'none',
    // WP195：viewBox 就是标记外框，待机时领头那块往上 / 右探出几个单位会被外框裁掉——
    // 让它画出框外（周围本来就留着安全区，§1.4）
    overflow: 'visible',
    'data-testid': 'brand-mark',
    'data-variant': mono ? 'mono' : 'gradient',
    'data-motion': active,
    ...(active === 'idle' ? { 'data-idle-style': idleStyle } : {}),
    ...(classes === '' ? {} : { className: classes }),
    ...(playOnHover && allowed && !hovering
      ? {
          onMouseEnter: () => {
            setHovering(true)
          },
        }
      : {}),
  } as const

  // 两条分支各写一个 `<svg>`，不把 aria 那几个属性摊在同一个展开里：
  // 摊在展开里静态看不出这张图到底有没有替代文本（lint 也认不出来）。
  return label === undefined ? (
    <svg {...shared} aria-hidden="true">
      {body}
    </svg>
  ) : (
    <svg {...shared} role="img" aria-label={label}>
      <title>{label}</title>
      {body}
    </svg>
  )
}

/**
 * 「Agent 正在替你干活」那个指示 —— **全站只有这一个**。
 *
 * 呼吸只代表这一个语义（docs/36 §12）：按钮里那种普通的加载转圈还是 `Loader2`，
 * 不换成它。幅度按规范 §3.4 压住，尺寸默认 14 —— 小于 28 自动退单色，
 * 于是它在正文里就是一个跟着文字颜色走的小标记，不会有一块彩色跳出来抢戏。
 */
export function AgentBusyMark({
  label,
  size = 14,
  className,
}: {
  label: string
  size?: number
  className?: string
}): ReactNode {
  return (
    <span
      className={`inline-flex items-center gap-1.5 text-ws-muted-fg ${className ?? ''}`}
      data-testid="agent-busy"
    >
      <BrandMark size={size} motion="breathe" label={label} />
      <span className="text-[12px]">{label}</span>
    </span>
  )
}

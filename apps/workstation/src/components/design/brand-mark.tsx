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
 * | `none` | 就是这个牌子 | 左栏顶部、favicon、README |
 * | `assemble` | 这套东西正在起来 | 冷启动首屏、初始化设置第一屏 |
 * | `breathe` | **Agent 正在替你干活** | 对话线程、岗位卡运行点、正在进行 |
 * | `split` | 一个活做通了，复制成一队 | 设置完成屏、新岗位上岗回执 |
 *
 * 三条硬规矩，全部来自规范：
 *
 * 1. **静态一条 `userSpaceOnUse` 渐变铺满整个标记，方块把它切开**（§1.2）；
 *    **动效每块自己一条 `objectBoundingBox` 渐变**（§3.0）——块飞出去的时候
 *    渐变要跟着块走，固定在坐标系上会闪。
 * 2. **小于 28px 一律退单色**（§1.3）：再小方块间的缝会并起来，渐变只剩一团糊。
 *    单色走 `currentColor`，颜色由摆它的地方说了算。
 * 3. **`prefers-reduced-motion: reduce` 时一律静态**：一个 animation 类都不挂。
 *
 * SVG 里对 `<rect>` 做 transform 必须写 `transform-box: fill-box` +
 * `transform-origin: center`（§4.1 坑 1），这两句在 `index.css` 的基类里。
 */
import { type CSSProperties, type ReactNode, useId, useSyncExternalStore } from 'react'
import {
  ALL_BLOCKS,
  ASSEMBLE_DELAYS_MS,
  BLOCK_RADIUS,
  BLOCK_SIZE,
  BLOCKS,
  BREATHE_PHASE_MS,
  GRADIENT_AXIS,
  MIN_GRADIENT_PX,
  MOTION_CLASS,
  motionStopVars,
  SPLIT_FIRST_DELAY_MS,
  SPLIT_OFFSETS,
  SPLIT_STEP_MS,
  STATIC_STOP_VARS,
  STOPS_ON_DARK,
  VIEW_BOX,
} from './brand-mark.geometry'

export type BrandMarkVariant = 'gradient' | 'mono'
export type BrandMarkMotion = 'none' | 'assemble' | 'breathe' | 'split'

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
  className,
  label,
}: {
  /** 边长（px）。标记本身就是 65×65 的方外框，所以宽高相等。 */
  size?: number
  variant?: BrandMarkVariant
  motion?: BrandMarkMotion
  className?: string
  /**
   * 给了就是有意义的图形（`role="img"` + `<title>`）；不给就是装饰
   * （`aria-hidden`）——旁边已经有字的时候读屏再念一遍只是噪音。
   */
  label?: string
}): ReactNode {
  const uid = useId()
  const reduce = usePrefersReducedMotion()
  // 规范 §1.3：小于 28px 一律退单色，无论调用方写的是 gradient 还是什么
  const mono = variant === 'mono' || size < MIN_GRADIENT_PX
  const active: BrandMarkMotion = reduce ? 'none' : motion
  const moving = active !== 'none'

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
    mono ? 'currentColor' : `url(#${moving ? blockId(i) : staticId})`

  /** 第 i 块（0–4 是随从，5 是领头）在这一姿态下的类名与内联延迟。 */
  const poseOf = (i: number): { className?: string; style?: CSSProperties } => {
    if (!moving) return {}
    const lead = i === BLOCKS.length
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

  const body = (
    <>
      {mono ? null : <defs>{moving ? motionGradients : staticGradient}</defs>}
      {ALL_BLOCKS.map((b, i) => (
        <Blk key={`${b.x}-${b.y}`} x={b.x} y={b.y} fill={fillOf(i)} {...poseOf(i)} />
      ))}
    </>
  )
  const shared = {
    xmlns: 'http://www.w3.org/2000/svg',
    viewBox: VIEW_BOX,
    width: size,
    height: size,
    fill: 'none',
    'data-testid': 'brand-mark',
    'data-variant': mono ? 'mono' : 'gradient',
    'data-motion': active,
    ...(className === undefined ? {} : { className }),
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

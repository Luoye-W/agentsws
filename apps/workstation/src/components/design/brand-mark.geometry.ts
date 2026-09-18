/**
 * `BrandMark` 用到的几何、颜色与动效常量。
 *
 * **真源是母品牌规范** `Luoye/projects/AgentsWorkshop/00_Brand/品牌设计规范-v2.md`
 * （几何 §1.1、整体渐变 §1.2、每块渐变 §3.0、缓动 §3.1、集结 §3.2、
 * 一变一队 §3.3、呼吸 §3.4）。数字一个都不在这里定义——全部从
 * `@agentsws/brand` 取，那个包是规范在代码里的唯一副本
 * （`packages/brand/test/geometry.test.ts` 逐格对着规范核）。
 *
 * 这个文件只多做一件事：把"这些颜色在界面里叫什么"钉下来。
 * 端点不写死在组件里而是走 CSS 变量，于是**明暗主题自动取对应端点**——
 * 浅色主题拿压暗那套（§1.2「浅底的坑」），深色主题拿亮那套，
 * 一行 JS 都不需要知道现在是哪个主题。变量本身定义在 `src/index.css`
 * 的 `:root` / `.dark` 两段里。
 */
export {
  ALL_BLOCKS,
  ASSEMBLE_DELAYS_MS,
  ASSEMBLE_LEAD_DELAY_MS,
  BLOCK_RADIUS,
  BLOCK_SIZE,
  BLOCKS,
  BREATHE_PHASE_MS,
  GRADIENT_AXIS,
  LEAD,
  MIN_GRADIENT_PX,
  MOTION_GRADIENTS_ON_DARK,
  MOTION_GRADIENTS_ON_LIGHT,
  SPLIT_FIRST_DELAY_MS,
  SPLIT_OFFSETS,
  SPLIT_STEP_MS,
  STOPS_ON_DARK,
  STOPS_ON_LIGHT,
  VIEW_BOX,
} from '@agentsws/brand'

/** 整体渐变那三个端点的 CSS 变量名（静态标记用，§1.2）。 */
export const STATIC_STOP_VARS = [
  '--ws-brand-mark-0',
  '--ws-brand-mark-1',
  '--ws-brand-mark-2',
] as const

/** 动效里第 i 块自己那一段的起 / 止色变量名（§3.0）。 */
export function motionStopVars(i: number): { from: string; to: string } {
  return { from: `--ws-brand-mark-b${i + 1}-from`, to: `--ws-brand-mark-b${i + 1}-to` }
}

/** 六块 × 起止两端 = 十二个变量名，明暗两套都得齐（CSS 那边的测试按它数）。 */
export const MOTION_STOP_VARS: readonly string[] = [0, 1, 2, 3, 4, 5].flatMap((i) => {
  const v = motionStopVars(i)
  return [v.from, v.to]
})

/**
 * 四种姿态各自的类名。
 *
 * 类与 `@keyframes` 都写在 `index.css` 的 `@layer components` 里——
 * 零新依赖、零 mp4 / gif / lottie（WP112 的定论）。
 */
export const MOTION_CLASS = {
  assemble: { block: 'ws-bm-assemble', lead: 'ws-bm-assemble-lead' },
  breathe: { block: 'ws-bm-breathe', lead: 'ws-bm-breathe' },
  split: { block: 'ws-bm-split', lead: 'ws-bm-split-lead' },
} as const

/** WP96 共用件的唯一出口：页面只从这里拿，不去摸单个文件。 */
export { type BarPoint, DualBarChart, DualBarLegend } from './bar-chart'
// WP112：母品牌标记，一个组件四种姿态（静态 / 集结 / 呼吸 / 一变一队）
export {
  AgentBusyMark,
  BrandMark,
  type BrandMarkMotion,
  type BrandMarkVariant,
  usePrefersReducedMotion,
} from './brand-mark'
export { PositionCard, type PositionCardHolder } from './position-card'
export {
  avatarInitial,
  avatarTone,
  DeltaPill,
  type Direction,
  GoButton,
  SparkBars,
  SparkLine,
  StatusPill,
  WsAvatar,
  WsCard,
  WsTag,
} from './primitives'
export { StatRow } from './stat-row'
export { StatTile } from './stat-tile'
export { TONE_BADGE, TONE_FG, TONE_PILL, type Tone } from './tone'

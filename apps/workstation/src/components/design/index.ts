/** WP96 共用件的唯一出口：页面只从这里拿，不去摸单个文件。 */
export { type BarPoint, DualBarChart, DualBarLegend } from './bar-chart'
// WP112：母品牌标记，一个组件四种姿态（静态 / 集结 / 呼吸 / 一变一队）；WP195 加待机
export {
  AgentBusyMark,
  BrandMark,
  type BrandMarkIdleStyle,
  type BrandMarkMotion,
  type BrandMarkVariant,
  useMotionAllowed,
  usePageHidden,
  usePrefersReducedMotion,
} from './brand-mark'
export {
  applyMotionPref,
  MOTION_PREFS,
  type MotionPref,
  setMotionPref,
  useMotionPref,
} from './motion-pref'
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
// WP214（36 §7 第四档）：状态用图标——四态、tooltip、可键盘聚焦、明暗两套
export {
  FRESH_MS,
  InfoTip,
  STATUS_STATES,
  StatusIcons,
  type StatusItem,
  type StatusState,
  statusText,
  useFresh,
} from './status-icons'
export { TONE_BADGE, TONE_FG, TONE_PILL, type Tone } from './tone'

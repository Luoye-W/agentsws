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
// WP456-T2：决定卡外壳（「要你处理」、事项页的卡、卡片流共用一种）
export {
  CompareBlock,
  DecisionCard,
  DecisionCardBody,
  DecisionCardFoot,
  DecisionCardHead,
  type DecisionOption,
  OptionGroup,
} from './decision-card'
// WP456-T2：一套共用的小件（页头、节标题、列表组 / 行、标签、徽章、一行提醒、空状态、骨架）
export {
  CategoryTag,
  CountBadge,
  countText,
  EmptyState,
  GroupLabel,
  ListGroup,
  ListRow,
  type NoticeAction,
  NoticeLine,
  PageHeader,
  SectionHeader,
  SkeletonBar,
  SkeletonList,
  SkeletonRow,
} from './kit'
export {
  applyMotionPref,
  MOTION_PREFS,
  type MotionPref,
  setMotionPref,
  useMotionPref,
} from './motion-pref'
// WP320（docs/96 §4.2）：小提醒——一句话、几秒收起、打字时不弹、点了去看
export {
  isTypingNow,
  NOTICE_TOAST_MS,
  NoticeToast,
  TYPING_QUIET_MS,
  useLastTypedAt,
} from './notice-toast'
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
// WP456-T2：分段切换全站只留一种
export { Segmented, type SegmentedOption } from './segmented'
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
  testedMs,
  useFresh,
} from './status-icons'
export { TONE_BADGE, TONE_FG, TONE_PILL, type Tone } from './tone'

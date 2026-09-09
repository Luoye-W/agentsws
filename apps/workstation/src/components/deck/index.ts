/** 一副牌的公开面：首页与岗位页各写一行 `<DeckSection …/>`，其余都是这个目录的内部事。 */
export { DeckBattleReport } from './deck-battle-report.js'
export { DeckCardView, type DeckDecideRequest } from './deck-card.js'
export { DeckFilterRow, type PositionOption } from './deck-filters.js'
export {
  type CountdownFace,
  countdownFace,
  type DeckDirection,
  deckActionForDirection,
  directionForDeckAction,
  directionForDeckKey,
  formatCountdown,
  isTypingTarget,
  secondsLeft,
} from './deck-gestures.js'
export {
  DECK_CARD_BODY_SCROLL_CLASS,
  DECK_CARD_MIN_HEIGHT_CLASS,
  DECK_EXIT_MS,
  DECK_MAX_WIDTH_CLASS,
} from './deck-layout.js'
export { DeckSection, type DeckSectionProps } from './deck-section.js'

/**
 * WP438 的第三栏口子——int/1024 起**转到 WP437 的统一宿主**（`components/rail/right-pane.ts`）。
 *
 * 报表整页（`report`）与「做一份报表」（`report-compose`）不再自己画一栏：开在外壳那一个第三栏里
 * （同一时间一格、头上 ×、拖宽记住、报表那两格至少 560 宽、窄了盖在中栏上 / 看板让位，见 `board-fit.ts`）。
 * 调用方照旧从这里 `openRightPane({ kind: 'report', id })`，一行不用改；两格的身体在 `report-pane-bodies.tsx`。
 */
export {
  closeRightPane,
  currentPane,
  markPinned,
  openRightPane,
  type PaneState,
  type RightPane,
  resetRightPane,
  useRightPane,
} from '@/components/rail/right-pane'

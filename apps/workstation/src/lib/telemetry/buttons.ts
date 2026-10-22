/**
 * WP476：关键按钮 → 固定编号（`ui_click.button_id`）。
 *
 * 不靠 autocapture 抓按钮上的字（按钮上的字可能就是一个客户名），也不给每颗按钮改代码：
 * 按钮本来就有固定的 `data-testid`，这里一张对照表。新按钮想记，二选一：
 * - 在这张表里加一行（testid → 编号），编号先加进 `@agentsws/contracts` 的 `TELEMETRY_BUTTONS`；
 * - 或者直接在按钮上写 `data-track="<编号>"`（同样要在清单里）。
 * 只认**整串相等**的 testid——带变量的那种（`card-approve-<id>`）认不上，也就带不出 id。
 */
import { TELEMETRY_BUTTONS, type TelemetryButton } from '@agentsws/contracts'

export const BUTTON_TESTIDS: Readonly<Record<string, TelemetryButton>> = {
  // 助理的发送键是岗位页那一个完整对话框（WP456-T8），它在框上写 `data-track="assistant.send"`
  'matter-send': 'matter.send',
  'composer-send': 'messages.send',
  'compose-send': 'report.send',
  'matter-card-approve': 'card.approve',
  'matter-card-reject': 'card.reject',
  'matter-handoff': 'matter.handoff',
  'command-handoff': 'palette.handoff',
  'onboarding-finish': 'onboarding.finish',
  'login-account-send': 'cloud_login.send_code',
  'login-account-verify': 'cloud_login.verify',
  'account-topup': 'account.topup',
  'nav-settings': 'nav.settings',
  'shell-search': 'shell.search',
  'role-upgrade-confirm': 'role.reconfirm',
  'position-settings-link': 'position.settings',
  'connection-go': 'connection.go',
  'shopconnect-connect': 'shopify.connect',
  'setup-connect-start': 'setup.connect_start',
  'update-button': 'update.check',
  'update-restart-now': 'update.restart',
}

const CLICKABLE = 'button, a, [role="button"], [role="menuitem"], [role="switch"], [role="tab"]'
const KNOWN: ReadonlySet<string> = new Set(TELEMETRY_BUTTONS)

/** 一次点击落在哪颗「记的」按钮上；不是关键按钮就 `undefined`。 */
export function buttonIdOf(target: EventTarget | null): TelemetryButton | undefined {
  if (target === null || typeof (target as Element).closest !== 'function') return undefined
  const el = (target as Element).closest(CLICKABLE)
  if (!(el instanceof HTMLElement)) return undefined
  const explicit = el.dataset.track
  if (explicit !== undefined) return KNOWN.has(explicit) ? (explicit as TelemetryButton) : undefined
  const testid = el.dataset.testid
  return testid !== undefined && Object.hasOwn(BUTTON_TESTIDS, testid)
    ? BUTTON_TESTIDS[testid]
    : undefined
}

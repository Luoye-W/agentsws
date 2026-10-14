/**
 * 广告后台页面顶上那条「正在操作 · 停止」（WP313 第 5 条；docs/80 托盘变红是同一个思路）。
 *
 * 纯 DOM（不用 React：这条横条每一页都要重新放一次，越轻越好），住在 shadow root 里，
 * 页面的样式进不来、我们的也出不去。字尽量少：「AI 正在操作 · 3/7 · 打开页面　停止」。
 * 要人再确认时多两个按钮：「确认提交」「不提交」。
 */

import type { BannerState } from './dom-messages'

export const BANNER_HOST_ID = 'agentsws-ads-banner'

const CSS = `
:host { all: initial; }
.bar { position: fixed; top: 0; left: 0; right: 0; z-index: 2147483647;
  display: flex; align-items: center; gap: 10px; padding: 6px 12px;
  font: 13px/1.4 -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif;
  color: #fff; background: #b42318; box-shadow: 0 1px 4px rgba(0,0,0,.25); }
.bar[hidden] { display: none; }
.dot { width: 8px; height: 8px; border-radius: 50%; background: #fff; flex: none; }
.text { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
button { font: inherit; border: 1px solid rgba(255,255,255,.8); border-radius: 6px;
  padding: 2px 10px; cursor: pointer; background: transparent; color: #fff; }
button.primary { background: #fff; color: #b42318; border-color: #fff; }
`

export interface BannerHandlers {
  onStop(): void
  onConfirm(answer: 'yes' | 'no'): void
}

/** 横条上的那一行字。 */
export function bannerText(state: BannerState): string {
  const step = state.of > 0 && state.step > 0 ? ` · ${state.step}/${state.of}` : ''
  if (state.confirm !== undefined) return `${state.confirm}`
  return `AI 正在操作${step} · ${state.label}`
}

/** 画（或更新 / 收起）横条。`state === null` 就整条拿掉。 */
export function renderBanner(
  doc: Document,
  state: BannerState | null,
  handlers: BannerHandlers,
): void {
  const existing = doc.getElementById(BANNER_HOST_ID)
  if (state === null) {
    existing?.remove()
    return
  }
  let host = existing
  if (host === null) {
    host = doc.createElement('div')
    host.id = BANNER_HOST_ID
    doc.documentElement.appendChild(host)
  }
  const root = host.shadowRoot ?? host.attachShadow({ mode: 'open' })
  root.innerHTML = ''
  const style = doc.createElement('style')
  style.textContent = CSS
  const bar = doc.createElement('div')
  bar.className = 'bar'
  bar.setAttribute('role', 'status')
  bar.setAttribute('data-testid', 'ads-banner')
  if (state.hidden === true) bar.hidden = true
  const dot = doc.createElement('span')
  dot.className = 'dot'
  const text = doc.createElement('span')
  text.className = 'text'
  text.textContent = bannerText(state)
  text.title = state.title
  bar.append(dot, text)
  const button = (label: string, testid: string, primary: boolean, fn: () => void): void => {
    const b = doc.createElement('button')
    b.type = 'button'
    b.textContent = label
    b.setAttribute('data-testid', testid)
    if (primary) b.className = 'primary'
    b.addEventListener('click', fn)
    bar.append(b)
  }
  if (state.confirm !== undefined) {
    button('确认提交', 'ads-banner-yes', true, () => handlers.onConfirm('yes'))
    button('不提交', 'ads-banner-no', false, () => handlers.onConfirm('no'))
  }
  button('停止', 'ads-banner-stop', state.confirm === undefined, handlers.onStop)
  root.append(style, bar)
}

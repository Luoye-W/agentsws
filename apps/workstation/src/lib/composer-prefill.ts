/**
 * WP509：往这一页的完整对话框里**预填一句话**（不发出去，人看一眼、贴上链接再按发送）。
 *
 * 两个来路：
 * - 深链 `?ask=<一句话>`（插件「数据同步」的「去后台连接」→ `/influencer/sync` → 红人营销岗位 `?ask=…`）——
 *   岗位页的对话框挂上时读一次，读完从地址栏收掉；
 * - 页面里的按钮（第三栏「连接」/ 红人库 ⋯ 里「去设同步」「改设置」）调 {@link prefillComposer}。
 */
import { useEffect } from 'react'

const EVENT = 'agentsws:composer-prefill'
export const PREFILL_PARAM = 'ask'

export function prefillComposer(text: string): void {
  window.dispatchEvent(new CustomEvent<string>(EVENT, { detail: text }))
}

/** 对话框那一侧：收到就填进去（替换框里原来的字）、光标放进框里。 */
export function useComposerPrefill(fill: (text: string) => void): void {
  useEffect(() => {
    const on = (e: Event): void => {
      const text = (e as CustomEvent<string>).detail
      if (typeof text === 'string' && text !== '') fill(text)
    }
    window.addEventListener(EVENT, on)
    // 深链带来的那一句：读一次就从地址栏收掉（刷新不再填）
    const url = new URL(window.location.href)
    const asked = url.searchParams.get(PREFILL_PARAM)
    if (asked !== null && asked.trim() !== '') {
      fill(asked.slice(0, 500))
      url.searchParams.delete(PREFILL_PARAM)
      window.history.replaceState(
        window.history.state,
        '',
        `${url.pathname}${url.search}${url.hash}`,
      )
    }
    return () => window.removeEventListener(EVENT, on)
  }, [fill])
}

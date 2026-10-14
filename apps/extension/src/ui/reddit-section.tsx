/**
 * 设置页「Reddit」一节（WP329；docs/102 §2.3 第 1 条）。
 *
 * 一行：连上没有 + 一个按钮。连接 = 浏览器弹窗给 Reddit 的站点权限（可选权限，用户点了才申请）。
 * 连上之后，工坊里批过的 Reddit 回复 / 评论 / 发帖会在一个新标签页里把草稿填好，**你自己点发送**。
 * 没有风险告知勾选：插件不替你点发送（那一下是你的），连接那一下浏览器的权限弹窗就是同意。
 * 界面少字：说明放在问号里。
 */

import { useCallback, useEffect, useState } from 'react'
import { chromePermissions, removeAds, requestAds } from '@/lib/ads/permissions'
import type { AdsPanelStatus } from '@/lib/messages'
import { send } from '@/lib/messages'

export const REDDIT_HINT = '批过的回复由插件填进 Reddit 页面，你自己点发送。'

export function RedditSection(props: { paired: boolean }): React.ReactNode {
  const [ads, setAds] = useState<AdsPanelStatus | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | undefined>(undefined)

  const refresh = useCallback(() => {
    void send({ type: 'ads-status' }).then((r) => {
      if (r?.type === 'ads-status') setAds(r.ads)
    })
  }, [])
  useEffect(refresh, [refresh])

  const connect = useCallback(() => {
    setBusy(true)
    setMessage(undefined)
    // 申请权限必须在点击的这一拍里调（浏览器只认用户手势）
    void requestAds(chromePermissions(), 'reddit')
      .then((granted) => {
        if (!granted) setMessage('浏览器里没有给权限，没连上。')
        else void send({ type: 'ads-poll' })
      })
      .finally(() => {
        setBusy(false)
        refresh()
      })
  }, [refresh])

  const disconnect = useCallback(() => {
    void removeAds(chromePermissions(), 'reddit').finally(refresh)
  }, [refresh])

  const on = ads?.connected.reddit === true
  return (
    <section className="ws-card" data-testid="ws-reddit">
      <h2 title={REDDIT_HINT}>Reddit</h2>
      <ul className="ws-facts">
        <li>
          <span title={REDDIT_HINT}>填草稿 · 你点发送</span>
          <b data-testid="ws-reddit-state">{on ? '已连接' : '未连接'}</b>
          {on ? (
            <button type="button" className="ws-btn ws-btn--ghost" onClick={disconnect}>
              断开
            </button>
          ) : (
            <button
              type="button"
              className="ws-btn ws-btn--primary"
              disabled={!props.paired || busy}
              onClick={connect}
              data-testid="ws-reddit-connect"
            >
              {busy ? '连接中…' : '连接'}
            </button>
          )}
        </li>
      </ul>
      {props.paired ? null : <p className="ws-note ws-note--warn">先配对，再连接。</p>}
      {message === undefined ? null : <p className="ws-note ws-note--bad">{message}</p>}
    </section>
  )
}

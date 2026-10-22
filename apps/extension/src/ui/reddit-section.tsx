/**
 * 设置页「Reddit」一节（WP328 读 + WP329 写共用一行）。一行：连上没有 + 一个按钮 + 上次读到什么。
 * 连接 = 浏览器弹窗给 Reddit 的站点权限（可选权限）；登录由你自己在这个 Chrome 里做（插件从不碰口令）。
 */
import { useCallback, useEffect, useState } from 'react'
import { chromePermissions } from '@/lib/ads/permissions'
import type { RedditPanelStatus } from '@/lib/messages'
import { send } from '@/lib/messages'
import { removeReddit, requestReddit } from '@/lib/reddit/permissions'

const OUTCOME: Record<string, string> = {
  done: '读完了',
  not_logged_in: '没登录 Reddit',
  wrong_user: '登的不是品牌号',
  blocked: '被 Reddit 拦了，已停',
  failed: '没读成',
  stopped: '已停止',
}

export function RedditSection(props: { paired: boolean }): React.ReactNode {
  const [st, setSt] = useState<RedditPanelStatus | undefined>(undefined)
  const [note, setNote] = useState<string | undefined>(undefined)

  const refresh = useCallback(() => {
    void send({ type: 'reddit-status' }).then((r) => {
      if (r?.type === 'reddit-status') setSt(r.reddit)
    })
  }, [])
  useEffect(refresh, [refresh])

  const connect = useCallback(() => {
    setNote(undefined)
    // 申请权限必须在点击的这一拍里调（浏览器只认用户手势）
    void requestReddit(chromePermissions())
      .then(async (granted) => {
        if (!granted) setNote('浏览器里没有给权限，没连上。')
        await send({ type: 'reddit-poll' })
        // WP329：连上了也马上问一次有没有批好的回复要填
        if (granted) await send({ type: 'ads-poll' })
      })
      .finally(refresh)
  }, [refresh])
  const disconnect = useCallback(() => {
    void removeReddit(chromePermissions())
      .then(() => send({ type: 'reddit-poll' }))
      .finally(refresh)
  }, [refresh])

  const on = st?.connected === true
  const last = st?.last_result
  return (
    <section className="ws-card" data-testid="ws-reddit">
      <h2>Reddit</h2>
      <ul className="ws-facts">
        <li>
          <span>{st?.user === undefined ? '品牌号' : `u/${st.user}`}</span>
          <b data-testid="ws-reddit-state">{on ? '已连接' : '未连接'}</b>
          {on ? (
            <button type="button" className="ws-btn ws-btn--ghost" onClick={disconnect}>
              断开
            </button>
          ) : (
            <button
              type="button"
              className="ws-btn ws-btn--primary"
              disabled={!props.paired}
              onClick={connect}
              data-testid="ws-reddit-connect"
            >
              连接
            </button>
          )}
        </li>
      </ul>
      <p
        className="ws-note"
        title="读：只读收件箱与自家版块，不改已读。写：在你开着的原帖页里填好（没开着就新开一页），你自己点发送；你自己粘贴发的也照样记。登录你自己在这个 Chrome 里做"
      >
        读不改已读 · 写由你点发送
      </p>
      {props.paired ? null : <p className="ws-note ws-note--warn">先配对，再连接。</p>}
      {last === undefined ? null : (
        <p className={last.outcome === 'done' ? 'ws-note' : 'ws-note ws-note--warn'}>
          上次：{OUTCOME[last.outcome] ?? last.outcome}
          {last.outcome === 'done' ? `（${last.items} 条）` : ''}
        </p>
      )}
      {st?.note === undefined ? null : <p className="ws-note ws-note--warn">{st.note}</p>}
      {note === undefined ? null : <p className="ws-note ws-note--bad">{note}</p>}
    </section>
  )
}

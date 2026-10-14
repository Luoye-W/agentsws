/**
 * 设置页「广告后台」一节（WP313；决策 551 / 562）。
 *
 * 一家一行：连上没有 + 一个按钮。连接 = 勾一下风险告知 → 浏览器弹窗给这家后台的站点权限（可选权限）
 * → 本机记一次「同意」。断开 = 把站点权限还回去。界面少字：告知一句话，正式文案在 WP318。
 */

import type { ActionPlatform } from '@agentsws/browser-action'
import { useCallback, useEffect, useState } from 'react'
import { ADS_CONSENT_TEXT_VERSION } from '@/lib/ads/broker'
import {
  ADS_PLATFORM_LABEL,
  ADS_PLATFORMS,
  chromePermissions,
  removeAds,
  requestAds,
} from '@/lib/ads/permissions'
import type { AdsPanelStatus } from '@/lib/messages'
import { send } from '@/lib/messages'

/** 连接前那一句（决策 562）。**占位**：正式的白话告知在 WP318 写，改了文案要同时升版本号。 */
export const ADS_CONSENT_LINE =
  '我知道：它在我自己的后台里替我点批过的动作；平台条款对自动化有模糊地带，最坏可能账户受限、要申诉。'

const OUTCOME: Record<string, string> = {
  done: '做完了',
  failed: '没做成',
  handover: '停下交给你',
  stopped: '已停止',
  rejected: '退回去改',
}

export function AdsSection(props: { paired: boolean }): React.ReactNode {
  const [ads, setAds] = useState<AdsPanelStatus | undefined>(undefined)
  const [agreed, setAgreed] = useState(false)
  const [busy, setBusy] = useState<ActionPlatform | undefined>(undefined)
  const [message, setMessage] = useState<{ ok: boolean; text: string } | undefined>(undefined)

  const refresh = useCallback(() => {
    void send({ type: 'ads-status' }).then((r) => {
      if (r?.type === 'ads-status') setAds(r.ads)
    })
  }, [])
  useEffect(refresh, [refresh])

  const connect = useCallback(
    (platform: ActionPlatform) => {
      setBusy(platform)
      setMessage(undefined)
      // 申请权限必须在点击的这一拍里调（浏览器只认用户手势）
      void requestAds(chromePermissions(), platform)
        .then(async (granted) => {
          if (!granted) {
            setMessage({ ok: false, text: '浏览器里没有给权限，没连上。' })
            return
          }
          const r = await send({
            type: 'ads-consent',
            platform,
            text_version: ADS_CONSENT_TEXT_VERSION,
          })
          if (r?.type === 'ads-consent') {
            setAds(r.ads)
            setMessage({ ok: r.ok, text: r.message })
          }
        })
        .finally(() => {
          setBusy(undefined)
          refresh()
        })
    },
    [refresh],
  )

  const disconnect = useCallback(
    (platform: ActionPlatform) => {
      void removeAds(chromePermissions(), platform).finally(refresh)
    },
    [refresh],
  )

  return (
    <section className="ws-card" data-testid="ws-ads">
      <h2>广告后台</h2>
      <ul className="ws-facts">
        {ADS_PLATFORMS.map((p) => {
          const on = ads?.connected[p] === true
          const waitingConsent = on && ads?.needs_consent?.includes(p) === true
          return (
            <li key={p}>
              <span>{ADS_PLATFORM_LABEL[p]}</span>
              <b data-testid={`ws-ads-${p}`}>
                {on ? (waitingConsent ? '待同意' : '已连接') : '未连接'}
              </b>
              {on && !waitingConsent ? (
                <button
                  type="button"
                  className="ws-btn ws-btn--ghost"
                  onClick={() => disconnect(p)}
                >
                  断开
                </button>
              ) : (
                <button
                  type="button"
                  className="ws-btn ws-btn--primary"
                  disabled={!props.paired || !agreed || busy !== undefined}
                  onClick={() => connect(p)}
                  data-testid={`ws-ads-connect-${p}`}
                >
                  {busy === p ? '连接中…' : '连接'}
                </button>
              )}
            </li>
          )
        })}
      </ul>
      <label className="ws-row">
        <input
          type="checkbox"
          checked={agreed}
          onChange={(e) => setAgreed(e.target.checked)}
          data-testid="ws-ads-consent"
        />
        <span>{ADS_CONSENT_LINE}</span>
      </label>
      {props.paired ? null : <p className="ws-note ws-note--warn">先配对，再连接。</p>}
      {ads?.running === undefined ? null : (
        <p className="ws-note" data-testid="ws-ads-running">
          正在做：{ads.running.title}
        </p>
      )}
      {ads?.last_result === undefined ? null : (
        <p className="ws-note">
          上一件「{ads.last_result.title}」：
          {OUTCOME[ads.last_result.outcome] ?? ads.last_result.outcome}
        </p>
      )}
      {ads?.note === undefined ? null : <p className="ws-note ws-note--warn">{ads.note}</p>}
      {message === undefined ? null : (
        <p className={message.ok ? 'ws-note' : 'ws-note ws-note--bad'}>{message.text}</p>
      )}
    </section>
  )
}

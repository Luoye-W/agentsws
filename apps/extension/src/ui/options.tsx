/**
 * 设置页：配对、端口、排队、**隐私说明**（WP119 定论 2 / 3）。
 *
 * 隐私那一段不是法务文案的复读，它是这一页的主要内容之一。Luoye 09-19 定的
 * 那条——「只要用户登录了云账号，观测数据默认共享到公共红人库，不设勾选项」——
 * 意味着**唯一诚实的做法是说清楚**：既然不给开关，那就把「会共享什么、
 * 不会共享什么」写在用户配对前就看得见的地方，而不是藏进一份没人读的政策里。
 *
 * 三处都说同一句话，一字不改：这一页、页面上那块面板的第一行、`STORE.md`。
 */

import { useCallback, useEffect, useState } from 'react'
import type { ExtensionStatus } from '@/lib/messages'
import { send } from '@/lib/messages'
import { DEFAULT_PORT } from '@/lib/storage'
import { BrandMark } from './brand-mark'

export function Options(): React.ReactNode {
  const [status, setStatus] = useState<ExtensionStatus | undefined>(undefined)
  const [code, setCode] = useState('')
  const [port, setPort] = useState(String(DEFAULT_PORT))
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ ok: boolean; text: string } | undefined>(undefined)

  const refresh = useCallback(() => {
    void send({ type: 'status' }).then((r) => {
      if (r?.type !== 'status') return
      setStatus(r.status)
      setPort(String(r.status.port))
    })
  }, [])

  useEffect(refresh, [refresh])

  const submit = useCallback(() => {
    setBusy(true)
    void send({ type: 'pair', code }).then((r) => {
      setBusy(false)
      if (r?.type !== 'pair') return
      setMessage({ ok: r.ok, text: r.message })
      setStatus(r.status)
      if (r.ok) setCode('')
    })
  }, [code])

  const savePort = useCallback(() => {
    const value = Number(port)
    if (!Number.isInteger(value) || value <= 0 || value >= 65_536) {
      setMessage({ ok: false, text: '端口要是 1–65535 之间的整数。' })
      return
    }
    void send({ type: 'set-port', port: value }).then((r) => {
      if (r?.type === 'status') setStatus(r.status)
      setMessage({ ok: true, text: `记住了，以后找 127.0.0.1:${value}。` })
    })
  }, [port])

  return (
    <div className="ws-page">
      <header className="ws-head">
        <BrandMark />
        <h1>Agents 工坊 · 红人助手</h1>
      </header>

      <section className="ws-card">
        <h2>这台电脑上的连接</h2>
        <ul className="ws-facts">
          <li>
            <span>配对</span>
            <b data-testid="ws-paired">{status?.paired === true ? '已配对' : '还没配对'}</b>
          </li>
          <li>
            <span>Agents 工坊</span>
            <b>
              {status?.online === true ? `连得上（${status.workspace_name ?? '—'}）` : '没连上'}
            </b>
          </li>
          <li>
            <span>排着没传的</span>
            <b>{status?.queued ?? 0} 条</b>
          </li>
        </ul>
        {status?.note === undefined ? null : <p className="ws-note ws-note--warn">{status.note}</p>}
      </section>

      {status?.paired === true ? (
        <section className="ws-card">
          <h2>换一个工作区 / 解除配对</h2>
          <p>
            解除之后这台浏览器就再也传不进去了（已经排着的会留着，重新配上就补传）。
            工作台那一侧也可以随时把这把撤掉。
          </p>
          <div className="ws-row">
            <button
              type="button"
              className="ws-btn ws-btn--ghost"
              onClick={() => {
                void send({ type: 'unpair' }).then((r) => {
                  if (r?.type === 'status') setStatus(r.status)
                })
              }}
            >
              解除配对
            </button>
            <button
              type="button"
              className="ws-btn ws-btn--ghost"
              onClick={() => {
                void send({ type: 'clear-queue' }).then((r) => {
                  if (r?.type === 'status') setStatus(r.status)
                })
              }}
            >
              清空排着的
            </button>
          </div>
        </section>
      ) : (
        <section className="ws-card">
          <h2>配对</h2>
          <p>
            打开电脑上的 Agents 工坊 →「连接 → 浏览器插件」→ 按「生成配对码」， 把那 6
            位数字填到这里。码 5 分钟内有效，只能用一次。
          </p>
          <div className="ws-row">
            <label className="ws-field">
              <span className="ws-label">配对码</span>
              <input
                className="ws-input ws-code"
                inputMode="numeric"
                maxLength={6}
                placeholder="000000"
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                data-testid="ws-code"
              />
            </label>
            <button
              type="button"
              className="ws-btn ws-btn--primary"
              onClick={submit}
              disabled={busy || code.length !== 6}
            >
              {busy ? '正在配…' : '配对'}
            </button>
          </div>
          {message === undefined ? null : (
            <p
              className={message.ok ? 'ws-note' : 'ws-note ws-note--bad'}
              data-testid="ws-pair-message"
            >
              {message.text}
            </p>
          )}
        </section>
      )}

      <section className="ws-card">
        <h2>本机服务端口</h2>
        <p>
          默认 {DEFAULT_PORT}。插件<strong>只</strong>连这台电脑上的 127.0.0.1，
          不会连任何别的地址。
        </p>
        <div className="ws-row">
          <label className="ws-field">
            <span className="ws-label">端口</span>
            <input
              className="ws-input"
              inputMode="numeric"
              value={port}
              onChange={(e) => setPort(e.target.value.replace(/\D/g, '').slice(0, 5))}
            />
          </label>
          <button type="button" className="ws-btn ws-btn--ghost" onClick={savePort}>
            记住
          </button>
        </div>
      </section>

      <section className="ws-card">
        <h2>这个插件会收什么、往哪儿送</h2>
        <PrivacyCopy cloudLinked={status?.cloud_linked === true} />
      </section>
    </div>
  )
}

/**
 * 隐私说明。**与 `STORE.md` 和面板第一行同一套话**。
 *
 * 单独抽成组件是为了让它有一处真源：三个地方要说同一句，就不能各写一遍。
 */
export function PrivacyCopy(props: { cloudLinked: boolean }): React.ReactNode {
  return (
    <div className="ws-privacy" data-testid="ws-privacy">
      <p>
        <strong>只在你按下按钮的那一刻采集。</strong>
        插件不记录你的浏览历史，也不会在后台自己翻页。你没点按钮，它一个字段都不读。
      </p>
      <p>
        <strong>收到的东西先落在你自己的电脑上</strong>
        （127.0.0.1 上的 Agents 工坊）。插件自己不认识任何云端地址。
      </p>
      <p>
        <strong>
          登录 Agents 工坊云账号之后，你浏览时采集到的红人公开数据会共享到公共红人库。
        </strong>
        这是账号自带的，没有单独的开关——共享出去的只有平台上本来就公开可见的那些：
        <ul>
          <li>渠道、账号名、主页链接、头像</li>
          <li>页面上印着的粉丝数 / 播放数（原样那串文字）</li>
          <li>公开的商务联系方式与它的来源页</li>
        </ul>
        作为交换，你用别人贡献的数据时也不另外花钱。
      </p>
      <p>
        <strong>这些永远不会进公共库：</strong>
        你写的备注、你的候选池与名单、你的合作与活动、你和红人之间的往来邮件。
        它们只在你自己的电脑上（以及你自己的云端工作区里）。
      </p>
      <p>
        <strong>没登录 = 一条都不上传。</strong>
        {props.cloudLinked
          ? '你现在是登录状态，所以上面那条正在生效。'
          : '你现在没登录，所有东西只在这台电脑上。'}
      </p>
    </div>
  )
}

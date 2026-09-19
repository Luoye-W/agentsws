/**
 * 页面上那块面板（WP119 定论 2）。
 *
 * 三条产品纪律长在这个组件里：
 *
 * 1. **用户点了才采**。面板开着不等于在采集——解析发生在按下按钮的那一刻，
 *    上报发生在按下之后。滚动、翻页、切视频，一条都不会自己发出去。
 * 2. **「收进哪儿」永远在最上面一行**。登录态时它明说「同时共享到公共红人库」。
 *    这一句是 Chrome 应用商店要求的显著披露，也是用户唯一会真的看见的那一处——
 *    藏在设置页里的隐私政策没人读。
 * 3. **体检不需要配对**。没装应用、没配对、没登录，按一下照样出结果、照样
 *    复制得了一行。这是这个插件第一次被打开的那五分钟里唯一有用的东西。
 */

import { useCallback, useEffect, useState } from 'react'
import { formatCount } from '@/lib/counts'
import { creatorExportTable, toTsvRow } from '@/lib/export-row'
import type { ContentHealth, CreatorHealth } from '@/lib/health'
import {
  CONTENT_VERDICT_TEXT,
  CREATOR_VERDICT_TEXT,
  computeContentHealth,
  computeCreatorHealth,
  formatRatioPercent,
} from '@/lib/health'
import type { ExtensionStatus, ObserveOutcome } from '@/lib/messages'
import { destinationLine, send } from '@/lib/messages'
import type { ContentSnapshot, CreatorSnapshot } from '@/lib/snapshot'
import { creatorObservation } from '@/lib/to-observation'
import { BrandMark } from './brand-mark'
import { SearchPanel } from './search-panel'

export interface PanelProps {
  creator?: CreatorSnapshot | undefined
  content?: ContentSnapshot | undefined
  /** 搜索结果页：候选由 content script 在用户点开面板时解析一次。 */
  search?: { query: string; pageUrl: string } | undefined
  onClose: () => void
}

export function Panel(props: PanelProps): React.ReactNode {
  const [status, setStatus] = useState<ExtensionStatus | undefined>(undefined)

  const refresh = useCallback(() => {
    void send({ type: 'status' }).then((r) => {
      if (r?.type === 'status') setStatus(r.status)
    })
  }, [])

  useEffect(refresh, [refresh])

  return (
    <div className="ws-root" data-testid="ws-panel">
      <div className="ws-head">
        <BrandMark />
        <span className="ws-title">Agents 工坊 · 红人助手</span>
        <button type="button" className="ws-close" onClick={props.onClose} aria-label="关闭">
          ×
        </button>
      </div>
      <p className="ws-destination">
        {status === undefined ? '正在看这台电脑上的 Agents 工坊…' : destinationLine(status)}
      </p>

      {props.creator !== undefined ? (
        <CreatorCard snapshot={props.creator} status={status} onDone={refresh} />
      ) : props.content !== undefined ? (
        <ContentCard snapshot={props.content} />
      ) : props.search !== undefined ? (
        <SearchPanel query={props.search.query} pageUrl={props.search.pageUrl} onDone={refresh} />
      ) : (
        <p className="ws-note">
          这一页我看不懂。打开某个人的主页、某条视频，或者一页搜索结果再试。
        </p>
      )}

      {status !== undefined && !status.paired ? (
        <p className="ws-note" data-testid="ws-not-paired">
          体检和「复制一行」现在就能用。想让它自己收进红人库，
          <button
            type="button"
            className="ws-btn ws-btn--ghost"
            style={{ marginTop: 6, width: '100%' }}
            onClick={() => chrome.runtime.openOptionsPage()}
          >
            去配对（要 6 位码）
          </button>
        </p>
      ) : null}

      {status !== undefined && status.queued > 0 ? (
        <p className="ws-note ws-note--warn" data-testid="ws-queued">
          还有 {status.queued} 条排在插件里没传上去。打开 Agents 工坊，它会自己补。
        </p>
      ) : null}
    </div>
  )
}

function StatRow(props: { items: { label: string; value: string }[] }): React.ReactNode {
  return (
    <div className="ws-stats">
      {props.items.map((item) => (
        <div className="ws-stat" key={item.label}>
          <div className="ws-stat-label">{item.label}</div>
          <div className="ws-stat-value">{item.value}</div>
        </div>
      ))}
    </div>
  )
}

function Verdict(props: { kind: string; text: string }): React.ReactNode {
  return (
    <div className={`ws-verdict ws-verdict--${props.kind}`} data-testid="ws-verdict">
      {props.text}
    </div>
  )
}

function CreatorCard(props: {
  snapshot: CreatorSnapshot
  status: ExtensionStatus | undefined
  onDone: () => void
}): React.ReactNode {
  const health: CreatorHealth = computeCreatorHealth(props.snapshot)
  const [busy, setBusy] = useState(false)
  const [outcome, setOutcome] = useState<ObserveOutcome | undefined>(undefined)
  const [copied, setCopied] = useState(false)

  const save = useCallback(() => {
    setBusy(true)
    void send({
      type: 'observe',
      observations: [creatorObservation(props.snapshot, health)],
    }).then((r) => {
      setBusy(false)
      if (r?.type === 'observe') setOutcome(r.outcome)
      props.onDone()
    })
  }, [props, health])

  const copy = useCallback(() => {
    const table = creatorExportTable(props.snapshot, health)
    void navigator.clipboard.writeText(toTsvRow(table.row)).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }, [props.snapshot, health])

  return (
    <>
      <h3 className="ws-name">{props.snapshot.name}</h3>
      <p className="ws-handle">{props.snapshot.handle ?? props.snapshot.external_id}</p>
      <StatRow
        items={[
          { label: '粉丝', value: formatCount(props.snapshot.followers) },
          { label: '平均播放', value: formatCount(health.avg_views) },
          { label: '播放/粉丝', value: formatRatioPercent(health.views_to_followers) },
        ]}
      />
      <Verdict kind={health.verdict} text={CREATOR_VERDICT_TEXT[health.verdict]} />
      <div className="ws-actions">
        <button type="button" className="ws-btn ws-btn--primary" onClick={save} disabled={busy}>
          {busy ? '正在收…' : '收进红人库'}
        </button>
        <button type="button" className="ws-btn ws-btn--ghost" onClick={copy}>
          {copied ? '复制好了，去表格里粘一下' : '复制一行（不用登录）'}
        </button>
      </div>
      {outcome === undefined ? null : <OutcomeNote outcome={outcome} />}
    </>
  )
}

function ContentCard(props: { snapshot: ContentSnapshot }): React.ReactNode {
  const health: ContentHealth = computeContentHealth(props.snapshot)
  return (
    <>
      <h3 className="ws-name">{props.snapshot.title ?? '这一条'}</h3>
      <p className="ws-handle">
        {props.snapshot.author.handle ?? props.snapshot.author.name ?? ''}
      </p>
      <StatRow
        items={[
          { label: '播放', value: formatCount(props.snapshot.views) },
          { label: '点赞', value: formatCount(props.snapshot.likes) },
          { label: '赞/播', value: formatRatioPercent(health.engagement_rate) },
        ]}
      />
      <Verdict kind={health.verdict} text={CONTENT_VERDICT_TEXT[health.verdict]} />
      <p className="ws-note">
        要把这个人收进红人库，去他的主页按一下——单条内容上的数字说明不了一个账号。
      </p>
    </>
  )
}

/** 回执。**如实说**：写进去了几条、共享了几条、还是只是排着。 */
export function OutcomeNote(props: { outcome: ObserveOutcome }): React.ReactNode {
  const o = props.outcome
  if (o.kind === 'saved') {
    const shared =
      o.forwarded_to_public_library > 0
        ? `，其中 ${o.forwarded_to_public_library} 条同时共享到了公共红人库`
        : ''
    return (
      <p className="ws-note" data-testid="ws-outcome">
        收进去了 {o.saved} 条{o.deduped > 0 ? `（${o.deduped} 条本来就有）` : ''}
        {shared}。
      </p>
    )
  }
  if (o.kind === 'queued') {
    return (
      <p className="ws-note ws-note--warn" data-testid="ws-outcome">
        {o.message}（现在排着 {o.queued} 条）
      </p>
    )
  }
  return (
    <p className="ws-note ws-note--warn" data-testid="ws-outcome">
      {o.message}
    </p>
  )
}

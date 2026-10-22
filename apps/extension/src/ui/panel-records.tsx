/**
 * WP413 侧边栏 ③ 记录：发出记录（工坊替你发出去的每一条）与记录去处（如飞书表）写进去没有。
 * 去处出问题时照实说原因；补写、改去处仍在工坊里做。
 */
import type { PanelRecord, PanelSinkView } from '@agentsws/browser-action'
import { ACTION_LABEL, clock } from '@/lib/panel/format'
import { IconAlert, IconCheck, IconExternal, IconInbox } from './panel-icons'

const SINK_STATE: Record<PanelSinkView['state'], string> = {
  pending_confirm: '等你在工坊里确认',
  active: '在写',
  paused: '停了',
  broken: '出问题了',
}

function SinkResults(props: { record: PanelRecord }): React.ReactNode {
  if (props.record.sinks.length === 0) return null
  return (
    <div className="ws-sinkres" data-testid="ws-sinkres">
      {props.record.sinks.map((s) => {
        return (
          <span
            key={s.name}
            className={`ws-pill ws-pill--${s.status === 'written' ? 'good' : s.status === 'failed' ? 'bad' : 'wait'}`}
            title={s.message ?? (s.status === 'written' ? '写进去了' : '排着，等会儿写')}
          >
            {s.name}
          </span>
        )
      })}
    </div>
  )
}

export function PanelRecords(props: {
  records: PanelRecord[]
  sinks: PanelSinkView[]
  now?: Date
}): React.ReactNode {
  const now = props.now ?? new Date()
  return (
    <section className="ws-sec ws-records" data-testid="ws-records">
      {props.sinks.length === 0 ? null : (
        <ul className="ws-sinks" data-testid="ws-sinks">
          {props.sinks.map((s) => (
            <li key={s.name} className={`ws-sink ws-sink--${s.state}`}>
              {s.state === 'active' ? (
                <IconCheck className="ws-ico" />
              ) : (
                <IconAlert className="ws-ico" />
              )}
              <span className="ws-sink-name">{s.name}</span>
              <span className="ws-muted">
                {SINK_STATE[s.state]} · 已写 {s.written}
                {s.pending > 0 ? ` · 待写 ${s.pending}` : ''}
              </span>
              {s.last_error === undefined ? null : (
                <small className="ws-bad-text">{s.last_error}</small>
              )}
            </li>
          ))}
        </ul>
      )}
      {props.records.length === 0 ? (
        <p className="ws-empty" data-testid="ws-records-empty">
          <IconInbox className="ws-ico" /> 还没有发出记录
        </p>
      ) : (
        <ul className="ws-recs">
          {props.records.map((r) => (
            <li key={r.id} className="ws-rec" data-testid="ws-record" data-status={r.status}>
              <div className="ws-rec-head ws-muted">
                <time dateTime={r.sent_at}>{clock(r.sent_at, now)}</time>
                <span>{ACTION_LABEL[r.action] ?? r.action}</span>
                {r.destination === undefined ? null : <span>{r.destination}</span>}
                {r.status === 'sent' ? null : (
                  <span className="ws-pill ws-pill--bad">
                    {r.status === 'failed' ? '没发出去' : '已删'}
                  </span>
                )}
                {r.via_extension === true ? (
                  <span className="ws-tag" data-testid="ws-via-ext">
                    在插件里批的
                  </span>
                ) : null}
                {r.link === undefined ? null : (
                  <a
                    className="ws-iconbtn"
                    href={r.link}
                    target="_blank"
                    rel="noreferrer"
                    title="打开发出去的那一条"
                  >
                    <IconExternal className="ws-ico ws-ico--sm" />
                  </a>
                )}
              </div>
              <p className="ws-clamp-2" title={r.content}>
                {r.content}
              </p>
              <SinkResults record={r} />
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

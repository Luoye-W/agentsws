/**
 * WP413 侧边栏 ① 进度：读了什么、几点读的、下次几点、现在在做什么。读失败、被拦的照实显示。
 * 一块一行（图标 + 名字 + 条数），失败那一句小字跟在下面；巡查设置仍在工坊里改。
 */
import type { PanelProgress } from '@agentsws/browser-action'
import {
  nextLine,
  PART_LABEL,
  type PartTone,
  partLine,
  partTone,
  progressHead,
} from '@/lib/panel/format'
import { IconAlert, IconCheck, IconClock, IconMinus, IconX } from './panel-icons'

const TONE_ICON: Record<PartTone, (p: { className?: string }) => React.ReactNode> = {
  good: IconCheck,
  wait: IconClock,
  idle: IconMinus,
  warn: IconAlert,
  bad: IconX,
}

export function PanelProgressView(props: { progress: PanelProgress; now?: Date }): React.ReactNode {
  const p = props.progress
  const now = props.now ?? new Date()
  const next = nextLine(p, now)
  const parts = p.last_run?.parts ?? []
  return (
    <section className="ws-sec" data-testid="ws-progress">
      <div className="ws-sec-head">
        <b data-testid="ws-progress-head">{progressHead(p, now)}</b>
        {next === '' ? null : <span className="ws-muted">{next}</span>}
      </div>

      <div className="ws-account">
        <span>{p.account === undefined ? '品牌号' : `u/${p.account}`}</span>
        {p.reddit_connected === undefined ? null : (
          <span className={p.reddit_connected ? 'ws-pill ws-pill--good' : 'ws-pill ws-pill--warn'}>
            {p.reddit_connected ? 'Reddit 连着' : 'Reddit 没连'}
          </span>
        )}
      </div>
      {p.note === undefined ? null : <p className="ws-note ws-note--warn">{p.note}</p>}

      {parts.length === 0 ? null : (
        <ul className="ws-parts" data-testid="ws-parts">
          {parts.map((part) => {
            const tone = partTone(part)
            const Icon = TONE_ICON[tone]
            return (
              <li key={part.part} className={`ws-part ws-part--${tone}`}>
                <Icon className="ws-ico ws-part-ico" />
                <span className="ws-part-name">{PART_LABEL[part.part]}</span>
                <span className="ws-part-line">{partLine(part)}</span>
                {part.message === undefined || tone === 'good' ? null : (
                  <small className="ws-part-msg">{part.message}</small>
                )}
              </li>
            )
          })}
        </ul>
      )}

      <div className="ws-now" data-testid="ws-now">
        <span className="ws-chip" title="AI 正在写回复草稿的条数">
          起草中 <b>{p.drafting}</b>
        </span>
        <span className="ws-chip" title="读到的、要回还没处理的条数">
          待回 <b>{p.pending}</b>
        </span>
      </div>
      {p.configured ? null : (
        <p
          className="ws-note"
          title="自家版块、关键词、品牌号这些在 Agents 工坊的 Reddit 运营岗位里设"
        >
          巡查在工坊里设好后，这里会显示每次读了什么。
        </p>
      )}
    </section>
  )
}

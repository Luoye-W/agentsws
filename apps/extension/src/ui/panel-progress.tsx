/**
 * WP413 侧边栏 ① 进度：读了什么、几点读的、下次几点、现在在做什么。读失败、被拦的照实显示。
 * 一块一行（图标 + 名字 + 条数），失败那一句小字跟在下面；巡查设置仍在工坊里改。
 */
import type { PanelProgress, PanelStage } from '@agentsws/browser-action'
import {
  nextLine,
  PART_LABEL,
  type PartTone,
  partLine,
  partTone,
  progressHead,
  stageTone,
} from '@/lib/panel/format'
import { IconAlert, IconCheck, IconClock, IconInfo, IconMinus, IconX } from './panel-icons'

const TONE_ICON: Record<PartTone, (p: { className?: string }) => React.ReactNode> = {
  good: IconCheck,
  wait: IconClock,
  idle: IconMinus,
  warn: IconAlert,
  bad: IconX,
}

export function PanelProgressView(props: {
  progress: PanelProgress
  now?: Date
  /** WP419：在工坊里打开一张卡（口吻卡「去定」）。 */
  openCard?: (id: string) => void
}): React.ReactNode {
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
      {p.note === undefined ? null : (
        <p className="ws-note ws-note--warn">
          <IconAlert className="ws-ico" />
          <span className="ws-note-text">{p.note}</span>
        </p>
      )}

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

      <div className="ws-now ws-stat" data-testid="ws-now">
        <span className="ws-chip" title="AI 正在写回复草稿的条数">
          起草中 <b>{p.drafting}</b>
        </span>
        <span className="ws-chip" title="读到的、要回还没处理的条数">
          待回 <b>{p.pending}</b>
        </span>
        {p.replied_before === undefined ? null : (
          <span
            className="ws-chip"
            title="品牌号在这一串里已经回过，没再起草（最近 7 天）"
            data-testid="ws-replied-before"
          >
            已回过 <b>{p.replied_before}</b>
          </span>
        )}
      </div>
      {p.stage === undefined ? null : (
        <StageLine
          stage={p.stage}
          {...(props.openCard === undefined ? {} : { openCard: props.openCard })}
        />
      )}
      {p.configured ? null : (
        <p
          className="ws-note"
          title="自家版块、关键词、品牌号这些在 Agents 工坊的 Reddit 运营岗位里设"
        >
          <IconInfo className="ws-ico" />
          <span className="ws-note-text">巡查在工坊里设好后，这里会显示每次读了什么。</span>
        </p>
      )}
    </section>
  )
}

/**
 * WP419（自查 R5 / U17）：起草那一头卡在哪一步——一行字 + 要你动手时一个按钮（口吻卡「去定」在工坊里打开）。
 * 进度块和「要你处理」空着时都用它。
 */
export function StageLine(props: {
  stage: PanelStage
  openCard?: (id: string) => void
}): React.ReactNode {
  const st = props.stage
  const warn = stageTone(st.kind) === 'warn'
  const Icon = warn ? IconAlert : IconClock
  return (
    <p
      className={`ws-stage ws-note${warn ? ' ws-note--warn' : ''}`}
      data-testid="ws-stage"
      data-kind={st.kind}
    >
      <Icon className="ws-ico" />
      <span>{st.text}</span>
      {st.card_id === undefined || props.openCard === undefined ? null : (
        <button
          type="button"
          className="ws-link ws-note-end"
          data-testid="ws-stage-open"
          onClick={() => props.openCard?.(st.card_id ?? '')}
        >
          去定
        </button>
      )}
    </p>
  )
}

/**
 * PositionCard（画布首页那一排）：图标徽 + 待审大数字 + 一句状态 + 持有人头像 +
 *「交给它一件事」。
 *
 * 36 §3 / 54：**岗位是任务主入口**——所以这张卡上最显眼的是"几张等你决定"和
 * 那个把活儿交出去的按钮，不是岗位名。`selected` 是当前岗位的光晕态。
 */
import { BrandMark } from './brand-mark'
import { WsAvatar, WsCard } from './primitives'
import { TONE_BADGE, type Tone } from './tone'

export interface PositionCardHolder {
  /** person id：只用来给头像定底色（WP100），一个字都不印出来。 */
  id?: string
  name: string
  tone?: Tone
}

export function PositionCard({
  icon,
  tone = 'brand',
  name,
  pending,
  pendingLabel,
  line,
  holders = [],
  menu,
  running,
  runningLabel,
  runningHint,
  selected,
  entryLabel,
  onEntry,
  onOpen,
}: {
  icon?: React.ReactNode
  tone?: Tone
  name: string
  /** 待审张数（已经是数字，不是"几张"那句话） */
  pending: number
  /** "张待审" 这几个字（i18n 从外面传） */
  pendingLabel: string
  /** 一句状态：例如 "改价 1 待审 · 库存告急 3 个 SKU · 日报已出" */
  line: string
  holders?: PositionCardHolder[]
  /**
   * WP98：画布上卡头右上角那个 `···`。
   *
   * 里面装的是这个岗位的快捷提示（WP84 原来平铺在首页岗位卡下面的那一串芯片）。
   * 这一层只留一个插槽，不知道里面是什么——菜单的内容与路由都在页面那边。
   */
  menu?: React.ReactNode
  /**
   * WP112：这个岗位现在**有活在跑**吗。
   *
   * 真的在跑才给——卡头上多一个呼吸的标记，它在全站只代表一件事：
   * "Agent 正在替你干活"（docs/36 §12）。不跑的时候整个不出，
   * 而不是给一个灰掉的点：一个永远在那儿的状态点等于没有状态。
   */
  running?: boolean
  /** 状态点的名字（"运行中"）：读屏念的就是它。 */
  runningLabel?: string
  /** hover 上去才说的细节（"运行中 · 3 件在办"）。不给就只说 `runningLabel`。 */
  runningHint?: string
  selected?: boolean
  entryLabel: string
  onEntry?: () => void
  onOpen?: () => void
}): React.ReactNode {
  return (
    <WsCard
      data-testid="ws-position-card"
      data-position={name}
      {...(selected === undefined ? {} : { selected })}
      className="flex flex-col gap-3 p-[18px]"
    >
      <div className="flex items-center gap-2.5">
        {icon === undefined ? null : (
          <span
            className={`inline-flex size-9 items-center justify-center rounded-xl ${TONE_BADGE[tone]}`}
          >
            {icon}
          </span>
        )}
        {onOpen === undefined ? (
          <span className="ws-display text-[15px]">{name}</span>
        ) : (
          <button
            type="button"
            data-testid="ws-position-card-open"
            onClick={onOpen}
            className="ws-display text-left text-[15px] hover:underline"
          >
            {name}
          </button>
        )}
        {running === true && runningLabel !== undefined ? (
          // 一个**状态点**，不是一句话：WP98 已经把"N 件在办"从卡面上拿掉了
          // （它和那个 28px 的大数字说的是同一件事）。这里只留那一下呼吸，
          // 具体几件在 hover 与读屏里说。
          <span data-testid="ws-position-running" title={runningHint ?? runningLabel}>
            <BrandMark size={14} motion="breathe" label={runningLabel} />
          </span>
        ) : null}
        {menu === undefined ? null : <span className="ml-auto">{menu}</span>}
      </div>
      <div className="flex items-baseline gap-2">
        <span className="ws-display text-[28px] leading-none" data-testid="ws-position-pending">
          {pending}
        </span>
        <span className="text-[13px] text-ws-muted-fg">{pendingLabel}</span>
      </div>
      <p className="text-[12.5px] leading-[18px] text-ws-muted-fg">{line}</p>
      <div className="flex items-center gap-2">
        <span className="flex pl-1.5">
          {holders.map((h) => (
            <WsAvatar
              key={h.id ?? h.name}
              name={h.name}
              {...(h.id === undefined ? {} : { id: h.id })}
              {...(h.tone === undefined ? {} : { tone: h.tone })}
              className="-ml-1.5 ring-2 ring-ws-card"
            />
          ))}
        </span>
        <span className="flex-1" />
        <button
          type="button"
          data-testid="ws-position-entry"
          onClick={onEntry}
          className={`inline-flex h-8 items-center rounded-[10px] px-3 text-xs font-medium ${
            selected === true
              ? 'bg-ws-brand text-ws-brand-fg'
              : 'bg-ws-surface text-ws-ink hover:bg-ws-tint'
          }`}
        >
          {entryLabel}
        </button>
      </div>
    </WsCard>
  )
}

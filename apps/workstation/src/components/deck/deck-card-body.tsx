/**
 * WP96：卡的**主体**按 `card.layout` 换排版（十一种，09-18 设计画布《卡片排版一览》）。
 *
 * 分工（画布上那句"头一行、按钮行全类共用"）：
 * - 通用头（岗位 · 类 胶囊 / 等待时长 / 提案人头像）、通用页脚（按钮行 + 右下 → 圆钮）
 *   在 `deck-card.tsx` 里，全类一份；
 * - 这个文件只管中间那一块，十一个分支，**一个 kind 都不 switch**——它只看 layout，
 *   而 layout 是服务端投影时算好一起下发的（`@agentsws/deck` 的 layout.ts）。
 *
 * 纪律照旧：这里只**排版**，不算数也不编。payload 里没有的字段就不出那一格，
 * 绝不用"—"以外的东西填空（14 §2 数字不经模型手）。
 */
import type { DeckCard, DeckContentMode } from '@agentsws/deck'
import { pickContent } from '@agentsws/deck'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { useApp } from '@/lib/app-context'

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined)

/** 把 payload 里的一个值压成一行人看得懂的字；对象就 JSON，别硬编成句子。 */
function valueText(v: unknown): string {
  if (v === undefined || v === null) return '—'
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  return JSON.stringify(v)
}

/** payload 里的 before / after 摊成键值对；不是对象就当成单个值。 */
function pairs(v: unknown): [string, string][] {
  if (isRecord(v)) return Object.entries(v).map(([k, x]) => [k, valueText(x)])
  if (v === undefined) return []
  return [['', valueText(v)]]
}

function highlightText(card: DeckCard, type: string): string | undefined {
  return card.highlights.find((h) => h.type === type)?.text
}

/** 灰底的一段话（依据 / 正文 / 原话都用它）。 */
function Note({
  children,
  testId,
}: {
  children: React.ReactNode
  testId?: string
}): React.ReactNode {
  return (
    <p
      {...(testId === undefined ? {} : { 'data-testid': testId })}
      className="rounded-[10px] bg-ws-surface p-3 text-sm leading-6 whitespace-pre-wrap text-ws-body"
    >
      {children}
    </p>
  )
}

/**
 * 规范自检那一行（71 §5，WP122）：这批产出物有哪些地方不合这个品牌的
 * `DESIGN.md`（色板外的颜色、字体表外的字体……）。
 *
 * 排版上刻意做成**一行灰字**：不是红章、不是警告框、更不是按钮上的一把锁。
 * 这一行没有任何一条通路能让这张卡批不下去——品牌规范是给人省事的，
 * 一个会拦住人的检查，人只会想办法关掉它。
 */
function DesignNoteLine({ card }: { card: DeckCard }): React.ReactNode {
  const note = highlightText(card, 'design_note')
  if (note === undefined) return null
  return (
    <p className="mt-1.5 text-xs text-ws-muted-fg" data-testid="deck-design-note">
      {note}
    </p>
  )
}

/** 键值对表（金钱卡右半、事后决定卡、策略卡都用它）。 */
function KeyValues({
  rows,
  testId,
}: {
  rows: [string, string][]
  testId: string
}): React.ReactNode {
  if (rows.length === 0) return null
  return (
    <dl
      data-testid={testId}
      className="grid grid-cols-[auto_1fr] items-baseline gap-x-3 gap-y-1.5 text-[13px]"
    >
      {rows.map(([k, v]) => (
        <div key={`${k}:${v}`} className="col-span-2 grid grid-cols-subgrid">
          <dt className="text-ws-muted-fg">{k === '' ? '值' : k}</dt>
          <dd className="ws-num truncate text-right">{v}</dd>
        </div>
      ))}
    </dl>
  )
}

/** before / after 双格（② 改动卡与 ⑪ 策略卡共用的那一块）。 */
function BeforeAfter({ before, after }: { before: unknown; after: unknown }): React.ReactNode {
  const { t } = useApp()
  const b = pairs(before)
  const a = pairs(after)
  if (b.length === 0 && a.length === 0) return null
  return (
    <div className="grid grid-cols-2 gap-2.5" data-testid="deck-before-after">
      <div className="rounded-[10px] bg-ws-surface p-2.5">
        <div className="text-[11px] tracking-wider text-ws-muted-fg uppercase">
          {t('deck.before')}
        </div>
        <div className="ws-num mt-1 space-y-0.5 text-[13px]">
          {b.map(([k, v]) => (
            <div key={`b:${k}:${v}`} className="truncate">
              {k === '' ? v : `${k}: ${v}`}
            </div>
          ))}
        </div>
      </div>
      <div className="rounded-[10px] bg-ws-good-bg p-2.5">
        <div className="text-[11px] tracking-wider text-ws-good uppercase">{t('deck.after')}</div>
        <div className="ws-num mt-1 space-y-0.5 text-[13px]">
          {a.map(([k, v]) => (
            <div key={`a:${k}:${v}`} className="truncate">
              {k === '' ? v : `${k}: ${v}`}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

/**
 * 选项单选列表（⑤ 选择卡的主体）。
 *
 * 36 §2.1：带 `options` 的卡**裸 approve 服务端会拒**，所以只要这张卡有选项，
 * 单选列表就必须在卡面上——哪怕它的主体排版是 ⑪ 策略卡那种配置 diff
 * （`policy_change` 正是这种：又有 before/after，又是问句）。
 */
function OptionList({
  options,
  option,
  onOption,
}: {
  options: { id: string; label: string }[]
  option: string
  onOption: (id: string) => void
}): React.ReactNode {
  const { t } = useApp()
  return (
    <fieldset className="rounded-[10px] bg-ws-surface p-3" data-testid="deck-card-options">
      <legend className="px-1 text-xs text-ws-muted-fg">{t('card.options.hint')}</legend>
      <RadioGroup value={option} onValueChange={onOption}>
        {options.map((o) => (
          <Label key={o.id} className="flex items-center gap-2 font-normal">
            <RadioGroupItem value={o.id} />
            <span>{o.label}</span>
          </Label>
        ))}
      </RadioGroup>
    </fieldset>
  )
}

/** ① 出站文案：正文整段给人看（这一格是 37 §1 第 4 行的"一次一种语言"）。 */
function OutboundBody({ card, mode }: { card: DeckCard; mode: DeckContentMode }): React.ReactNode {
  const { t } = useApp()
  const content = pickContent(card.content_variants, mode)
  return (
    <>
      <p
        data-testid="deck-content"
        data-mode={content.mode}
        className="mt-2.5 rounded-[10px] bg-ws-surface p-3 text-sm leading-6 whitespace-pre-wrap"
      >
        {content.text}
      </p>
      {content.fell_back ? (
        <p data-testid="deck-content-fallback" className="mt-1.5 text-xs text-ws-warn">
          {t('deck.content.fallback')}
        </p>
      ) : null}
    </>
  )
}

export function DeckCardBody({
  card,
  mode,
  option,
  onOption,
  onOpen,
}: {
  card: DeckCard
  mode: DeckContentMode
  /** 选择题卡当前选中的选项 id */
  option: string
  onOption: (id: string) => void
  onOpen: () => void
}): React.ReactNode {
  const { t } = useApp()
  const payload = isRecord(card.detail.payload) ? card.detail.payload : {}
  const content = pickContent(card.content_variants, mode)
  const options = card.options ?? []

  const main = ((): React.ReactNode => {
    switch (card.layout) {
      // ⑤ 选择：单选列表，不猜。选项来自服务端，前端不编第三个。
      case 'choice':
        return (
          <div className="mt-2.5" data-testid="deck-layout-choice">
            {options.length === 0 ? (
              <OutboundBody card={card} mode={mode} />
            ) : (
              <OptionList options={options} option={option} onOption={onOption} />
            )}
          </div>
        )

      // ② 改动：before / after 双格是主体，一句依据放下面
      case 'change':
        return (
          <div className="mt-2.5 flex flex-col gap-2.5" data-testid="deck-layout-change">
            <BeforeAfter before={payload.before} after={payload.after} />
            <Note testId="deck-reason">{content.text}</Note>
          </div>
        )

      // ⑪ 策略：配置 diff。与 ② 同一块双格，但下面那句是"谁能批"而不是"依据"
      case 'policy':
        return (
          <div className="mt-2.5 flex flex-col gap-2.5" data-testid="deck-layout-policy">
            <BeforeAfter before={payload.before} after={payload.after} />
            <Note testId="deck-reason">{content.text}</Note>
            <p className="text-xs text-ws-muted-fg">{t('deck.policy.owner_only')}</p>
          </div>
        )

      // ③ 发布：左预览右说明；排期时间与受众数**必现**（15 §2 / 56 §2）
      case 'publish': {
        const preview = str(payload.preview_image) ?? str(payload.image_url)
        const scheduled = highlightText(card, 'scheduled')
        const audience = highlightText(card, 'audience')
        return (
          <div className="mt-2.5 flex gap-3" data-testid="deck-layout-publish">
            <div
              data-testid="deck-publish-preview"
              className="size-24 flex-none overflow-hidden rounded-xl bg-ws-tint"
            >
              {preview === undefined ? null : (
                <img src={preview} alt="" className="size-full object-cover" />
              )}
            </div>
            <div className="min-w-0 flex-1 text-[13px] leading-5 text-ws-body">
              <p className="whitespace-pre-wrap">{content.text}</p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                <span className="inline-flex h-[22px] items-center rounded-md bg-ws-surface px-2 text-xs">
                  {t('deck.publish.when', { when: scheduled ?? t('deck.publish.now') })}
                </span>
                <span className="inline-flex h-[22px] items-center rounded-md bg-ws-surface px-2 text-xs">
                  {t('deck.publish.audience', { n: audience ?? '—' })}
                </span>
              </div>
              <DesignNoteLine card={card} />
            </div>
          </div>
        )
      }

      // ④ 金钱：金额一个大字，旁边是额度与依据的键值对
      case 'money': {
        const amount = highlightText(card, 'amount') ?? valueText(payload.amount)
        const rows = pairs(payload.caps).concat(pairs(payload.basis))
        return (
          <div className="mt-2.5 flex flex-col gap-2.5" data-testid="deck-layout-money">
            <div className="flex items-end gap-3.5">
              <span className="ws-display text-[30px] leading-none" data-testid="deck-money-amount">
                {amount}
              </span>
              <div className="flex-1">
                <KeyValues rows={rows} testId="deck-money-kv" />
              </div>
            </div>
            <Note testId="deck-reason">{content.text}</Note>
          </div>
        )
      }

      // ⑥ 变体：N 张缩略图，人点一张（定稿入库另出一张 L1 卡）
      case 'variants': {
        const variants = Array.isArray(payload.variants) ? payload.variants : []
        return (
          <div className="mt-2.5 flex flex-col gap-2.5" data-testid="deck-layout-variants">
            <div className="grid grid-cols-3 gap-2" data-testid="deck-variant-grid">
              {variants.map((v, i) => {
                const rec = isRecord(v) ? v : {}
                const id = str(rec.id) ?? String(i)
                const url = str(rec.url) ?? str(rec.preview_image)
                const selected = option === id
                return (
                  <button
                    key={id}
                    type="button"
                    data-testid="deck-variant"
                    data-selected={selected ? 'true' : undefined}
                    aria-pressed={selected}
                    onClick={() => {
                      onOption(id)
                    }}
                    className={`aspect-[4/3] overflow-hidden rounded-[10px] bg-ws-tint ${
                      selected ? 'ring-2 ring-ws-brand' : ''
                    }`}
                  >
                    {url === undefined ? null : (
                      <img
                        src={url}
                        alt={str(rec.label) ?? id}
                        className="size-full object-cover"
                      />
                    )}
                  </button>
                )
              })}
            </div>
            {variants.length === 0 ? <Note>{content.text}</Note> : null}
            <DesignNoteLine card={card} />
          </div>
        )
      }

      // ⑦ 事后决定：系统已经做了一件事，判据键值对是主体，问的是"要不要改回来"
      case 'aftermath': {
        const rows = pairs(payload.facts).concat(pairs(payload.after))
        return (
          <div className="mt-2.5 flex flex-col gap-2.5" data-testid="deck-layout-aftermath">
            <div className="rounded-[10px] bg-ws-surface p-3">
              {rows.length === 0 ? (
                <p className="text-[13px] text-ws-body">{content.text}</p>
              ) : (
                <KeyValues rows={rows} testId="deck-aftermath-kv" />
              )}
            </div>
            {rows.length === 0 ? null : <Note testId="deck-reason">{content.text}</Note>}
          </div>
        )
      }

      // ⑧ 人物：头像 + 资料摘要 + 规则匹配结果
      case 'person': {
        const who = isRecord(payload.person) ? payload.person : {}
        const name = str(who.name) ?? str(payload.name) ?? t('deck.person.unknown')
        const profile = str(who.profile) ?? str(payload.profile)
        return (
          <div className="mt-2.5 flex flex-col gap-2.5" data-testid="deck-layout-person">
            <div className="flex items-center gap-3">
              <span
                data-testid="deck-person-avatar"
                className="inline-flex size-10 flex-none items-center justify-center rounded-full bg-ws-info-bg text-sm font-semibold text-ws-info"
              >
                {name.slice(0, 1)}
              </span>
              <div className="min-w-0 flex-1 text-[13px] leading-5">
                <b>{name}</b>
                {profile === undefined ? null : <div className="text-ws-muted-fg">{profile}</div>}
              </div>
            </div>
            <Note testId="deck-reason">{content.text}</Note>
          </div>
        )
      }

      // ⑨ 转交 / 认领：主体是**原话** + 分类依据
      case 'handoff': {
        const quote = str(payload.quote) ?? str(payload.original) ?? content.text
        return (
          <div className="mt-2.5 flex flex-col gap-2.5" data-testid="deck-layout-handoff">
            <blockquote
              data-testid="deck-quote"
              className="rounded-[10px] bg-ws-surface p-3 text-[13px] leading-5 whitespace-pre-wrap text-ws-body"
            >
              {quote}
            </blockquote>
            <p className="text-xs text-ws-muted-fg">
              {t('deck.handoff.basis', { basis: str(payload.reason) ?? content.text })}
            </p>
          </div>
        )
      }

      /*
       * ⑩ 接管：只说发生了什么、人要做什么。
       *
       * **Agent 不重试**，也不替人输密码——那个按钮把受控浏览器打开，剩下的是人的事。
       */
      case 'takeover': {
        const url = str(payload.url) ?? str(payload.target_url)
        return (
          <div className="mt-2.5 flex flex-col gap-2.5" data-testid="deck-layout-takeover">
            <Note testId="deck-reason">{content.text}</Note>
            <button
              type="button"
              data-testid="deck-takeover-open"
              onClick={onOpen}
              className="inline-flex h-8 w-fit items-center rounded-[10px] bg-ws-brand px-3 text-xs font-medium text-ws-brand-fg"
            >
              {t('deck.takeover.open')}
            </button>
            {url === undefined ? null : <p className="truncate text-xs text-ws-muted-fg">{url}</p>}
          </div>
        )
      }

      // ① 出站文案（也是兜底）
      default:
        return (
          <div data-testid="deck-layout-outbound">
            <OutboundBody card={card} mode={mode} />
          </div>
        )
    }
  })()

  /*
   * 有选项就一定要有单选列表（36 §2.1 裸 approve 会被拒）。
   * ⑤ 自己就是列表，⑥ 的缩略图格本身就是选法——只有这两种不再追加一份。
   */
  const needsOptions = options.length > 0 && card.layout !== 'choice' && card.layout !== 'variants'
  return (
    <>
      {main}
      {needsOptions ? (
        <div className="mt-2.5">
          <OptionList options={options} option={option} onOption={onOption} />
        </div>
      ) : null}
    </>
  )
}

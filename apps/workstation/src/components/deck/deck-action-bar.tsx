/**
 * 四段式的第 ④ 段：动作行（37 §1 第 6 行）。
 *
 * **WP100（09-18 画布收口）：按钮上的字按 `card.layout` 走**（`@agentsws/deck` 的
 * `LAYOUT_VERBS`）。WP96 之后十一种卡的按钮行一律是"批准 / 驳回 / 指导 / 需要补素材 /
 * 稍后"——而画布上它们各说各的话：出站文案卡写**发送**，变体卡写**就这张**，
 * 接管卡写**打开浏览器**。按钮上的字是人按下去之前唯一读的东西，十一种卡共用
 * 三个动词等于把"这一下会发生什么"从界面上抹掉。
 *
 * 换的只有**文案与摆放**：`approve` 还是 `approve`，动作矩阵、路由、审批状态机
 * 一个字没动（36 §2.1 五动作没有第六个）。
 *
 * 摆放（WP414，Luoye 10-19 真机）：
 * - **主动词**：左起第一个，实心。一张卡只有一个（有的卡主按钮在卡身里，这里就不出）；
 * - **次动词**：跟在后面，**一律是描边按钮**，依次「修改 / 不要 / 稍后」——底下那几个只是文字时
 *   用户会以为是说明；「稍后」不再收进 `···`（有的卡暂时不知道怎么处理，要能一眼跳过）；
 *   「需要补素材」并进「修改」（点开同一个框：说一句怎么改，或贴素材）；
 * - **`···`**：只留真正少用的（主次都排不上的动作）；没有就不出。
 *
 * WP456-T3（规范 §2.6 第 10 / 13 条）：按钮走四级里的「主 / 次」两级——主按钮品牌色实底（还不能点时 40% 透明，
 * 不另起一种淡绿），其余一律**次按钮（灰底）**：WP414 定过「只是文字的按钮会被当成说明」，所以「稍后」也不降成弱按钮。
 * 「先选一个」那句灰字去掉（主按钮淡着就说明了，悬停再说一遍）；快捷键写进每颗按钮的悬停提示。
 */
import { FOLLOW_UP_CARD_FORM } from '@agentsws/contracts'
import type { DeckAction, DeckCard } from '@agentsws/deck'
import {
  CONFIRM_ONLY_FORMS,
  LAYOUT_VERBS,
  MANUAL_SEND_VERB_KIND,
  verbKey,
  verbRank,
} from '@agentsws/deck'
import { MoreHorizontal } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { type FootAction, FootButton } from '@/components/deck/card-foot'
import { kolBatchCount } from '@/components/kol/kol-card-bodies'
import { useMode } from '@/lib/mode'
import { cn } from '@/lib/utils'

/** 方向键 → 动作（和 `deck-keys.ts` 同一张表）；按钮悬停时写「→ 通过」。 */
const KEY_OF: Partial<Record<DeckAction, string>> = {
  approve: '→',
  reject: '←',
  snooze: '↑',
  instruct: '↓',
}

/** 主动词 + 「修改 / 不要 / 稍后」。 */
export const MAX_QUICK_ACTIONS = 4

/**
 * WP418（审计 U9）：发布主题卡借了「发布」排版，但它不是发帖——按钮是「发布 / 不发」，
 * 没有「改时间」（WP414 起次按钮统一「修改 / 不要 / 稍后」，「修改」照常外露）。
 */
const themePublish = (card: DeckCard): boolean => card.change_kind === 'publish_theme'

/** 按钮行上排得上的全部动作（主 + 次，按 `LAYOUT_VERBS` 排；不截）。 */
function rowActions(card: DeckCard): DeckAction[] {
  const verbs = LAYOUT_VERBS[card.layout]
  // 排序按**表**走，不按 `available_actions` 的原序：画布上"发送 / 改一下 / 不发"
  // 的顺序是设计的一部分（最常按的那个在最左），而服务端那个数组是按 kind 给的
  const rank = (a: DeckAction): number =>
    a === verbs.primary ? 0 : 1 + (verbs.secondary as readonly DeckAction[]).indexOf(a)
  // WP324：连接卡 / 配置卡的主按钮（连接 / 保存）在卡身里——底下那排不再出一个点不对的「接着做」
  const form = (card.detail.payload as { form?: unknown } | undefined)?.form
  // WP329：Reddit「发出去」卡的「发送」也在卡身里（要带上卡上改过的字）
  // WP390：工坊服务卡的主按钮（下单 / 提交 / 同意并支付 / 通过…）也在卡身里
  const bodyPrimary =
    form === 'connect_request' ||
    form === 'setup_request' ||
    form === 'reddit_write' ||
    // WP387：建 / 改 Google 提醒——「确认」要带上卡上的勾选，在卡身里
    (card.detail.payload as { kind?: unknown } | undefined)?.kind === 'google_alert_change' ||
    (typeof form === 'string' && form.startsWith('service_')) ||
    // WP406：岗位更新的「全部应用 / 这次跳过」在卡身里（带选项）
    form === 'content_update_digest' ||
    // WP441：「要建这条规则吗」——「建」要带上「也处理过去 30 天的」那个勾，在卡身里
    form === 'message_rule' ||
    // WP489：「没对上红人的往来」那张卡的「记下」要带上卡里选的 / 填的，在卡身里
    form === 'kol_mail_match' ||
    // WP442：催促卡的「发出」「修改」都在卡身里（就地改字、带着改过的那一版批）
    form === FOLLOW_UP_CARD_FORM ||
    // WP488：「学到 N 条」的「采纳」要带上卡上改过的范围 / 去掉的几条；「可能过期」两个选项也在卡身里
    form === 'knowledge_learned' ||
    form === 'knowledge_stale'
  return (
    card.available_actions
      .filter((a) => a !== 'open' && verbRank(card.layout, a) !== 'more')
      .filter((a) => !(bodyPrimary && a === 'approve'))
      // WP441：「要建这条规则吗」的「修改」在卡身里（把原话带回规则面板）；WP442 催促卡的「修改」也在卡身里
      .filter(
        (a) =>
          !(
            (form === 'message_rule' ||
              form === FOLLOW_UP_CARD_FORM ||
              form === 'kol_mail_match') &&
            a === 'instruct'
          ),
      )
      // WP508：只有确认含义的卡（停用 / 启用知识、整批导入……）没有「修改」——服务端已经不给，这里再兜一层
      .filter(
        (a) => !(typeof form === 'string' && CONFIRM_ONLY_FORMS.has(form) && a === 'instruct'),
      )
      .sort((a, b) => rank(a) - rank(b))
  )
}

/**
 * 按钮行上的那几个：主动词 + 次动词，按 `LAYOUT_VERBS` 排，最多四个。
 *
 * 只出这张卡**真有**的动作（`available_actions` 是服务端按 kind × state 给的，
 * 这里一个都不添）。
 */
export function quickActions(card: DeckCard): DeckAction[] {
  return rowActions(card).slice(0, MAX_QUICK_ACTIONS)
}

/**
 * 这个动作在这张卡上写什么字（按钮行、`···` 菜单、键盘提示行共用一份）。
 *
 * 顺序是有意的：**排版的动词赢过服务端给的 `action_labels`**——后者是 WP15 那版
 * 按 kind 给的中文（只有中文），而排版这一张表是中英齐的，且与画布逐条对得上。
 * 两张表都没有的（`open`）才退回服务端那份与通用动词。
 */
export function deckActionLabel(card: DeckCard, a: DeckAction, t: (key: string) => string): string {
  // WP415：没接通的卡上「不要」写成「知道了」（批不了，只能记下来自己去办）
  if (card.wiring?.state === 'not_wired' && a === 'reject') return t('exec.ack')
  // WP276：「X 想把「…」交给你」——接下 / 不接（不是「认领 / 不是客户问题」）
  if ((card.detail.payload as { form?: unknown } | undefined)?.form === 'handoff') {
    if (a === 'approve') return t('handoff.accept')
    if (a === 'reject') return t('handoff.decline')
  }
  // WP442：催促卡底下那排是「再等等」（顺延 3 个工作日）/「不用跟了」
  if ((card.detail.payload as { form?: unknown } | undefined)?.form === FOLLOW_UP_CARD_FORM) {
    if (a === 'snooze') return t('follow_up.verb.wait')
    if (a === 'reject') return t('follow_up.verb.stop')
  }
  // WP506（决策 1796 C）：AI 提议停用 / 启用知识——「停用 N 条」/「启用 N 条」·「不用」
  const toggle = card.detail.payload as { form?: unknown; action?: unknown; items?: unknown }
  if (toggle?.form === 'knowledge_toggle' && Array.isArray(toggle.items)) {
    if (a === 'approve')
      return t(
        toggle.action === 'enable' ? 'kl.toggle.approve.enable' : 'kl.toggle.approve.disable',
      ).replace('{n}', String(toggle.items.length))
    if (a === 'reject') return t('kl.toggle.reject')
  }
  // WP504（决策 1777 A）：批量开发信卡上主按钮写「发出 N 封」（N = 名单上真要发的人数）
  const batch = kolBatchCount(card.detail.payload)
  if (batch !== undefined && a === 'approve')
    return t('kol.batch.send').replace('{n}', String(batch))
  if (themePublish(card)) {
    if (a === 'approve') return t('verb.publish_theme.approve')
    if (a === 'reject') return t('verb.publish_theme.reject')
  }
  // WP232：收件人待定的草稿批了不发出去——按钮不能写「发送」
  const key = verbKey(
    card.layout,
    a,
    card.manual_send === true ? MANUAL_SEND_VERB_KIND : (card.change_kind ?? card.kind),
  )
  /*
   * WP287：借了「选择题」排版、却没有选项的卡（复盘之类）——「就这条 / 都不是」是错话，
   * 用这种卡自己的说法（服务端给的按钮字），没有就用通用动词。
   */
  const notAQuestion =
    card.layout === 'choice' &&
    (card.options ?? []).length === 0 &&
    key?.startsWith('verb.choice.') === true
  if (key !== undefined && !notAQuestion) return t(key)
  return card.action_labels?.[a] ?? t(`action.${a}`)
}

/** `···` 里的那几个：主次都排不上的动作（WP414 起一般没有——没有就不出 `···`）。 */
export function moreActions(card: DeckCard): DeckAction[] {
  return card.available_actions.filter((a) => a !== 'open' && verbRank(card.layout, a) === 'more')
}

export function DeckActionBar({
  card,
  disabled,
  optionMissing,
  onAction,
  extra,
  keys,
  lead,
}: {
  card: DeckCard
  disabled?: boolean
  /** 选择题卡还没选 → approve 按不动（36 §2.1：裸 approve 服务端会拒） */
  optionMissing?: boolean
  onAction: (action: DeckAction) => void
  /** WP219：主次按钮后面再放一个（内容更新卡的「查看改动」）。不是第四个决定，只是看。 */
  extra?: React.ReactNode
  /** WP456-T3：哪几个动作有方向键（悬停提示里写上）。 */
  keys?: readonly DeckAction[]
  /**
   * WP478：卡身报上来的那几颗（方案卡的「就这样 / 修改」……），排在这一排最前面；
   * 合起来超过 4 颗时多余的进「⋯」。
   */
  lead?: readonly FootAction[]
}): React.ReactNode {
  // WP275：按钮的字按模式换（① ② 是「通过 / 不要」）
  const { t } = useMode()
  const [open, setOpen] = useState(false)
  /**
   * WP275（docs/95 §5）：① ② 超了你设的上限——安全闸要你**再点一次**。第一下只把按钮换成
   * 「再点一次确认」，第二下才真的通过（键盘的 → 也是点这个按钮，同样要两下）。
   */
  const [armed, setArmed] = useState(false)
  const box = useRef<HTMLSpanElement>(null)
  const leading = lead ?? []
  /** 卡身已经有主按钮了：卡底这几个都是次按钮（一张卡只有一颗主按钮）。 */
  const leadPrimary = leading.some((a) => a.primary === true)
  // WP478：卡身那几颗 + 主次动作合成一排，最多 4 颗；多出来的和少用的一起进「⋯」
  const room = Math.max(0, MAX_QUICK_ACTIONS - leading.length)
  const shownLead = leading.slice(0, MAX_QUICK_ACTIONS)
  const overflowLead = leading.slice(MAX_QUICK_ACTIONS)
  const row = rowActions(card)
  const quick = row.slice(0, room)
  const more = [...row.slice(room), ...moreActions(card)]
  const hasMore = more.length + overflowLead.length > 0

  // 换卡就把菜单收回去（与折叠区同一条理由：上一张卡的状态不该出现在下一张上）
  // biome-ignore lint/correctness/useExhaustiveDependencies: 依赖就是"换了一张卡"这件事
  useEffect(() => {
    setOpen(false)
    setArmed(false)
  }, [card.id])

  /** 点菜单外面收起来（朴素下拉的那一条必备行为，与岗位卡的 `···` 同一个做法）。 */
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (box.current?.contains(e.target as Node) === true) return
      setOpen(false)
    }
    globalThis.addEventListener?.('mousedown', onDown)
    return () => {
      globalThis.removeEventListener?.('mousedown', onDown)
    }
  }, [open])

  const labelOf = (a: DeckAction): string => deckActionLabel(card, a, t)

  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="deck-action-bar">
      {shownLead.map((a) => (
        <FootButton
          key={`lead:${a.key}`}
          action={{ ...a, disabled: disabled === true || a.disabled === true }}
        />
      ))}
      {quick.map((action) => {
        const waiting = action === 'approve' && optionMissing === true
        const key = keys?.includes(action) === true ? KEY_OF[action] : undefined
        return (
          <button
            key={action}
            type="button"
            className={cn(
              'ws-btn',
              verbRank(card.layout, action) === 'primary' && !leadPrimary
                ? 'ws-btn-primary'
                : 'ws-btn-secondary',
            )}
            title={
              waiting
                ? t('deck.option_required')
                : key === undefined
                  ? undefined
                  : `${key} ${labelOf(action)}`
            }
            disabled={disabled === true || waiting}
            data-action={action}
            data-rank={verbRank(card.layout, action)}
            data-armed={action === 'approve' && armed ? 'true' : undefined}
            onClick={() => {
              if (action === 'approve' && card.reconfirm === true && !armed) {
                setArmed(true)
                return
              }
              onAction(action)
            }}
          >
            {action === 'approve' && armed ? t('deck.reconfirm.again') : labelOf(action)}
          </button>
        )
      })}
      {card.reconfirm === true ? (
        <span className="text-xs text-ws-warn" data-testid="deck-reconfirm-hint">
          {t('deck.reconfirm.hint')}
        </span>
      ) : null}
      {extra}
      {/* WP414：`···` 只留真正少用的（主次都排不上的动作）；WP478：一排超过 4 颗多出来的也进这里；没有就不出 */}
      {!hasMore ? null : (
        <span className="relative inline-flex" ref={box}>
          <button
            type="button"
            aria-expanded={open}
            aria-haspopup="menu"
            aria-label={t('deck.more')}
            title={t('deck.more')}
            data-testid="deck-more"
            disabled={disabled === true}
            className="inline-flex size-7 items-center justify-center rounded-md text-ws-muted-fg hover:bg-ws-surface hover:text-ws-ink disabled:opacity-50"
            onClick={() => {
              setOpen(!open)
            }}
          >
            <MoreHorizontal className="size-4" aria-hidden />
          </button>
          {open ? (
            // 与岗位卡的 `···`、账号块、品牌切换器同一种朴素下拉：一个按钮 + 一张列表
            <div
              role="menu"
              data-testid="deck-more-menu"
              className="absolute right-0 bottom-full z-50 mb-1 flex w-44 flex-col rounded-md border bg-popover p-1 shadow-md"
            >
              {overflowLead.map((a) => (
                <button
                  key={`lead:${a.key}`}
                  type="button"
                  role="menuitem"
                  data-foot={a.key}
                  data-testid={a.testId}
                  disabled={disabled === true || a.disabled === true}
                  className="rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent disabled:opacity-50"
                  onClick={() => {
                    setOpen(false)
                    a.onSelect()
                  }}
                >
                  {a.label}
                </button>
              ))}
              {more.map((action) => (
                <button
                  key={action}
                  type="button"
                  role="menuitem"
                  data-action={action}
                  className="rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent"
                  onClick={() => {
                    setOpen(false)
                    onAction(action)
                  }}
                >
                  {labelOf(action)}
                </button>
              ))}
            </div>
          ) : null}
        </span>
      )}
    </div>
  )
}

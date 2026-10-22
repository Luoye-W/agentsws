/**
 * WP276（docs/95 §4.3）：交给对方在页面上的那几行（少字：一行灰字 + 一两个按钮）。
 *
 * - {@link MatterHandoffBar}：事项页页头下面——发起人看到「等 Y 接 · 撤回」；接手人看到
 *   「X 想把这件事交给你 · 接下 / 不接」（同一件事卡片队列里也有那张卡，这里只是就地能点）。
 * - 接下 / 不接 / 退回了、上级派活：WP429 起进顶栏铃铛（站内通知），首页不再单出一行。
 * - {@link HandoffDecide}：卡片上的动作行——选项是自己的岗位（只有一个就是「接下」）+「不接」
 *   （理由可选：太忙 / 不归我 / 自己写一句）。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { getPositions } from '@/lib/api'
import { acceptHandoff, declineHandoff, listHandoffs, withdrawHandoff } from '@/lib/api-peers'
import { useApp } from '@/lib/app-context'

export const HANDOFFS_KEY = ['handoffs'] as const

/** 「X 想把「…」交给你」那张卡（`claim` 类、`form: 'handoff'`）。 */
export function isHandoffOfferCard(card: { kind: string; detail: { payload?: unknown } }): boolean {
  const p = card.detail.payload
  return (
    card.kind === 'claim' &&
    typeof p === 'object' &&
    p !== null &&
    (p as { form?: unknown }).form === 'handoff'
  )
}

/**
 * ② 改了共用东西的「知道了 / 撤回」通知卡（选项直接是按钮，不是单选 + 通过）。
 * WP277：开公司模式时同事收的「知道了 / 我要退出」也是这个样子。
 */
export function isPeerNoticeCard(card: { kind: string; detail: { payload?: unknown } }): boolean {
  const p = card.detail.payload
  const form = typeof p === 'object' && p !== null ? (p as { form?: unknown }).form : undefined
  return (
    card.kind === 'policy_change' &&
    (form === 'peer_change_notice' ||
      form === 'company_notice' ||
      // WP284：「以后都这样」那张——「记进规矩 / 不用」也直接是两个按钮
      form === 'instruction_rule' ||
      // WP322：FAQ 导入那张——「记下 / 只加新的 / 不用」（或「撤下 / 留着」）
      form === 'faq_import' ||
      // WP323：记录去处那张——「记下 / 不用」
      form === 'record_sink')
  )
}

/**
 * WP277：「知道了」型通知卡（② 的「知道了 / 撤回」、开公司模式的「知道了 / 我要退出」）上键盘干什么。
 *
 * 按钮就是卡上的选项，所以键盘也跟着选项走：→ 是第一个（知道了），← 是第二个（撤回）；
 * 「我要退出」这种走了就回不来的不给键盘，只能点按钮。↑ ↓ 不做事（这种卡没有稍后 / 指导）。
 * 不是这种卡回 `undefined`（照审批卡的老规矩）。
 */
export function noticeKeys(card: {
  kind: string
  detail: { payload?: unknown }
  options?: { id: string; label: string }[] | undefined
}): { right?: { id: string; label: string }; left?: { id: string; label: string } } | undefined {
  if (!isPeerNoticeCard(card)) return undefined
  const options = card.options ?? []
  const [first] = options
  // WP322：FAQ 导入那张有三个选项（记下 / 只加新的 / 不用）——← 是最后那个「不用」，不是中间那个
  const form = (card.detail.payload as { form?: unknown } | undefined)?.form
  const second =
    form === 'faq_import' && options.length > 2 ? options[options.length - 1] : options[1]
  return {
    ...(first === undefined ? {} : { right: first }),
    ...(second === undefined || second.id === 'leave' ? {} : { left: second }),
  }
}

/** 底座职责（不算一个能接活的岗位），与服务端同一份。 */
const BASE = new Set(['common.member', 'common.owner'])

/** 我能用哪几条分配接（每个岗位一个；与服务端出卡时的选项同一个口径）。 */
function useTakeOptions(): { id: string; label: string }[] {
  const positions = useQuery({ queryKey: ['positions'], queryFn: getPositions })
  const out: { id: string; label: string }[] = []
  for (const p of positions.data?.instances ?? []) {
    const hit = p.roles.find((r) => r.my_assignment_id !== undefined && !BASE.has(r.role_id))
    if (hit?.my_assignment_id !== undefined)
      out.push({ id: hit.my_assignment_id, label: p.name.zh })
  }
  return out
}

/** 「不接」那一块：两个常用理由 + 一行自己写（都可以不选）。 */
function DeclinePanel({
  busy,
  onCancel,
  onSend,
}: {
  busy: boolean
  onCancel: () => void
  onSend: (reason?: string) => void
}): React.ReactNode {
  const { t } = useApp()
  const [text, setText] = useState('')
  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="handoff-decline-panel">
      {(['busy', 'not_mine'] as const).map((k) => (
        <Button
          key={k}
          size="xs"
          variant="outline"
          disabled={busy}
          data-reason={k}
          onClick={() => {
            onSend(t(`handoff.reason.${k}`))
          }}
        >
          {t(`handoff.reason.${k}`)}
        </Button>
      ))}
      <Input
        className="h-7 w-48 text-xs"
        value={text}
        maxLength={200}
        placeholder={t('handoff.reason.placeholder')}
        onChange={(e) => {
          setText(e.target.value)
        }}
      />
      <Button
        size="xs"
        disabled={busy}
        data-testid="handoff-decline-send"
        onClick={() => {
          onSend(text.trim() === '' ? undefined : text.trim())
        }}
      >
        {t('handoff.decline.send')}
      </Button>
      <Button size="xs" variant="ghost" disabled={busy} onClick={onCancel}>
        {t('action.cancel')}
      </Button>
    </div>
  )
}

/** 卡片上的动作行（卡片决定走审批总线那条路：选项 = 用哪条分配接，拒绝 = 不接）。 */
export function HandoffDecide({
  options,
  busy,
  onAccept,
  onDecline,
}: {
  options: { id: string; label: string }[]
  busy: boolean
  onAccept: (option_id: string) => void
  onDecline: (reason?: string) => void
}): React.ReactNode {
  const { t } = useApp()
  const [declining, setDeclining] = useState(false)
  if (declining)
    return (
      <DeclinePanel
        busy={busy}
        onCancel={() => {
          setDeclining(false)
        }}
        onSend={(reason) => {
          setDeclining(false)
          onDecline(reason)
        }}
      />
    )
  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="deck-handoff">
      {options.map((o, i) => (
        <Button
          key={o.id}
          size="sm"
          variant={i === 0 ? 'default' : 'outline'}
          disabled={busy}
          data-option={o.id}
          onClick={() => {
            onAccept(o.id)
          }}
        >
          {o.label}
        </Button>
      ))}
      <Button
        size="sm"
        variant="ghost"
        disabled={busy}
        data-testid="handoff-decline"
        data-action="reject"
        onClick={() => {
          setDeclining(true)
        }}
      >
        {t('handoff.decline')}
      </Button>
    </div>
  )
}

/** 事项页页头下面那一行。 */
export function MatterHandoffBar({
  matterId,
  me,
}: {
  matterId: string
  me: string | undefined
}): React.ReactNode {
  const { t } = useApp()
  const client = useQueryClient()
  const [declining, setDeclining] = useState(false)
  const lists = useQuery({ queryKey: HANDOFFS_KEY, queryFn: () => listHandoffs(), retry: false })
  const takes = useTakeOptions()
  const refresh = async (): Promise<void> => {
    await client.invalidateQueries({ queryKey: HANDOFFS_KEY })
    await client.invalidateQueries({ queryKey: ['matter', matterId] })
    await client.invalidateQueries({ queryKey: ['approvals'] })
  }
  const act = useMutation({
    mutationFn: async (
      input:
        | { kind: 'accept'; position_id?: string }
        | { kind: 'decline'; reason?: string }
        | {
            kind: 'withdraw'
          },
    ) => {
      if (input.kind === 'accept') return acceptHandoff('matter', matterId, input.position_id)
      if (input.kind === 'decline') return declineHandoff('matter', matterId, input.reason)
      return withdrawHandoff('matter', matterId)
    },
    onSuccess: refresh,
  })
  const mine = lists.data?.from_me.find(
    (h) => h.kind === 'matter' && h.id === matterId && h.handoff.state === 'offered',
  )
  const tome = lists.data?.to_me.find((h) => h.kind === 'matter' && h.id === matterId)
  if (mine !== undefined && mine.handoff.from === me)
    return (
      <div
        className="mt-2 flex items-center gap-2 text-[13px] text-ws-muted-fg"
        data-testid="matter-handoff-waiting"
      >
        <span>{t('handoff.waiting', { name: mine.to_label })}</span>
        <button
          type="button"
          className="underline-offset-2 hover:text-foreground hover:underline"
          data-testid="matter-handoff-withdraw"
          disabled={act.isPending}
          onClick={() => {
            act.mutate({ kind: 'withdraw' })
          }}
        >
          {t('handoff.withdraw')}
        </button>
      </div>
    )
  if (tome === undefined) return null
  return (
    <div
      className="mt-2 flex flex-wrap items-center gap-2 rounded-xl bg-ws-card px-3 py-2 text-[13px] shadow-ws"
      data-testid="matter-handoff-offered"
    >
      <span className="mr-1">{t('handoff.offered', { name: tome.from_label })}</span>
      {declining ? (
        <DeclinePanel
          busy={act.isPending}
          onCancel={() => {
            setDeclining(false)
          }}
          onSend={(reason) => {
            act.mutate({ kind: 'decline', ...(reason === undefined ? {} : { reason }) })
          }}
        />
      ) : (
        <>
          {(takes.length <= 1 ? [undefined] : takes).map((o, i) => (
            <Button
              key={o?.id ?? 'one'}
              size="xs"
              variant={i === 0 ? 'default' : 'outline'}
              disabled={act.isPending}
              data-testid="matter-handoff-accept"
              onClick={() => {
                act.mutate({ kind: 'accept', ...(o === undefined ? {} : { position_id: o.id }) })
              }}
            >
              {o === undefined
                ? t('handoff.accept')
                : t('handoff.accept.as', { position: o.label })}
            </Button>
          ))}
          <Button
            size="xs"
            variant="ghost"
            disabled={act.isPending}
            onClick={() => {
              setDeclining(true)
            }}
          >
            {t('handoff.decline')}
          </Button>
        </>
      )}
    </div>
  )
}

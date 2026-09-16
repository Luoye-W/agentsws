/**
 * WP73（56 §6 第四项）：社媒运营岗位页上的**内容日历周视图**。
 *
 * WP72 的"内容日历"只是 deck 上一张按时间排的只读表——看得出"接下来会发什么"，
 * 看不出"周四晚上是不是堆了三条"。这个组件把它换成七列 × 渠道行的一屏，
 * 并且让人**拖得动**。
 *
 * 四条界面纪律：
 *
 * 1. **撞车是服务端算的**。格子上那个 ⚠ 与它的说明来自
 *    `SocialCalendarCellData.conflicts`（`social-core` 的 `scheduleConflicts`）——
 *    界面一条判据都不自己写，否则迟早与卡面上那句话对不上。
 * 2. **拖一下 = 重新出一张卡**。换个时间发也是一次发布（`social_post` 永远 L1），
 *    所以拖完之后显示的是"已经提上去了，等人点头"，**不是**"改好了"。
 * 3. **四态看得出来**。草稿 / 排期 / 已发 / 退回各有各的样子；退回那一条**不隐藏**，
 *    它混进排期里就再也没人发现它没发出去。
 * 4. **空列也画出来**。周四一条都没有 ≠ 周四不存在——七列永远在，
 *    看得出"这周后半段是空的"才有排期这回事。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, CalendarDays, ChevronLeft, ChevronRight, Plus } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import {
  createSocialPost,
  getSocialAccounts,
  getSocialCalendar,
  rescheduleSocialPost,
  type SocialCalendarCellData,
  type SocialChannelId,
} from '@/lib/api'
import { useApp } from '@/lib/app-context'

const DAY_MS = 86_400_000

/** 职责 id → 渠道（`social.facebook-group` → `facebook_group`）。 */
export function socialChannelOfRole(role_id: string | undefined): SocialChannelId | undefined {
  if (role_id === undefined || !role_id.startsWith('social.')) return undefined
  const id = role_id.slice('social.'.length).replace(/-/g, '_')
  const all: SocialChannelId[] = [
    'meta',
    'tiktok',
    'x',
    'youtube',
    'facebook_group',
    'reddit',
    'discord',
    'telegram_group',
    'whatsapp',
  ]
  return all.find((c) => c === id)
}

/** 这一周的周一零点（本地时区；周一开始，不是周日——与服务端 `weekStart` 同一条约定）。 */
function mondayOf(at: Date): Date {
  const d = new Date(at)
  d.setHours(0, 0, 0, 0)
  const dow = (d.getDay() + 6) % 7
  d.setTime(d.getTime() - dow * DAY_MS)
  return d
}

const sameDay = (a: Date, b: Date): boolean =>
  a.getFullYear() === b.getFullYear() &&
  a.getMonth() === b.getMonth() &&
  a.getDate() === b.getDate()

/** 四态各有各的样子（纪律 3）。 */
const STATUS_CLASS: Record<string, string> = {
  draft: 'border-dashed border-muted-foreground/40 bg-muted/40',
  scheduled: 'border-primary/30 bg-primary/5',
  published: 'border-emerald-500/30 bg-emerald-500/5',
  failed: 'border-destructive/50 bg-destructive/10',
}

function Cell({
  cell,
  onDragStart,
}: {
  cell: SocialCalendarCellData
  onDragStart: (post_id: string) => void
}): React.ReactNode {
  const { t } = useApp()
  const at = new Date(cell.scheduled_at)
  const hh = String(at.getHours()).padStart(2, '0')
  const mm = String(at.getMinutes()).padStart(2, '0')
  return (
    <button
      type="button"
      draggable
      data-testid="social-calendar-cell"
      data-post={cell.post_id}
      data-status={cell.status}
      data-conflict={cell.conflicts.length > 0 ? 'true' : 'false'}
      onDragStart={() => {
        onDragStart(cell.post_id)
      }}
      className={`w-full rounded border px-1.5 py-1 text-left text-[11px] leading-tight ${
        STATUS_CLASS[cell.status] ?? 'border-muted bg-muted/30'
      }`}
      // 撞车那句话原样当成 tooltip：卡面上写的是同一句
      title={cell.conflicts.length === 0 ? cell.preview : cell.conflicts.join('\n')}
    >
      <span className="flex items-center gap-1 font-medium">
        {`${hh}:${mm}`}
        {cell.conflicts.length > 0 ? (
          <AlertTriangle className="size-3 text-destructive" aria-hidden />
        ) : null}
      </span>
      <span className="block truncate text-muted-foreground">{cell.preview}</span>
      {cell.status === 'failed' ? (
        <span className="block text-destructive">{t('social.calendar.failed')}</span>
      ) : null}
    </button>
  )
}

export function SocialCalendar({
  assignment,
  channel,
}: {
  assignment: string
  channel: SocialChannelId
}): React.ReactNode {
  const { t } = useApp()
  const client = useQueryClient()
  /** 往前 / 往后翻几周（0 = 本周）。 */
  const [offset, setOffset] = useState(0)
  const [dragging, setDragging] = useState<string | undefined>(undefined)
  const [note, setNote] = useState<string | undefined>(undefined)
  const [composing, setComposing] = useState<string | undefined>(undefined)
  const [draft, setDraft] = useState('')

  const start = new Date(mondayOf(new Date()).getTime() + offset * 7 * DAY_MS)
  const end = new Date(start.getTime() + 7 * DAY_MS)
  const days = Array.from({ length: 7 }, (_, i) => new Date(start.getTime() + i * DAY_MS))

  const calendar = useQuery({
    queryKey: ['social-calendar', assignment, start.toISOString()],
    queryFn: () =>
      getSocialCalendar({ from: start.toISOString(), to: end.toISOString() }, assignment),
  })
  const accounts = useQuery({
    queryKey: ['social-accounts', assignment, channel],
    queryFn: () => getSocialAccounts({ channel }, assignment),
  })

  const refresh = (): void => {
    void client.invalidateQueries({ queryKey: ['social-calendar'] })
    void client.invalidateQueries({ queryKey: ['deck'] })
  }

  const move = useMutation({
    mutationFn: (input: { post_id: string; at: string }) =>
      rescheduleSocialPost(input.post_id, input.at, assignment),
    onSuccess: (res) => {
      // 纪律 2：拖完不是"改好了"，是"提上去了，等人点头"
      setNote(
        res.conflicts.length > 0
          ? `${t('social.calendar.moved')} ${res.conflicts.join(' ')}`
          : t('social.calendar.moved'),
      )
      refresh()
    },
  })

  const compose = useMutation({
    mutationFn: (input: { account_id: string; at: string }) =>
      createSocialPost(
        { account_id: input.account_id, kind: 'post', body: draft, scheduled_at: input.at },
        assignment,
      ),
    onSuccess: (res) => {
      setComposing(undefined)
      setDraft('')
      setNote(
        res.conflicts.length > 0
          ? `${t('social.calendar.staged')} ${res.conflicts.join(' ')}`
          : t('social.calendar.staged'),
      )
      refresh()
    },
  })

  // 这条渠道自己那些格子（一条职责只看它自己那条渠道，56 §2）
  const cells = (calendar.data?.cells ?? []).filter((c) => c.channel === channel)
  const accountRows = accounts.data?.rows ?? []

  /** 拖到某一天的默认时刻：**保持原来的钟点**，只换日子（人拖的是"哪天"不是"几点"）。 */
  const dropAt = (day: Date, post_id: string): string => {
    const cell = cells.find((c) => c.post_id === post_id)
    const at = new Date(day)
    const was = cell === undefined ? undefined : new Date(cell.scheduled_at)
    at.setHours(was?.getHours() ?? 10, was?.getMinutes() ?? 0, 0, 0)
    return at.toISOString()
  }

  return (
    <Card data-testid="social-calendar">
      <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
        <CardTitle className="flex items-center gap-1.5 text-sm">
          <CalendarDays className="size-4" aria-hidden />
          {t('social.calendar.title')}
        </CardTitle>
        <div className="flex items-center gap-1">
          <Button
            size="xs"
            variant="ghost"
            aria-label={t('social.calendar.prev')}
            onClick={() => {
              setOffset(offset - 1)
            }}
          >
            <ChevronLeft className="size-4" aria-hidden />
          </Button>
          <span className="text-xs text-muted-foreground" data-testid="social-calendar-range">
            {offset === 0 ? t('social.calendar.this_week') : t('social.calendar.next_week')}
          </span>
          <Button
            size="xs"
            variant="ghost"
            aria-label={t('social.calendar.next')}
            onClick={() => {
              setOffset(offset + 1)
            }}
          >
            <ChevronRight className="size-4" aria-hidden />
          </Button>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {calendar.isPending ? (
          <Skeleton className="h-40 w-full" />
        ) : (
          <div className="grid grid-cols-7 gap-1 text-xs">
            {days.map((day) => (
              <div key={day.toISOString()} className="flex flex-col gap-1">
                <div className="px-1 pb-0.5 text-[11px] font-medium text-muted-foreground">
                  {`${day.getMonth() + 1}/${day.getDate()}`}
                </div>
                {/* biome-ignore lint/a11y/noStaticElementInteractions: 放下那一下只能挂在列上 */}
                <div
                  data-testid="social-calendar-day"
                  data-date={day.toISOString().slice(0, 10)}
                  className="flex min-h-24 flex-col gap-1 rounded border border-dashed border-muted p-1"
                  onDragOver={(e) => {
                    e.preventDefault()
                  }}
                  onDrop={() => {
                    if (dragging === undefined) return
                    move.mutate({ post_id: dragging, at: dropAt(day, dragging) })
                    setDragging(undefined)
                  }}
                >
                  {cells
                    .filter((c) => sameDay(new Date(c.scheduled_at), day))
                    .map((c) => (
                      <Cell key={c.post_id} cell={c} onDragStart={setDragging} />
                    ))}
                  {accountRows.length === 0 ? null : (
                    <Button
                      size="xs"
                      variant="ghost"
                      className="h-6 justify-start px-1 text-[11px] text-muted-foreground"
                      data-testid="social-calendar-add"
                      onClick={() => {
                        setComposing(day.toISOString())
                      }}
                    >
                      <Plus className="size-3" aria-hidden />
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}

        {accountRows.length === 0 ? (
          // 36 §3：没有号就说没有号，不画一张空日历让人以为是自己没排
          <p className="text-xs text-muted-foreground" data-testid="social-calendar-no-account">
            {t('social.calendar.no_account')}
          </p>
        ) : null}

        {composing === undefined ? null : (
          <div className="flex flex-col gap-2 rounded border p-2" data-testid="social-compose">
            <Textarea
              rows={3}
              value={draft}
              placeholder={t('social.calendar.compose.placeholder')}
              onChange={(e) => {
                setDraft(e.target.value)
              }}
            />
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                disabled={draft.trim() === '' || compose.isPending}
                onClick={() => {
                  const account_id = accountRows[0]?.id
                  if (account_id === undefined) return
                  const at = new Date(composing)
                  at.setHours(10, 0, 0, 0)
                  compose.mutate({ account_id, at: at.toISOString() })
                }}
              >
                {t('social.calendar.compose.submit')}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setComposing(undefined)
                }}
              >
                {t('social.calendar.compose.cancel')}
              </Button>
            </div>
            {/* 发布永远人审：这句话在按钮旁边，不在提交之后才出现 */}
            <p className="text-xs text-muted-foreground">{t('social.calendar.always_l1')}</p>
          </div>
        )}

        {note === undefined ? null : (
          <p className="text-xs text-muted-foreground" data-testid="social-calendar-note">
            {note}
          </p>
        )}
      </CardContent>
    </Card>
  )
}

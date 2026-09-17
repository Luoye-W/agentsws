/**
 * 社媒运营职责页上的**内容日历周视图**（56 §6 第四项）。
 *
 * WP74 之后这个文件只剩一层薄封装：**日历只有一个**（`components/calendar/unified-calendar`），
 * 这里做的是"把它固定在社媒排期那一层、并且只看这条渠道"。WP73 那份独立实现
 * （七列 × 自己画的格子）删掉了——两份日历意味着两套拖拽语义、两套撞车提示、
 * 两套深浅色，而它们迟早会不一样。
 *
 * WP73 的四条界面纪律一条没丢，只是落点换了：
 *
 * 1. **撞车是服务端算的**。格子上那个 ⚠ 与它的说明现在走 `CalendarItem.notes`
 *    （服务端用 `social-core` 的 `scheduleConflicts` 算好），界面一条判据都不自己写。
 * 2. **拖一下 = 重新出一张卡**。拖完显示的是"已经提上去了，等人点头"，不是"改好了"
 *    ——这条在统一日历的社媒分支里（`lib/calendar-drag` → `rescheduleSocialPost`）。
 * 3. **四态看得出来**。状态在事件小卡上，退回那一条不隐藏。
 * 4. **空的那几天也画出来**。周视图本来就画满七天。
 *
 * 留在这个文件里的只有一样统一日历不该管的东西：**在某一天新建一条**。
 * 那是社媒自己的动作（要选号、要写正文、要提一张 L1 卡），不是日历的动作。
 */
import type { CalendarSource } from '@agentsws/contracts'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CalendarDays, ChevronLeft, ChevronRight } from 'lucide-react'
import { useState } from 'react'
import { UnifiedCalendar } from '@/components/calendar/unified-calendar'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Textarea } from '@/components/ui/textarea'
import { createSocialPost, getSocialAccounts, type SocialChannelId } from '@/lib/api'
import { useApp } from '@/lib/app-context'

const DAY_MS = 86_400_000

/** 这一块固定只开社媒排期那一层。 */
const SOCIAL_LAYER: readonly CalendarSource[] = ['social_post']

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
  const [composing, setComposing] = useState<string | undefined>(undefined)
  const [draft, setDraft] = useState('')
  const [note, setNote] = useState<string | undefined>(undefined)

  const anchor = new Date(Date.now() + offset * 7 * DAY_MS)

  const accounts = useQuery({
    queryKey: ['social-accounts', assignment, channel],
    queryFn: () => getSocialAccounts({ channel }, assignment),
  })
  const accountRows = accounts.data?.rows ?? []

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
      void client.invalidateQueries({ queryKey: ['calendar'] })
      void client.invalidateQueries({ queryKey: ['deck'] })
    },
  })

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
        {/* 同一个组件的嵌入：固定 social_post 图层 + 这条渠道（一条职责只看它自己那条，56 §2） */}
        <UnifiedCalendar
          layers={SOCIAL_LAYER}
          fetchLayers={SOCIAL_LAYER}
          view="week"
          anchor={anchor}
          channel={channel}
          assignment={assignment}
          heightClass="h-96"
          // 没登记号就不给"在这一天新建"：点了也没号可发
          {...(accountRows.length === 0
            ? {}
            : {
                onPickDate: (iso: string) => {
                  setComposing(iso)
                },
              })}
        />

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

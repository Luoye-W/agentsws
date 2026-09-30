/**
 * WP207：「已归档（n）」点开的那张列表——按时间 / 岗位 / 职责筛、全文搜、一键恢复，
 * 底下一格「让 AI 找回…」：说个大概，给几张候选卡，点一张放回来。
 *
 * 从职责行点进来时岗位与职责已经筛好；筛子都能改（找的东西常常不在你以为的那条职责下）。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArchiveRestore, Sparkles } from 'lucide-react'
import { type ReactNode, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { TutorialLink } from '@/components/help/tutorial-link'
import { RecallCards } from '@/components/sidebar/recall-cards'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import type { PositionInstanceData } from '@/lib/api'
import { useApp } from '@/lib/app-context'
import { formatDate } from '@/lib/format'
import {
  ARCHIVED_KEY,
  findArchivedWork,
  listArchivedWork,
  unarchiveMatter,
} from '@/lib/work-archive'

type Span = 'all' | 'week' | 'month' | 'older'
const DAY = 86_400_000

/** 时间筛子 → `from` / `to`（按"现在"往回数；只在打开面板那一刻算一次）。 */
function spanRange(span: Span, now: number): { from?: string; to?: string } {
  if (span === 'week') return { from: new Date(now - 7 * DAY).toISOString() }
  if (span === 'month') return { from: new Date(now - 30 * DAY).toISOString() }
  if (span === 'older') return { to: new Date(now - 30 * DAY).toISOString() }
  return {}
}

export interface ArchivedScope {
  position_id?: string
  role_id?: string
}

export function ArchivedDialog({
  open,
  onOpenChange,
  scope,
  instances,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  scope: ArchivedScope
  instances: PositionInstanceData[]
}): ReactNode {
  const { t, lang } = useApp()
  const client = useQueryClient()
  const navigate = useNavigate()
  const [q, setQ] = useState('')
  const [debounced, setDebounced] = useState('')
  const [position, setPosition] = useState(scope.position_id ?? '')
  const [role, setRole] = useState(scope.role_id ?? '')
  const [span, setSpan] = useState<Span>('all')
  const [now] = useState(() => Date.now())
  const [ask, setAsk] = useState('')
  // 每次从别的职责点进来，筛子跟着换
  useEffect(() => {
    setPosition(scope.position_id ?? '')
    setRole(scope.role_id ?? '')
  }, [scope.position_id, scope.role_id])
  useEffect(() => {
    const h = setTimeout(() => {
      setDebounced(q.trim())
    }, 250)
    return () => {
      clearTimeout(h)
    }
  }, [q])

  const filter = {
    ...(debounced === '' ? {} : { q: debounced }),
    ...(position === '' ? {} : { position_id: position }),
    ...(role === '' ? {} : { role_id: role }),
    ...spanRange(span, now),
  }
  const list = useQuery({
    queryKey: [...ARCHIVED_KEY, filter],
    queryFn: () => listArchivedWork(filter),
    enabled: open,
  })
  const restore = useMutation({
    mutationFn: (id: string) => unarchiveMatter(id, 'user'),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ['matter'] })
    },
  })
  const find = useMutation({ mutationFn: (text: string) => findArchivedWork(text) })

  const nameOf = (p: PositionInstanceData): string => (lang === 'en' ? p.name.en : p.name.zh)
  const duties = instances.find((p) => p.position_id === position)?.roles ?? []
  const label = (position_id?: string, role_id?: string): string => {
    const p = instances.find((x) => x.position_id === position_id)
    const r = p?.roles.find((x) => x.role_id === role_id)
    return [p === undefined ? undefined : nameOf(p), r?.role_name].filter(Boolean).join(' › ')
  }
  const select =
    'h-8 rounded-md border border-ws-line bg-background px-2 text-[13px] text-foreground'

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-h-[85vh] overflow-y-auto sm:max-w-2xl"
        data-testid="archived-dialog"
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {t('archive.title')}
            <TutorialLink slug="archive" className="text-xs font-normal" />
          </DialogTitle>
        </DialogHeader>
        <div className="flex flex-wrap gap-2">
          <Input
            value={q}
            placeholder={t('archive.search')}
            aria-label={t('archive.search')}
            data-testid="archived-search"
            className="min-w-48 flex-1"
            onChange={(e) => {
              setQ(e.target.value)
            }}
          />
          <select
            className={select}
            aria-label={t('archive.filter.position')}
            data-testid="archived-position"
            value={position}
            onChange={(e) => {
              setPosition(e.target.value)
              setRole('')
            }}
          >
            <option value="">{t('archive.filter.position')}</option>
            {instances.map((p) => (
              <option key={p.position_id} value={p.position_id}>
                {nameOf(p)}
              </option>
            ))}
          </select>
          <select
            className={select}
            aria-label={t('archive.filter.duty')}
            data-testid="archived-duty"
            value={role}
            disabled={position === ''}
            onChange={(e) => {
              setRole(e.target.value)
            }}
          >
            <option value="">{t('archive.filter.duty')}</option>
            {duties.map((r) => (
              <option key={r.role_id} value={r.role_id}>
                {r.role_name}
              </option>
            ))}
          </select>
          <select
            className={select}
            aria-label={t('archive.filter.time.all')}
            data-testid="archived-span"
            value={span}
            onChange={(e) => {
              setSpan(e.target.value as Span)
            }}
          >
            {(['all', 'week', 'month', 'older'] as const).map((s) => (
              <option key={s} value={s}>
                {t(`archive.filter.time.${s}`)}
              </option>
            ))}
          </select>
        </div>

        <ul className="flex flex-col divide-y divide-ws-line" data-testid="archived-list">
          {(list.data ?? []).map((m) => (
            <li key={m.id} className="flex items-start gap-3 py-2" data-testid="archived-item">
              <button
                type="button"
                className="min-w-0 flex-1 text-left"
                onClick={() => {
                  onOpenChange(false)
                  navigate(`/matters/${encodeURIComponent(m.id)}`)
                }}
              >
                <span className="block truncate text-[13.5px] font-medium">{m.title}</span>
                {m.snippet !== undefined || m.summary !== '' ? (
                  <span className="line-clamp-2 block text-[12px] text-ws-muted-fg">
                    {m.snippet ?? m.summary}
                  </span>
                ) : null}
                <span className="block text-[11px] text-ws-muted-fg">
                  {[
                    label(m.position_template_id, m.role_id),
                    t('archive.at', { when: formatDate(m.archived_at, lang) }),
                  ]
                    .filter((x) => x !== '')
                    .join(' · ')}
                </span>
              </button>
              <Button
                size="xs"
                variant="outline"
                data-testid="archived-restore"
                disabled={restore.isPending}
                onClick={() => {
                  restore.mutate(m.id)
                }}
              >
                <ArchiveRestore aria-hidden />
                {t('archive.restore')}
              </Button>
            </li>
          ))}
          {list.data !== undefined && list.data.length === 0 ? (
            <li className="py-6 text-center text-[13px] text-ws-muted-fg">{t('archive.empty')}</li>
          ) : null}
        </ul>
        {/* 让 AI 找回：说个大概 → 几张候选卡 → 点一张放回来（不点不恢复） */}
        <form
          className="flex flex-col gap-2 rounded-[10px] bg-ws-tint/50 p-2.5"
          data-testid="archived-ai"
          onSubmit={(e) => {
            e.preventDefault()
            if (ask.trim() !== '') find.mutate(ask.trim())
          }}
        >
          <div className="flex gap-2">
            <Input
              value={ask}
              aria-label={t('archive.ai')}
              placeholder={t('archive.ai.placeholder')}
              data-testid="archived-ai-input"
              className="flex-1 bg-ws-card"
              onChange={(e) => {
                setAsk(e.target.value)
              }}
            />
            <Button
              type="submit"
              size="sm"
              data-testid="archived-ai-go"
              disabled={ask.trim() === '' || find.isPending}
            >
              <Sparkles aria-hidden />
              {t('archive.ai.go')}
            </Button>
          </div>
          {find.data === undefined ? null : find.data.candidates.length === 0 ? (
            <p className="text-[12px] text-ws-muted-fg">{t('archive.ai.none')}</p>
          ) : (
            <>
              <p className="text-[12px] text-ws-muted-fg">
                {t('archive.ai.pick')}
                {find.data.semantic ? ` · ${t('archive.ai.semantic')}` : ''}
              </p>
              <RecallCards
                candidates={find.data.candidates}
                onRestored={() => {
                  onOpenChange(false)
                }}
              />
            </>
          )}
        </form>
      </DialogContent>
    </Dialog>
  )
}

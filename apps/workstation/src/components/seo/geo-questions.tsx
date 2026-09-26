/**
 * WP154「内容与搜索」职责页上那一块：**买家会问的问题**（每周拿去问各 AI 平台）。
 *
 * 三条界面纪律：
 *
 * 1. **花多少写在明处**（WP155 提醒）：探测按「每个问题 × 每个平台一次」计费，
 *    这一块顶上就写「每周问 N 个 × M 个平台，约 X 积分」——数是服务端算的，界面不自己乘。
 * 2. **调得动、关得掉**：一个开关（每周探测开 / 关）+ 问几个（1–10）。
 * 3. **人改过的永远赢**：改字、关掉、加一句，存下来就是"人的"，下一次自动生成不覆盖它。
 *
 * 另有两个"现在跑一轮"的按钮：不用等到早上 8 点 / 周一。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus, Search, Sparkles } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { type GeoQuestionData, getGeoQuestions, runSeo, setGeoQuestions } from '@/lib/api'
import { useApp } from '@/lib/app-context'

export function GeoQuestions({ assignment }: { assignment: string }): React.ReactNode {
  const { t } = useApp()
  const qc = useQueryClient()
  const view = useQuery({
    queryKey: ['geo-questions', assignment],
    queryFn: () => getGeoQuestions(assignment),
  })
  const [draft, setDraft] = useState<GeoQuestionData[]>([])
  const [added, setAdded] = useState('')
  const [ran, setRan] = useState<string | undefined>(undefined)
  useEffect(() => {
    if (view.data !== undefined) setDraft(view.data.questions)
  }, [view.data])

  const save = useMutation({
    mutationFn: (input: Parameters<typeof setGeoQuestions>[0]) =>
      setGeoQuestions(input, assignment),
    onSuccess: (data) => {
      qc.setQueryData(['geo-questions', assignment], data)
    },
  })
  const run = useMutation({
    mutationFn: (what: 'daily' | 'weekly') => runSeo(what, assignment),
    onSuccess: (out) => {
      setRan(out.skipped ?? t('seo.run.done'))
      void qc.invalidateQueries({ queryKey: ['view'] })
    },
  })

  const data = view.data
  if (data === undefined) return null
  const { settings, estimate } = data
  const cost =
    estimate.credits_per_week === undefined
      ? t('seo.geo.cost.unknown')
      : estimate.route === 'byo'
        ? t('seo.geo.cost.byo')
        : t('seo.geo.cost', {
            n: String(estimate.questions),
            p: String(estimate.platforms),
            c: String(estimate.credits_per_week),
          })

  return (
    <Card data-testid="geo-questions">
      <CardHeader>
        <CardTitle className="flex items-center gap-1.5 text-sm">
          <Sparkles className="size-4" aria-hidden />
          {t('seo.geo.title')}
        </CardTitle>
        <p className="text-xs text-muted-foreground" data-testid="geo-cost">
          {settings.enabled ? cost : t('seo.geo.off')}
        </p>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <label className="flex items-center gap-1.5">
            <input
              type="checkbox"
              checked={settings.enabled}
              onChange={(e) => save.mutate({ settings: { enabled: e.target.checked } })}
              data-testid="geo-enabled"
            />
            {t('seo.geo.enabled')}
          </label>
          <label htmlFor="geo-max" className="flex items-center gap-1.5">
            {t('seo.geo.max')}
            <Input
              id="geo-max"
              type="number"
              min={1}
              max={10}
              className="h-7 w-16"
              value={settings.max_questions}
              onChange={(e) => {
                const n = Number(e.target.value)
                if (Number.isInteger(n) && n >= 1 && n <= 10)
                  save.mutate({ settings: { max_questions: n } })
              }}
              data-testid="geo-max"
            />
          </label>
        </div>
        <ul className="flex flex-col gap-1.5">
          {draft.map((q, i) => (
            <li key={q.id} className="flex items-center gap-2">
              <input
                type="checkbox"
                aria-label={t('seo.geo.ask_this')}
                checked={q.enabled}
                onChange={(e) =>
                  setDraft(draft.map((x, j) => (j === i ? { ...x, enabled: e.target.checked } : x)))
                }
              />
              <Input
                className="h-8 text-sm"
                value={q.text}
                onChange={(e) =>
                  setDraft(draft.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)))
                }
              />
            </li>
          ))}
        </ul>
        <div className="flex items-center gap-2">
          <Input
            className="h-8 text-sm"
            placeholder={t('seo.geo.add_placeholder')}
            value={added}
            onChange={(e) => setAdded(e.target.value)}
          />
          <Button
            size="sm"
            variant="outline"
            disabled={added.trim() === ''}
            onClick={() => {
              setDraft([
                ...draft,
                { id: `new_${draft.length}`, text: added.trim(), origin: 'human', enabled: true },
              ])
              setAdded('')
            }}
          >
            <Plus className="size-3.5" aria-hidden />
            {t('seo.geo.add')}
          </Button>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            onClick={() =>
              save.mutate({
                questions: draft.map((q) => ({
                  ...(q.id.startsWith('new_') ? {} : { id: q.id }),
                  text: q.text,
                  enabled: q.enabled,
                })),
              })
            }
            disabled={save.isPending}
          >
            {t('seo.geo.save')}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => run.mutate('daily')}
            disabled={run.isPending}
          >
            <Search className="size-3.5" aria-hidden />
            {t('seo.run.daily')}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => run.mutate('weekly')}
            disabled={run.isPending}
          >
            {t('seo.run.weekly')}
          </Button>
          {ran === undefined ? null : <span className="text-xs text-muted-foreground">{ran}</span>}
        </div>
      </CardContent>
    </Card>
  )
}

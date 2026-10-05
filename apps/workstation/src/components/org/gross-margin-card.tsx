/**
 * WP224（docs/91 §2.2 #3）：**公司 → 品牌 · 毛利率**。
 *
 * 品牌事实里的一格（就是知识库里的一张事实卡），可按品类 / SKU 覆盖（小的盖大的）。
 * 投放面板上 ROAS 旁边那一格「盈亏线 ROAS = 1 / 毛利率」从这里算；**没填就是没填**——
 * 面板上写「没填毛利率」带一个「去填」回到这里（`?tab=brands&focus=gross-margin`）。
 *
 * 界面少字（36 §7）：一格品牌毛利率 + 一张覆盖表，「为什么 / 怎么算」进问号。
 * 负责人填的直接生效；清掉一格 = 那张卡退役（留痕，不删）。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Trash2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Hint } from '@/components/ui/hint'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { ApiClientError, type GrossMarginInput, getGrossMargins, saveGrossMargin } from '@/lib/api'
import { useApp } from '@/lib/app-context'

/** 盈亏线（1 / 毛利率），两位小数；填的数不能用就没有。 */
const breakEven = (pct: number | undefined): string | undefined =>
  pct === undefined || pct <= 0 || pct > 100
    ? undefined
    : String(Math.round((100 / pct + Number.EPSILON) * 100) / 100)

export function GrossMarginCard({ assignment }: { assignment?: string }): React.ReactNode {
  const { t } = useApp()
  const client = useQueryClient()
  const [params] = useSearchParams()
  const ref = useRef<HTMLDivElement>(null)
  const [brandDraft, setBrandDraft] = useState<string | undefined>(undefined)
  const [scope, setScope] = useState<'category' | 'sku'>('category')
  const [key, setKey] = useState('')
  const [pct, setPct] = useState('')
  const [failure, setFailure] = useState<string | undefined>(undefined)

  const margins = useQuery({
    queryKey: ['economics', 'margins', assignment],
    enabled: assignment !== undefined,
    queryFn: () => getGrossMargins(assignment),
  })

  // 从投放面板「没填毛利率 · 去填」点过来：滚到这一格
  const focused = params.get('focus') === 'gross-margin'
  useEffect(() => {
    if (focused && margins.data !== undefined) ref.current?.scrollIntoView({ block: 'center' })
  }, [focused, margins.data])

  const save = useMutation({
    mutationFn: (input: GrossMarginInput) => saveGrossMargin(input, assignment),
    onSuccess: async (view) => {
      setFailure(undefined)
      client.setQueryData(['economics', 'margins', assignment], view)
      await client.invalidateQueries({ queryKey: ['block'] })
    },
    onError: (err: unknown) => {
      setFailure(err instanceof ApiClientError ? err.message : t('error.generic'))
    },
  })

  if (assignment === undefined) return null
  if (margins.data === undefined) return <Skeleton className="h-32 w-full" />

  const brand = margins.data.entries.find((e) => e.scope === 'brand')
  const overrides = margins.data.entries.filter((e) => e.scope !== 'brand')
  const brandValue = brandDraft ?? (brand === undefined ? '' : String(brand.margin_pct))
  const brandLine = breakEven(brand?.margin_pct)

  const num = (s: string): number | undefined => {
    const v = Number(s.trim())
    return s.trim() === '' || !Number.isFinite(v) ? undefined : v
  }

  return (
    <Card
      ref={ref}
      id="gross-margin"
      data-testid="org-gross-margin"
      className={focused ? 'ring-2 ring-ws-brand' : undefined}
    >
      <CardHeader>
        <CardTitle className="flex items-center gap-1 text-sm">
          {t('org.margin.title')}
          <Hint text={t('org.margin.hint')} testId="org-gross-margin-hint" />
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault()
            const v = num(brandValue)
            save.mutate({ scope: 'brand', margin_pct: v ?? null })
            setBrandDraft(undefined)
          }}
        >
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="gm-brand">{t('org.margin.brand')}</Label>
            <div className="flex items-center gap-1.5">
              <Input
                id="gm-brand"
                data-testid="org-gross-margin-brand"
                inputMode="decimal"
                className="w-24"
                placeholder={t('org.margin.unset')}
                value={brandValue}
                onChange={(e) => {
                  setBrandDraft(e.target.value)
                }}
              />
              <span className="text-sm text-ws-muted-fg">%</span>
            </div>
          </div>
          <Button type="submit" size="sm" disabled={save.isPending}>
            {t('org.margin.save')}
          </Button>
          <p className="text-sm text-ws-muted-fg" data-testid="org-gross-margin-line">
            {brandLine === undefined
              ? t('org.margin.unset')
              : t('org.margin.line', { line: brandLine })}
          </p>
        </form>

        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-1 text-xs font-medium text-ws-muted-fg">
            {t('org.margin.overrides')}
            <Hint text={t('org.margin.overrides.hint')} />
          </div>
          {overrides.length === 0 ? null : (
            <ul className="flex flex-col gap-1" data-testid="org-gross-margin-overrides">
              {overrides.map((e) => (
                <li
                  key={`${e.scope}:${e.key ?? ''}`}
                  className="flex items-center gap-3 rounded-lg bg-ws-surface px-3 py-2 text-sm"
                >
                  <span className="text-xs text-ws-muted-fg">
                    {t(e.scope === 'sku' ? 'org.margin.sku' : 'org.margin.category')}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{e.key}</span>
                  <span className="ws-num">{e.margin_pct}%</span>
                  <span className="ws-num text-xs text-ws-muted-fg">
                    {t('org.margin.line', { line: breakEven(e.margin_pct) ?? '—' })}
                  </span>
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    aria-label={t('org.margin.clear')}
                    onClick={() => {
                      save.mutate({
                        scope: e.scope,
                        ...(e.key === undefined ? {} : { key: e.key }),
                        margin_pct: null,
                      })
                    }}
                  >
                    <Trash2 className="size-4" aria-hidden />
                  </Button>
                </li>
              ))}
            </ul>
          )}
          <form
            className="flex flex-wrap items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault()
              const v = num(pct)
              if (key.trim() === '' || v === undefined) return
              save.mutate({ scope, key: key.trim(), margin_pct: v })
              setKey('')
              setPct('')
            }}
          >
            <select
              aria-label={t('org.margin.scope')}
              className="h-9 rounded-md border border-ws-line bg-ws-card px-2 text-sm"
              value={scope}
              onChange={(e) => {
                setScope(e.target.value === 'sku' ? 'sku' : 'category')
              }}
            >
              <option value="category">{t('org.margin.category')}</option>
              <option value="sku">{t('org.margin.sku')}</option>
            </select>
            <Input
              aria-label={t('org.margin.key')}
              className="w-40"
              placeholder={t(scope === 'sku' ? 'org.margin.sku' : 'org.margin.category')}
              value={key}
              onChange={(e) => {
                setKey(e.target.value)
              }}
            />
            <Input
              aria-label={t('org.margin.pct')}
              inputMode="decimal"
              className="w-20"
              placeholder="%"
              value={pct}
              onChange={(e) => {
                setPct(e.target.value)
              }}
            />
            <Button type="submit" size="sm" variant="outline" disabled={save.isPending}>
              {t('org.margin.add')}
            </Button>
          </form>
        </div>
        {failure === undefined ? null : (
          <p className="text-sm text-ws-bad" role="alert">
            {failure}
          </p>
        )}
      </CardContent>
    </Card>
  )
}

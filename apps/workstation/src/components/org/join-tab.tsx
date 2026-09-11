/**
 * 公司页「并进来」Tab（45 H2）：一个人的工作区并进公司时的**对照页**。
 *
 * 一屏列完，按类分组（品牌 / 产品线 / 店铺范围），每类一个「全部采纳」，也能逐条改。
 * 三种结论各有自己的选项：
 *
 * - **一样**：合并（公司那份成员取并集），或"保留两条"
 * - **像但不确定**：同一个取并集 / 以公司为准 / 保留两条 —— 一律给人选，界面不替人决定
 * - **公司还没有**：在公司新建，或"这条不带进公司"
 *
 * 底下一段是连接：**默认全关**。40 §1 定了凭据归属，交给公司要本人一条条打开。
 *
 * 36 §7：解释性文字进 tooltip；卡片上只留名字、双方摘要、几个岗位挂着、和那几个选项。
 */
import { useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Hint } from '@/components/ui/hint'
import type { JoinMappingView, JoinObjectView, JoinResolution } from '@/lib/api'
import { useApp } from '@/lib/app-context'
import { cn } from '@/lib/utils'

/** 三类对象的显示顺序（与 45 H2 表里的行序一致）。 */
const KINDS: JoinObjectView['kind'][] = ['range_group', 'product_line', 'store_range']

export interface JoinChoice {
  objects: { unique_key: string; chosen: JoinResolution; name_choice?: 'company' | 'personal' }[]
  connections: { connection_id: string; transfer: boolean }[]
}

export function JoinTab({
  mapping,
  busy,
  error,
  onComplete,
}: {
  mapping?: JoinMappingView
  busy: boolean
  error?: string
  onComplete(choice: JoinChoice): void
}): React.ReactNode {
  const { t } = useApp()
  const [picked, setPicked] = useState<Record<string, JoinResolution>>({})
  const [names, setNames] = useState<Record<string, 'company' | 'personal'>>({})
  const [transfer, setTransfer] = useState<Record<string, boolean>>({})

  if (mapping === undefined) {
    return (
      <p className="text-sm text-muted-foreground" data-testid="join-empty">
        {t('org.join.empty')}
      </p>
    )
  }

  const chosenOf = (o: JoinObjectView): JoinResolution => picked[o.unique_key] ?? o.suggested
  const adoptAll = (kind: JoinObjectView['kind']): void => {
    setPicked((current) => {
      const next = { ...current }
      for (const o of mapping.objects) if (o.kind === kind) next[o.unique_key] = o.suggested
      return next
    })
  }

  return (
    <div className="flex flex-col gap-4" data-testid="join-tab">
      {error === undefined ? null : (
        <p role="alert" className="text-sm text-destructive" data-testid="join-error">
          {error}
        </p>
      )}

      <Card>
        <CardContent className="flex flex-col gap-1 pt-4 text-sm">
          <p data-testid="join-counts">
            {t('org.join.counts', {
              same: String(mapping.counts.same),
              similar: String(mapping.counts.similar),
              missing: String(mapping.counts.missing),
            })}
          </p>
          <p className="text-xs text-muted-foreground">{t('org.join.subtitle')}</p>
        </CardContent>
      </Card>

      {KINDS.map((kind) => {
        const rows = mapping.objects.filter((o) => o.kind === kind)
        if (rows.length === 0) return null
        return (
          <section key={kind} className="flex flex-col gap-2" data-testid={`join-group-${kind}`}>
            <div className="flex items-center justify-between">
              <h2 className="flex items-center gap-1 text-sm font-semibold">
                {t(`org.join.kind.${kind}`)}
                <Badge variant="outline">{rows.length}</Badge>
              </h2>
              <Button
                size="xs"
                variant="outline"
                disabled={busy}
                data-testid={`join-adopt-${kind}`}
                onClick={() => {
                  adoptAll(kind)
                }}
              >
                {t('org.join.adopt_all')}
              </Button>
            </div>

            {rows.map((o) => (
              <Card key={o.unique_key} data-testid="join-row" data-verdict={o.verdict}>
                <CardHeader className="flex-row items-center justify-between gap-2">
                  <CardTitle className="text-sm">{o.mine.name}</CardTitle>
                  <Badge
                    variant={o.verdict === 'similar' ? 'secondary' : 'outline'}
                    data-testid="join-verdict"
                  >
                    {t(`org.join.verdict.${o.verdict}`)}
                  </Badge>
                </CardHeader>
                <CardContent className="flex flex-col gap-2 text-sm">
                  <div className="grid gap-1 md:grid-cols-2">
                    <p className="text-xs text-muted-foreground">
                      {t('org.join.side.mine', { summary: o.mine.summary })}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {o.theirs === undefined
                        ? t('org.join.side.none')
                        : t('org.join.side.theirs', {
                            name: o.theirs.name,
                            summary: o.theirs.summary,
                            n: String(o.theirs.holders ?? 0),
                          })}
                    </p>
                  </div>
                  {o.reasons.length === 0 ? null : (
                    <p className="text-xs text-muted-foreground">{o.reasons.join('；')}</p>
                  )}

                  <div className="flex flex-wrap gap-1">
                    {o.options.map((option) => (
                      <button
                        key={option}
                        type="button"
                        data-testid="join-option"
                        data-option={option}
                        className={cn(
                          'rounded-md border px-2 py-0.5 text-xs transition-colors hover:bg-muted',
                          chosenOf(o) === option && 'border-primary bg-primary/10',
                        )}
                        onClick={() => {
                          setPicked((c) => ({ ...c, [o.unique_key]: option }))
                        }}
                      >
                        {t(`org.join.option.${option}`)}
                      </button>
                    ))}
                  </div>

                  {/* "同一个，用哪个名字"——只有真的要合成一条时才问 */}
                  {o.theirs !== undefined && chosenOf(o) === 'merge_union' ? (
                    <div className="flex items-center gap-1 text-xs">
                      <span className="text-muted-foreground">{t('org.join.name_choice')}</span>
                      {(['company', 'personal'] as const).map((which) => (
                        <button
                          key={which}
                          type="button"
                          data-testid="join-name-choice"
                          data-which={which}
                          className={cn(
                            'rounded-md border px-2 py-0.5 transition-colors hover:bg-muted',
                            (names[o.unique_key] ?? 'company') === which &&
                              'border-primary bg-primary/10',
                          )}
                          onClick={() => {
                            setNames((c) => ({ ...c, [o.unique_key]: which }))
                          }}
                        >
                          {which === 'company' ? (o.theirs?.name ?? '') : o.mine.name}
                        </button>
                      ))}
                    </div>
                  ) : null}
                </CardContent>
              </Card>
            ))}
          </section>
        )
      })}

      {mapping.connections.length === 0 ? null : (
        <section className="flex flex-col gap-2" data-testid="join-connections">
          <h2 className="flex items-center gap-1 text-sm font-semibold">
            {t('org.join.connections')}
            <Hint text={t('org.join.connections.hint')} />
          </h2>
          {mapping.connections.map((c) => (
            <Card key={c.connection_id}>
              <CardContent className="flex items-center justify-between gap-2 pt-4 text-sm">
                <div className="flex flex-col">
                  <span>{c.label}</span>
                  {c.company_has_same_service === true ? (
                    <span className="text-xs text-muted-foreground">
                      {t('org.join.connections.same_service')}
                    </span>
                  ) : null}
                </div>
                <Button
                  size="xs"
                  variant={transfer[c.connection_id] === true ? 'default' : 'outline'}
                  data-testid="join-transfer"
                  data-on={transfer[c.connection_id] === true ? 'yes' : 'no'}
                  disabled={busy}
                  onClick={() => {
                    setTransfer((x) => ({
                      ...x,
                      [c.connection_id]: x[c.connection_id] !== true,
                    }))
                  }}
                >
                  {transfer[c.connection_id] === true
                    ? t('org.join.connections.on')
                    : t('org.join.connections.off')}
                </Button>
              </CardContent>
            </Card>
          ))}
        </section>
      )}

      <div className="flex justify-end">
        <Button
          size="sm"
          disabled={busy}
          data-testid="join-complete"
          onClick={() => {
            onComplete({
              objects: mapping.objects.map((o) => ({
                unique_key: o.unique_key,
                chosen: chosenOf(o),
                ...(names[o.unique_key] === undefined
                  ? {}
                  : { name_choice: names[o.unique_key] as 'company' | 'personal' }),
              })),
              connections: mapping.connections.map((c) => ({
                connection_id: c.connection_id,
                transfer: transfer[c.connection_id] === true,
              })),
            })
          }}
        >
          {t('org.join.complete')}
        </Button>
      </div>
    </div>
  )
}

/**
 * 公司页「品牌与产品线」Tab（44 G1 / G2）。
 *
 * 两件东西，两张清单：
 *
 * - **品牌** = 一组店铺 / 账号 / 市场的名字（范围组）。挂了它的岗位，品牌新开一家店
 *   就自动看得到——所以改成员这件事会留痕，owner 会收到一张卡。
 * - **产品线** = 一家店 / 一个账号 / 一个市场**里面**按平台判据切出来的商品子集。
 *   判据能翻成 Shopify 搜索语法的，拉数据时让上游先切一刀；翻不了的拉回来本地切。
 *
 * 36 §7：解释性文字进 tooltip，页面上只留名字、成员、"几个岗位挂着"和动作。
 */
import { useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Hint } from '@/components/ui/hint'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import type { ProductLineRule, ProductLineView, RangeGroupView, RangeOption } from '@/lib/api'
import { useApp } from '@/lib/app-context'
import { cn } from '@/lib/utils'

export interface RangeGroupDraft {
  name: string
  members: { kind: string; id: string }[]
}

export interface ProductLineDraft {
  name: string
  parent: { kind: string; id: string }
  rule: ProductLineRule
}

/** 判据说成人话（"标签 kitchen / 供应商 Nordvolt"）。中英都走 i18n，别在这里写死中文。 */
export function ruleText(
  rule: ProductLineRule,
  t: (key: string, vars?: Record<string, string>) => string,
): string {
  const join = (values: readonly string[]) => values.join(' / ')
  if (rule.platform === 'manual')
    return t('org.ranges.rule.manual', { n: String(rule.product_ids.length) })
  const parts =
    rule.platform === 'amazon'
      ? [
          rule.asins === undefined
            ? ''
            : t('org.ranges.rule.asins', { n: String(rule.asins.length) }),
          rule.sku_prefixes === undefined
            ? ''
            : t('org.ranges.rule.sku', { v: join(rule.sku_prefixes) }),
          rule.brand === undefined ? '' : t('org.ranges.rule.brand', { v: rule.brand }),
        ]
      : [
          rule.collection_ids === undefined
            ? ''
            : t('org.ranges.rule.collections', { v: join(rule.collection_ids) }),
          rule.tags === undefined ? '' : t('org.ranges.rule.tags', { v: join(rule.tags) }),
          rule.vendors === undefined ? '' : t('org.ranges.rule.vendors', { v: join(rule.vendors) }),
          rule.product_types === undefined
            ? ''
            : t('org.ranges.rule.types', { v: join(rule.product_types) }),
        ]
  const kept = parts.filter((x) => x !== '')
  return kept.length === 0 ? t('org.ranges.rule.empty') : kept.join('，')
}

/** 逗号 / 顿号分隔的一串 → 数组（空串回 undefined，别把空数组存进判据）。 */
export function listOf(text: string): string[] | undefined {
  const items = text
    .split(/[,，、\s]+/)
    .map((x) => x.trim())
    .filter((x) => x !== '')
  return items.length === 0 ? undefined : items
}

function ruleFrom(platform: ProductLineRule['platform'], raw: string): ProductLineRule {
  const items = listOf(raw) ?? []
  if (platform === 'manual') return { platform: 'manual', product_ids: items }
  if (platform === 'amazon') return { platform: 'amazon', asins: items }
  return { platform: 'shopify', tags: items }
}

export function RangesTab({
  groups,
  lines,
  rangeOptions,
  busy,
  error,
  onCreateGroup,
  onUpdateGroup,
  onDeleteGroup,
  onCreateLine,
  onDeleteLine,
}: {
  groups: RangeGroupView[]
  lines: ProductLineView[]
  rangeOptions: RangeOption[]
  busy: boolean
  error?: string
  onCreateGroup(input: RangeGroupDraft): void
  onUpdateGroup(id: string, input: RangeGroupDraft): void
  onDeleteGroup(id: string): void
  onCreateLine(input: ProductLineDraft): void
  onDeleteLine(id: string): void
}): React.ReactNode {
  const { t } = useApp()
  const [brandName, setBrandName] = useState('')
  const [brandMembers, setBrandMembers] = useState<string[]>([])
  const [editing, setEditing] = useState<string | null>(null)
  const [editMembers, setEditMembers] = useState<string[]>([])
  const [lineName, setLineName] = useState('')
  const [lineParent, setLineParent] = useState('')
  const [linePlatform, setLinePlatform] = useState<ProductLineRule['platform']>('shopify')
  const [lineRule, setLineRule] = useState('')

  // 品牌的成员只能是"整层"的范围（产品线是切在它们里面的，不能当品牌成员）
  const memberOptions = rangeOptions.filter((o) => o.kind !== 'product_line')
  const parentOptions = rangeOptions.filter(
    (o) => o.kind === 'store' || o.kind === 'account' || o.kind === 'market',
  )
  const parse = (key: string): { kind: string; id: string } => {
    const at = key.indexOf(':')
    return { kind: key.slice(0, at), id: key.slice(at + 1) }
  }
  const toggle = (list: string[], key: string): string[] =>
    list.includes(key) ? list.filter((x) => x !== key) : [...list, key]

  return (
    <div className="flex flex-col gap-4" data-testid="ranges-tab">
      {error === undefined ? null : (
        <p role="alert" className="text-sm text-destructive" data-testid="ranges-error">
          {error}
        </p>
      )}

      {/* ── 品牌（范围组）──────────────────────────────────────────── */}
      <section className="flex flex-col gap-3">
        <h2 className="flex items-center gap-1 text-sm font-semibold">
          {t('org.ranges.brands')}
          <Hint text={t('org.ranges.brands.hint')} />
        </h2>
        {groups.length === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="brands-empty">
            {t('org.ranges.brands.empty')}
          </p>
        ) : (
          <div className="grid gap-3 md:grid-cols-2">
            {groups.map((g) => (
              <Card key={g.id} data-testid="brand-card" data-brand={g.id}>
                <CardHeader className="flex-row items-center justify-between gap-2">
                  <CardTitle className="text-sm">{g.name}</CardTitle>
                  <Badge variant="outline">
                    {t('org.ranges.holders', { n: String(g.holders) })}
                  </Badge>
                </CardHeader>
                <CardContent className="flex flex-col gap-2 text-sm">
                  <div className="flex flex-wrap gap-1">
                    {g.members.map((m) => (
                      <Badge key={`${m.kind}:${m.id}`} variant="secondary">
                        {m.id}
                      </Badge>
                    ))}
                    {g.members.length === 0 ? (
                      <span className="text-muted-foreground">{t('org.ranges.members.none')}</span>
                    ) : null}
                  </div>
                  {editing === g.id ? (
                    <div className="flex flex-col gap-2">
                      <div className="flex flex-wrap gap-1">
                        {memberOptions.map((o) => {
                          const key = `${o.kind}:${o.id}`
                          return (
                            <button
                              key={key}
                              type="button"
                              data-testid="brand-member-option"
                              className={cn(
                                'rounded-md border px-2 py-0.5 text-xs transition-colors hover:bg-muted',
                                editMembers.includes(key) && 'border-primary bg-primary/10',
                              )}
                              onClick={() => {
                                setEditMembers((c) => toggle(c, key))
                              }}
                            >
                              {o.label}
                            </button>
                          )
                        })}
                      </div>
                      <div className="flex justify-end gap-2">
                        <Button
                          size="xs"
                          variant="ghost"
                          onClick={() => {
                            setEditing(null)
                          }}
                        >
                          {t('org.cancel')}
                        </Button>
                        <Button
                          size="xs"
                          disabled={busy}
                          data-testid="brand-save"
                          onClick={() => {
                            onUpdateGroup(g.id, { name: g.name, members: editMembers.map(parse) })
                            setEditing(null)
                          }}
                        >
                          {t('org.ranges.save')}
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex justify-end gap-2">
                      <Button
                        size="xs"
                        variant="outline"
                        data-testid="brand-edit"
                        onClick={() => {
                          setEditing(g.id)
                          setEditMembers(g.members.map((m) => `${m.kind}:${m.id}`))
                        }}
                      >
                        {t('org.ranges.edit_members')}
                      </Button>
                      <Button
                        size="xs"
                        variant="ghost"
                        disabled={busy}
                        data-testid="brand-delete"
                        onClick={() => {
                          onDeleteGroup(g.id)
                        }}
                      >
                        {t('org.ranges.delete')}
                      </Button>
                    </div>
                  )}
                </CardContent>
              </Card>
            ))}
          </div>
        )}

        <Card>
          <CardContent className="flex flex-col gap-2 pt-4 text-sm">
            <div className="flex flex-col gap-1">
              <Label htmlFor="brand-name" className="text-xs text-muted-foreground">
                {t('org.ranges.brand.name')}
              </Label>
              <Input
                id="brand-name"
                value={brandName}
                placeholder={t('org.ranges.brand.placeholder')}
                onChange={(e) => {
                  setBrandName(e.target.value)
                }}
              />
            </div>
            <div className="flex flex-wrap gap-1">
              {memberOptions.map((o) => {
                const key = `${o.kind}:${o.id}`
                return (
                  <button
                    key={key}
                    type="button"
                    data-testid="brand-new-member"
                    className={cn(
                      'rounded-md border px-2 py-0.5 text-xs transition-colors hover:bg-muted',
                      brandMembers.includes(key) && 'border-primary bg-primary/10',
                    )}
                    onClick={() => {
                      setBrandMembers((c) => toggle(c, key))
                    }}
                  >
                    {o.label}
                  </button>
                )
              })}
            </div>
            <div className="flex justify-end">
              <Button
                size="sm"
                disabled={busy || brandName.trim() === ''}
                data-testid="brand-create"
                onClick={() => {
                  onCreateGroup({ name: brandName.trim(), members: brandMembers.map(parse) })
                  setBrandName('')
                  setBrandMembers([])
                }}
              >
                {t('org.ranges.brand.create')}
              </Button>
            </div>
          </CardContent>
        </Card>
      </section>

      {/* ── 产品线 ─────────────────────────────────────────────────── */}
      <section className="flex flex-col gap-3">
        <h2 className="flex items-center gap-1 text-sm font-semibold">
          {t('org.ranges.lines')}
          <Hint text={t('org.ranges.lines.hint')} />
        </h2>
        {lines.length === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="lines-empty">
            {t('org.ranges.lines.empty')}
          </p>
        ) : (
          <div className="grid gap-3 md:grid-cols-2">
            {lines.map((l) => (
              <Card key={l.id} data-testid="line-card" data-line={l.id}>
                <CardHeader className="flex-row items-center justify-between gap-2">
                  <CardTitle className="text-sm">{l.name}</CardTitle>
                  <Badge variant="outline">
                    {t('org.ranges.holders', { n: String(l.holders) })}
                  </Badge>
                </CardHeader>
                <CardContent className="flex flex-col gap-2 text-sm">
                  <p className="text-xs text-muted-foreground">
                    {t('org.ranges.line.parent', { parent: l.parent.id })}
                  </p>
                  <p>{ruleText(l.rule, t)}</p>
                  <p className="flex items-center gap-1 text-xs text-muted-foreground">
                    {l.pushdown ? t('org.ranges.pushdown.yes') : t('org.ranges.pushdown.no')}
                    <Hint text={t('org.ranges.pushdown.hint')} />
                  </p>
                  <div className="flex justify-end">
                    <Button
                      size="xs"
                      variant="ghost"
                      disabled={busy}
                      data-testid="line-delete"
                      onClick={() => {
                        onDeleteLine(l.id)
                      }}
                    >
                      {t('org.ranges.delete')}
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}

        <Card>
          <CardContent className="flex flex-col gap-2 pt-4 text-sm">
            <div className="flex flex-col gap-1">
              <Label htmlFor="line-name" className="text-xs text-muted-foreground">
                {t('org.ranges.line.name')}
              </Label>
              <Input
                id="line-name"
                value={lineName}
                placeholder={t('org.ranges.line.placeholder')}
                onChange={(e) => {
                  setLineName(e.target.value)
                }}
              />
            </div>
            <div className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">{t('org.ranges.line.in')}</span>
              <div className="flex flex-wrap gap-1">
                {parentOptions.map((o) => {
                  const key = `${o.kind}:${o.id}`
                  return (
                    <button
                      key={key}
                      type="button"
                      data-testid="line-parent-option"
                      className={cn(
                        'rounded-md border px-2 py-0.5 text-xs transition-colors hover:bg-muted',
                        lineParent === key && 'border-primary bg-primary/10',
                      )}
                      onClick={() => {
                        setLineParent(key)
                      }}
                    >
                      {o.label}
                    </button>
                  )
                })}
                {parentOptions.length === 0 ? (
                  <span className="text-muted-foreground">{t('org.ranges.line.no_parent')}</span>
                ) : null}
              </div>
            </div>
            <div className="flex flex-col gap-1">
              <span className="flex items-center gap-1 text-xs text-muted-foreground">
                {t('org.ranges.line.rule')}
                <Hint text={t('org.ranges.line.rule.hint')} />
              </span>
              <div className="flex flex-wrap gap-1">
                {(['shopify', 'amazon', 'manual'] as const).map((p) => (
                  <Button
                    key={p}
                    size="xs"
                    type="button"
                    aria-pressed={linePlatform === p}
                    variant={linePlatform === p ? 'secondary' : 'ghost'}
                    data-testid={`line-platform-${p}`}
                    onClick={() => {
                      setLinePlatform(p)
                    }}
                  >
                    {t(`org.ranges.platform.${p}`)}
                  </Button>
                ))}
              </div>
              <Input
                id="line-rule"
                value={lineRule}
                placeholder={t(`org.ranges.rule.placeholder.${linePlatform}`)}
                onChange={(e) => {
                  setLineRule(e.target.value)
                }}
              />
            </div>
            <div className="flex justify-end">
              <Button
                size="sm"
                disabled={busy || lineName.trim() === '' || lineParent === ''}
                data-testid="line-create"
                onClick={() => {
                  onCreateLine({
                    name: lineName.trim(),
                    parent: parse(lineParent),
                    rule: ruleFrom(linePlatform, lineRule),
                  })
                  setLineName('')
                  setLineRule('')
                }}
              >
                {t('org.ranges.line.create')}
              </Button>
            </div>
          </CardContent>
        </Card>
      </section>
    </div>
  )
}

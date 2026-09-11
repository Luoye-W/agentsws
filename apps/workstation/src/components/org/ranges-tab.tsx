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
import { useEffect, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Hint } from '@/components/ui/hint'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import type {
  OrgDuplicateHit,
  ProductLineRule,
  ProductLineView,
  RangeGroupView,
  RangeOption,
} from '@/lib/api'
import { useApp } from '@/lib/app-context'
import { cn } from '@/lib/utils'

/** 45 H4：查到像的还是要建时带上那句为什么。 */
export interface DuplicateAckDraft {
  decision: 'new'
  reason: string
  similar_to: string[]
}

export interface RangeGroupDraft {
  name: string
  members: { kind: string; id: string }[]
  duplicate_ack?: DuplicateAckDraft
}

export interface ProductLineDraft {
  name: string
  parent: { kind: string; id: string }
  rule: ProductLineRule
  duplicate_ack?: DuplicateAckDraft
}

/** 打完字等这么久再去查（40 §2「查重不改任何东西」，多问几遍也不要紧，但别每个键都问）。 */
export const DUPLICATE_CHECK_DEBOUNCE_MS = 300

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

/** `store:store_a` → `{ kind: 'store', id: 'store_a' }`。模块级——它不认识 props，
 * 而查重那两个 `useEffect` 把它当依赖，函数每渲染换一次身份会把查询排成死循环。 */
function parse(key: string): { kind: string; id: string } {
  const at = key.indexOf(':')
  return { kind: key.slice(0, at), id: key.slice(at + 1) }
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

/**
 * 45 H4「建之前先查」命中之后那一段。
 *
 * 两个选项，不是三个：组织对象在"还没建出来"这一刻没有"合并进它"可言——
 * 那是建完之后夜间扫描出卡的事。"直接用它"点了就是引用已有那条，不产生第二份；
 * "仍新建"要写一句为什么（那句话进事件日志，下次谁查到这一对看得见）。
 */
function DuplicateNotice({
  hits,
  reason,
  reused,
  onReason,
  onReuse,
}: {
  hits: OrgDuplicateHit[]
  reason: string
  reused: OrgDuplicateHit | undefined
  onReason(value: string): void
  onReuse(hit: OrgDuplicateHit): void
}): React.ReactNode {
  const { t } = useApp()
  if (reused !== undefined)
    return (
      <p className="text-xs text-muted-foreground" data-testid="dupe-reused">
        {t('org.ranges.dupe.reused', { name: reused.name })}
      </p>
    )
  if (hits.length === 0) return null
  return (
    <div className="flex flex-col gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-2">
      {hits.map((h) => (
        <div key={h.id} className="flex flex-col gap-1" data-testid="dupe-hit" data-hit={h.id}>
          <p className="text-xs">
            {t('org.ranges.dupe.hit', {
              name: h.name,
              who: h.created_by_name ?? h.created_by ?? t('org.ranges.dupe.unknown'),
              n: String(h.holders),
            })}
          </p>
          {h.reasons.map((why) => (
            <p key={why} className="text-xs text-muted-foreground">
              {why}
            </p>
          ))}
          <div className="flex justify-end">
            <Button
              size="xs"
              variant="outline"
              data-testid="dupe-reuse"
              onClick={() => {
                onReuse(h)
              }}
            >
              {t('org.ranges.dupe.reuse')}
            </Button>
          </div>
        </div>
      ))}
      <div className="flex flex-col gap-1">
        <Label htmlFor="dupe-reason" className="text-xs text-muted-foreground">
          {t('org.ranges.dupe.reason')}
        </Label>
        <Input
          id="dupe-reason"
          value={reason}
          data-testid="dupe-reason"
          placeholder={t('org.ranges.dupe.still')}
          onChange={(e) => {
            onReason(e.target.value)
          }}
        />
      </div>
    </div>
  )
}

/**
 * 45 H3 / H5：只读的那一条给的不是"改"，是"提议修改"——写一句为什么，出一张卡给老板。
 *
 * 为什么不给一个完整的编辑表单：提议的价值在那句人话上（老板照它点头），
 * 把字段也搬过来等于让人填两遍；批下来要改什么，卡上的 diff 说得清。
 */
function ProposeBox({
  target,
  id,
  busy,
  open,
  reason,
  done,
  onOpen,
  onReason,
  onSubmit,
}: {
  target: 'range_group' | 'product_line'
  id: string
  busy: boolean
  open: boolean
  reason: string
  done: boolean
  onOpen(): void
  onReason(value: string): void
  onSubmit(target: 'range_group' | 'product_line', id: string, reason: string): void
}): React.ReactNode {
  const { t } = useApp()
  if (done)
    return (
      <p className="text-xs text-muted-foreground" data-testid="propose-done">
        {t('org.ranges.propose.done')}
      </p>
    )
  if (!open)
    return (
      <div className="flex justify-end">
        <Button size="xs" variant="outline" data-testid="propose-open" onClick={onOpen}>
          {t('org.ranges.propose')}
        </Button>
      </div>
    )
  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor={`propose-${id}`} className="text-xs text-muted-foreground">
        {t('org.ranges.propose.reason')}
      </Label>
      <Input
        id={`propose-${id}`}
        value={reason}
        data-testid="propose-reason"
        placeholder={t('org.ranges.propose.placeholder')}
        onChange={(e) => {
          onReason(e.target.value)
        }}
      />
      <div className="flex justify-end">
        <Button
          size="xs"
          disabled={busy || reason.trim().length < 8}
          data-testid="propose-submit"
          onClick={() => {
            onSubmit(target, id, reason.trim())
          }}
        >
          {t('org.ranges.propose.submit')}
        </Button>
      </div>
    </div>
  )
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
  onPropose,
  onCheckDuplicate,
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
  /** 45 H5：只读的那一条按这条路走——出一张卡，不直接改。没接就不显示那个按钮。 */
  onPropose?(target: 'range_group' | 'product_line', id: string, reason: string): void
  /**
   * 45 H4：建之前先查。表单一边打字一边防抖来问；没接就不查（离线档 / 老装配）。
   * 传进来的函数要是稳定的（`useCallback`），否则每次渲染都会重新排一次查询。
   */
  onCheckDuplicate?(query: {
    kind: 'range_group' | 'product_line'
    name: string
    members?: { kind: string; id: string }[]
    parent?: { kind: string; id: string }
    rule?: ProductLineRule
  }): Promise<OrgDuplicateHit[]>
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
  // 45 H5：正在给哪一条写提议，写了什么
  const [proposing, setProposing] = useState<string | null>(null)
  const [reason, setReason] = useState('')
  const [proposed, setProposed] = useState<string | null>(null)
  // 45 H4：建之前先查——命中的候选、"仍新建"那句理由、点了"直接用它"的那条
  const [brandHits, setBrandHits] = useState<OrgDuplicateHit[]>([])
  const [brandReason, setBrandReason] = useState('')
  const [brandReused, setBrandReused] = useState<OrgDuplicateHit | undefined>(undefined)
  const [lineHits, setLineHits] = useState<OrgDuplicateHit[]>([])
  const [lineReason, setLineReason] = useState('')
  const [lineReused, setLineReused] = useState<OrgDuplicateHit | undefined>(undefined)

  // 品牌的成员只能是"整层"的范围（产品线是切在它们里面的，不能当品牌成员）
  const memberOptions = rangeOptions.filter((o) => o.kind !== 'product_line')
  const parentOptions = rangeOptions.filter(
    (o) => o.kind === 'store' || o.kind === 'account' || o.kind === 'market',
  )
  const toggle = (list: string[], key: string): string[] =>
    list.includes(key) ? list.filter((x) => x !== key) : [...list, key]

  // 45 H4：名字 / 成员一变就重排一次查询，打字停下来才真的问
  useEffect(() => {
    if (onCheckDuplicate === undefined || brandName.trim() === '') {
      // 空数组也要用函数式判一下：无条件 `setState([])` 每渲染换一次身份，会转成死循环
      setBrandHits((prev) => (prev.length === 0 ? prev : []))
      return
    }
    const timer = setTimeout(() => {
      void onCheckDuplicate({
        kind: 'range_group',
        name: brandName.trim(),
        members: brandMembers.map(parse),
      })
        .then(setBrandHits)
        // 查不动不该挡住建东西（40 §2：查重是加分项）
        .catch(() => {
          setBrandHits([])
        })
    }, DUPLICATE_CHECK_DEBOUNCE_MS)
    return () => {
      clearTimeout(timer)
    }
  }, [brandName, brandMembers, onCheckDuplicate])

  useEffect(() => {
    if (onCheckDuplicate === undefined || lineName.trim() === '' || lineParent === '') {
      setLineHits((prev) => (prev.length === 0 ? prev : []))
      return
    }
    const timer = setTimeout(() => {
      void onCheckDuplicate({
        kind: 'product_line',
        name: lineName.trim(),
        parent: parse(lineParent),
        rule: ruleFrom(linePlatform, lineRule),
      })
        .then(setLineHits)
        .catch(() => {
          setLineHits([])
        })
    }, DUPLICATE_CHECK_DEBOUNCE_MS)
    return () => {
      clearTimeout(timer)
    }
  }, [lineName, lineParent, linePlatform, lineRule, onCheckDuplicate])

  /** 查到像的就得先表态：点"直接用它"，或者写够一句为什么。 */
  const blocked = (hits: OrgDuplicateHit[], reason: string): boolean =>
    hits.length > 0 && reason.trim().length < 8

  const ackOf = (
    hits: OrgDuplicateHit[],
    reason: string,
  ): { duplicate_ack: DuplicateAckDraft } | Record<string, never> =>
    hits.length === 0
      ? {}
      : {
          duplicate_ack: {
            decision: 'new' as const,
            reason: reason.trim(),
            similar_to: hits.map((h) => h.id),
          },
        }

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
                  <span className="flex items-center gap-1">
                    {g.readonly === true ? (
                      <Badge variant="secondary" data-testid="brand-readonly">
                        {t('org.ranges.readonly')}
                        <Hint text={t('org.ranges.readonly.hint')} />
                      </Badge>
                    ) : null}
                    <Badge variant="outline">
                      {t('org.ranges.holders', { n: String(g.holders) })}
                    </Badge>
                  </span>
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
                  {g.origin === undefined ? null : (
                    <p className="text-xs text-muted-foreground" data-testid="brand-origin">
                      {t('org.ranges.origin', { who: g.origin.person_id })}
                    </p>
                  )}
                  {g.readonly === true ? (
                    onPropose === undefined ? null : (
                      <ProposeBox
                        target="range_group"
                        id={g.id}
                        busy={busy}
                        open={proposing === g.id}
                        reason={reason}
                        done={proposed === g.id}
                        onOpen={() => {
                          setProposing(g.id)
                          setReason('')
                        }}
                        onReason={setReason}
                        onSubmit={(target, id, why) => {
                          onPropose(target, id, why)
                          setProposing(null)
                          setProposed(id)
                        }}
                      />
                    )
                  ) : editing === g.id ? (
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
            {/* 45 H4：建之前先查——命中就先说"已有：X（谁建的，几个岗位挂着）" */}
            <DuplicateNotice
              hits={brandHits}
              reason={brandReason}
              reused={brandReused}
              onReason={setBrandReason}
              onReuse={(hit) => {
                // 点了就是引用它，不新建：表单清空，清单里那一条就是答案
                setBrandReused(hit)
                setBrandHits([])
                setBrandName('')
                setBrandMembers([])
                setBrandReason('')
              }}
            />
            <div className="flex justify-end">
              <Button
                size="sm"
                disabled={busy || brandName.trim() === '' || blocked(brandHits, brandReason)}
                data-testid="brand-create"
                onClick={() => {
                  onCreateGroup({
                    name: brandName.trim(),
                    members: brandMembers.map(parse),
                    ...ackOf(brandHits, brandReason),
                  })
                  setBrandName('')
                  setBrandMembers([])
                  setBrandHits([])
                  setBrandReason('')
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
            <DuplicateNotice
              hits={lineHits}
              reason={lineReason}
              reused={lineReused}
              onReason={setLineReason}
              onReuse={(hit) => {
                setLineReused(hit)
                setLineHits([])
                setLineName('')
                setLineRule('')
                setLineReason('')
              }}
            />
            <div className="flex justify-end">
              <Button
                size="sm"
                disabled={
                  busy ||
                  lineName.trim() === '' ||
                  lineParent === '' ||
                  blocked(lineHits, lineReason)
                }
                data-testid="line-create"
                onClick={() => {
                  onCreateLine({
                    name: lineName.trim(),
                    parent: parse(lineParent),
                    rule: ruleFrom(linePlatform, lineRule),
                    ...ackOf(lineHits, lineReason),
                  })
                  setLineName('')
                  setLineRule('')
                  setLineHits([])
                  setLineReason('')
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

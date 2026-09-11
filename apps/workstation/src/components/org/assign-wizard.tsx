/**
 * 分配向导（36 §3 的口吻）：选人 → 选岗位 → 选范围 → 确认。
 *
 * 三条：
 * - 一屏一件事，三步都在同一张卡里，做完哪一步下一步才亮；
 * - 说的是人话："管哪几个店"，不是 `ranges: [{kind:'store'}]`；
 * - 确认那一句把结果先说清楚："李默 会拿到 独立站售后客服，管 store_main。"
 *
 * WP47（44 G3）：选范围这一步有**三种入口**——挑店铺 / 挑品牌 / 挑产品线，
 * 三种可以同时挑，取并集。一个人同时选了"整个品牌"和"另一个品牌里的一条产品线"时
 * 给一句提示：这两种切法建议建两个岗位（额度、采纳率、撞车都是按岗位记的，
 * 混在一个岗位里数字就说不清）。
 */
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Hint } from '@/components/ui/hint'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import type {
  OrgMemberView,
  OrgPositionView,
  ProductLineView,
  RangeGroupView,
  RangeOption,
} from '@/lib/api'
import { useApp } from '@/lib/app-context'
import { cn } from '@/lib/utils'

export interface AssignChoice {
  person_id: string
  position_id: string
  ranges: { kind: string; id: string }[]
  range_groups: string[]
}

type Entry = 'store' | 'brand' | 'line'

/**
 * 44 G3 的那句提示：整品牌 + 别的品牌里的一条产品线 = 两种切法。
 *
 * 判据是"挑了品牌，又挑了一条产品线，而这条产品线的归属不在这些品牌的成员里"——
 * 同一个品牌内部再切一条线是合理的（看得更细），跨品牌混着挂才是该分两个岗位的那种。
 */
export function crossCutting(
  groups: RangeGroupView[],
  pickedGroups: string[],
  lines: ProductLineView[],
  pickedLines: string[],
): boolean {
  if (pickedGroups.length === 0 || pickedLines.length === 0) return false
  const covered = new Set(
    groups
      .filter((g) => pickedGroups.includes(g.id))
      .flatMap((g) => g.members.map((m) => `${m.kind}:${m.id}`)),
  )
  return lines
    .filter((l) => pickedLines.includes(l.id))
    .some((l) => !covered.has(`${l.parent.kind}:${l.parent.id}`))
}

export function AssignWizard({
  members,
  positions,
  rangeOptions,
  rangeGroups,
  productLines,
  presetPosition,
  busy,
  error,
  onCancel,
  onConfirm,
}: {
  members: OrgMemberView[]
  positions: OrgPositionView[]
  rangeOptions: RangeOption[]
  rangeGroups?: RangeGroupView[]
  productLines?: ProductLineView[]
  presetPosition?: string
  busy: boolean
  error?: string
  onCancel(): void
  onConfirm(choice: AssignChoice): void
}): React.ReactNode {
  const { t } = useApp()
  const [person, setPerson] = useState<string | null>(null)
  const [position, setPosition] = useState<string | null>(presetPosition ?? null)
  const [entry, setEntry] = useState<Entry>('store')
  const [picked, setPicked] = useState<string[]>([])
  const [pickedGroups, setPickedGroups] = useState<string[]>([])
  const [extra, setExtra] = useState('')

  const groups = rangeGroups ?? []
  const lines = productLines ?? []
  const active = members.filter((m) => m.left_at === undefined)
  const chosenPerson = active.find((m) => m.person_id === person)
  const chosenPosition = positions.find((p) => p.id === position)

  // 挑店铺那一栏只列"整层"的范围；产品线单独一栏（它是切在店铺 / 账号里面的）
  const storeOptions: RangeOption[] = [
    ...rangeOptions.filter((o) => o.kind !== 'product_line'),
    ...(extra.trim() === ''
      ? []
      : [{ kind: 'store' as const, id: extra.trim(), label: extra.trim() }]),
  ]
  const lineOptions: RangeOption[] = lines.map((l) => ({
    kind: 'product_line' as const,
    id: l.id,
    label: l.name,
  }))
  const options = [...storeOptions, ...lineOptions]
  const ranges = options
    .filter((o) => picked.includes(`${o.kind}:${o.id}`))
    .map((o) => ({ kind: o.kind, id: o.id }))
  const pickedLineIds = ranges.filter((r) => r.kind === 'product_line').map((r) => r.id)

  const toggle = (key: string): void => {
    setPicked((current) =>
      current.includes(key) ? current.filter((k) => k !== key) : [...current, key],
    )
  }
  const toggleGroup = (id: string): void => {
    setPickedGroups((current) =>
      current.includes(id) ? current.filter((k) => k !== id) : [...current, id],
    )
  }

  /** 确认那一句里"管：…"后面的内容（品牌用名字说，不是 id）。 */
  const scopeText = (): string => {
    const names = [
      ...groups.filter((g) => pickedGroups.includes(g.id)).map((g) => g.name),
      ...options.filter((o) => picked.includes(`${o.kind}:${o.id}`)).map((o) => o.label),
    ]
    return names.length === 0 ? t('org.assign.range.none') : names.join('、')
  }

  const warn = crossCutting(groups, pickedGroups, lines, pickedLineIds)

  const ENTRIES: { key: Entry; label: string; count: number }[] = [
    { key: 'store', label: t('org.assign.entry.store'), count: storeOptions.length },
    { key: 'brand', label: t('org.assign.entry.brand'), count: groups.length },
    { key: 'line', label: t('org.assign.entry.line'), count: lines.length },
  ]

  return (
    <div className="flex flex-col gap-4 text-sm" data-testid="assign-wizard">
      <section className="flex flex-col gap-2">
        <p className="font-medium">{t('org.assign.step1')}</p>
        <div className="flex flex-wrap gap-2">
          {active.map((m) => (
            <button
              key={m.person_id}
              type="button"
              data-testid="assign-person"
              className={cn(
                'rounded-md border px-2 py-1 text-left transition-colors hover:bg-muted',
                person === m.person_id && 'border-primary bg-primary/10',
              )}
              onClick={() => {
                setPerson(m.person_id)
              }}
            >
              {m.name}
            </button>
          ))}
          {active.length === 0 ? (
            <p className="text-muted-foreground">{t('org.members.empty')}</p>
          ) : null}
        </div>
      </section>

      <section className={cn('flex flex-col gap-2', person === null && 'opacity-40')}>
        <p className="font-medium">{t('org.assign.step2')}</p>
        <div className="flex flex-wrap gap-2">
          {positions.map((p) => (
            <button
              key={p.id}
              type="button"
              disabled={person === null}
              data-testid="assign-position"
              className={cn(
                'rounded-md border px-2 py-1 text-left transition-colors hover:bg-muted',
                position === p.id && 'border-primary bg-primary/10',
              )}
              onClick={() => {
                setPosition(p.id)
              }}
            >
              {p.name}
            </button>
          ))}
        </div>
      </section>

      <section className={cn('flex flex-col gap-2', position === null && 'opacity-40')}>
        <p className="flex items-center gap-1 font-medium">
          {t('org.assign.step3')}
          <Hint text={t('org.assign.step3.hint')} />
        </p>

        {/* 44 G3：三种入口，能同时挑，取并集 */}
        <div className="flex flex-wrap gap-1" role="tablist" aria-label={t('org.assign.step3')}>
          {ENTRIES.map((e) => (
            <Button
              key={e.key}
              type="button"
              size="xs"
              role="tab"
              aria-selected={entry === e.key}
              variant={entry === e.key ? 'secondary' : 'ghost'}
              disabled={position === null}
              data-testid={`assign-entry-${e.key}`}
              onClick={() => {
                setEntry(e.key)
              }}
            >
              {e.label}
              <span className="ml-1 text-muted-foreground">{e.count}</span>
            </Button>
          ))}
        </div>

        {entry === 'store' ? (
          <div className="flex flex-col gap-2" data-testid="assign-pane-store">
            <div className="flex flex-wrap gap-2">
              {storeOptions.map((o) => {
                const key = `${o.kind}:${o.id}`
                return (
                  <button
                    key={key}
                    type="button"
                    disabled={position === null}
                    data-testid="assign-range"
                    className={cn(
                      'rounded-md border px-2 py-1 transition-colors hover:bg-muted',
                      picked.includes(key) && 'border-primary bg-primary/10',
                    )}
                    onClick={() => {
                      toggle(key)
                    }}
                  >
                    {o.label}
                  </button>
                )
              })}
            </div>
            <div className="flex items-end gap-2">
              <div className="flex flex-1 flex-col gap-1">
                <Label htmlFor="assign-extra-range" className="text-xs text-muted-foreground">
                  {t('org.assign.range.add')}
                </Label>
                <Input
                  id="assign-extra-range"
                  value={extra}
                  placeholder="store_main"
                  onChange={(e) => {
                    setExtra(e.target.value)
                  }}
                />
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={extra.trim() === ''}
                onClick={() => {
                  toggle(`store:${extra.trim()}`)
                }}
              >
                {t('org.assign.range.use')}
              </Button>
            </div>
          </div>
        ) : null}

        {entry === 'brand' ? (
          <div className="flex flex-wrap gap-2" data-testid="assign-pane-brand">
            {groups.map((g) => (
              <button
                key={g.id}
                type="button"
                disabled={position === null}
                data-testid="assign-brand"
                className={cn(
                  'rounded-md border px-2 py-1 text-left transition-colors hover:bg-muted',
                  pickedGroups.includes(g.id) && 'border-primary bg-primary/10',
                )}
                onClick={() => {
                  toggleGroup(g.id)
                }}
              >
                {g.name}
                <span className="ml-1 text-xs text-muted-foreground">
                  {t('org.ranges.members', { n: String(g.members.length) })}
                </span>
              </button>
            ))}
            {groups.length === 0 ? (
              <p className="text-muted-foreground">{t('org.assign.entry.brand.empty')}</p>
            ) : null}
          </div>
        ) : null}

        {entry === 'line' ? (
          <div className="flex flex-wrap gap-2" data-testid="assign-pane-line">
            {lineOptions.map((o) => {
              const key = `${o.kind}:${o.id}`
              return (
                <button
                  key={key}
                  type="button"
                  disabled={position === null}
                  data-testid="assign-line"
                  className={cn(
                    'rounded-md border px-2 py-1 text-left transition-colors hover:bg-muted',
                    picked.includes(key) && 'border-primary bg-primary/10',
                  )}
                  onClick={() => {
                    toggle(key)
                  }}
                >
                  {o.label}
                </button>
              )
            })}
            {lineOptions.length === 0 ? (
              <p className="text-muted-foreground">{t('org.assign.entry.line.empty')}</p>
            ) : null}
          </div>
        ) : null}
      </section>

      {warn ? (
        <p
          className="rounded-md border border-amber-500/40 bg-amber-500/10 p-2"
          data-testid="assign-cross-cut"
        >
          {t('org.assign.cross_cut')}
        </p>
      ) : null}

      {chosenPerson === undefined || chosenPosition === undefined ? null : (
        <p className="rounded-md border bg-muted/40 p-2" data-testid="assign-summary">
          {t('org.assign.summary', {
            person: chosenPerson.name,
            position: chosenPosition.name,
            ranges: scopeText(),
          })}
        </p>
      )}
      {error === undefined ? null : (
        <p role="alert" className="text-destructive" data-testid="assign-error">
          {error}
        </p>
      )}

      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel}>
          {t('org.cancel')}
        </Button>
        <Button
          size="sm"
          data-testid="assign-confirm"
          disabled={person === null || position === null || busy}
          onClick={() => {
            if (person === null || position === null) return
            onConfirm({
              person_id: person,
              position_id: position,
              ranges,
              range_groups: pickedGroups,
            })
          }}
        >
          {t('org.assign.confirm')}
        </Button>
      </div>
    </div>
  )
}
